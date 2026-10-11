package runtime

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/ssh"
)

const railwayTestManifest = `{"box":"zippy-laughter","preview":"https://x.up.railway.app","claim":"https://railway.new/claim","deadline":"2026-01-01T00:00:00Z"}`

// serveFakeRailway implements just enough of an SSH server: it accepts any client
// public key, and on an "exec" request writes the injected manifest to stdout and
// reports exit status 0.
func serveFakeRailway(conn net.Conn, cfg *ssh.ServerConfig, output func() string) {
	server, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer server.Close()
	go ssh.DiscardRequests(reqs)
	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			_ = newCh.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			continue
		}
		go func() {
			defer ch.Close()
			for req := range chReqs {
				if req.Type != "exec" {
					_ = req.Reply(false, nil)
					continue
				}
				_ = req.Reply(true, nil)
				if data := output(); data != "" {
					_, _ = ch.Write([]byte(data))
				}
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
				return
			}
		}()
	}
}

func startFakeRailway(t *testing.T, signer ssh.Signer, output func() string, conns *int32) (host, port string) {
	t.Helper()
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
			return &ssh.Permissions{}, nil
		},
	}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			if conns != nil {
				atomic.AddInt32(conns, 1)
			}
			go serveFakeRailway(conn, cfg, output)
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", strconv.Itoa(addr.Port)
}

func sealedRailwayCredentials(t *testing.T, secret []byte, spaceID, privateKey, fingerprint string) string {
	t.Helper()
	plain, err := json.Marshal(map[string]string{"privateKey": privateKey, "hostKeyFingerprint": fingerprint})
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := computers.SealCredentials(secret, "tenant", spaceID, "computer", plain)
	if err != nil {
		t.Fatal(err)
	}
	return sealed
}

type railwayEnv struct {
	h           *handler
	r           computers.Runtime
	spaceID     string
	host        string
	port        string
	clientKey   string
	fingerprint string
	conns       *int32
	output      *atomic.Value
}

func (e *railwayEnv) adapter() railwayComputerProvider {
	return railwayComputerProvider{h: e.h, host: e.host, port: e.port}
}

// railwaySetup mirrors e2bTestSetup: a directly inserted computer, runtime and
// durable approval, but the computer is not session-scoped (scope "").
func railwaySetup(t *testing.T) *railwayEnv {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "computers"})
	if err != nil {
		t.Fatal(err)
	}
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := computers.SSHFingerprint(hostSigner.PublicKey())
	_, clientPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(clientPriv)
	if err != nil {
		t.Fatal(err)
	}
	clientKey := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	h := &handler{deps: d, store: store, mcpSessions: map[string]spaceMCPSession{}}
	sealed := sealedRailwayCredentials(t, d.Secret, space.ID, clientKey, fingerprint)
	now := d.Clock().UTC().Format(time.RFC3339Nano)
	if _, err = d.DB.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,secret_ref,capabilities_json,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES('computer','tenant',?,?,?,?,?,?,?,?,?)`, space.ID, "Railway", "railway", sealed, "[]", 900, 3600, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB.Exec(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at) VALUES('runtime','tenant',?,'computer','','incarnation','op1','creating',?,?)`, space.ID, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB.Exec(`INSERT INTO computer_creation_approvals(runtime_id,create_operation_id,approved_by,approved_at) VALUES('runtime','op1','admin',?)`, now); err != nil {
		t.Fatal(err)
	}
	var conns int32
	out := new(atomic.Value)
	out.Store(railwayTestManifest)
	host, port := startFakeRailway(t, hostSigner, func() string { return out.Load().(string) }, &conns)
	r := computers.Runtime{ID: "runtime", ComputerID: "computer", TenantID: "tenant", SpaceID: space.ID, Incarnation: "incarnation", CreateOperationID: "op1", State: computers.Creating}
	return &railwayEnv{h: h, r: r, spaceID: space.ID, host: host, port: port, clientKey: clientKey, fingerprint: fingerprint, conns: &conns, output: out}
}

func (e *railwayEnv) reseal(t *testing.T, privateKey, fingerprint string) {
	t.Helper()
	sealed := sealedRailwayCredentials(t, e.h.deps.Secret, e.spaceID, privateKey, fingerprint)
	if _, err := e.h.deps.DB.Exec(`UPDATE computers SET secret_ref=? WHERE tenant_id='tenant' AND space_id=? AND id='computer'`, sealed, e.spaceID); err != nil {
		t.Fatal(err)
	}
}

func TestRailwayCreateReturnsBox(t *testing.T) {
	env := railwaySetup(t)
	result, err := env.adapter().Create(context.Background(), env.r)
	if err != nil || result.ExternalID != "zippy-laughter" || result.RootPath != "" {
		t.Fatalf("create: %+v %v", result, err)
	}
}

func TestRailwayFindReconnectIsIdempotent(t *testing.T) {
	env := railwaySetup(t)
	result, err := env.adapter().Create(context.Background(), env.r)
	if err != nil || result.ExternalID != "zippy-laughter" {
		t.Fatalf("create: %+v %v", result, err)
	}
	r := env.r
	if got, err := env.adapter().Find(context.Background(), r); err != nil || got.ExternalID != "zippy-laughter" {
		t.Fatalf("find empty: %+v %v", got, err)
	}
	r.ExternalID = "zippy-laughter"
	if got, err := env.adapter().Find(context.Background(), r); err != nil || got.ExternalID != "zippy-laughter" {
		t.Fatalf("find same: %+v %v", got, err)
	}
}

func TestRailwayNoManifestIsError(t *testing.T) {
	env := railwaySetup(t)
	env.output.Store("welcome to your railway box\nno manifest here\n")
	if _, err := env.adapter().Create(context.Background(), env.r); err == nil {
		t.Fatal("expected create error without a manifest")
	}
}

func TestRailwayDifferentBoxRejected(t *testing.T) {
	env := railwaySetup(t)
	env.output.Store(`{"box":"other-box","preview":"https://y.up.railway.app"}`)
	r := env.r
	r.ExternalID = "zippy-laughter"
	_, err := env.adapter().Find(context.Background(), r)
	if err == nil || !strings.Contains(err.Error(), "different railway box") {
		t.Fatalf("expected different box error, got %v", err)
	}
}

func TestRailwayApprovalRequired(t *testing.T) {
	env := railwaySetup(t)
	if _, err := env.h.deps.DB.Exec(`DELETE FROM computer_creation_approvals WHERE runtime_id='runtime'`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.adapter().Create(context.Background(), env.r); !errors.Is(err, computers.ErrTransitionConflict) {
		t.Fatalf("create without approval: %v", err)
	}
	if _, err := env.adapter().Find(context.Background(), env.r); !errors.Is(err, computers.ErrTransitionConflict) {
		t.Fatalf("find without approval: %v", err)
	}
	if atomic.LoadInt32(env.conns) != 0 {
		t.Fatalf("unapproved runtime contacted railway %d times", atomic.LoadInt32(env.conns))
	}
}

func TestRailwayCrossTenantRejected(t *testing.T) {
	env := railwaySetup(t)
	foreign := env.r
	foreign.TenantID = "other"
	if _, err := env.adapter().Create(context.Background(), foreign); err == nil {
		t.Fatal("cross-tenant create was accepted")
	}
	if _, err := env.adapter().Find(context.Background(), foreign); err == nil {
		t.Fatal("cross-tenant find was accepted")
	}
	if atomic.LoadInt32(env.conns) != 0 {
		t.Fatalf("cross-tenant runtime contacted railway %d times", atomic.LoadInt32(env.conns))
	}
}

func TestRailwayFingerprintMismatchIsError(t *testing.T) {
	env := railwaySetup(t)
	env.reseal(t, env.clientKey, "SHA256:"+strings.Repeat("A", 43))
	if _, err := env.adapter().Create(context.Background(), env.r); err == nil {
		t.Fatal("expected handshake failure on fingerprint mismatch")
	}
}

func TestRailwayProviderHasNoDestroyer(t *testing.T) {
	if _, ok := any(railwayComputerProvider{}).(computers.DestructionProvider); ok {
		t.Fatal("railway provider must not implement Destroy")
	}
}

func TestRailwayManifestPersistedAndSurfaced(t *testing.T) {
	env := railwaySetup(t)
	if _, err := env.adapter().Create(context.Background(), env.r); err != nil {
		t.Fatalf("create: %v", err)
	}
	var raw string
	if err := env.h.deps.DB.QueryRow(`SELECT manifest_json FROM computer_runtimes WHERE id='runtime'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "zippy-laughter") || !strings.Contains(raw, "https://x.up.railway.app") {
		t.Fatalf("manifest not persisted: %s", raw)
	}
	router := chi.NewRouter()
	env.h.registerComputers(router)
	req := httptest.NewRequest("GET", "/spaces/"+env.spaceID+"/computers/computer/runtimes/runtime?incarnation=incarnation", nil)
	req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant", Role: "owner", UserID: "user"}))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("get runtime: %d %s", w.Code, w.Body)
	}
	var got computerRuntimeResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Manifest == nil || got.Manifest.ID != "zippy-laughter" || got.Manifest.Preview != "https://x.up.railway.app" || got.Manifest.Claim != "https://railway.new/claim" || got.Manifest.Deadline != "2026-01-01T00:00:00Z" {
		t.Fatalf("manifest not surfaced: %+v", got.Manifest)
	}
}

func TestRailwayTrustOnFirstUsePinsFingerprint(t *testing.T) {
	env := railwaySetup(t)
	env.reseal(t, env.clientKey, "")
	if _, err := env.adapter().Create(context.Background(), env.r); err != nil {
		t.Fatalf("create: %v", err)
	}
	var envelope string
	if err := env.h.deps.DB.QueryRow(`SELECT secret_ref FROM computers WHERE tenant_id='tenant' AND space_id=? AND id='computer'`, env.spaceID).Scan(&envelope); err != nil {
		t.Fatal(err)
	}
	plain, err := computers.OpenCredentials(env.h.deps.Secret, "tenant", env.spaceID, "computer", envelope)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]string
	if err := json.Unmarshal(plain, &stored); err != nil {
		t.Fatal(err)
	}
	if stored["hostKeyFingerprint"] != env.fingerprint {
		t.Fatalf("fingerprint not pinned: %q want %q", stored["hostKeyFingerprint"], env.fingerprint)
	}
	_, otherPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	otherSigner, err := ssh.NewSignerFromKey(otherPriv)
	if err != nil {
		t.Fatal(err)
	}
	out := new(atomic.Value)
	out.Store(railwayTestManifest)
	host, port := startFakeRailway(t, otherSigner, func() string { return out.Load().(string) }, nil)
	adapter := railwayComputerProvider{h: env.h, host: host, port: port}
	if _, err := adapter.Create(context.Background(), env.r); err == nil || !strings.Contains(err.Error(), "host key fingerprint mismatch") {
		t.Fatalf("expected fingerprint mismatch, got %v", err)
	}
}
