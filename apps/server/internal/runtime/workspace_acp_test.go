package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func TestWorkspaceACPRuntimeCannotFollowReplacement(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "ACP disk"})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var effects []protocol.Target
	starts, closes := 0, 0
	h := codemodeToolHarness(t, d, "rnr_acp_disk", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
		switch method {
		case "sys.info":
			info := codemodeInfo()
			info["streamOwner"] = "acp-owner"
			return info, nil
		case "docker.list":
			return []computerContainer{{DockerID: "acp-workspace", Status: "running", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace", "zakura.workspace-instance": "acp-old"}}}, nil
		}
		var binding protocol.Binding
		raw, _ := json.Marshal(params["workspace"])
		if json.Unmarshal(raw, &binding) != nil || binding.Validate() != nil {
			t.Errorf("ACP effect omitted binding: %s", method)
		}
		mu.Lock()
		effects = append(effects, binding.Target)
		mu.Unlock()
		switch method {
		case "docker.exec.start":
			mu.Lock()
			starts++
			mu.Unlock()
			return map[string]any{"id": "acp-stream"}, nil
		case "docker.exec.write":
			rpc := decodeCodemodeParams(params)
			result := map[string]any{}
			if rpc["method"] == "session/new" {
				result["sessionId"] = "protocol-session"
			}
			return map[string]any{"ok": true}, func() {
				if rpc["id"] != nil {
					emit("acp-stream", "stdout", map[string]any{"jsonrpc": "2.0", "id": rpc["id"], "result": result})
				}
			}
		case "docker.exec.close":
			if params["streamOwner"] != "acp-owner" {
				t.Error("ACP cleanup lost executor identity")
			}
			mu.Lock()
			closes++
			mu.Unlock()
			return map[string]any{"ok": true}, nil
		case "host.fs.write":
			return map[string]any{"ok": true}, nil
		default:
			t.Errorf("unexpected ACP effect: %s", method)
			return map[string]any{}, nil
		}
	})
	old := attachTestWorkspace(t, h, space.ID, "acp-old-disk", "acp-old")
	a, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	session, err := h.store.CreateSession(ctx, "tenant", "", a.ID, Session{Kind: "acp"})
	if err != nil {
		t.Fatal(err)
	}
	manager := newACPRuntimeManager(h)
	h.acp = manager
	defer manager.closeAll()
	profile := map[string]any{"command": "fake-adapter"}
	rt, err := manager.start(ctx, "tenant", a.ID, session.ID, "codex", "", session, profile)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.close(nil)
	manager.mu.Lock()
	manager.runtimes["tenant\x00"+session.ID] = rt
	manager.mu.Unlock()
	persisted, err := h.store.GetSession(ctx, "tenant", a.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	var origin struct {
		Target protocol.Target `json:"acpWorkspaceTarget"`
	}
	if json.Unmarshal(persisted.Origin, &origin) != nil || origin.Target != old.Target {
		t.Fatalf("ACP target not durable: %s", persisted.Origin)
	}
	if _, err := rt.workspaceRemote().write(ctx, "/project.txt", []byte("old")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.workspaceStore().Retire(ctx, old.Target, "acp-retire", "acp-cleanup", false, h.store.now()); err != nil {
		t.Fatal(err)
	}
	attachTestWorkspace(t, h, space.ID, "acp-new-disk", "acp-new")
	for name, check := range map[string]func() error{
		"cached":   func() error { return rt.validateMCPCaller(ctx) },
		"write":    func() error { return rt.writeContext(ctx, map[string]any{"method": "late"}) },
		"file":     func() error { _, e := rt.workspaceRemote().write(ctx, "/late", []byte("late")); return e },
		"terminal": func() error { _, e := rt.createTerminal(ctx, map[string]any{"command": "true"}); return e },
		"restart":  func() error { _, e := resolveACPHost(ctx, h, "tenant", a.ID, session.ID); return e },
	} {
		if err := check(); !errors.Is(err, workspaces.ErrTargetRevoked) {
			t.Fatalf("%s followed replacement: %v", name, err)
		}
	}
	nextExec, err := h.resolveServerComputer(ctx, "tenant", space.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.acquireACPAuthLock(ctx, "tenant", space.ID, "codex", "terminal", "replacement-owner", time.Minute, nextExec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.deps.DB.Exec(`UPDATE acp_profile_auth_locks SET expires_at=0 WHERE space_id=?`, space.ID); err != nil {
		t.Fatal(err)
	}
	actor := acpMCPUser(t, h)
	actor.Role = "owner"
	if claim, _, _, err := h.claimACPClose(ctx, actor, rt); err == nil {
		claim.release()
		t.Fatal("old close took over replacement authentication")
	}
	closed, err := h.closeACP(ctx, actor, a.ID, session.ID)
	if err != nil || closed["state"] != "closed" {
		t.Fatalf("close retired ACP process: %v", err)
	}
	// A delayed policy watcher must also keep its old instance context.
	_ = rt.stopForApprovalPolicy(errors.New("old policy changed"))
	lock, err := h.loadACPAuthRecovery(ctx, "tenant", space.ID, "codex")
	if err != nil || lock.Token != "replacement-owner" || lock.WorkspaceToken != "" {
		t.Fatalf("old runtime changed replacement authentication: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if starts != 1 || closes != 1 {
		t.Fatalf("ACP lifecycle starts=%d closes=%d", starts, closes)
	}
	for _, target := range effects {
		if target != old.Target {
			t.Fatalf("ACP target drift: %+v", target)
		}
	}
}

func TestWorkspaceACPSidecarMountAndRetiredCleanup(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "ACP mount"})
	if err != nil {
		t.Fatal(err)
	}
	var binding protocol.Binding
	var mu sync.Mutex
	creates, removes := 0, 0
	h := builtinToolHarness(t, d, "rnr_acp_mount", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return codemodeInfo(), nil
		case "workspace.mount":
			return map[string]any{"target": binding.Target, "mount": workspaceMount{VolumeName: "workspace-data", VolumeSubpath: binding.Disk.Locator.RelativePath, ContainerPath: "/workspace", NoCopy: true}}, nil
		case "docker.create":
			raw, _ := json.Marshal(params["workspace"])
			var got protocol.Binding
			_ = json.Unmarshal(raw, &got)
			op := params["operation"].(map[string]any)
			labels := params["labels"].(map[string]any)
			volumes := params["volumes"].([]any)
			volume := volumes[0].(map[string]any)
			if got != binding || op["purpose"] != "acp-adapter" || op["id"] != params["name"] || labels["zakura.workspace-instance"] != binding.Target.InstanceID || volume["volumeName"] != "workspace-data" || volume["volumeSubpath"] != binding.Disk.Locator.RelativePath || volume["noCopy"] != true || volume["hostPath"] != nil {
				t.Error("ACP did not use exact instance mount and receipt")
			}
			mu.Lock()
			creates++
			mu.Unlock()
			return map[string]any{"dockerId": "adapter-container"}, nil
		case "docker.stop":
			raw, _ := json.Marshal(params["workspace"])
			var got protocol.Binding
			_ = json.Unmarshal(raw, &got)
			if got != binding || params["id"] != "adapter-container" || params["remove"] != true {
				t.Error("ACP cleanup changed target")
			}
			mu.Lock()
			removes++
			mu.Unlock()
			return map[string]any{"ok": true}, nil
		default:
			return nil, errors.New("unexpected RPC: " + method)
		}
	})
	old := attachTestWorkspace(t, h, space.ID, "sidecar-disk", "sidecar-instance")
	exec, err := h.resolveServerComputer(ctx, "tenant", space.ID)
	if err != nil {
		t.Fatal(err)
	}
	binding = *exec.workspace
	runner, err := h.hub.get(exec.nodeID)
	if err != nil {
		t.Fatal(err)
	}
	id, err := h.startACPContainer(ctx, runner, exec, "session", "profile", "adapter:1", "/workspace", nil)
	if err != nil || id != "adapter-container" {
		t.Fatalf("sidecar create: %s %v", id, err)
	}
	if _, err := h.workspaceStore().Retire(ctx, old.Target, "sidecar-retire", "sidecar-clean", false, h.store.now()); err != nil {
		t.Fatal(err)
	}
	attachTestWorkspace(t, h, space.ID, "sidecar-new-disk", "sidecar-new-instance")
	if err := cleanupWorkspaceContainer(ctx, runner, h.executionRemote(runner, exec), id); err != nil {
		t.Fatal(err)
	}
	if _, err := h.startACPContainer(ctx, runner, exec, "late", "profile", "adapter:1", "/workspace", nil); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("late adapter created: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if creates != 1 || removes != 1 {
		t.Fatalf("unexpected sidecar effects %d/%d", creates, removes)
	}
}

func TestWorkspaceACPLoginAndDeviceTargetsChangeOnReplacement(t *testing.T) {
	h, _, space, _ := acpLoginRig(t)
	ctx := context.Background()
	old := attachTestWorkspace(t, h, space.ID, "login-old-disk", "login-old-instance")
	login, err := h.resolveACPLogin(ctx, "tenant", space.ID, "codex")
	if err != nil {
		t.Fatal(err)
	}
	ticket, err := h.issueACPLoginTicket(ctx, login, acpLoginPrincipal())
	if err != nil {
		t.Fatal(err)
	}
	if err := h.saveSpaceACP(ctx, "tenant", space.ID, map[string]any{"agents": map[string]any{"codex": map[string]any{"enabled": true, "setupMode": "oauth", "modelProvider": "native"}}}); err != nil {
		t.Fatal(err)
	}
	device, err := h.codexDeviceTarget(ctx, "tenant", space.ID, "codex")
	if err != nil {
		t.Fatal(err)
	}
	before, err := h.resolveACPLogin(ctx, "tenant", space.ID, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.workspaceStore().Retire(ctx, old.Target, "login-retire", "login-clean", false, h.store.now()); err != nil {
		t.Fatal(err)
	}
	attachTestWorkspace(t, h, space.ID, "login-new-disk", "login-new-instance")
	after, err := h.resolveACPLogin(ctx, "tenant", space.ID, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if after.ticket.ConfigHash == before.ticket.ConfigHash {
		t.Fatal("login ticket omitted instance")
	}
	if _, err := h.consumeACPLoginTicket(ctx, ticket, space.ID, "codex"); err == nil {
		t.Fatal("old login ticket accepted")
	}
	newDevice, err := h.codexDeviceTarget(ctx, "tenant", space.ID, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if newDevice.hash == device.hash {
		t.Fatal("device attempt omitted instance")
	}
}

func TestACPLegacySessionCannotAdoptNewDisk(t *testing.T) {
	exec := &resolvedExecution{workspace: &protocol.Binding{Target: protocol.Target{InstanceID: "new"}}}
	if err := checkACPSessionWorkspace(json.RawMessage(`{"acpRuntimeId":"old"}`), exec); err == nil || !strings.Contains(err.Error(), "start a new session") {
		t.Fatalf("legacy session rebound: %v", err)
	}
}
