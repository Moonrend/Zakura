// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"testing"
)

func prepareConnectionFixture(t *testing.T, rig *workspaceProxyRig) (*workspaceLease, *workspaceConnection) {
	t.Helper()
	ctx := context.Background()
	lease, err := rig.h.acquireSpaceInfrastructure(ctx, "tenant", rig.space.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lease.release)
	target, err := rig.h.resolveSpaceWorkspaceTarget(ctx, "tenant", rig.space.ID, "terminal")
	if err != nil {
		t.Fatal(err)
	}
	row, err := rig.h.beginWorkspaceConnection(ctx, lease, target, "terminal")
	if err != nil {
		t.Fatal(err)
	}
	return lease, row
}

func TestWorkspaceConnectionIntentAndRecovery(t *testing.T) {
	for _, scenario := range []string{"server-restart", "lost-allocation-reply", "cleanup-failure", "executor-replaced", "offline-node", "wrong-space", "lease-replaced"} {
		t.Run(scenario, func(t *testing.T) {
			rig := newWorkspaceProxyRig(t)
			lease, row := prepareConnectionFixture(t, rig)
			var persisted workspaceConnection
			if err := rig.h.deps.Gorm.Table("workspace_connections").Where("id=?", row.ID).Take(&persisted).Error; err != nil || persisted.State != "allocating" || persisted.StreamID != nil {
				t.Fatalf("pre-allocation intent=%+v, err=%v", persisted, err)
			}
			ctx := context.Background()
			if scenario != "lost-allocation-reply" {
				if err := rig.h.activateWorkspaceConnection(ctx, lease, row, "workspace-stream", "docker.exec.close"); err != nil {
					t.Fatal(err)
				}
			}
			lease.release()
			other, err := rig.h.store.CreateSpace(ctx, "tenant", Space{Name: "Other"})
			if err != nil {
				t.Fatal(err)
			}
			unrelated := *row
			unrelated.ID, unrelated.SpaceID = "unrelated-connection", other.ID
			if err := rig.h.deps.Gorm.Table("workspace_connections").Create(&unrelated).Error; err != nil {
				t.Fatal(err)
			}
			// A fresh handler has no in-memory bridge registry to rely on.
			restarted := &handler{deps: rig.h.deps, store: NewStore(rig.h.deps), hub: rig.h.hub}
			recoverySpace := rig.space.ID
			rig.mu.Lock()
			switch scenario {
			case "cleanup-failure":
				rig.failClose = true
			case "executor-replaced":
				rig.owner = "replacement-executor"
			case "wrong-space":
				recoverySpace = other.ID
			}
			rig.mu.Unlock()
			if scenario == "offline-node" {
				runner, _ := rig.h.hub.get("node")
				runner.ready.Store(false)
			}
			migration, err := restarted.acquireSpaceWorkspace(ctx, "tenant", recoverySpace, "migrating", false, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer migration.release()
			if scenario == "lease-replaced" {
				if err := restarted.deps.Gorm.Table("computer_workspace_leases").Where("space_id=?", recoverySpace).Update("token", "new-owner").Error; err != nil {
					t.Fatal(err)
				}
			}
			err = restarted.recoverWorkspaceConnections(ctx, migration)
			if (err == nil) != (scenario == "server-restart") {
				t.Fatalf("recovery err=%v", err)
			}
			var count int64
			if err := restarted.deps.Gorm.Table("workspace_connections").Where("id=?", row.ID).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			want := int64(1)
			if scenario == "server-restart" {
				want = 0
			}
			if count != want {
				t.Fatalf("remaining connection rows=%d want=%d", count, want)
			}
			if err := restarted.deps.Gorm.Table("workspace_connections").Where("id=?", unrelated.ID).Count(&count).Error; err != nil || count != 1 {
				t.Fatal("recovery touched another Space's journal")
			}
			rig.mu.Lock()
			defer rig.mu.Unlock()
			closes, starts := 0, 0
			for _, call := range rig.calls {
				if call.method == "docker.exec.start" || call.method == "host.pty.start" {
					starts++
				}
				if call.method == "docker.exec.close" {
					closes++
					if call.params["id"] != "workspace-stream" || call.params["streamOwner"] != "fixture-executor" {
						t.Fatalf("unbound cleanup: %+v", call)
					}
				}
			}
			wantCloses := 0
			if scenario == "server-restart" || scenario == "cleanup-failure" {
				wantCloses = 1
			}
			if starts != 0 || closes != wantCloses {
				t.Fatalf("start/close effects=%d/%d want=0/%d", starts, closes, wantCloses)
			}
		})
	}
}

func TestWorkspaceConnectionSpaceDeletionRequiresConfirmedCleanup(t *testing.T) {
	for _, scenario := range []string{"confirmed", "lost-allocation-reply", "cleanup-failure", "executor-replaced"} {
		t.Run(scenario, func(t *testing.T) {
			rig := newWorkspaceProxyRig(t)
			lease, row := prepareConnectionFixture(t, rig)
			if scenario != "lost-allocation-reply" {
				if err := rig.h.activateWorkspaceConnection(context.Background(), lease, row, "workspace-stream", "docker.exec.close"); err != nil {
					t.Fatal(err)
				}
			}
			lease.release()
			rig.mu.Lock()
			if scenario == "cleanup-failure" {
				rig.failClose = true
			}
			if scenario == "executor-replaced" {
				rig.owner = "new-executor"
			}
			rig.mu.Unlock()
			err := rig.h.prepareSpaceDeletion(context.Background(), "tenant", rig.space.ID)
			confirmed := scenario == "confirmed"
			if (err == nil) != confirmed {
				t.Fatalf("deletion prepare=%v confirmed=%v", err, confirmed)
			}
			var count int64
			if err := rig.h.deps.Gorm.Table("workspace_connections").Where("id=?", row.ID).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			want := int64(1)
			if confirmed {
				want = 0
			}
			if count != want {
				t.Fatalf("retained connection=%d want=%d", count, want)
			}
			if _, err := rig.h.store.GetSpace(context.Background(), "tenant", rig.space.ID); err != nil {
				t.Fatal("preparation removed the owner")
			}
			if !confirmed {
				var intents int64
				if err := rig.h.deps.Gorm.Table("managed_container_cleanup_intents").Count(&intents).Error; err != nil || intents != 0 {
					t.Fatalf("unconfirmed stream permitted container cleanup: count=%d err=%v", intents, err)
				}
			}
		})
	}
}

func TestWorkspaceConnectionActivationFenced(t *testing.T) {
	rig := newWorkspaceProxyRig(t)
	lease, row := prepareConnectionFixture(t, rig)
	if err := rig.h.deps.Gorm.Table("computer_workspace_leases").Where("space_id=?", rig.space.ID).Update("token", "replacement").Error; err != nil {
		t.Fatal(err)
	}
	if err := rig.h.activateWorkspaceConnection(context.Background(), lease, row, "stream", "docker.exec.close"); err == nil {
		t.Fatal("stale owner activated a workspace connection")
	}
	var saved workspaceConnection
	if err := rig.h.deps.Gorm.Table("workspace_connections").Where("id=?", row.ID).Take(&saved).Error; err != nil || saved.StreamID != nil || saved.State != "allocating" {
		t.Fatalf("stale activation changed intent=%+v, err=%v", saved, err)
	}
}
