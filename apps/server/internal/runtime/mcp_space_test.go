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
	"github.com/go-chi/chi/v5"
)

func TestMCPSpaceZeroAgentInstallFailureAndSecrets(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Empty", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	code, out := doJSON(t, server.Client(), "POST", server.URL+"/api/mcp/import-stdio", token, map[string]any{"name": "Local", "command": "npx", "spaceId": space.ID, "env": map[string]string{"PRIVATE": "super-private-value"}})
	if code != 201 || out["started"] != false || out["startError"] == nil {
		t.Fatalf("real start failure: %d %#v", code, out)
	}
	inst := out["instance"].(map[string]any)
	raw, _ := json.Marshal(out)
	if inst["status"] != "error" || strings.Contains(string(raw), "super-private-value") {
		t.Fatalf("failed install leaks/fakes ready: %#v", out)
	}
	id := inst["id"].(string)
	var cfg, sec string
	if err = d.DB.QueryRow("SELECT config_json,secret_json FROM component_instances WHERE id=?", id).Scan(&cfg, &sec); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(cfg, "super-private-value") || strings.Contains(sec, "super-private-value") {
		t.Fatal("credentials not encrypted")
	}
	var config map[string]any
	_ = json.Unmarshal([]byte(cfg), &config)
	if config["ownerSpaceId"] != space.ID || config["serverComputerId"] == nil {
		t.Fatalf("canonical owner missing %s", cfg)
	}
	code, inventory := doJSON(t, server.Client(), "GET", server.URL+"/api/spaces/"+space.ID+"/mcp/inventory", token, nil)
	if code != 200 || len(inventory["instances"].([]any)) != 1 {
		t.Fatalf("zero-Agent inventory: %d %#v", code, inventory)
	}
	code, caps := doJSON(t, server.Client(), "GET", server.URL+"/api/spaces/"+space.ID+"/mcp/capabilities", token, nil)
	if code != 200 || len(caps["tools"].([]any)) != 0 {
		t.Fatalf("zero-Agent capabilities: %d %#v", code, caps)
	}
}

func TestMCPSpaceCeilingDirectOperationsAndAudit(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	other, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "Other", WorkspaceKind: "local"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	sibling, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "B", SpaceID: space.ID})
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcEnvelope
		_ = json.NewDecoder(r.Body).Decode(&req)
		result := any(map[string]any{"ok": true})
		if req.Method == "tools/list" {
			result = map[string]any{"tools": []map[string]any{{"name": "ok"}, {"name": "blocked"}}}
		} else {
			calls.Add(1)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}))
	defer upstream.Close()
	insertMCPInstance(t, d, "inst", "tenant", nil, "demo", "Demo", map[string]any{"url": upstream.URL})
	insertMCPBinding(t, d, "binding", "tenant", space.ID, "inst")
	now := runtimeTimeString(d.Clock())
	for _, row := range []struct {
		id           string
		space, agent any
		policy       string
	}{
		{"space-policy", space.ID, nil, `{"toolAllowlist":["ok"],"resourceAllowlist":["file:///allowed"],"promptAllowlist":["safe"]}`},
		{"agent-policy", nil, agent.ID, `{"toolAllowlist":["ok","blocked"],"resourceAllowlist":["file:///allowed","file:///secret"],"promptAllowlist":["safe","unsafe"]}`},
	} {
		if _, err := d.DB.Exec(`INSERT INTO mcp_policies(id,tenant_id,space_id,agent_id,name,policy_json,created_at,updated_at) VALUES(?,'tenant',?,?,'P',?,?,?)`, row.id, row.space, row.agent, row.policy, now, now); err != nil {
			t.Fatal(err)
		}
	}
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	p := httpx.Principal{TenantID: "tenant", APIKey: true, APIKeyID: "key-tenant", SpaceID: space.ID, AgentID: agent.ID}
	invoke := func(actor httpx.Principal, path string, body map[string]any) int {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest("POST", path, bytes.NewReader(raw))
		r = r.WithContext(httpx.WithPrincipal(r.Context(), actor))
		w := httptest.NewRecorder()
		switch path {
		case "/api/mcp/call":
			h.mcpCall(w, r)
		case "/api/mcp/resources/read":
			h.mcpResource(w, r)
		case "/api/mcp/prompts/get":
			h.mcpPrompt(w, r)
		case "/api/mcp/complete":
			h.mcpComplete(w, r)
		}
		return w.Code
	}
	for _, tc := range []struct {
		path string
		body map[string]any
	}{
		{"/api/mcp/call", map[string]any{"toolName": "blocked"}},
		{"/api/mcp/resources/read", map[string]any{"uri": "file:///secret"}},
		{"/api/mcp/prompts/get", map[string]any{"name": "unsafe"}},
		{"/api/mcp/complete", map[string]any{"params": map[string]any{"ref": map[string]any{"type": "ref/prompt", "name": "unsafe"}}}},
	} {
		tc.body["instanceId"] = "inst"
		tc.body["spaceId"] = space.ID
		if code := invoke(p, tc.path, tc.body); code != 404 {
			t.Fatalf("policy bypass %s: %d", tc.path, code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("denied calls reached upstream")
	}
	instForResource, _ := h.getMCPInstance(context.Background(), "tenant", "inst")
	resourceCtx := httpx.WithPrincipal(context.Background(), p)
	if _, err := h.runReadMCPResource(resourceCtx, "tenant", agent.ID, map[string]any{"server": "Demo", "uri": "file:///secret"}); err == nil {
		t.Fatal("Agent resource runner bypassed Space ceiling")
	}
	if _, err := h.runAgentMCPCall(resourceCtx, "tenant", agent.ID, instForResource, "tools/call", map[string]any{"name": "blocked"}); err == nil {
		t.Fatal("cached Agent tool bypassed live policy")
	}
	if calls.Load() != 0 {
		t.Fatal("Agent denied calls reached upstream")
	}
	if code := invoke(p, "/api/mcp/call", map[string]any{"instanceId": "inst", "spaceId": other.ID, "toolName": "ok"}); code != 404 {
		t.Fatal("Space-bound key escaped")
	}
	if code := invoke(p, "/api/mcp/call", map[string]any{"instanceId": "inst", "spaceId": space.ID, "agentId": sibling.ID, "toolName": "ok"}); code != 404 {
		t.Fatal("Agent-bound key escaped to sibling")
	}
	if code := invoke(p, "/api/mcp/call", map[string]any{"instanceId": "inst", "spaceId": space.ID, "toolName": "ok"}); code != 200 {
		t.Fatalf("allowed direct call: %d", code)
	}
	var key, actualSpace, actualAgent string
	if err := d.DB.QueryRow(`SELECT api_key_id,space_id,agent_id FROM tool_call_logs WHERE is_error=FALSE`).Scan(&key, &actualSpace, &actualAgent); err != nil || key != p.APIKeyID || actualSpace != space.ID || actualAgent != agent.ID {
		t.Fatalf("actor audit %s %s %s %v", key, actualSpace, actualAgent, err)
	}
	tools := h.agentMCPCatalogTools(context.Background(), "tenant", agent.ID, space.ID)
	if len(tools) != 1 || tools[0].LocalName != "ok" {
		t.Fatalf("Agent widened Space ceiling: %#v", tools)
	}
}

func TestMCPStdioStartRejectsWorkspaceMigrationLease(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	insertMCPInstance(t, d, "stdio", "tenant", nil, "stdio", "Stdio", map[string]any{"command": "npx", "ownerSpaceId": space.ID})
	insertMCPBinding(t, d, "stdio-binding", "tenant", space.ID, "stdio")
	h := &handler{deps: d, store: store}
	lease, err := h.acquireSpaceWorkspace(context.Background(), "tenant", space.ID, "migrating", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.release()
	if err = h.startMCPInstance(context.Background(), "tenant", "stdio"); err == nil || !strings.Contains(err.Error(), "migrating") {
		t.Fatalf("stdio start ignored migration lease: %v", err)
	}
	var token string
	if err = d.DB.QueryRow("SELECT token FROM computer_workspace_leases WHERE space_id=?", space.ID).Scan(&token); err != nil || token != lease.Token {
		t.Fatalf("stdio start replaced migration lease: %q %v", token, err)
	}
}

func TestMCPStdioCreationLeaseAndUncertainCleanup(t *testing.T) {
	for _, outcome := range []string{"create-error", "missing-id", "cleanup-error", "cleaned"} {
		t.Run(outcome, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			store := NewStore(d)
			node := "node"
			space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
			if err != nil {
				t.Fatal(err)
			}
			insertMCPInstance(t, d, "stdio", "tenant", nil, "stdio", "Stdio", map[string]any{"command": "npx", "ownerSpaceId": space.ID})
			insertMCPBinding(t, d, "stdio-binding", "tenant", space.ID, "stdio")
			var sawLease atomic.Bool
			h := builtinToolHarness(t, d, "rnr_mcp_lease", func(method string, params map[string]any) (any, error) {
				switch method {
				case "sys.info":
					return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"docker": true}, "hostInfo": map[string]any{"primaryIp": "127.0.0.1", "platform": "linux"}}, nil
				case "docker.pull":
					return map[string]any{"ok": true}, nil
				case "host.fs.mkdir":
					return map[string]any{"abs": "/srv/zakura/data"}, nil
				case "docker.create":
					var operation string
					if e := d.DB.QueryRow("SELECT operation FROM computer_workspace_leases WHERE space_id=?", space.ID).Scan(&operation); e != nil || operation != "configuring" {
						return nil, fmt.Errorf("missing creation lease: %s %v", operation, e)
					}
					if other, e := (&handler{deps: d, store: store}).acquireSpaceWorkspace(context.Background(), "tenant", space.ID, "migrating", false, nil); e == nil {
						other.release()
						return nil, fmt.Errorf("migration acquired lease during stdio create")
					}
					sawLease.Store(true)
					if outcome == "create-error" {
						return nil, fmt.Errorf("remote create outcome unknown")
					}
					if outcome == "missing-id" {
						return map[string]any{}, nil
					}
					return map[string]any{"dockerId": "created", "name": "stdio", "status": "running"}, nil
				case "docker.inspect":
					return map[string]any{"status": "running"}, nil
				case "docker.stop":
					if outcome == "cleanup-error" {
						return nil, fmt.Errorf("remote cleanup outcome unknown")
					}
					return map[string]any{"ok": true}, nil
				default:
					return nil, fmt.Errorf("unexpected runner method %s", method)
				}
			})
			t.Setenv("ZAKURA_STDIO_BRIDGE_IMAGE", "bridge:test")
			if err = h.startMCPInstance(context.Background(), "tenant", "stdio"); err == nil {
				t.Fatal("failed stdio creation claimed success")
			}
			if !sawLease.Load() {
				t.Fatalf("create was not fenced by lease: %v", err)
			}
			var count int
			if err = d.DB.QueryRow("SELECT COUNT(*) FROM computer_workspace_leases WHERE space_id=?", space.ID).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if outcome == "cleaned" {
				if count != 0 {
					t.Fatal("verified cleanup retained lease")
				}
			} else if count != 1 {
				t.Fatal("uncertain process released lease")
			}
			var status string
			if err = d.DB.QueryRow("SELECT status FROM component_instances WHERE id='stdio'").Scan(&status); err != nil || status != "error" {
				t.Fatalf("failed start status: %s %v", status, err)
			}
		})
	}
}

func TestMCPStoreSharesProvisioningAndLegacyOwnership(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	other, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "Other", WorkspaceKind: "local"})
	now := runtimeTimeString(d.Clock())
	if _, err := d.DB.Exec(`INSERT INTO store_catalog_entries(id,tenant_id,source_id,kind,ref,name,description,meta_json,updated_at) VALUES('entry','tenant','source','mcp','demo','Demo','',?,?)`, `{"command":"npx","args":["-y","demo"],"env":{"TOKEN":"hidden"}}`, now); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	code, out := doJSON(t, server.Client(), "POST", server.URL+"/api/mcp/store/install", token, map[string]any{"id": "entry", "spaceId": space.ID})
	if code != 201 || out["started"] != false || out["startError"] == nil {
		t.Fatalf("store fake ready %d %#v", code, out)
	}
	inst := out["instance"].(map[string]any)
	id := inst["id"].(string)
	h := &handler{deps: d, store: store}
	if err := h.ValidateMCPBinding(context.Background(), "tenant", other.ID, id); err == nil {
		t.Fatal("cross-owner stdio binding accepted")
	}
	insertMCPBinding(t, d, "conflict", "tenant", other.ID, id)
	if err := h.startMCPInstance(context.Background(), "tenant", id); err == nil || !strings.Contains(err.Error(), "multiple owning") {
		t.Fatalf("legacy ownership conflict hidden: %v", err)
	}
	raw := json.RawMessage(`{"env":{"TOKEN":"new-hidden"},"description":"changed"}`)
	cfg, secret, err := h.PatchMCPConfig(context.Background(), "tenant", id, raw)
	if err != nil || strings.Contains(cfg, "new-hidden") || strings.Contains(secret, "new-hidden") {
		t.Fatalf("encrypted patch %s %s %v", cfg, secret, err)
	}
	if _, _, err = h.PatchMCPConfig(context.Background(), "tenant", id, json.RawMessage(`{"ownerSpaceId":"other"}`)); err == nil {
		t.Fatal("owner changed via generic config patch")
	}
}
