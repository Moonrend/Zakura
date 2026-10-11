package runtime

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"golang.org/x/crypto/ssh"
)

type sshExecReply struct {
	stdout   string
	stderr   string
	exitCode int
}

// serveFakeSSHExec implements just enough of an SSH server: it accepts any client
// public key, records the exec command, writes the configured streams and reports
// the configured exit status.
func serveFakeSSHExec(conn net.Conn, cfg *ssh.ServerConfig, reply func() sshExecReply, last *atomic.Value) {
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
				var payload struct{ Command string }
				if err := ssh.Unmarshal(req.Payload, &payload); err == nil && last != nil {
					last.Store(payload.Command)
				}
				result := reply()
				if result.stdout != "" {
					_, _ = ch.Write([]byte(result.stdout))
				}
				if result.stderr != "" {
					_, _ = ch.Stderr().Write([]byte(result.stderr))
				}
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{uint32(result.exitCode)}))
				return
			}
		}()
	}
}

func startFakeSSHExec(t *testing.T, signer ssh.Signer, reply func() sshExecReply, conns *int32, last *atomic.Value) (host, port string) {
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
			go serveFakeSSHExec(conn, cfg, reply, last)
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", strconv.Itoa(addr.Port)
}

// sshTestHostIdentity returns a server signer, a client private key PEM and the
// server's OpenSSH SHA256 fingerprint.
func sshTestHostIdentity(t *testing.T) (ssh.Signer, string, string) {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatal(err)
	}
	_, clientPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(clientPriv)
	if err != nil {
		t.Fatal(err)
	}
	key := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	return signer, key, computers.SSHFingerprint(signer.PublicKey())
}

func sshCredsJSON(t *testing.T, privateKey, fingerprint, host, port string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]string{
		"host": host, "user": "u", "privateKey": privateKey,
		"hostKeyFingerprint": fingerprint, "port": port,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

type sshExecEnv struct {
	h    *handler
	exec *resolvedExecution
}

// sshExecHarness inserts a computer and a ready runtime for the given provider.
// An empty credentials string leaves secret_ref NULL (missing configuration).
func sshExecHarness(t *testing.T, provider computers.Provider, credentials, external string) *sshExecEnv {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	var sealed any
	if credentials != "" {
		value, err := computers.SealCredentials(d.Secret, "tenant", space.ID, "computer", []byte(credentials))
		if err != nil {
			t.Fatal(err)
		}
		sealed = value
	}
	now := d.Clock().UTC().Format(time.RFC3339Nano)
	if _, err = d.DB.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,secret_ref,capabilities_json,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES('computer','tenant',?,?,?,?,?,?,?,?,?)`, space.ID, "Host", provider, sealed, `["commands"]`, 900, 3600, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB.Exec(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,external_id,created_at,updated_at) VALUES('runtime','tenant',?,'computer','','incarnation','op1','ready',?,?,?)`, space.ID, external, now, now); err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store, mcpSessions: map[string]spaceMCPSession{}}
	exec := &resolvedExecution{
		spaceID:     space.ID,
		containerID: external,
		computer:    computers.Computer{ID: "computer", TenantID: "tenant", SpaceID: space.ID, Name: "Host", Provider: provider, Capabilities: []computers.Capability{computers.Commands}},
		runtime:     computers.Runtime{ID: "runtime", ComputerID: "computer", TenantID: "tenant", SpaceID: space.ID, ExternalID: external, State: computers.Ready},
	}
	return &sshExecEnv{h: h, exec: exec}
}

func TestSSHExecSuccess(t *testing.T) {
	signer, key, fingerprint := sshTestHostIdentity(t)
	var conns int32
	last := new(atomic.Value)
	host, port := startFakeSSHExec(t, signer, func() sshExecReply { return sshExecReply{stdout: "hello\n"} }, &conns, last)
	env := sshExecHarness(t, computers.SSH, sshCredsJSON(t, key, fingerprint, host, port), "ssh:"+host+":"+port)
	result, err := env.h.computerSSHExec(context.Background(), env.exec, 0, "bash", "-lc", "echo hello")
	if err != nil {
		t.Fatal(err)
	}
	if result["stdout"] != "hello\n" || result["exitCode"] != float64(0) {
		t.Fatalf("result = %v", result)
	}
	if result["executionMode"] != "remote-ssh" || result["isolated"] != false || result["restrictedPolicyApplied"] != false {
		t.Fatalf("flags = %v", result)
	}
	if got, _ := last.Load().(string); got != "bash -lc 'echo hello'" {
		t.Fatalf("remote command = %q", got)
	}
}

func TestSSHExecRailwayUsesProviderDefaults(t *testing.T) {
	signer, key, fingerprint := sshTestHostIdentity(t)
	var conns int32
	last := new(atomic.Value)
	host, port := startFakeSSHExec(t, signer, func() sshExecReply { return sshExecReply{stdout: "ok"} }, &conns, last)
	previousHost, previousPort := railwayExecHost, railwayExecPort
	railwayExecHost, railwayExecPort = host, port
	t.Cleanup(func() { railwayExecHost, railwayExecPort = previousHost, previousPort })
	credentials, err := json.Marshal(map[string]string{"privateKey": key, "hostKeyFingerprint": fingerprint})
	if err != nil {
		t.Fatal(err)
	}
	env := sshExecHarness(t, computers.Railway, string(credentials), "box-1")
	result, err := env.h.computerSSHExec(context.Background(), env.exec, 0, "bash", "-lc", "echo hi")
	if err != nil {
		t.Fatal(err)
	}
	if result["stdout"] != "ok" || result["executionMode"] != "remote-ssh" {
		t.Fatalf("result = %v", result)
	}
	if atomic.LoadInt32(&conns) == 0 {
		t.Fatal("railway exec never dialed the host")
	}
}

func TestSSHExecFingerprintMismatch(t *testing.T) {
	signer, key, _ := sshTestHostIdentity(t)
	_, _, otherFingerprint := sshTestHostIdentity(t)
	var conns int32
	last := new(atomic.Value)
	host, port := startFakeSSHExec(t, signer, func() sshExecReply { return sshExecReply{stdout: "should not run"} }, &conns, last)
	env := sshExecHarness(t, computers.SSH, sshCredsJSON(t, key, otherFingerprint, host, port), "ssh:"+host+":"+port)
	result, err := env.h.computerSSHExec(context.Background(), env.exec, 0, "bash", "-lc", "echo hello")
	if err == nil || result != nil {
		t.Fatalf("expected error without result: %v %v", result, err)
	}
	if last.Load() != nil {
		t.Fatalf("command ran despite fingerprint mismatch: %v", last.Load())
	}
}

func TestSSHExecNonZeroExit(t *testing.T) {
	signer, key, fingerprint := sshTestHostIdentity(t)
	var conns int32
	last := new(atomic.Value)
	host, port := startFakeSSHExec(t, signer, func() sshExecReply { return sshExecReply{stdout: "out", stderr: "boom", exitCode: 7} }, &conns, last)
	env := sshExecHarness(t, computers.SSH, sshCredsJSON(t, key, fingerprint, host, port), "ssh:"+host+":"+port)
	result, err := env.h.computerSSHExec(context.Background(), env.exec, 0, "bash", "-lc", "false")
	if err == nil || result == nil {
		t.Fatalf("expected result and error: %v %v", result, err)
	}
	if result["exitCode"] != float64(7) || result["stdout"] != "out" || result["stderr"] != "boom" {
		t.Fatalf("result = %v", result)
	}
}

func TestSSHExecMissingCredentials(t *testing.T) {
	signer, _, _ := sshTestHostIdentity(t)
	var conns int32
	host, port := startFakeSSHExec(t, signer, func() sshExecReply { return sshExecReply{stdout: "no"} }, &conns, nil)
	env := sshExecHarness(t, computers.SSH, "", "ssh:"+host+":"+port)
	result, err := env.h.computerSSHExec(context.Background(), env.exec, 0, "bash", "-lc", "echo hi")
	if err == nil || result != nil {
		t.Fatalf("expected a credential error: %v %v", result, err)
	}
	if !strings.Contains(err.Error(), "configuration") {
		t.Fatalf("error = %v", err)
	}
	if atomic.LoadInt32(&conns) != 0 {
		t.Fatalf("credential-less exec dialed %d times", atomic.LoadInt32(&conns))
	}
}

func TestSSHExecBadEnvelope(t *testing.T) {
	signer, _, _ := sshTestHostIdentity(t)
	var conns int32
	host, port := startFakeSSHExec(t, signer, func() sshExecReply { return sshExecReply{} }, &conns, nil)
	env := sshExecHarness(t, computers.SSH, "", "ssh:"+host+":"+port)
	if _, err := env.h.deps.DB.Exec(`UPDATE computers SET secret_ref='computer-v1.bm90LWEtcmVhbA' WHERE id='computer'`); err != nil {
		t.Fatal(err)
	}
	result, err := env.h.computerSSHExec(context.Background(), env.exec, 0, "bash", "-lc", "echo hi")
	if err == nil || result != nil {
		t.Fatalf("expected an envelope error: %v %v", result, err)
	}
	if atomic.LoadInt32(&conns) != 0 {
		t.Fatalf("bad-envelope exec dialed %d times", atomic.LoadInt32(&conns))
	}
}

func TestSSHExecTimeout(t *testing.T) {
	signer, key, fingerprint := sshTestHostIdentity(t)
	var conns int32
	host, port := startFakeSSHExec(t, signer, func() sshExecReply {
		time.Sleep(2 * time.Second)
		return sshExecReply{stdout: "late"}
	}, &conns, nil)
	env := sshExecHarness(t, computers.SSH, sshCredsJSON(t, key, fingerprint, host, port), "ssh:"+host+":"+port)
	start := time.Now()
	result, err := env.h.computerSSHExec(context.Background(), env.exec, 200, "bash", "-lc", "sleep 5")
	if err == nil || result != nil || !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("timeout: %v %v", result, err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("timeout not honored: %v", elapsed)
	}
}

func TestSSHExecDispatch(t *testing.T) {
	signer, key, fingerprint := sshTestHostIdentity(t)
	var conns int32
	last := new(atomic.Value)
	host, port := startFakeSSHExec(t, signer, func() sshExecReply { return sshExecReply{stdout: "hi"} }, &conns, last)
	env := sshExecHarness(t, computers.SSH, sshCredsJSON(t, key, fingerprint, host, port), "ssh:"+host+":"+port)
	result, err := env.h.computerContainerExec(context.Background(), env.exec, "host", 0, "bash", "-lc", "echo hi")
	if err != nil {
		t.Fatal(err)
	}
	if result["stdout"] != "hi" || result["executionMode"] != "remote-ssh" {
		t.Fatalf("result = %v", result)
	}
	if atomic.LoadInt32(&conns) == 0 {
		t.Fatal("dispatch did not reach the ssh host")
	}
	if _, err := env.h.computerContainerExec(context.Background(), env.exec, "sandbox", 0, "bash", "-lc", "echo hi"); err == nil || !strings.Contains(err.Error(), "refusing downgrade") {
		t.Fatalf("sandbox downgrade not refused: %v", err)
	}
}

func TestSSHRemoteCommandQuoting(t *testing.T) {
	if got := sshRemoteCommand("bash", []string{"-lc", "echo hello"}); got != "bash -lc 'echo hello'" {
		t.Fatalf("command = %q", got)
	}
	if got := sshRemoteCommand("bash", []string{"-lc", "echo 'it'"}); got != `bash -lc 'echo '\''it'\'''` {
		t.Fatalf("quoted command = %q", got)
	}
}
