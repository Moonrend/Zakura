package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func TestWorkspaceInstanceShellNeverFollowsReplacement(t *testing.T) {
	rig := newWorkspaceProxyRig(t)
	ctx := context.Background()
	a, err := rig.h.store.CreateAgent(ctx, "tenant", Agent{Name: "Shell", SpaceID: rig.space.ID})
	if err != nil {
		t.Fatal(err)
	}
	old := attachProxyWorkspace(t, rig, "shell-old", "shell-instance-old")
	chat, err := rig.h.store.CreateSession(ctx, "tenant", "", a.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	run, err := rig.h.store.StartRun(ctx, "tenant", a.ID, chat.ID, "shell", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	runCtx := context.WithValue(ctx, computerRunKey{}, run.ID)
	exec, err := rig.h.resolveExecutionGuard(runCtx, "tenant", a.ID, chat.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	pinned := context.WithValue(runCtx, computerExecKey{}, exec)
	call := func(ctx context.Context, mode string) (map[string]any, error) {
		return rig.h.runtimeExecWithModeTimeout(ctx, "tenant", a.ID, mode, 10000, "printf", "workspace output")
	}
	for _, admitted := range []context.Context{ctx, pinned} {
		result, err := call(admitted, "")
		if err != nil || result["stdout"] != "workspace output" || result["executionMode"] != "workspace-container" {
			t.Fatalf("shell dispatch: %+v %v", result, err)
		}
	}
	if _, err := call(pinned, "sandbox"); err == nil {
		t.Fatal("restricted request was downgraded")
	}
	if _, err := rig.h.workspaceStore().Retire(ctx, old.Target, "retire-shell", "cleanup-shell", false, rig.h.store.now()); err != nil {
		t.Fatal(err)
	}
	current := attachProxyWorkspace(t, rig, "shell-new", "shell-instance-new")
	for _, admitted := range []context.Context{runCtx, pinned} {
		if _, err := call(admitted, ""); !errors.Is(err, workspaces.ErrTargetRevoked) {
			t.Fatalf("old shell followed replacement: %v", err)
		}
	}
	if _, err := call(ctx, ""); err != nil {
		t.Fatal(err)
	}
	rig.mu.Lock()
	defer rig.mu.Unlock()
	var targets []protocol.Target
	for _, call := range rig.calls {
		if call.method == "docker.exec" {
			var binding protocol.Binding
			raw, _ := json.Marshal(call.params["workspace"])
			if json.Unmarshal(raw, &binding) != nil || binding.Validate() != nil || call.params["id"] != "canonical-container" {
				t.Fatalf("unbound shell effect: %+v", call)
			}
			targets = append(targets, binding.Target)
		}
	}
	if len(targets) != 3 || targets[0] != old.Target || targets[1] != old.Target || targets[2] != current.Target {
		t.Fatalf("shell targets: %+v", targets)
	}
}
