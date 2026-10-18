// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func acpAuthHarness(t *testing.T, fake *fakeACPAdapter) (*acpRuntimeManager, Agent, Session) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	token := "rnr_acp-auth"
	hash := sha256.Sum256([]byte(token))
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now)
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: NewStore(d)}
	h.service = NewService(h.store)
	h.hub = newRunnerHub(d)
	node := "node"
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "ACP", WorkspaceKind: "host", RuntimeNodeID: &node, EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.saveSpaceACP(context.Background(), "tenant", space.ID, map[string]any{"agents": map[string]any{"codex": map[string]any{"enabled": true, "command": "fake-adapter"}}}); err != nil {
		t.Fatal(err)
	}
	session, err := h.store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{Kind: "acp", Origin: json.RawMessage(`{"acpProfileId":"codex"}`)})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Handle("/api/runtime-nodes/hub", http.HandlerFunc(h.runnerHubHTTP))
	server := httptest.NewServer(router)
	startACPRunner(t, server.URL, token, fake)
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := h.hub.get("node"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runner unavailable")
		}
		time.Sleep(time.Millisecond * 5)
	}
	manager := newACPRuntimeManager(h)
	t.Cleanup(func() {
		manager.closeAll()
		fake.mu.Lock()
		conn := fake.conn
		fake.mu.Unlock()
		if conn != nil {
			_ = conn.Close()
		}
		server.Close()
	})
	return manager, agent, session
}

func TestACPRunnerDisconnectPersistsErrorLifecycle(t *testing.T) {
	fake := &fakeACPAdapter{}
	manager, agent, session := acpAuthHarness(t, fake)
	rt, err := manager.ensure(context.Background(), "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	conn := fake.conn
	fake.mu.Unlock()
	_ = conn.Close()
	select {
	case <-rt.done:
	case <-time.After(time.Second):
		t.Fatal("runner disconnect left idle runtime cached")
	}
	state, err := manager.snapshot(context.Background(), "tenant", agent.ID, session.ID)
	if err != nil || state["state"] != "error" {
		t.Fatalf("disconnect state %#v %v", state, err)
	}
}

func TestACPAuthenticationRequiredRuntimeSurvivesAndRetries(t *testing.T) {
	fake := &fakeACPAdapter{requireAuth: true}
	manager, agent, session := acpAuthHarness(t, fake)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rt, err := manager.ensure(ctx, "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := rt.snapshot()
	if state["state"] != "auth_required" || state["authRequired"] != true || len(state["authMethods"].([]any)) != 2 {
		t.Fatalf("auth metadata lost: %#v", state)
	}
	select {
	case <-rt.done:
		t.Fatal("authentication-required closed transport")
	default:
	}
	if err = rt.authenticate(ctx, "unknown"); err == nil {
		t.Fatal("unknown method accepted")
	}
	if err = rt.authenticate(ctx, "tty"); err == nil {
		t.Fatal("terminal auth passed to authenticate")
	}
	if fake.has("authenticate") {
		t.Fatal("invalid auth method reached adapter")
	}
	if err = rt.authenticate(ctx, "login"); err != nil {
		t.Fatal(err)
	}
	if state = rt.snapshot(); state["state"] != "idle" || state["authenticated"] != true || state["acpSessionId"] != "acp-session-1" {
		t.Fatalf("session not reopened: %#v", state)
	}
	fake.mu.Lock()
	processes := fake.process
	fake.mu.Unlock()
	if processes != 1 {
		t.Fatalf("auth respawned adapter: %d", processes)
	}
	if err = rt.logout(ctx); err != nil {
		t.Fatal(err)
	}
	if state = rt.snapshot(); state["state"] != "auth_required" || state["authenticated"] != false {
		t.Fatalf("logout state %#v", state)
	}
	rt.mu.Lock()
	rt.state["logoutSupported"] = false
	rt.mu.Unlock()
	if err = rt.logout(ctx); err == nil {
		t.Fatal("unsupported logout accepted")
	}
	if err = rt.authenticate(ctx, "login"); err != nil {
		t.Fatal(err)
	}
	rt.close(errors.New("adapter failed"))
	snapshot, err := manager.snapshot(ctx, "tenant", agent.ID, session.ID)
	if err != nil || snapshot["state"] != "error" {
		t.Fatalf("lost lifecycle %#v %v", snapshot, err)
	}
	other, err := manager.h.store.CreateAgent(ctx, "tenant", Agent{Name: "Other", SpaceID: agent.SpaceID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.snapshot(ctx, "tenant", other.ID, session.ID); err == nil {
		t.Fatal("GET snapshot bypassed ownership")
	}
	fresh := &acpRuntimeManager{h: manager.h, runtimes: map[string]*acpLiveRuntime{}}
	snapshot, err = fresh.snapshot(ctx, "tenant", agent.ID, session.ID)
	if err != nil || snapshot["state"] != "error" {
		t.Fatalf("terminal lifecycle not durable: %#v %v", snapshot, err)
	}
}
