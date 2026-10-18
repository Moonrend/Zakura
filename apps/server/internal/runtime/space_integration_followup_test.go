package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestSpaceIntegrationInstanceLifecyclePatchAndPolicyDispatch(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "followup")
	var initialized, calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		result := map[string]any{}
		switch req.Method {
		case "initialize":
			initialized.Add(1)
			result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}}}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "echo", "inputSchema": map[string]any{"type": "object"}}}}
		case "tools/call":
			calls.Add(1)
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "ok"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}))
	defer upstream.Close()
	r := chi.NewRouter()
	lifecycle := RegisterRoutes(r, d)
	s := httptest.NewServer(r)
	defer s.Close()
	code, out := doJSON(t, s.Client(), "POST", s.URL+"/api/spaces", token, map[string]any{"name": "Empty"})
	if code != 201 {
		t.Fatal(code, out)
	}
	space := out["id"].(string)
	code, out = doJSON(t, s.Client(), "POST", s.URL+"/api/instances", token, map[string]any{"spaceId": space, "providerId": "test-http", "name": "HTTP", "config": map[string]any{"url": upstream.URL, "transport": "http", "headers": map[string]any{"X-Key": "secret-one"}}})
	if code != 201 {
		t.Fatal(code, out)
	}
	id := out["id"].(string)
	if initialized.Load() != 0 || out["status"] != "stopped" {
		t.Fatal("create fabricated readiness", out)
	}
	if e := lifecycle.Start(context.Background(), "followup", id); e != nil {
		t.Fatal(e)
	}
	if initialized.Load() != 1 {
		t.Fatal("existing handler failed real initialize")
	}
	code, out = doJSON(t, s.Client(), "PATCH", s.URL+"/api/instances/"+id, token, map[string]any{"config": map[string]any{"token": "secret-two", "timeoutMs": 4000}})
	if code != 200 {
		t.Fatal(code, out)
	}
	encoded, _ := json.Marshal(out)
	if strings.Contains(string(encoded), "secret-one") || strings.Contains(string(encoded), "secret-two") {
		t.Fatal("PATCH response leaked secrets", string(encoded))
	}
	var cfg, secrets string
	_ = d.DB.QueryRow(`SELECT config_json,secret_json FROM component_instances WHERE id=?`, id).Scan(&cfg, &secrets)
	if strings.Contains(cfg, "secret-one") || strings.Contains(cfg, "secret-two") || strings.Contains(secrets, "secret-two") {
		t.Fatal("PATCH stored plaintext", cfg, secrets)
	}
	code, out = doJSON(t, s.Client(), "POST", s.URL+"/api/agents", token, map[string]any{"spaceId": space, "name": "Reply"})
	if code != 201 {
		t.Fatal(code, out)
	}
	agent := out["id"].(string)
	h := &handler{deps: d, store: NewStore(d), hub: newRunnerHub(d), mcpSessions: map[string]spaceMCPSession{}}
	h.service = NewService(h.store)
	ctx := httpx.WithPrincipal(context.Background(), httpx.Principal{TenantID: "followup", UserID: "owner"})
	if _, e := h.dispatchAgentTool(ctx, "followup", agent, "", "", id+":echo", json.RawMessage(`{}`)); e != nil {
		t.Fatal(e)
	}
	if calls.Load() != 1 {
		t.Fatal("dispatch did not reach MCP")
	}
	if _, e := d.DB.Exec(`DELETE FROM agent_bindings WHERE instance_id=?`, id); e != nil {
		t.Fatal(e)
	}
	if _, e := h.dispatchAgentTool(ctx, "followup", agent, "", "", id+":echo", json.RawMessage(`{}`)); e == nil {
		t.Fatal("unbound cached/qualified dispatch bypassed authorization")
	}
	if calls.Load() != 1 {
		t.Fatal("revoked dispatch still called upstream")
	}
	if e := lifecycle.Stop(context.Background(), "followup", id); e != nil {
		t.Fatal(e)
	}
	if e := lifecycle.Delete(context.Background(), "followup", id); e != nil {
		t.Fatal(e)
	}
	var count int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM component_instances WHERE id=?`, id).Scan(&count)
	if count != 0 {
		t.Fatal("lifecycle delete did not remove instance")
	}
}
