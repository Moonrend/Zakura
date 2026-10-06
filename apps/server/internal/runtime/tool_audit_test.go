// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestToolCallAuditFrontendContract(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	now := d.Clock()
	for i, failed := range []bool{false, true} {
		_, err = d.DB.Exec(`INSERT INTO tool_call_logs(id,tenant_id,agent_id,qualified_name,local_name,provider_id,args_json,result_json,is_error,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, d.NewID(), "tenant", agent.ID, "re_demo__echo", "echo", "demo", `{"n":1}`, `"ok"`, failed, 10+i, now)
		if err != nil {
			t.Fatal(err)
		}
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	code, listed := doJSON(t, server.Client(), "GET", server.URL+"/api/tool-calls?agentId="+agent.ID+"&q=echo&limit=1&offset=1", token, nil)
	if code != 200 || listed["total"] != float64(2) || len(listed["items"].([]any)) != 1 {
		t.Fatalf("list contract: %d %#v", code, listed)
	}
	item := listed["items"].([]any)[0].(map[string]any)
	if item["agentName"] != "A" || item["agentSlug"] == nil || item["argsJson"] != `{"n":1}` {
		t.Fatalf("enriched audit item: %#v", item)
	}
	code, detail := doJSON(t, server.Client(), "GET", server.URL+"/api/tool-calls/"+item["id"].(string), token, nil)
	if code != 200 || detail["id"] != item["id"] || detail["item"] != nil {
		t.Fatalf("flat detail contract: %d %#v", code, detail)
	}
	code, stats := doJSON(t, server.Client(), "GET", server.URL+"/api/agents/"+agent.ID+"/tool-calls/stats", token, nil)
	if code != 200 || stats["total"] != float64(2) || stats["errors"] != float64(1) || stats["last24h"] != float64(2) || len(stats["byTool"].([]any)) != 1 {
		t.Fatalf("stats contract: %d %#v", code, stats)
	}
	code, _ = doJSON(t, server.Client(), "GET", server.URL+"/api/agents/missing/tool-calls", token, nil)
	if code != 404 {
		t.Fatalf("missing agent list status: %d", code)
	}
}
