package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func attachProxyWorkspace(t *testing.T, rig *workspaceProxyRig, disk, id string) workspaces.Instance {
	t.Helper()
	instance := attachTestWorkspace(t, rig.h, rig.space.ID, disk, id)
	if err := rig.h.deps.Gorm.Table("spaces").Where("id=?", rig.space.ID).Update("enable_computer", true).Error; err != nil {
		t.Fatal(err)
	}
	rig.mu.Lock()
	rig.container.Labels["zakura.workspace-instance"] = id
	rig.mu.Unlock()
	return instance
}

func TestWorkspaceInstanceConnectionsSurviveReplacement(t *testing.T) {
	rig := newWorkspaceProxyRig(t)
	ctx := context.Background()
	old := attachProxyWorkspace(t, rig, "disk-old", "instance-old")
	unused := rig.issue(t, "terminal")
	token := rig.issue(t, "terminal")
	target, lease, actorCtx, err := rig.h.consumeSpaceWorkspaceTicket(ctx, token, rig.space.ID, "terminal")
	if err != nil {
		t.Fatal(err)
	}
	row, err := rig.h.beginWorkspaceConnection(actorCtx, lease, target, "terminal")
	if err != nil {
		t.Fatal(err)
	}
	if row.WorkspaceInstanceID == nil || *row.WorkspaceInstanceID != old.InstanceID {
		t.Fatal("connection did not persist its instance")
	}
	if err := rig.h.activateWorkspaceConnection(actorCtx, lease, row, "old-stream", "docker.exec.close"); err != nil {
		t.Fatal(err)
	}
	lease.release()
	bridge := &workspaceBridge{remote: target.remote, streamOwner: row.StreamOwner}
	if err := bridge.call(ctx, target.runner, "docker.exec.resize", map[string]any{"id": "old-stream", "cols": 80, "rows": 24}, nil); err != nil {
		t.Fatal(err)
	}
	job, err := rig.h.workspaceStore().Retire(ctx, old.Target, "retire", "cleanup", false, rig.h.store.now())
	if err != nil {
		t.Fatal(err)
	}
	if len(job.Snapshot.Connections) != 1 {
		t.Fatal("retirement lost the old connection obligation")
	}
	replacement := attachProxyWorkspace(t, rig, "disk-new", "instance-new")
	// Deliberately leave the fixture Docker ID unchanged: the ticket must also
	// distinguish instances, independent of its container observation.
	if _, staleLease, _, err := rig.h.consumeSpaceWorkspaceTicket(ctx, unused, rig.space.ID, "terminal"); err == nil {
		staleLease.release()
		t.Fatal("old ticket followed the replacement")
	}
	if err := bridge.call(ctx, target.runner, "docker.exec.write", map[string]any{"id": "old-stream", "base64": "eA=="}, nil); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("late input was not revoked: %v", err)
	}
	if err := rig.h.activateWorkspaceConnection(ctx, lease, row, "late-stream", "docker.exec.close"); !errors.Is(err, errWorkspaceLeaseLost) {
		t.Fatalf("late allocation activated: %v", err)
	}
	bridge.closeRemote(ctx, target.runner, "docker.exec.close", "old-stream")
	if !bridge.remoteClosed || bridge.cleanupErr != nil {
		t.Fatalf("old transport could not close: %v", bridge.cleanupErr)
	}
	newToken := rig.issue(t, "terminal")
	newTarget, newLease, newCtx, err := rig.h.consumeSpaceWorkspaceTicket(ctx, newToken, rig.space.ID, "terminal")
	if err != nil {
		t.Fatal(err)
	}
	newRow, err := rig.h.beginWorkspaceConnection(newCtx, newLease, newTarget, "terminal")
	if err != nil {
		t.Fatal(err)
	}
	if err := rig.h.activateWorkspaceConnection(newCtx, newLease, newRow, "new-stream", "docker.exec.close"); err != nil {
		t.Fatal(err)
	}
	newLease.release()
	recovery, err := rig.h.acquireSpaceInfrastructure(ctx, "tenant", rig.space.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer recovery.release()
	if err := rig.h.recoverWorkspaceConnections(ctx, recovery); err != nil {
		t.Fatal(err)
	}
	var remaining []workspaceConnection
	if err := rig.h.deps.Gorm.Table("workspace_connections").Find(&remaining).Error; err != nil || len(remaining) != 1 || remaining[0].ID != row.ID {
		t.Fatalf("current recovery changed old obligations: %+v %v", remaining, err)
	}
	rig.mu.Lock()
	defer rig.mu.Unlock()
	closes, writes := 0, 0
	for _, call := range rig.calls {
		if call.method == "docker.exec.write" {
			writes++
		}
		if call.method != "docker.exec.close" && call.method != "docker.exec.resize" {
			continue
		}
		var binding protocol.Binding
		raw, _ := json.Marshal(call.params["workspace"])
		if err := json.Unmarshal(raw, &binding); err != nil || binding.Validate() != nil {
			t.Fatalf("unbound stream RPC: %+v", call)
		}
		want := old.Target
		if call.params["id"] == "new-stream" {
			want = replacement.Target
		}
		if binding.Target != want {
			t.Fatalf("stream followed another instance: %+v", call)
		}
		if call.method == "docker.exec.close" {
			closes++
		}
	}
	if closes != 2 || writes != 0 {
		t.Fatalf("stream effects: closes=%d writes=%d", closes, writes)
	}
}

func TestWorkspaceInstanceRetirementDisconnectsOnlyOldSockets(t *testing.T) {
	h := &handler{}
	old, oldClient := net.Pipe()
	newer, newClient := net.Pipe()
	defer old.Close()
	defer oldClient.Close()
	defer newer.Close()
	defer newClient.Close()
	oldBridge, newBridge := &workspaceBridge{conn: old}, &workspaceBridge{conn: newer}
	liveWorkspaceBridges.Lock()
	liveWorkspaceBridges.items[oldBridge] = workspaceConnectionTicket{TenantID: "tenant", SpaceID: "space", WorkspaceInstanceID: "old"}
	liveWorkspaceBridges.items[newBridge] = workspaceConnectionTicket{TenantID: "tenant", SpaceID: "space", WorkspaceInstanceID: "new"}
	liveWorkspaceBridges.Unlock()
	defer func() {
		liveWorkspaceBridges.Lock()
		delete(liveWorkspaceBridges.items, oldBridge)
		delete(liveWorkspaceBridges.items, newBridge)
		liveWorkspaceBridges.Unlock()
	}()
	h.disconnectInstanceWorkspaceBridges("tenant", "space", "old")
	_ = oldClient.SetReadDeadline(time.Now().Add(time.Second))
	var b [1]byte
	if _, err := oldClient.Read(b[:]); err == nil {
		t.Fatal("old socket remained open")
	}
	_ = newClient.SetReadDeadline(time.Now().Add(time.Second))
	go func() { _, _ = newer.Write([]byte("x")) }()
	if _, err := newClient.Read(b[:]); err != nil || b[0] != 'x' {
		t.Fatalf("replacement socket was closed: %v", err)
	}
}

func TestWorkspaceInstanceTerminalSocketLifecycle(t *testing.T) {
	rig := newWorkspaceProxyRig(t)
	attachProxyWorkspace(t, rig, "socket-disk", "socket-instance")
	runWorkspaceTerminalSocketLifecycle(t, rig)
	rig.mu.Lock()
	defer rig.mu.Unlock()
	for _, call := range rig.calls {
		switch call.method {
		case "docker.exec.start", "docker.exec.write", "docker.exec.resize", "docker.exec.close":
			var binding protocol.Binding
			raw, _ := json.Marshal(call.params["workspace"])
			if json.Unmarshal(raw, &binding) != nil || binding.Target.InstanceID != "socket-instance" || binding.Validate() != nil {
				t.Fatalf("unbound terminal transport: %+v", call)
			}
		}
	}
}
