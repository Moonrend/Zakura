// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func TestMCPNativeToolsUseSpaceWithoutHostAgent(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "Native", RuntimeNodeID: &node, WorkspaceKind: "host", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	var executions atomic.Int32
	h := codemodeToolHarness(t, d, "rnr_native_tools", func(method string, params map[string]any, _ func(string, string, any)) (any, func()) {
		switch method {
		case "sys.info":
			return codemodeInfo(), nil
		case "sandbox.policy":
			return map[string]any{"enforced": false}, nil
		case "host.exec", "host.fs.read":
			if params["spaceId"] != space.ID {
				return fmt.Errorf("wrong workspace: %#v", params), nil
			}
			executions.Add(1)
			if method == "host.fs.read" {
				return map[string]any{"base64": base64.StdEncoding.EncodeToString([]byte("space file")), "path": "/note.txt"}, nil
			}
			return map[string]any{"exitCode": 0, "stdout": "space command", "stderr": ""}, nil
		}
		return nil, nil
	})
	p := httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: space.ID, APIKeyScopes: `["mcp"]`}
	sid := ""
	invoke := func(method, name string, args any) map[string]any {
		t.Helper()
		body, _ := json.Marshal(rpcEnvelope{JSONRPC: "2.0", ID: 1, Method: method, Params: map[string]any{"name": name, "arguments": args}})
		r := httptest.NewRequest(http.MethodPost, "/mcp/spaces/"+space.Slug, bytes.NewReader(body))
		r = r.WithContext(httpx.WithPrincipal(r.Context(), p))
		if sid != "" {
			r.Header.Set("Mcp-Session-Id", sid)
		}
		w := httptest.NewRecorder()
		h.mcpServer(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
		}
		if method == "initialize" {
			sid = w.Header().Get("Mcp-Session-Id")
		}
		var response map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response["error"] != nil {
			t.Fatalf("RPC error: %#v", response)
		}
		return response["result"].(map[string]any)
	}
	invoke("initialize", "", nil)
	listed := invoke("tools/list", "", nil)["tools"].([]any)
	names := map[string]bool{}
	for _, item := range listed {
		names[item.(map[string]any)["name"].(string)] = true
	}
	for _, name := range []string{"list_computers", "shell_exec", "fs_read", "computer_screenshot", "browser_open", "memory_search", "memory_remember", "list_skills", "read_skill"} {
		if !names[name] {
			t.Fatalf("missing native tool %s", name)
		}
	}
	found := invoke("tools/call", "tool_search", map[string]any{})["structuredContent"].(map[string]any)["tools"].([]any)
	if len(found) != 0 {
		t.Fatal("native tools should not require discovery")
	}
	for _, call := range []struct {
		name string
		args any
	}{
		{"list_computers", map[string]any{}},
		{"shell_exec", map[string]any{"command": "pwd"}},
		{"re_fs_read", map[string]any{"path": "/note.txt"}},
		{"tool_execute", map[string]any{"name": "fs_read", "arguments": map[string]any{"path": "/note.txt"}}},
	} {
		result := invoke("tools/call", call.name, call.args)
		if result["isError"] == true || result["structuredContent"] == nil {
			t.Fatalf("native call %s failed: %#v", call.name, result)
		}
	}
	if executions.Load() != 3 {
		t.Fatalf("workspace calls=%d", executions.Load())
	}
	var agentCount int64
	h.deps.Gorm.Table("agents").Count(&agentCount)
	if agentCount != 0 {
		t.Fatal("native Space calls must not create a host Agent")
	}
	before := executions.Load()
	result := invoke("tools/call", "shell_exec", map[string]any{"command": "pwd", "computerId": "foreign"})
	if result["isError"] != true || executions.Load() != before {
		t.Fatalf("invalid computer fell back to Space: %#v", result)
	}
	var logged int64
	if err := h.deps.Gorm.Table("tool_call_logs").Where("space_id=? AND provider_id='zakura'", space.ID).Count(&logged).Error; err != nil || logged < 5 {
		t.Fatalf("native audit missing: %d %v", logged, err)
	}
}

func TestMCPNativeMemorySkillsAndPolicyScopes(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	h := &handler{deps: d, store: NewStore(d)}
	h.service = NewService(h.store)
	space, _ := h.store.CreateSpace(ctx, "tenant", Space{Name: "Here"})
	other, _ := h.store.CreateSpace(ctx, "tenant", Space{Name: "Elsewhere"})
	a, _ := h.store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID, EnableMemory: true})
	b, _ := h.store.CreateAgent(ctx, "tenant", Agent{Name: "B", SpaceID: other.ID, EnableMemory: true})
	p := httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: space.ID, APIKeyScopes: `["mcp"]`}
	request := httptest.NewRequest(http.MethodPost, "/mcp/spaces/"+space.Slug, nil)
	call := func(principal httpx.Principal, name string, args any) (json.RawMessage, error) {
		r := request.WithContext(httpx.WithPrincipal(ctx, principal))
		return h.callMCPBuiltin(r, principal, space.ID, name, rawJSON(args))
	}
	if _, err := call(p, "memory_remember", map[string]any{"content": "missing owner"}); err == nil {
		t.Fatal("memory silently chose an Agent")
	}
	if _, err := call(p, "memory_remember", map[string]any{"agentId": b.ID, "content": "cross-space"}); err == nil {
		t.Fatal("cross-Space memory allowed")
	}
	if _, err := call(p, "memory_remember", map[string]any{"agentId": a.ID, "content": "native note"}); err != nil {
		t.Fatal(err)
	}
	result, err := call(p, "memory_search", map[string]any{"agentId": a.ID, "query": "native note"})
	if err != nil || !strings.Contains(string(result), "native note") {
		t.Fatalf("memory lookup: %s %v", result, err)
	}
	h.deps.Gorm.Table("agents").Where("id=?", a.ID).Update("enable_memory", false)
	if _, err := call(p, "memory_remember", map[string]any{"agentId": a.ID, "content": "disabled"}); err == nil {
		t.Fatal("disabled memory accepted a write")
	}
	h.deps.Gorm.Table("agents").Where("id=?", a.ID).Updates(map[string]any{"enable_memory": true, "config_json": `{"cloud":{"approvals":{"policy":"allow_all","alwaysDeny":["memory_remember"]}}}`})
	if _, err := call(p, "memory_remember", map[string]any{"agentId": a.ID, "content": "denied"}); err == nil {
		t.Fatal("Agent approval deny bypassed")
	}
	now := runtimeTimeString(h.store.now())
	for i, s := range []Space{space, other} {
		files := []skillFile{{Path: "SKILL.md", Content: "---\nname: guide\ndescription: Space guide\n---\nInstructions for " + s.ID}}
		skill, err := h.registerSkillPackage(ctx, "tenant", skillCachedPackage{Name: fmt.Sprintf("guide-%d", i), Files: files}, json.RawMessage(`{}`), nil)
		if err != nil {
			t.Fatal(err)
		}
		row := spaceSkill{ID: fmt.Sprintf("installed-%d", i), TenantID: "tenant", SpaceID: s.ID, SkillID: skill.ID, Name: "guide", Status: "installed", Path: "/skills/guide", FilesJSON: string(rawJSON(files)), Revision: "1", CreatedAt: now, UpdatedAt: now}
		if err := d.Gorm.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	result, err = call(p, "list_skills", map[string]any{})
	if err != nil || !strings.Contains(string(result), "guide") {
		t.Fatalf("skill list: %s %v", result, err)
	}
	result, err = call(p, "read_skill", map[string]any{"name": "guide"})
	if err != nil || !strings.Contains(string(result), space.ID) || strings.Contains(string(result), other.ID) {
		t.Fatalf("skill scope: %s %v", result, err)
	}
	if _, err := call(p, "read_skill", map[string]any{"name": "guide", "path": "../secret"}); err == nil {
		t.Fatal("skill path escaped installation")
	}
	bound := p
	bound.AgentID = a.ID
	if _, err := call(bound, "read_skill", map[string]any{"name": "guide"}); err == nil {
		t.Fatal("Agent could read an unenabled skill")
	}
	if _, err := d.DB.Exec(`INSERT INTO agent_skills(id,tenant_id,agent_id,skill_id,name,enabled,path,status,created_at,updated_at) SELECT 'agent-guide',tenant_id,?,skill_id,name,true,path,'installed',?,? FROM space_skills WHERE space_id=?`, a.ID, now, now, space.ID); err != nil {
		t.Fatal(err)
	}
	result, err = call(bound, "read_skill", map[string]any{"name": "guide"})
	if err != nil || !strings.Contains(string(result), space.ID) {
		t.Fatalf("enabled Agent skill unavailable: %s %v", result, err)
	}
	result, err = h.dispatchAgentTool(ctx, "tenant", a.ID, "", "skill", "read_skill", json.RawMessage(`{"name":"guide"}`))
	if err != nil || !strings.Contains(string(result), space.ID) {
		t.Fatalf("Agent dispatcher skill unavailable: %s %v", result, err)
	}
	if _, err := d.DB.Exec(`INSERT INTO mcp_policies(id,tenant_id,space_id,name,policy_json,created_at,updated_at) VALUES('native-deny','tenant',?,'deny','{"includeBuiltin":false}',?,?)`, space.ID, now, now); err != nil {
		t.Fatal(err)
	}
	tools, err := h.mcpBuiltinTools(ctx, p, space.ID)
	if err != nil || len(tools) != 0 {
		t.Fatalf("includeBuiltin=false ignored: %v %v", tools, err)
	}
	if _, err := call(p, "list_skills", map[string]any{}); err == nil {
		t.Fatal("previously listed native tool bypassed changed policy")
	}
}

func TestNativeToolDefinitionsAlwaysDirect(t *testing.T) {
	tools := builtinToolDefinitions(Agent{EnableMemory: true}, true, true, defaultPlatformWebToolDefaults())
	for _, tool := range tools {
		if tool.Kind != "builtin" || tool.Exposure != "direct" {
			t.Fatalf("native tool is deferred: %+v", tool)
		}
	}
	if got := discoverTools(tools, nil, toolDiscoveryQuery{}); got.Total != 0 {
		t.Fatal("native tools included in upstream discovery")
	}
	if got := discoverTools(tools, nil, toolDiscoveryQuery{Names: []string{"memory_search"}}); len(got.Tools) != 1 || got.Tools[0].InputSchema == nil {
		t.Fatal("Code Mode cannot describe a native tool")
	}
}
