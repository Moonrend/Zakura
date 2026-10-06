// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
)

func newFakeMCPTools() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		method, _ := req["method"].(string)
		if method == "tools/list" {
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": map[string]any{"tools": []any{
				map[string]any{"name": "search_issues", "description": "Search issues by query.", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string", "description": "Search text."}}, "required": []any{"query"}}},
				map[string]any{"name": "create_issue", "description": "Create a new issue.", "inputSchema": map[string]any{"properties": map[string]any{"title": map[string]any{"type": "string"}}}},
			}}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": map[string]any{}})
	}))
}

func insertRuntimeNode(t *testing.T, d *appdeps.Dependencies, id, tenant, status string) {
	t.Helper()
	now := d.Clock()
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES(?,?,'Runner','runner','computer',?,'hash','{}','{}','/srv/zakura','{}',false,?,?)`, id, tenant, status, now, now); err != nil {
		t.Fatal(err)
	}
}

func insertMCPInstance(t *testing.T, d *appdeps.Dependencies, id, tenant string, agentID *string, ref, name string, cfg map[string]any) {
	t.Helper()
	now := d.Clock()
	if _, err := d.DB.Exec(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,created_at,updated_at) VALUES(?,?,?,'mcp',?,?,?,'{}','ready',?,?)`, id, tenant, agentID, ref, name, string(raw(cfg)), now, now); err != nil {
		t.Fatal(err)
	}
}

func insertMCPBinding(t *testing.T, d *appdeps.Dependencies, id, tenant, spaceID, instanceID string) {
	t.Helper()
	now := d.Clock()
	if _, err := d.DB.Exec(`INSERT INTO agent_bindings(id,tenant_id,space_id,agent_id,instance_id,created_at) VALUES(?,?,?,NULL,?,?)`, id, tenant, spaceID, instanceID, now); err != nil {
		t.Fatal(err)
	}
}

func catalogByName(catalog agentCatalog) map[string]agentTool {
	out := map[string]agentTool{}
	for _, tool := range catalog.Tools {
		out[tool.Name] = tool
	}
	return out
}

func newFakeMCPExposureTools() *httptest.Server {
	tool := func(name string) map[string]any {
		return map[string]any{"name": name, "description": name, "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}}
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		if method, _ := req["method"].(string); method == "tools/list" {
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": map[string]any{"tools": []any{
				tool("get_issue"), tool("delete_issue"), tool("create_issue"), tool("update_issue"),
			}}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": map[string]any{}})
	}))
}

func newFakeMCPResourceTools() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		method, _ := req["method"].(string)
		params, _ := req["params"].(map[string]any)
		id := req["id"]
		switch method {
		case "tools/list":
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"tools": []any{
				map[string]any{"name": "search", "description": "search", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
			}}})
		case "resources/list":
			if cursor, _ := params["cursor"].(string); cursor == "" {
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
					"resources":  []any{map[string]any{"uri": "docs://a", "name": "A", "description": "first", "mimeType": "text/plain"}},
					"nextCursor": "c2",
				}})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
					"resources": []any{map[string]any{"uri": "docs://b", "name": "B", "mimeType": "text/plain"}},
				}})
			}
		case "resources/templates/list":
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
				"resourceTemplates": []any{map[string]any{"uriTemplate": "docs://{id}", "name": "Doc"}},
			}})
		case "resources/read":
			uri, _ := params["uri"].(string)
			if uri == "docs://blob" {
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
					"contents": []any{map[string]any{"uri": uri, "mimeType": "image/png", "blob": "aGVsbG8="}},
				}})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
				"contents": []any{map[string]any{"uri": uri, "mimeType": "text/plain", "text": "hello"}},
			}})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{}})
		}
	}))
}

func TestToolExposureOf(t *testing.T) {
	config := map[string]any{"exposure": "deferred", "toolExposure": map[string]any{
		"get_issue": "hidden",
		"get_*":     "direct",
		"create_*":  "deferred",
		"*_issue":   "hidden",
	}}
	if got := toolExposureOf(config, "get_issue"); got != "hidden" {
		t.Fatalf("exact name should win over pattern, got %q", got)
	}
	if got := toolExposureOf(config, "get_milestone"); got != "direct" {
		t.Fatalf("pattern should apply, got %q", got)
	}
	if got := toolExposureOf(config, "create_comment"); got != "deferred" {
		t.Fatalf("pattern should apply, got %q", got)
	}
	if got := toolExposureOf(config, "list_issue"); got != "hidden" {
		t.Fatalf("first matching pattern should win, got %q", got)
	}
	if got := toolExposureOf(map[string]any{}, "unknown"); got != "deferred" {
		t.Fatalf("default exposure should be deferred, got %q", got)
	}
	if got := toolExposureOf(map[string]any{"exposure": "hidden"}, "unknown"); got != "hidden" {
		t.Fatalf("instance exposure should apply, got %q", got)
	}
	if got := toolExposureOf(map[string]any{"exposure": "deferred", "toolExposure": map[string]any{"a.b*": "direct"}}, "a.bx"); got != "direct" {
		t.Fatalf("escaped pattern must match literal dot, got %q", got)
	}
	if got := toolExposureOf(map[string]any{"exposure": "deferred", "toolExposure": map[string]any{"a.b*": "direct"}}, "axbx"); got != "deferred" {
		t.Fatalf("regex metacharacters must be escaped, got %q", got)
	}
	if got := toolExposureOf(map[string]any{"exposure": "deferred", "toolExposure": map[string]any{"x+y*": "hidden"}}, "x+yz"); got != "hidden" {
		t.Fatalf("plus must match literally, got %q", got)
	}
}

func TestAgentToolCatalogToolExposureOverrides(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	server := newFakeMCPExposureTools()
	defer server.Close()
	insertMCPInstance(t, d, "mcp-exposure", "tenant", nil, "gh", "GitHub", map[string]any{
		"url":      server.URL,
		"exposure": "deferred",
		"toolExposure": map[string]any{
			"get_*":        "direct",
			"delete_*":     "hidden",
			"create_issue": "deferred",
		},
	})
	insertMCPBinding(t, d, "bind-1", "tenant", space.ID, "mcp-exposure")
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	catalog, err := h.agentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	byName := catalogByName(catalog)
	cases := map[string]string{
		"mcp__gh__get_issue":    "direct",
		"mcp__gh__delete_issue": "hidden",
		"mcp__gh__create_issue": "deferred",
		"mcp__gh__update_issue": "deferred",
	}
	for name, want := range cases {
		tool, ok := byName[name]
		if !ok {
			t.Fatalf("missing %s, got %v", name, catalog.Tools)
		}
		if tool.Exposure != want {
			t.Fatalf("%s exposure = %q, want %q", name, tool.Exposure, want)
		}
	}
}

func TestAgentToolCatalogResourceToolsGate(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	catalog, err := h.agentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"} {
		if _, ok := catalogByName(catalog)[name]; ok {
			t.Fatalf("%s registered without any MCP instance", name)
		}
	}

	server := newFakeMCPResourceTools()
	defer server.Close()
	insertMCPInstance(t, d, "mcp-res", "tenant", nil, "docs", "Docs", map[string]any{"url": server.URL})
	insertMCPBinding(t, d, "bind-1", "tenant", space.ID, "mcp-res")
	catalog, err = h.agentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	byName := catalogByName(catalog)
	for _, name := range []string{"tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"} {
		tool, ok := byName[name]
		if !ok {
			t.Fatalf("%s missing with a searchable MCP instance", name)
		}
		if tool.Kind != "builtin" {
			t.Fatalf("%s kind = %q", name, tool.Kind)
		}
	}
	if byName["list_mcp_resources"].Exposure != "deferred" || byName["read_mcp_resource"].Exposure != "deferred" {
		t.Fatalf("resource tools should be deferred: %+v", byName)
	}
}

func TestListMCPResourcesAggregatesAndPaginates(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	server := newFakeMCPResourceTools()
	defer server.Close()
	insertMCPInstance(t, d, "mcp-res", "tenant", nil, "docs", "Docs", map[string]any{"url": server.URL})
	insertMCPBinding(t, d, "bind-1", "tenant", space.ID, "mcp-res")
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	ctx := context.Background()

	allRaw, err := h.runBuiltinToolResources(ctx, "tenant", agent.ID, "list_mcp_resources", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var all struct {
		Resources  []map[string]any `json:"resources"`
		NextCursor string           `json:"nextCursor"`
	}
	if err := json.Unmarshal(allRaw, &all); err != nil {
		t.Fatal(err)
	}
	if len(all.Resources) != 2 {
		t.Fatalf("expected two pages aggregated, got %#v", all.Resources)
	}
	if all.Resources[0]["server"] != "Docs" || all.Resources[0]["uri"] != "docs://a" || all.Resources[1]["uri"] != "docs://b" {
		t.Fatalf("unexpected aggregation %#v", all.Resources)
	}
	if all.NextCursor != "" {
		t.Fatalf("all-server listing should not carry a cursor, got %q", all.NextCursor)
	}

	firstRaw, err := h.runBuiltinToolResources(ctx, "tenant", agent.ID, "list_mcp_resources", map[string]any{"server": "Docs"})
	if err != nil {
		t.Fatal(err)
	}
	var first struct {
		Resources  []map[string]any `json:"resources"`
		NextCursor string           `json:"nextCursor"`
	}
	if err := json.Unmarshal(firstRaw, &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Resources) != 1 || first.Resources[0]["uri"] != "docs://a" || first.NextCursor != "c2" {
		t.Fatalf("single-page listing = %#v cursor %q", first.Resources, first.NextCursor)
	}

	secondRaw, err := h.runBuiltinToolResources(ctx, "tenant", agent.ID, "list_mcp_resources", map[string]any{"server": "mcp__docs", "cursor": "c2"})
	if err != nil {
		t.Fatal(err)
	}
	var second struct {
		Resources  []map[string]any `json:"resources"`
		NextCursor string           `json:"nextCursor"`
	}
	if err := json.Unmarshal(secondRaw, &second); err != nil {
		t.Fatal(err)
	}
	if len(second.Resources) != 1 || second.Resources[0]["uri"] != "docs://b" || second.NextCursor != "" {
		t.Fatalf("second page = %#v cursor %q", second.Resources, second.NextCursor)
	}
}

func TestListMCPResourceTemplates(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	server := newFakeMCPResourceTools()
	defer server.Close()
	insertMCPInstance(t, d, "mcp-res", "tenant", nil, "docs", "Docs", map[string]any{"url": server.URL})
	insertMCPBinding(t, d, "bind-1", "tenant", space.ID, "mcp-res")
	h := &handler{deps: d, store: store}
	h.service = NewService(store)

	raw, err := h.runBuiltinToolResources(context.Background(), "tenant", agent.ID, "list_mcp_resource_templates", map[string]any{"server": "docs"})
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Templates []map[string]any `json:"templates"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Templates) != 1 || listed.Templates[0]["uriTemplate"] != "docs://{id}" || listed.Templates[0]["server"] != "Docs" {
		t.Fatalf("unexpected templates %#v", listed.Templates)
	}
}

func TestReadMCPResourceTextAndBlob(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	server := newFakeMCPResourceTools()
	defer server.Close()
	insertMCPInstance(t, d, "mcp-res", "tenant", nil, "docs", "Docs", map[string]any{"url": server.URL})
	insertMCPBinding(t, d, "bind-1", "tenant", space.ID, "mcp-res")
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	ctx := context.Background()

	textRaw, err := h.runBuiltinToolResources(ctx, "tenant", agent.ID, "read_mcp_resource", map[string]any{"server": "Docs", "uri": "docs://a"})
	if err != nil {
		t.Fatal(err)
	}
	var text struct {
		Contents []map[string]any `json:"contents"`
	}
	if err := json.Unmarshal(textRaw, &text); err != nil {
		t.Fatal(err)
	}
	if len(text.Contents) != 1 || text.Contents[0]["text"] != "hello" || text.Contents[0]["mimeType"] != "text/plain" {
		t.Fatalf("unexpected text contents %#v", text.Contents)
	}

	blobRaw, err := h.runBuiltinToolResources(ctx, "tenant", agent.ID, "read_mcp_resource", map[string]any{"server": "mcp__docs", "uri": "docs://blob"})
	if err != nil {
		t.Fatal(err)
	}
	var blob struct {
		Contents []map[string]any `json:"contents"`
	}
	if err := json.Unmarshal(blobRaw, &blob); err != nil {
		t.Fatal(err)
	}
	if len(blob.Contents) != 1 || blob.Contents[0]["blob"] != "aGVsbG8=" || blob.Contents[0]["mimeType"] != "image/png" {
		t.Fatalf("unexpected blob contents %#v", blob.Contents)
	}

	if _, err := h.runBuiltinToolResources(ctx, "tenant", agent.ID, "read_mcp_resource", map[string]any{"server": "nope", "uri": "docs://a"}); err == nil {
		t.Fatal("unknown server should error")
	}
}

func TestAgentToolCatalogMCPDeferred(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	server := newFakeMCPTools()
	defer server.Close()
	insertMCPInstance(t, d, "mcp-deferred", "tenant", nil, "gh", "GitHub", map[string]any{"url": server.URL})
	insertMCPBinding(t, d, "bind-1", "tenant", space.ID, "mcp-deferred")
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	catalog, err := h.agentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	byName := catalogByName(catalog)
	search, ok := byName["mcp__gh__search_issues"]
	if !ok {
		t.Fatalf("missing deferred tool, got %v", catalog.Tools)
	}
	if search.Exposure != "deferred" || search.Kind != "mcp" || search.InstanceID != "mcp-deferred" || search.LocalName != "search_issues" || search.ServerName != "GitHub" || search.ServerRef != "gh" {
		t.Fatalf("unexpected tool metadata %+v", search)
	}
	create, ok := byName["mcp__gh__create_issue"]
	if !ok {
		t.Fatalf("missing create tool, got %v", catalog.Tools)
	}
	if create.InputSchema["type"] != "object" {
		t.Fatalf("expected normalized schema type, got %#v", create.InputSchema)
	}
	if _, ok := create.InputSchema["properties"].(map[string]any); !ok {
		t.Fatalf("expected properties map, got %#v", create.InputSchema["properties"])
	}
	if _, ok := byName["memory_search"]; ok {
		t.Fatal("memory_search present without enable_memory")
	}
	if _, ok := byName["fs_list"]; ok {
		t.Fatal("fs_list present without workspace")
	}
	if _, ok := byName["shell_exec"]; ok {
		t.Fatal("shell_exec present without workspace")
	}
	if _, ok := byName["tool_search"]; !ok {
		t.Fatal("tool_search missing while searchable MCP tools exist")
	}
}

func TestAgentToolCatalogMemoryWorkspaceAndDirect(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	insertRuntimeNode(t, d, "node", "tenant", "online")
	node := "node"
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, EnableMemory: true})
	server := newFakeMCPTools()
	defer server.Close()
	insertMCPInstance(t, d, "mcp-direct", "tenant", nil, "gh", "GitHub", map[string]any{"url": server.URL, "exposure": "direct", "description": "GitHub tools"})
	insertMCPBinding(t, d, "bind-1", "tenant", space.ID, "mcp-direct")
	insertMCPInstance(t, d, "mcp-agent", "tenant", &agent.ID, "local", "Local", map[string]any{"url": server.URL})
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	catalog, err := h.agentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	byName := catalogByName(catalog)
	if tool, ok := byName["memory_search"]; !ok || tool.Exposure != "direct" || tool.Kind != "builtin" || tool.LocalName != "memory_search" {
		t.Fatalf("memory_search wrong: %+v", tool)
	}
	if _, ok := byName["memory_remember"]; !ok {
		t.Fatal("memory_remember missing with enable_memory")
	}
	for _, name := range []string{"fs_list", "fs_read", "fs_write", "shell_exec"} {
		if tool, ok := byName[name]; !ok || tool.Exposure != "direct" {
			t.Fatalf("%s wrong: %+v", name, tool)
		}
	}
	direct, ok := byName["mcp__gh__search_issues"]
	if !ok || direct.Exposure != "direct" || direct.ServerDescription != "GitHub tools" {
		t.Fatalf("direct mcp tool wrong: %+v", direct)
	}
	if _, ok := byName["mcp__local__create_issue"]; !ok {
		t.Fatalf("agent-level instance tools missing, got %v", catalog.Tools)
	}
	if _, ok := byName["tool_search"]; !ok {
		t.Fatal("tool_search missing while searchable MCP tools exist")
	}
}

func TestAgentToolCatalogHiddenMCP(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	server := newFakeMCPTools()
	defer server.Close()
	insertMCPInstance(t, d, "mcp-hidden", "tenant", nil, "gh", "GitHub", map[string]any{"url": server.URL, "exposure": "hidden"})
	insertMCPBinding(t, d, "bind-1", "tenant", space.ID, "mcp-hidden")
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	catalog, err := h.agentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	byName := catalogByName(catalog)
	if tool, ok := byName["mcp__gh__search_issues"]; !ok || tool.Exposure != "hidden" {
		t.Fatalf("hidden tool wrong: %+v", tool)
	}
	if _, ok := byName["tool_search"]; ok {
		t.Fatal("tool_search present with only hidden MCP tools")
	}
}

func TestAgentToolCatalogPolicyFiltersMCPTools(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	server := newFakeMCPTools()
	defer server.Close()
	insertMCPInstance(t, d, "mcp-policy", "tenant", nil, "gh", "GitHub", map[string]any{"url": server.URL})
	insertMCPBinding(t, d, "bind-1", "tenant", space.ID, "mcp-policy")
	now := d.Clock()
	if _, err := d.DB.Exec(`INSERT INTO mcp_policies(id,tenant_id,agent_id,space_id,name,policy_json,created_at,updated_at) VALUES('p1','tenant',NULL,?,'default',?,?,?)`, space.ID, `{"toolAllowlist":["search_issues"]}`, now, now); err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	catalog, err := h.agentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	byName := catalogByName(catalog)
	if _, ok := byName["mcp__gh__search_issues"]; !ok {
		t.Fatalf("allowed tool missing, got %v", catalog.Tools)
	}
	if _, ok := byName["mcp__gh__create_issue"]; ok {
		t.Fatal("denied tool still present after allowlist filter")
	}
}

func TestAgentToolMCPModelName(t *testing.T) {
	if got := mcpToolModelName("Ghost Hub", "", "list-repos"); got != "mcp__ghost-hub__list_repos" {
		t.Fatalf("name = %q", got)
	}
	if got := mcpToolModelName("", "Fallback Name", "do_it"); got != "mcp__fallback-name__do_it" {
		t.Fatalf("fallback name = %q", got)
	}
	long := strings.Repeat("x", 80)
	got := mcpToolModelName("server", "Server", long)
	if len(got) > 64 || len(got) != 63 {
		t.Fatalf("truncated name length = %d (%q)", len(got), got)
	}
	if !strings.HasPrefix(got, "mcp__server__xxx") {
		t.Fatalf("truncated name prefix = %q", got)
	}
	if got != mcpToolModelName("server", "Server", long) {
		t.Fatal("truncated name is not deterministic")
	}
}

func TestBM25Tokenize(t *testing.T) {
	got := tokenizeToolText("searchIssues HTTPServer")
	want := []string{"search", "issue", "http", "server"}
	if len(got) != len(want) {
		t.Fatalf("tokenize = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("tokenize = %v want %v", got, want)
		}
	}
	if terms := tokenizeToolText("searches"); len(terms) != 1 || terms[0] != "search" {
		t.Fatalf("stem search = %v", terms)
	}
	if terms := tokenizeToolText("issues"); len(terms) != 1 || terms[0] != "issue" {
		t.Fatalf("stem issue = %v", terms)
	}
	if terms := tokenizeToolText("class"); len(terms) != 1 || terms[0] != "class" {
		t.Fatalf("stem class = %v", terms)
	}
}

func TestBM25RankOrdering(t *testing.T) {
	docs := []toolSearchDoc{
		{Name: "alpha", Text: "alpha create issue tracker"},
		{Name: "beta", Text: "beta search issues full text"},
		{Name: "gamma", Text: "gamma unrelated calendar"},
	}
	matches := bm25Rank("search issues", docs, 10)
	if len(matches) != 2 {
		t.Fatalf("matches = %v", matches)
	}
	if matches[0].Name != "beta" || matches[1].Name != "alpha" {
		t.Fatalf("ranking = %v", matches)
	}
	if len(bm25Rank("the", docs, 10)) != 0 {
		t.Fatal("stop words should not match")
	}
	if len(bm25Rank("search issues", docs, 1)) != 1 {
		t.Fatal("limit not applied")
	}
	if len(bm25Rank("search", docs, 0)) != 0 {
		t.Fatal("non-positive limit should return no matches")
	}
}

func TestToolSearchDeferredCandidates(t *testing.T) {
	catalog := agentCatalog{Tools: []agentTool{
		{Name: "mcp__a__search", Kind: "mcp", Exposure: "deferred", Description: "search things"},
		{Name: "mcp__a__direct", Kind: "mcp", Exposure: "direct", Description: "search direct"},
		{Name: "mcp__a__hidden", Kind: "mcp", Exposure: "hidden", Description: "search hidden"},
		{Name: "mcp__b__search", Kind: "mcp", Exposure: "deferred", Description: "search other"},
	}}
	loaded := map[string]bool{"mcp__b__search": true}
	got := runToolSearch(catalog, loaded, "search", 8)
	if len(got) != 1 || got[0].Name != "mcp__a__search" {
		t.Fatalf("runToolSearch = %+v", got)
	}
	got = runToolSearch(catalog, nil, "search", 1)
	if len(got) != 1 {
		t.Fatalf("limit not applied: %+v", got)
	}
	got = runToolSearch(catalog, nil, "search", 0)
	if len(got) != 2 {
		t.Fatalf("default limit should return both deferred tools: %+v", got)
	}
}
