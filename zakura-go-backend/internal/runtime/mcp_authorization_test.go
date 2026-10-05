// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

func TestMCPAgentAuthorizationAndScopes(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request rpcEnvelope
		_ = json.NewDecoder(r.Body).Decode(&request)
		result := any(map[string]any{})
		switch request.Method {
		case "tools/list":
			result = map[string]any{"tools": []map[string]any{{"name": "echo", "description": "echo", "inputSchema": map[string]any{"type": "object"}}}}
		case "tools/call":
			result = map[string]any{"content": []map[string]any{{"type": "text", "text": "ok"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}))
	defer upstream.Close()
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	a, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Alpha", SpaceID: space.ID})
	b, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Beta", SpaceID: space.ID})
	now := d.Clock()
	for _, item := range []struct{ id, ref, agent string }{{"inst-a", "alpha-tools", a.ID}, {"inst-b", "beta-tools", b.ID}} {
		config, _ := json.Marshal(map[string]any{"url": upstream.URL})
		_, err = d.DB.Exec(`INSERT INTO component_instances(id,tenant_id,component_type,component_ref,name,config_json,secret_json,status,created_at,updated_at) VALUES(?,?,'mcp',?,?,?,'{}','ready',?,?)`, item.id, "tenant", item.ref, item.ref, string(config), now, now)
		if err != nil {
			t.Fatal(err)
		}
		_, err = d.DB.Exec(`INSERT INTO agent_bindings(id,tenant_id,space_id,agent_id,instance_id,created_at) VALUES(?,?,?,?,?,?)`, d.NewID(), "tenant", space.ID, item.agent, item.id, now)
		if err != nil {
			t.Fatal(err)
		}
	}
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	h.hub = newRunnerHub(d)

	call := func(p httpx.Principal, path, method, name string) (int, map[string]any) {
		do := func(callMethod string, params map[string]any, sid string) (int, map[string]any, string) {
			body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": callMethod, "params": params})
			req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
			if sid != "" {
				req.Header.Set("Mcp-Session-Id", sid)
			}
			req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
			recorder := httptest.NewRecorder()
			h.mcpServer(recorder, req)
			var response map[string]any
			_ = json.Unmarshal(recorder.Body.Bytes(), &response)
			return recorder.Code, response, recorder.Header().Get("Mcp-Session-Id")
		}
		code, init, sid := do("initialize", map[string]any{"protocolVersion": "2025-06-18"}, "")
		if code != http.StatusOK {
			return code, init
		}
		params := map[string]any{}
		if name != "" {
			params = map[string]any{"name": name, "arguments": map[string]any{}}
		}
		code, response, _ := do(method, params, sid)
		return code, response
	}
	principals := []httpx.Principal{
		{TenantID: "tenant", APIKey: true, AgentID: a.ID, APIKeyScopes: `["mcp"]`},
		{TenantID: "tenant", OAuth: true, AgentID: a.ID, OAuthScope: "mcp"},
	}
	for _, p := range principals {
		code, listed := call(p, "/mcp/agents/"+a.Slug, "tools/list", "")
		result := listed["result"].(map[string]any)
		tools := result["tools"].([]any)
		if code != 200 || len(tools) != 1 || tools[0].(map[string]any)["name"] != "re_alpha-tools__echo" {
			t.Fatalf("agent-scoped tools (%+v): %d %#v", p, code, listed)
		}
		code, denied := call(p, "/mcp/agents/"+a.Slug, "tools/call", "inst-b:echo")
		if code != 200 || denied["error"] == nil {
			t.Fatalf("cross-agent tool call was not denied (%+v): %d %#v", p, code, denied)
		}
		code, mismatch := call(p, "/mcp/agents/"+b.Slug, "tools/list", "")
		if code != http.StatusForbidden || mismatch["error"] == nil {
			t.Fatalf("claim/path mismatch (%+v): %d %#v", p, code, mismatch)
		}
	}
	code, denied := call(httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: a.ID, APIKeyScopes: `["gateway"]`}, "/mcp/agents/"+a.Slug, "tools/list", "")
	if code != http.StatusForbidden || denied["error"] != "insufficient_scope" {
		t.Fatalf("MCP scope enforcement: %d %#v", code, denied)
	}
}

func TestGatewayRequiresBoundScopedAPIKey(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	h.service = NewService(h.store)
	request := func(p httpx.Principal) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
		req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
		response := httptest.NewRecorder()
		h.listGatewayModels(response, req)
		var body map[string]any
		_ = json.Unmarshal(response.Body.Bytes(), &body)
		return response.Code, body
	}
	for _, principal := range []httpx.Principal{
		{TenantID: "tenant", Role: "owner"},
		{TenantID: "tenant", APIKey: true, APIKeyScopes: `["*"]`},
		{TenantID: "tenant", APIKey: true, AgentID: "agent", APIKeyScopes: `["mcp"]`},
	} {
		if code, body := request(principal); code != http.StatusForbidden || body["error"] == nil {
			t.Fatalf("gateway principal should be denied (%+v): %d %#v", principal, code, body)
		}
	}
	if code, body := request(httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: "agent", APIKeyScopes: `["gateway:models"]`}); code != http.StatusOK || body["object"] != "list" {
		t.Fatalf("scoped gateway key: %d %#v", code, body)
	}
}

func TestGeneralAPIDeniesCapabilityOnlyKey(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	raw := "zak_scope-limited"
	hash := sha256.Sum256([]byte(raw))
	_, err := d.DB.Exec(`INSERT INTO api_keys(id,tenant_id,name,key_prefix,key_hash,scopes,created_at) VALUES('limited','tenant','limited','zak_s',?, '["mcp"]',?)`, hex.EncodeToString(hash[:]), d.Clock())
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	code, body := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agents", raw, nil)
	if code != http.StatusForbidden || body["error"] != "insufficient_scope" {
		t.Fatalf("limited key escaped API scope: %d %#v", code, body)
	}
}
