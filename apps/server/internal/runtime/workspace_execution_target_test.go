package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func attachTestWorkspace(t *testing.T, h *handler, space, diskID, instanceID string) workspaces.Instance {
	t.Helper()
	ctx := context.Background()
	if _, err := h.deps.DB.Exec(`UPDATE runtime_nodes SET incarnation='incarnation' WHERE id='node'`); err != nil {
		t.Fatal(err)
	}
	disk, err := h.workspaceStore().RegisterDisk(ctx, "tenant", space, diskID, diskID, "node", "incarnation", h.store.now())
	if err != nil {
		t.Fatal(err)
	}
	if err := h.workspaceStore().VerifyDisk(ctx, disk, 0, h.store.now()); err != nil {
		t.Fatal(err)
	}
	lease, err := h.acquireSpaceWorkspace(ctx, "tenant", space, "configuring", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	instance, err := h.workspaceStore().Attach(ctx, "tenant", space, instanceID, diskID, lease.Token, workspaces.Config{Kind: "container", Image: "test:image"}, h.store.now())
	if err != nil {
		t.Fatal(err)
	}
	lease.Space, err = h.store.GetSpace(ctx, "tenant", space)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.finish(ctx, "stopped", nil); err != nil {
		t.Fatal(err)
	}
	return instance
}

func TestWorkspaceExecutionSnapshotSurvivesReplacement(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "Pinned"})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var calls []protocol.Binding
	h := builtinToolHarness(t, d, "rnr_pinned_workspace", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"kind": "server", "goos": "linux", "storageRoot": "/workspace-data", "capabilities": map[string]any{"boundedExecOutput": true, "boundedDockerExecInputOutput": true}}, nil
		case "docker.list":
			return []computerContainer{{DockerID: "hook-container", Status: "running", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace", "zakura.workspace-instance": "new-instance"}}}, nil
		case "host.fs.write", "docker.exec":
			var binding protocol.Binding
			raw, _ := json.Marshal(params["workspace"])
			if json.Unmarshal(raw, &binding) != nil || binding.Validate() != nil {
				return nil, errors.New("missing workspace binding")
			}
			mu.Lock()
			calls = append(calls, binding)
			mu.Unlock()
			return map[string]any{"ok": true, "exitCode": 0, "stdout": "hook"}, nil
		default:
			return nil, fmt.Errorf("unexpected RPC %s", method)
		}
	})
	a, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	newRun := func(computer string) (context.Context, string) {
		t.Helper()
		chat, err := h.store.CreateSession(ctx, "tenant", "", a.ID, Session{})
		if err != nil {
			t.Fatal(err)
		}
		if computer != "" {
			if err := h.computerStore().SetSessionDefault(ctx, "tenant", space.ID, chat.ID, computer); err != nil {
				t.Fatal(err)
			}
		}
		run, err := h.store.StartRun(ctx, "tenant", a.ID, chat.ID, "test", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		return context.WithValue(ctx, computerRunKey{}, run.ID), chat.ID
	}
	beforeCtx, beforeSession := newRun("")
	old := attachTestWorkspace(t, h, space.ID, "old-disk", "old-instance")
	oldCtx, oldSession := newRun("")
	exec, err := h.resolveExecutionGuard(oldCtx, "tenant", a.ID, oldSession, nil)
	if err != nil || exec.workspace == nil || exec.workspace.Target != old.Target {
		t.Fatalf("old target: %+v %v", exec, err)
	}
	remote, err := h.remotePinnedWorkspace(oldCtx, exec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remote.write(oldCtx, "/before.txt", []byte("old")); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,capabilities_json,created_at,updated_at) VALUES('other','tenant',?,'Other','server','[]','now','now')`, space.ID); err != nil {
		t.Fatal(err)
	}
	overrideCtx, overrideSession := newRun("other")
	accepted, finish, err := h.claimSharedWorkspaceWrite(ctx, "tenant", space.ID)
	if err != nil {
		t.Fatal(err)
	}
	intent, err := h.reserveProjectIntent(accepted, "tenant", space.ID, projectIntent{ID: "project-delete", Kind: "delete", Slug: "demo", Next: "demo", HasWorkspace: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.workspaceStore().Retire(ctx, old.Target, "retire", "cleanup", false, h.store.now()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.resolveServerComputer(ctx, "tenant", space.ID); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("empty slot became executable: %v", err)
	}
	if _, err := h.workspaceForSpace(ctx, "tenant", space.ID); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("retired slot fell back locally: %v", err)
	}
	replacement := attachTestWorkspace(t, h, space.ID, "new-disk", "new-instance")
	if _, _, err := h.remoteSpaceWorkspace(accepted, "tenant", space.ID); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("accepted upload followed replacement: %v", err)
	}
	if err := h.applyProjectIntentFS(ctx, "tenant", space.ID, intent); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("project retry followed replacement: %v", err)
	}
	if err := h.finishProjectIntent(ctx, "tenant", space.ID, intent); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("old project committed metadata: %v", err)
	}
	finish(nil)
	for _, tc := range []struct {
		ctx     context.Context
		session string
		args    []byte
	}{
		{beforeCtx, beforeSession, nil}, {oldCtx, oldSession, nil},
		{overrideCtx, overrideSession, []byte(fmt.Sprintf(`{"computerId":%q}`, computers.ServerComputerID(space.ID)))},
	} {
		if _, err := h.resolveExecutionGuard(tc.ctx, "tenant", a.ID, tc.session, tc.args); !errors.Is(err, workspaces.ErrTargetRevoked) {
			t.Fatalf("old run followed replacement: %v", err)
		}
	}
	if _, err := remote.write(oldCtx, "/late.txt", []byte("late")); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("old file operation followed replacement: %v", err)
	}
	if _, err := h.executeProjectHook(oldCtx, "tenant", space.ID, "", projectHookPackage{}, projectHookAction{Command: "true"}, projectHookInput{}); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("old hook followed replacement: %v", err)
	}
	newCtx, newSession := newRun("")
	exec, err = h.resolveExecutionGuard(newCtx, "tenant", a.ID, newSession, nil)
	if err != nil || exec.workspace == nil || exec.workspace.Target != replacement.Target {
		t.Fatalf("new target: %+v %v", exec, err)
	}
	remote, err = h.remotePinnedWorkspace(newCtx, exec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remote.write(newCtx, "/after.txt", []byte("new")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.executeProjectHook(newCtx, "tenant", space.ID, "", projectHookPackage{}, projectHookAction{Command: "true"}, projectHookInput{}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 3 || calls[0].Target != old.Target || calls[1].Target != replacement.Target || calls[2].Target != replacement.Target {
		t.Fatalf("unexpected remote dispatch: %+v", calls)
	}
}
