// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestACPLoginConflictMessagesAreSafe(t *testing.T) {
	const fallback = "terminal unavailable"
	for _, conflict := range []error{errACPManagedConflict, errACPOAuthEnvConflict} {
		wrapped := fmt.Errorf("runner-secret: %w", conflict)
		if got := acpLoginStartMessage(wrapped, fallback); got != conflict.Error() || strings.Contains(got, "runner-secret") {
			t.Fatalf("unsafe conflict message %q", got)
		}
	}
	if got := acpLoginStartMessage(errors.New("credential=runner-secret"), fallback); got != fallback {
		t.Fatalf("runner error exposed: %q", got)
	}
}

func TestACPMCPExplicitReconnectRetainsFenceOnUnconfirmedCleanup(t *testing.T) {
	fake := &fakeACPAdapter{}
	manager, agent, session := acpAuthHarness(t, fake)
	h := manager.h
	h.acp, h.service = manager, NewService(h.store)
	actor := acpMCPUser(t, h)
	rt, err := manager.ensure(httpx.WithPrincipal(context.Background(), actor), "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	fake.failClose = true
	fake.mu.Unlock()
	router := chi.NewRouter()
	router.Post("/agents/{id}/sessions/{sid}/acp-runtime/reconnect", h.reconnectACPRuntime)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/agents/"+agent.ID+"/sessions/"+session.ID+"/acp-runtime/reconnect", nil)
	router.ServeHTTP(w, req.WithContext(httpx.WithPrincipal(req.Context(), actor)))
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "cleanup is unconfirmed") {
		t.Fatalf("unconfirmed cleanup was ignored: %d %s", w.Code, w.Body.String())
	}
	if !errors.Is(rt.close(nil), errACPCleanupUnconfirmed) {
		t.Fatal("cleanup uncertainty was lost on retry")
	}
	for _, table := range []string{"computer_workspace_leases", "acp_profile_auth_locks"} {
		var count int
		if err := h.deps.DB.QueryRow(`SELECT COUNT(*) FROM `+table+` WHERE tenant_id='tenant' AND space_id=?`, agent.SpaceID).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s fence missing: %d %v", table, count, err)
		}
	}
	fake.mu.Lock()
	processes := fake.process
	fake.mu.Unlock()
	if processes != 1 {
		t.Fatal("unconfirmed process was replaced")
	}
}

func TestACPMCPExplicitReconnectRevokesAndReloadsSession(t *testing.T) {
	fake := &fakeACPAdapter{}
	manager, agent, session := acpAuthHarness(t, fake)
	h := manager.h
	h.acp, h.service = manager, NewService(h.store)
	actor := acpMCPUser(t, h)
	insertMCPInstance(t, h.deps, "reconnect-inst", "tenant", nil, "demo", "Demo", map[string]any{"url": "http://unused.example"})
	insertMCPBinding(t, h.deps, "reconnect-bind", "tenant", agent.SpaceID, "reconnect-inst")
	fake.onRPC = func(_ string, rpc map[string]any, send func(any)) bool {
		if rpc["method"] == "initialize" {
			send(map[string]any{"jsonrpc": "2.0", "id": rpc["id"], "result": map[string]any{"agentCapabilities": map[string]any{"loadSession": true, "mcpCapabilities": map[string]any{"http": true}}}})
			return true
		}
		return false
	}
	ctx := httpx.WithPrincipal(context.Background(), actor)
	old, err := manager.ensure(ctx, "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	oldHash := old.mcpGrantHash
	manager.mcpGrants[oldHash].expires = h.store.now()
	state, err := manager.snapshot(ctx, "tenant", agent.ID, session.ID)
	if err != nil || state["mcpReconnectRequired"] != true {
		t.Fatalf("expiry not exposed: %#v %v", state, err)
	}
	if _, err = manager.ensure(ctx, "tenant", agent.ID, session.ID); err == nil || old.mcpGrantHash != oldHash {
		t.Fatal("ensure silently renewed expired grant")
	}
	router := chi.NewRouter()
	router.Post("/agents/{id}/sessions/{sid}/acp-runtime/reconnect", h.reconnectACPRuntime)
	invoke := func(p httpx.Principal) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/agents/"+agent.ID+"/sessions/"+session.ID+"/acp-runtime/reconnect", nil)
		router.ServeHTTP(w, req.WithContext(httpx.WithPrincipal(req.Context(), p)))
		return w
	}
	wrong := actor
	wrong.APIKey, wrong.SpaceID, wrong.APIKeyScopes = true, "other-space", `["api"]`
	if w := invoke(wrong); w.Code != http.StatusNotFound {
		t.Fatalf("cross-Space reconnect: %d %s", w.Code, w.Body.String())
	}
	if _, err = h.deps.DB.Exec(`UPDATE cloud_agent_sessions SET active_run_id='busy' WHERE id=?`, session.ID); err != nil {
		t.Fatal(err)
	}
	if w := invoke(actor); w.Code != http.StatusConflict || old.mcpGrantHash != oldHash {
		t.Fatalf("active reconnect: %d %s", w.Code, w.Body.String())
	}
	if _, err = h.deps.DB.Exec(`UPDATE cloud_agent_sessions SET active_run_id=NULL WHERE id=?`, session.ID); err != nil {
		t.Fatal(err)
	}
	if w := invoke(actor); w.Code != http.StatusOK {
		t.Fatalf("explicit reconnect: %d %s", w.Code, w.Body.String())
	}
	current, err := manager.ensure(ctx, "tenant", agent.ID, session.ID)
	if err != nil || current == old || current.mcpGrantHash == "" || current.mcpGrantHash == oldHash || fake.loadCount() != 1 {
		t.Fatalf("session not reloaded with new delegation: %v", err)
	}
	if manager.mcpGrants[oldHash] != nil {
		t.Fatal("old process delegation retained")
	}
}
