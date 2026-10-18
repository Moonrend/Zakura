// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestACPMCPGatewayCachedAndInFlightCallerFencing(t *testing.T) {
	h, rt, _ := acpMCPFixture(t)
	rt.mcpActor = &httpx.Principal{TenantID: "tenant", APIKey: true, APIKeyID: "key-tenant"}
	acpMCPDescriptor(t, rt)
	key := rt.tenantID + "\x00" + rt.sid
	h.acp.runtimes[key] = rt
	original := *rt.mcpActor
	other := httpx.Principal{TenantID: "tenant", UserID: "acp-user"}
	if _, err := h.acp.ensure(httpx.WithPrincipal(context.Background(), other), rt.tenantID, rt.agentID, rt.sid); err == nil {
		t.Fatal("cached runtime lent key actor's MCP grant to another user")
	}
	if _, err := h.acp.ensure(httpx.WithPrincipal(context.Background(), original), rt.tenantID, rt.agentID, rt.sid); err != nil {
		t.Fatal(err)
	}
	delete(h.acp.runtimes, key)
	done := make(chan struct{})
	close(done)
	h.acp.starting = map[string]*acpRuntimeStart{key: {done: done, rt: rt}}
	if _, err := h.acp.ensure(httpx.WithPrincipal(context.Background(), other), rt.tenantID, rt.agentID, rt.sid); err == nil {
		t.Fatal("in-flight runtime lent key actor's MCP grant")
	}
	if _, err := h.deps.DB.Exec(`UPDATE api_keys SET revoked_at=? WHERE id='key-tenant'`, runtimeTimeString(h.store.now())); err != nil {
		t.Fatal(err)
	}
	if _, err := h.acp.ensure(httpx.WithPrincipal(context.Background(), original), rt.tenantID, rt.agentID, rt.sid); err == nil {
		t.Fatal("revoked original key reused in-flight runtime")
	}
	delete(h.acp.starting, key)
	h.acp.runtimes[key] = rt
	if _, err := h.acp.ensure(context.Background(), rt.tenantID, rt.agentID, rt.sid); err == nil {
		t.Fatal("actorless background borrowed creator after original key revoked")
	}
	rt.revokeMCPGrant()
	if _, err := h.acp.ensure(httpx.WithPrincipal(context.Background(), other), rt.tenantID, rt.agentID, rt.sid); err != nil {
		t.Fatalf("no MCP adapter behavior changed: %v", err)
	}
}

func TestACPMCPGatewayOAuthDeadlineAndCrossSpace(t *testing.T) {
	h, rt, _ := acpMCPFixture(t)
	now := h.store.now()
	h.deps.Clock = func() time.Time { return now }
	deadline := now.Add(time.Minute)
	rt.mcpActor = &httpx.Principal{TenantID: "tenant", UserID: "acp-user", OAuth: true, OAuthScope: "mcp", OAuthExpiresAt: deadline, SpaceID: rt.spaceID, AgentID: rt.agentID}
	_, auth := acpMCPDescriptor(t, rt)
	if !h.acp.mcpGrants[rt.mcpGrantHash].expires.Equal(deadline) {
		t.Fatal("grant extended source OAuth lifetime")
	}
	if w, _ := acpMCPInvoke(t, h, rt, auth, "", "initialize", ""); w.Code != 200 {
		t.Fatalf("valid OAuth delegation failed: %d %s", w.Code, w.Body.String())
	}
	now = deadline
	if w, _ := acpMCPInvoke(t, h, rt, auth, "", "initialize", ""); w.Code != 401 {
		t.Fatal("expired original JWT retained delegated access")
	}
	now = deadline.Add(-30 * time.Second)
	rt.mcpActor.SpaceID = "other-space"
	if _, err := rt.mcpSessionServers(context.Background()); err == nil {
		t.Fatal("OAuth grant escaped bound Space")
	}
	rt.mcpActor.SpaceID = rt.spaceID
	rt.mcpActor.OAuthScope = "openid profile"
	if _, err := rt.mcpSessionServers(context.Background()); err == nil {
		t.Fatal("OAuth capability-free token acquired MCP grant")
	}
}

func acpMCPUser(t *testing.T, h *handler) httpx.Principal {
	t.Helper()
	now := runtimeTimeString(h.store.now())
	if _, err := h.deps.DB.Exec(`INSERT INTO users(id,email,password_hash,status,created_at,updated_at) VALUES('acp-user','acp-user@example.test','unused','active',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := h.deps.DB.Exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES('acp-member','tenant','acp-user','member','active',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	return httpx.Principal{TenantID: "tenant", UserID: "acp-user"}
}
func acpMCPFixture(t *testing.T) (*handler, *acpLiveRuntime, *atomic.Int64) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d), mcpSessions: map[string]spaceMCPSession{}}
	h.service = NewService(h.store)
	h.acp = &acpRuntimeManager{h: h, runtimes: map[string]*acpLiveRuntime{}}
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "MCP"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "tenant", Agent{Name: "Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	actor := acpMCPUser(t, h)
	sess, err := h.store.CreateSession(context.Background(), "tenant", actor.UserID, agent.ID, Session{Kind: "acp"})
	if err != nil {
		t.Fatal(err)
	}
	calls := &atomic.Int64{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcEnvelope
		_ = json.NewDecoder(r.Body).Decode(&req)
		result := any(map[string]any{})
		if req.Method == "tools/list" {
			result = map[string]any{"tools": []map[string]any{{"name": "echo"}}}
		}
		if req.Method == "tools/call" {
			calls.Add(1)
			result = map[string]any{"content": []map[string]any{{"type": "text", "text": "ok"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}))
	t.Cleanup(upstream.Close)
	insertMCPInstance(t, d, "acp-inst", "tenant", nil, "demo", "Demo", map[string]any{"url": upstream.URL})
	insertMCPBinding(t, d, "acp-bind", "tenant", space.ID, "acp-inst")
	rt := &acpLiveRuntime{manager: h.acp, tenantID: "tenant", spaceID: space.ID, agentID: agent.ID, sid: sess.ID, profileID: "codex", processID: "process-1", done: make(chan struct{}), state: map[string]any{}, mcpHTTP: true, mcpActor: &actor}
	return h, rt, calls
}
func acpMCPDescriptor(t *testing.T, rt *acpLiveRuntime) (string, string) {
	t.Helper()
	servers, err := rt.mcpSessionServers(context.Background())
	if err != nil || len(servers) != 1 {
		t.Fatalf("MCP descriptor %#v %v", servers, err)
	}
	server := servers[0].(map[string]any)
	header := server["headers"].([]any)[0].(map[string]any)["value"].(string)
	return server["url"].(string), header
}
func acpMCPInvoke(t *testing.T, h *handler, rt *acpLiveRuntime, auth, session, method, name string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": map[string]any{"name": name, "arguments": map[string]any{}}})
	router := chi.NewRouter()
	router.Handle("/mcp/acp/{sessionId}", http.HandlerFunc(h.acpMCPGateway))
	req := httptest.NewRequest("POST", "/mcp/acp/"+rt.sid, bytes.NewReader(body))
	req.Header.Set("Authorization", auth)
	if session != "" {
		req.Header.Set("Mcp-Session-Id", session)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var response map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &response)
	return w, response
}
func TestACPMCPGatewaySessionNewInjectionAndCloseRevokes(t *testing.T) {
	fake := &fakeACPAdapter{}
	manager, agent, session := acpAuthHarness(t, fake)
	h := manager.h
	h.acp = manager
	actor := acpMCPUser(t, h)
	insertMCPInstance(t, h.deps, "acp-live-inst", "tenant", nil, "demo", "Demo", map[string]any{"url": "http://unused.example"})
	insertMCPBinding(t, h.deps, "acp-live-bind", "tenant", agent.SpaceID, "acp-live-inst")
	var injected atomic.Bool
	fake.onRPC = func(process string, rpc map[string]any, send func(any)) bool {
		if rpc["method"] == "initialize" {
			send(map[string]any{"jsonrpc": "2.0", "id": rpc["id"], "result": map[string]any{"agentCapabilities": map[string]any{"mcpCapabilities": map[string]any{"http": true}}}})
			return true
		}
		if rpc["method"] == "session/new" {
			params, _ := rpc["params"].(map[string]any)
			servers, _ := params["mcpServers"].([]any)
			if len(servers) == 1 {
				server, _ := servers[0].(map[string]any)
				injected.Store(server["type"] == "http" && server["url"] == h.deps.PublicURL+"/mcp/acp/"+session.ID)
			}
		}
		return false
	}
	rt, err := manager.ensure(httpx.WithPrincipal(context.Background(), actor), "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !injected.Load() || rt.mcpGrantHash == "" {
		t.Fatal("session/new did not receive scoped HTTP MCP descriptor")
	}
	rt.close(nil)
	manager.mu.Lock()
	remaining := len(manager.mcpGrants)
	manager.mu.Unlock()
	if remaining != 0 {
		t.Fatal("close retained usable grant")
	}
}

func TestACPMCPGatewaySameHandlerPolicyAuditAndNoSecretPersistence(t *testing.T) {
	h, rt, calls := acpMCPFixture(t)
	url, auth := acpMCPDescriptor(t, rt)
	if url != h.deps.PublicURL+"/mcp/acp/"+rt.sid {
		t.Fatalf("guessed gateway %q", url)
	}
	w, init := acpMCPInvoke(t, h, rt, auth, "", "initialize", "")
	if w.Code != 200 || init["result"] == nil {
		t.Fatalf("initialize %d %#v", w.Code, init)
	}
	session := w.Header().Get("Mcp-Session-Id")
	_, result := acpMCPInvoke(t, h, rt, auth, session, "tools/call", "demo__echo")
	if result["error"] != nil || calls.Load() != 1 {
		t.Fatalf("call %#v count%d", result, calls.Load())
	}
	var actor, agent, space string
	if err := h.deps.DB.QueryRow(`SELECT actor_user_id,agent_id,space_id FROM tool_call_logs WHERE local_name='tools/call'`).Scan(&actor, &agent, &space); err != nil || actor != "acp-user" || agent != rt.agentID || space != rt.spaceID {
		t.Fatalf("audit actor=%q agent=%q space=%q err=%v", actor, agent, space, err)
	}
	now := runtimeTimeString(h.store.now())
	if _, err := h.deps.DB.Exec(`INSERT INTO mcp_policies(id,tenant_id,agent_id,name,policy_json,created_at,updated_at) VALUES('acp-policy','tenant',?,'Deny','{"toolDenylist":["echo"]}',?,?)`, rt.agentID, now, now); err != nil {
		t.Fatal(err)
	}
	_, result = acpMCPInvoke(t, h, rt, auth, session, "tools/call", "demo__echo")
	if result["error"] == nil || calls.Load() != 1 {
		t.Fatal("cached grant bypassed changed Agent policy")
	}
	if err := rt.persistSnapshot(context.Background()); err != nil {
		t.Fatal(err)
	}
	var origin string
	if err := h.deps.DB.QueryRow(`SELECT origin_json FROM cloud_agent_sessions WHERE id=?`, rt.sid).Scan(&origin); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(origin, "acpm_") || strings.Contains(origin, "Authorization") {
		t.Fatalf("grant in origin %s", origin)
	}
	var leaked int
	if err := h.deps.DB.QueryRow(`SELECT COUNT(*) FROM cloud_agent_events WHERE payload_json LIKE '%acpm_%'`).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatal("grant in events")
	}
}
func TestACPMCPGatewayRevalidationRevocationExpiryAndScope(t *testing.T) {
	for _, change := range []string{"membership", "api-key", "key-owner-membership", "scope", "expiry", "runtime", "revoke", "session"} {
		t.Run(change, func(t *testing.T) {
			h, rt, _ := acpMCPFixture(t)
			if change == "api-key" || change == "scope" || change == "key-owner-membership" {
				rt.mcpActor = &httpx.Principal{TenantID: "tenant", APIKey: true, APIKeyID: "key-tenant"}
			}
			if change == "key-owner-membership" {
				if _, err := h.deps.DB.Exec(`UPDATE api_keys SET user_id='acp-user' WHERE id='key-tenant'`); err != nil {
					t.Fatal(err)
				}
			}
			_, auth := acpMCPDescriptor(t, rt)
			switch change {
			case "membership", "key-owner-membership":
				_, _ = h.deps.DB.Exec(`UPDATE tenant_memberships SET status='removed' WHERE user_id='acp-user'`)
			case "api-key":
				_, _ = h.deps.DB.Exec(`UPDATE api_keys SET revoked_at=? WHERE id='key-tenant'`, runtimeTimeString(h.store.now()))
			case "scope":
				_, _ = h.deps.DB.Exec(`UPDATE api_keys SET scopes='["api"]' WHERE id='key-tenant'`)
			case "expiry":
				h.acp.mcpGrants[rt.mcpGrantHash].expires = h.store.now().Add(-time.Second)
			case "runtime":
				close(rt.done)
			case "revoke":
				rt.revokeMCPGrant()
			case "session":
				_, _ = h.deps.DB.Exec(`DELETE FROM cloud_agent_sessions WHERE id=?`, rt.sid)
			}
			w, _ := acpMCPInvoke(t, h, rt, auth, "", "initialize", "")
			if w.Code != 401 || !strings.Contains(w.Body.String(), "reopen") {
				t.Fatalf("invalid grant accepted %d %s", w.Code, w.Body.String())
			}
		})
	}
}
func TestACPMCPGatewayCapabilityAndReliableActor(t *testing.T) {
	h, rt, _ := acpMCPFixture(t)
	rt.mcpHTTP = false
	if _, err := rt.mcpSessionServers(context.Background()); err == nil || !strings.Contains(err.Error(), "HTTP MCP") {
		t.Fatalf("missing capability %v", err)
	}
	rt.mcpHTTP = true
	rt.mcpActor = &httpx.Principal{TenantID: "tenant", UserID: "invalid"}
	if _, err := rt.mcpSessionServers(context.Background()); err == nil {
		t.Fatal("invalid explicit actor borrowed valid session creator")
	}
	rt.mcpActor = nil
	if _, err := rt.mcpSessionServers(context.Background()); err != nil {
		t.Fatalf("verified persisted creator rejected %v", err)
	}
	rt.revokeMCPGrant()
	if _, err := h.deps.DB.Exec(`UPDATE cloud_agent_sessions SET created_by_user_id=NULL WHERE id=?`, rt.sid); err != nil {
		t.Fatal(err)
	}
	if _, err := rt.mcpSessionServers(context.Background()); err == nil {
		t.Fatal("background session invented owner")
	}
	rt.mcpActor = &httpx.Principal{TenantID: "tenant", UserID: "acp-user", OAuth: true}
	if _, err := rt.mcpSessionServers(context.Background()); err == nil || !strings.Contains(err.Error(), "OAuth") {
		t.Fatalf("OAuth lifetime silently extended %v", err)
	}
	if _, err := h.deps.DB.Exec(`DELETE FROM agent_bindings WHERE id='acp-bind'`); err != nil {
		t.Fatal(err)
	}
	rt.mcpHTTP = false
	servers, err := rt.mcpSessionServers(context.Background())
	if err != nil || len(servers) != 0 {
		t.Fatalf("unconfigured old adapter affected %#v %v", servers, err)
	}
}
