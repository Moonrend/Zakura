package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func TestWorkspaceMCPProvisionAndRetiredCleanup(t *testing.T) {
	var requests atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var rpc rpcEnvelope
		_ = json.NewDecoder(r.Body).Decode(&rpc)
		result := map[string]any{"tools": []any{}}
		if rpc.Method == "initialize" {
			result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": rpc.ID, "result": result})
	}))
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)
	port, _ := strconv.Atoi(u.Port())
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "MCP disk"})
	if err != nil {
		t.Fatal(err)
	}
	var binding protocol.Binding
	var mu sync.Mutex
	var effects []protocol.Target
	creates := 0
	h := builtinToolHarness(t, d, "rnr_mcp_disk", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"storageRoot": "/workspace-data", "capabilities": map[string]any{"docker": true}, "hostInfo": map[string]any{"primaryIp": u.Hostname(), "platform": "linux"}}, nil
		case "docker.pull":
			return map[string]any{"ok": true}, nil
		case "workspace.mount":
			return map[string]any{"target": binding.Target, "mount": workspaceMount{VolumeName: "workspace-data", VolumeSubpath: binding.Disk.Locator.RelativePath, ContainerPath: "/workspace", NoCopy: true}}, nil
		}
		var got protocol.Binding
		raw, _ := json.Marshal(params["workspace"])
		if json.Unmarshal(raw, &got) != nil || got != binding {
			t.Errorf("unbound MCP effect %s", method)
		}
		mu.Lock()
		effects = append(effects, got.Target)
		mu.Unlock()
		switch method {
		case "docker.create":
			mount := params["volumes"].([]any)[0].(map[string]any)
			op := params["operation"].(map[string]any)
			if mount["volumeSubpath"] != binding.Disk.Locator.RelativePath+"/.zakura/components/stdio" || mount["containerPath"] != "/data" || mount["noCopy"] != true || op["purpose"] != "component" {
				t.Error("incorrect component mount/receipt")
			}
			mu.Lock()
			creates++
			mu.Unlock()
			return map[string]any{"dockerId": "mcp-container", "name": params["name"], "status": "running", "ports": []map[string]any{{"containerPort": 3100, "hostPort": port, "protocol": "tcp"}}}, nil
		case "docker.inspect":
			return map[string]any{"status": "running"}, nil
		case "docker.stop":
			if params["id"] != "mcp-container" || params["remove"] != true {
				t.Error("MCP cleanup changed container")
			}
			return map[string]any{"ok": true}, nil
		default:
			return nil, errors.New("unexpected RPC " + method)
		}
	})
	h.service = NewService(h.store)
	old := attachTestWorkspace(t, h, space.ID, "mcp-old-disk", "mcp-old-instance")
	exec, err := h.resolveServerComputer(ctx, "tenant", space.ID)
	if err != nil {
		t.Fatal(err)
	}
	binding = *exec.workspace
	a, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "MCP", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	chat, err := h.store.CreateSession(ctx, "tenant", "", a.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	run, err := h.store.StartRun(ctx, "tenant", a.ID, chat.ID, "mcp", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Gorm.Exec(`UPDATE cloud_agent_runs SET status='completed' WHERE id=?`, run.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.Gorm.Exec(`UPDATE cloud_agent_sessions SET active_run_id=NULL WHERE id=?`, chat.ID).Error; err != nil {
		t.Fatal(err)
	}
	insertMCPInstance(t, d, "stdio", "tenant", nil, "stdio", "Stdio", map[string]any{"command": "node", "ownerSpaceId": space.ID})
	insertMCPBinding(t, d, "stdio-binding", "tenant", space.ID, "stdio")
	t.Setenv("ZAKURA_STDIO_BRIDGE_IMAGE", "bridge:test")
	if err := h.startMCPInstance(ctx, "tenant", "stdio"); err != nil {
		t.Fatal(err)
	}
	var instance string
	if err := d.DB.QueryRow(`SELECT workspace_instance_id FROM managed_containers WHERE instance_id='stdio'`).Scan(&instance); err != nil || instance != old.InstanceID {
		t.Fatalf("MCP journal omitted workspace: %s %v", instance, err)
	}
	inst, err := h.getMCPInstance(ctx, "tenant", "stdio")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Target protocol.Target `json:"workspaceTarget"`
	}
	if json.Unmarshal(inst.Config, &config) != nil || config.Target != old.Target {
		t.Fatal("MCP config omitted workspace")
	}
	if _, _, err := h.PatchMCPConfig(ctx, "tenant", "stdio", json.RawMessage(`{"workspaceTarget":null}`)); err == nil {
		t.Fatal("MCP provenance removed through config patch")
	}
	if err := h.startMCPInstance(ctx, "tenant", "stdio"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.workspaceStore().Retire(ctx, old.Target, "mcp-retire", "mcp-clean", false, h.store.now()); err != nil {
		t.Fatal(err)
	}
	current := attachTestWorkspace(t, h, space.ID, "mcp-new-disk", "mcp-new-instance")
	before := requests.Load()
	if _, err := h.mcpRPC(ctx, inst, "tools/list", map[string]any{}); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("retired MCP dispatched: %v", err)
	}
	if requests.Load() != before {
		t.Fatal("retired MCP contacted stale endpoint")
	}
	if err := h.startMCPInstance(ctx, "tenant", "stdio"); err == nil {
		t.Fatal("old MCP followed new workspace")
	}
	if err := h.stopMCPInstance(ctx, "tenant", "stdio"); err != nil {
		t.Fatal(err)
	}
	if err := h.stopMCPInstance(ctx, "tenant", "stdio"); err != nil {
		t.Fatal(err)
	}
	s, err := h.store.GetSpace(ctx, "tenant", space.ID)
	if err != nil || s.CurrentWorkspaceInstanceID == nil || *s.CurrentWorkspaceInstanceID != current.InstanceID {
		t.Fatal("old MCP cleanup changed current workspace")
	}
	replacementConfig, _ := json.Marshal(map[string]any{"url": upstream.URL + "/mcp", "runtimeNodeId": current.NodeID, "workspaceTarget": current.Target})
	replacement := inst
	replacement.Config = replacementConfig
	runCtx := context.WithValue(ctx, computerRunKey{}, run.ID)
	if _, err := h.mcpRPC(runCtx, replacement, "tools/list", map[string]any{}); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("old run followed new MCP: %v", err)
	}
	if requests.Load() != before {
		t.Fatal("old run contacted new MCP endpoint")
	}
	mu.Lock()
	defer mu.Unlock()
	if creates != 1 {
		t.Fatalf("MCP duplicated create: %d", creates)
	}
	for _, target := range effects {
		if target != old.Target {
			t.Fatalf("MCP target drift: %+v", target)
		}
	}
}
