package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

type sshProviderEnv struct {
	h           *handler
	r           computers.Runtime
	spaceID     string
	host        string
	port        string
	clientKey   string
	fingerprint string
	conns       *int32
}

func (e *sshProviderEnv) adapter() sshComputerProvider {
	return sshComputerProvider{h: e.h}
}

func sealSSHProviderCredentials(t *testing.T, secret []byte, spaceID, privateKey, fingerprint, host, port string) string {
	t.Helper()
	plain, err := json.Marshal(map[string]string{"host": host, "user": "u", "privateKey": privateKey, "hostKeyFingerprint": fingerprint, "port": port})
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := computers.SealCredentials(secret, "tenant", spaceID, "computer", plain)
	if err != nil {
		t.Fatal(err)
	}
	return sealed
}

// sshProviderSetup mirrors railwaySetup: a directly inserted computer, runtime and
// durable approval, but pointed at an in-process SSH server.
func sshProviderSetup(t *testing.T) *sshProviderEnv {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "computers"})
	if err != nil {
		t.Fatal(err)
	}
	signer, clientKey, fingerprint := sshTestHostIdentity(t)
	var conns int32
	host, port := startFakeSSHExec(t, signer, func() sshExecReply { return sshExecReply{} }, &conns, nil)
	h := &handler{deps: d, store: store, mcpSessions: map[string]spaceMCPSession{}}
	sealed := sealSSHProviderCredentials(t, d.Secret, space.ID, clientKey, fingerprint, host, port)
	now := d.Clock().UTC().Format(time.RFC3339Nano)
	if _, err = d.DB.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,secret_ref,capabilities_json,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES('computer','tenant',?,?,?,?,?,?,?,?,?)`, space.ID, "SSH", "ssh", sealed, `["commands"]`, 900, 3600, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB.Exec(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at) VALUES('runtime','tenant',?,'computer','','incarnation','op1','creating',?,?)`, space.ID, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB.Exec(`INSERT INTO computer_creation_approvals(runtime_id,create_operation_id,approved_by,approved_at) VALUES('runtime','op1','admin',?)`, now); err != nil {
		t.Fatal(err)
	}
	r := computers.Runtime{ID: "runtime", ComputerID: "computer", TenantID: "tenant", SpaceID: space.ID, Incarnation: "incarnation", CreateOperationID: "op1", State: computers.Creating}
	return &sshProviderEnv{h: h, r: r, spaceID: space.ID, host: host, port: port, clientKey: clientKey, fingerprint: fingerprint, conns: &conns}
}

func (e *sshProviderEnv) reseal(t *testing.T, privateKey, fingerprint string) {
	t.Helper()
	sealed := sealSSHProviderCredentials(t, e.h.deps.Secret, e.spaceID, privateKey, fingerprint, e.host, e.port)
	if _, err := e.h.deps.DB.Exec(`UPDATE computers SET secret_ref=? WHERE tenant_id='tenant' AND space_id=? AND id='computer'`, sealed, e.spaceID); err != nil {
		t.Fatal(err)
	}
}

func TestSSHProviderCreatePinsHost(t *testing.T) {
	env := sshProviderSetup(t)
	result, err := env.adapter().Create(context.Background(), env.r)
	if err != nil || result.ExternalID != "ssh:"+env.host+":"+env.port || result.RootPath != "" {
		t.Fatalf("create: %+v %v", result, err)
	}
}

func TestSSHProviderFindIsIdempotent(t *testing.T) {
	env := sshProviderSetup(t)
	created, err := env.adapter().Create(context.Background(), env.r)
	if err != nil {
		t.Fatal(err)
	}
	r := env.r
	if got, err := env.adapter().Find(context.Background(), r); err != nil || got.ExternalID != created.ExternalID {
		t.Fatalf("find empty: %+v %v", got, err)
	}
	r.ExternalID = created.ExternalID
	if got, err := env.adapter().Find(context.Background(), r); err != nil || got.ExternalID != created.ExternalID {
		t.Fatalf("find same: %+v %v", got, err)
	}
}

func TestSSHProviderDifferentHostRejected(t *testing.T) {
	env := sshProviderSetup(t)
	r := env.r
	r.ExternalID = "ssh:other.example:22"
	if _, err := env.adapter().Find(context.Background(), r); err == nil || !strings.Contains(err.Error(), "different ssh host") {
		t.Fatalf("expected different host error, got %v", err)
	}
}

func TestSSHProviderApprovalRequired(t *testing.T) {
	env := sshProviderSetup(t)
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
		t.Fatalf("unapproved runtime contacted the host %d times", atomic.LoadInt32(env.conns))
	}
}

func TestSSHProviderCrossTenantRejected(t *testing.T) {
	env := sshProviderSetup(t)
	foreign := env.r
	foreign.TenantID = "other"
	if _, err := env.adapter().Create(context.Background(), foreign); err == nil {
		t.Fatal("cross-tenant create was accepted")
	}
	if _, err := env.adapter().Find(context.Background(), foreign); err == nil {
		t.Fatal("cross-tenant find was accepted")
	}
	if atomic.LoadInt32(env.conns) != 0 {
		t.Fatalf("cross-tenant runtime contacted the host %d times", atomic.LoadInt32(env.conns))
	}
}

func TestSSHProviderFingerprintMismatchIsError(t *testing.T) {
	env := sshProviderSetup(t)
	env.reseal(t, env.clientKey, "SHA256:"+strings.Repeat("A", 43))
	if _, err := env.adapter().Create(context.Background(), env.r); err == nil {
		t.Fatal("expected handshake failure on fingerprint mismatch")
	}
}

func TestSSHProviderHasNoDestroyer(t *testing.T) {
	if _, ok := any(sshComputerProvider{}).(computers.DestructionProvider); ok {
		t.Fatal("ssh provider must not implement Destroy")
	}
}
