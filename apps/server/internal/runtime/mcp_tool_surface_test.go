// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func TestMCPCompactDiscoveryExecuteAndPinning(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	h.service = NewService(h.store)
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "Tools"})
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcEnvelope
		_ = json.NewDecoder(r.Body).Decode(&req)
		var result any = map[string]any{}
		if req.Method == "tools/list" {
			tools := []map[string]any{}
			start, end := 0, 50
			params, _ := req.Params.(map[string]any)
			if params["cursor"] == "second" {
				start, end = 50, 100
			}
			for i := start; i < end; i++ {
				tools = append(tools, map[string]any{"name": fmt.Sprintf("issue_%02d", i), "description": "Search issues", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string"}}}})
			}
			page := map[string]any{"tools": tools}
			if start == 0 {
				page["nextCursor"] = "second"
			}
			result = page
		}
		if req.Method == "tools/call" {
			calls.Add(1)
			result = map[string]any{"isError": true, "structuredContent": map[string]any{"reason": "fixture"}, "content": []map[string]any{{"type": "text", "text": "fixture"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}))
	defer upstream.Close()
	insertMCPInstance(t, d, "many", "tenant", nil, "issues", "Issue tracker", map[string]any{"url": upstream.URL, "description": "Find and manage project issues", "toolExposure": map[string]any{"issue_00": "direct", "issue_99": "hidden"}})
	insertMCPBinding(t, d, "binding", "tenant", space.ID, "many")
	p := httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: space.ID, APIKeyScopes: `["mcp"]`}
	sid := ""
	invoke := func(method, name string, args any, expanded bool) map[string]any {
		t.Helper()
		body, _ := json.Marshal(rpcEnvelope{JSONRPC: "2.0", ID: 1, Method: method, Params: map[string]any{"name": name, "arguments": args}})
		path := "/mcp/spaces/" + space.Slug
		if expanded {
			path += "?tools=expanded"
		}
		r := httptest.NewRequest("POST", path, bytes.NewReader(body))
		r = r.WithContext(httpx.WithPrincipal(r.Context(), p))
		if sid != "" {
			r.Header.Set("Mcp-Session-Id", sid)
		}
		w := httptest.NewRecorder()
		h.mcpServer(w, r)
		if w.Code != 200 {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
		if method == "initialize" {
			sid = w.Header().Get("Mcp-Session-Id")
		}
		var response map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response
	}
	invoke("initialize", "", nil, false)
	listed := invoke("tools/list", "", nil, false)["result"].(map[string]any)["tools"].([]any)
	native, err := h.mcpBuiltinTools(context.Background(), p, space.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != len(native)+3 {
		t.Fatalf("100 upstream tools should add only 2 entry points + 1 pinned to native tools: %#v", listed)
	}
	names := map[string]bool{}
	for _, tool := range listed {
		names[tool.(map[string]any)["name"].(string)] = true
	}
	for _, name := range []string{"mcp__issues__issue_00", "list_computers", "computer_screenshot", "memory_search", "memory_remember", "list_skills", "read_skill"} {
		if !names[name] {
			t.Fatalf("always-listed tool missing: %s", name)
		}
	}
	if !strings.Contains(listed[0].(map[string]any)["description"].(string), "manage project issues") {
		t.Fatal("no discovery hints")
	}
	search := invoke("tools/call", "tool_search", map[string]any{"names": []string{"mcp__issues__issue_51"}}, false)
	found := search["result"].(map[string]any)["structuredContent"].(map[string]any)["tools"].([]any)
	if len(found) != 1 || found[0].(map[string]any)["inputSchema"] == nil {
		t.Fatalf("schema missing: %#v", search)
	}
	for _, name := range []string{"mcp__issues__issue_51", "tool_execute"} {
		var args any = map[string]any{"query": 42}
		if name == "tool_execute" {
			args = map[string]any{"name": "mcp__issues__issue_51", "arguments": args}
		}
		if got := invoke("tools/call", name, args, false); got["error"] == nil {
			t.Fatalf("invalid MCP arguments accepted: %#v", got)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid arguments reached upstream")
	}
	call := map[string]any{"name": "mcp__issues__issue_51", "arguments": map[string]any{"query": "bug"}}
	result := invoke("tools/call", "tool_execute", call, false)["result"].(map[string]any)
	if result["isError"] != true || result["structuredContent"] == nil || calls.Load() != 1 {
		t.Fatalf("MCP result lost: %#v", result)
	}
	if got := invoke("tools/call", "issues__issue_99", map[string]any{}, false); got["error"] == nil {
		t.Fatal("hidden tool callable through legacy name")
	}
	if calls.Load() != 1 {
		t.Fatal("hidden tool executed")
	}
	expanded := invoke("tools/list", "", nil, true)["result"].(map[string]any)["tools"].([]any)
	if len(expanded) != len(native)+99 {
		t.Fatalf("expanded includes hidden: %d", len(expanded))
	}
	now := d.Clock()
	if _, err := d.DB.Exec(`INSERT INTO mcp_policies(id,tenant_id,space_id,name,policy_json,created_at,updated_at) VALUES('deny','tenant',?,'deny','{"toolDenylist":["issue_51"]}',?,?)`, space.ID, now, now); err != nil {
		t.Fatal(err)
	}
	if got := invoke("tools/call", "tool_execute", call, false); got["error"] == nil {
		t.Fatal("discovery bypassed new policy")
	}
	if calls.Load() != 1 {
		t.Fatal("denied tool executed")
	}
}
