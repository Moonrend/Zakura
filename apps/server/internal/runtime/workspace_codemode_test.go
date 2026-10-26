package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func TestWorkspaceCodemodeUsesRunInstance(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "Codemode"})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var targets []protocol.Target
	h := codemodeToolHarness(t, d, "rnr_codemode_instance", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
		switch method {
		case "sys.info":
			info := codemodeInfo()
			info["streamOwner"] = "codemode-executor"
			return info, nil
		case "docker.list":
			return []computerContainer{{DockerID: "codemode-container", Status: "running", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace", "zakura.workspace-instance": "codemode-instance"}}}, nil
		}
		var binding protocol.Binding
		raw, _ := json.Marshal(params["workspace"])
		if json.Unmarshal(raw, &binding) != nil || binding.Validate() != nil {
			t.Errorf("missing codemode binding: %s", method)
			return nil, nil
		}
		mu.Lock()
		targets = append(targets, binding.Target)
		mu.Unlock()
		switch method {
		case "host.fs.write":
			return map[string]any{"ok": true}, nil
		case "docker.exec.start":
			return map[string]any{"id": "codemode-stream"}, nil
		case "docker.exec.write":
			return map[string]any{"ok": true}, func() {
				emit("codemode-stream", "stdout", map[string]any{"op": "done", "ok": true, "output": []string{"done"}})
			}
		case "docker.exec.close":
			if params["streamOwner"] != "codemode-executor" {
				t.Error("close omitted executor")
			}
			return map[string]any{"ok": true}, nil
		default:
			t.Errorf("unexpected RPC %s", method)
			return nil, nil
		}
	})
	instance := attachTestWorkspace(t, h, space.ID, "codemode-disk", "codemode-instance")
	a, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	chat, err := h.store.CreateSession(ctx, "tenant", "", a.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	run, err := h.store.StartRun(ctx, "tenant", a.ID, chat.ID, "code", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx = context.WithValue(ctx, computerRunKey{}, run.ID)
	args := json.RawMessage(`{"code":"return 'done'"}`)
	if _, err := h.runCodemodeTool(ctx, "tenant", a.ID, chat.ID, "call", args); err != nil {
		t.Fatal(err)
	}
	if _, err := h.workspaceStore().Retire(ctx, instance.Target, "retire-code", "cleanup-code", false, h.store.now()); err != nil {
		t.Fatal(err)
	}
	attachTestWorkspace(t, h, space.ID, "code-new-disk", "code-new-instance")
	if _, err := h.runCodemodeTool(ctx, "tenant", a.ID, chat.ID, "late", args); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("codemode followed replacement: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(targets) != 4 {
		t.Fatal(fmt.Sprintf("codemode effects: %+v", targets))
	}
	for _, target := range targets {
		if target != instance.Target {
			t.Fatalf("codemode changed target: %+v", target)
		}
	}
}
