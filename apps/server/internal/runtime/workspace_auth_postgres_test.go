package runtime

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func TestPostgresWorkspaceAuthRetirementSerializesNewWriters(t *testing.T) {
	d := runtimePostgresDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,incarnation,created_at,updated_at) VALUES('node','tenant','Node','node','server','offline','/workspace-data','incarnation','before','before')`); err != nil {
		t.Fatal(err)
	}
	for n := range 6 {
		t.Run(fmt.Sprintf("race-%d", n), func(t *testing.T) {
			space, err := h.store.CreateSpace(ctx, "tenant", Space{Name: fmt.Sprintf("Authentication race %d", n)})
			if err != nil {
				t.Fatal(err)
			}
			old := attachTestWorkspace(t, h, space.ID, fmt.Sprintf("disk-%d", n), fmt.Sprintf("instance-%d", n))
			exec, err := h.resolveServerComputer(ctx, "tenant", space.ID)
			if err != nil {
				t.Fatal(err)
			}
			token := fmt.Sprintf("device-%d", n)
			if err := h.acquireACPAuthLock(ctx, "tenant", space.ID, "codex", "device", token, time.Minute, exec); err != nil {
				t.Fatal(err)
			}
			a := acpDeviceAttempt{ID: token, TenantID: "tenant", SpaceID: space.ID, ProfileID: "codex", PrincipalID: "user", NodeID: old.NodeID, ComputerID: old.ComputerID, WorkspaceInstanceID: old.InstanceID, WorkspaceGeneration: old.Generation, Status: "persisting", Version: 1, EncryptedPayload: "fixture-envelope", ExpiresAt: "later", NextPollAt: "later", CreatedAt: "before", UpdatedAt: "before"}
			if err := d.Gorm.Table(acpDeviceTable).Create(&a).Error; err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			authResult := make(chan error, 1)
			go func() {
				<-start
				authResult <- h.acquireACPAuthLock(ctx, "tenant", space.ID, "other", "protocol", "racing-owner", time.Minute, exec)
			}()
			close(start)
			cleanup, retireErr := h.workspaceStore().Retire(ctx, old.Target, fmt.Sprintf("retire-%d", n), fmt.Sprintf("cleanup-%d", n), false, h.store.now())
			authErr := <-authResult
			if retireErr != nil {
				t.Fatal(retireErr)
			}
			wantLocks := 1
			if authErr == nil {
				wantLocks++
			} else if !errors.Is(authErr, workspaces.ErrTargetRevoked) {
				t.Fatal(authErr)
			}
			if len(cleanup.Snapshot.Authentication) != wantLocks || len(cleanup.Snapshot.DeviceAttempts) != 1 {
				t.Fatal("retirement missed a concurrently admitted authentication writer")
			}
			var locks int
			if err := d.DB.QueryRow(d.Rebind(`SELECT COUNT(*) FROM acp_profile_auth_locks WHERE space_id=?`), space.ID).Scan(&locks); err != nil || locks != 0 {
				t.Fatalf("authentication survived retirement: %d %v", locks, err)
			}
			if err := h.acpDeviceFinish(ctx, &a, "succeeded", ""); !errors.Is(err, errACPDeviceConflict) {
				t.Fatalf("in-flight credential callback committed after retirement: %v", err)
			}
			disk, err := h.workspaceStore().Disk(ctx, "tenant", old.DiskID)
			if err != nil || disk.State != "release_pending" || disk.AttachedInstanceID == nil {
				t.Fatalf("retirement prematurely released disk: %v", err)
			}
			attachTestWorkspace(t, h, space.ID, fmt.Sprintf("new-disk-%d", n), fmt.Sprintf("new-instance-%d", n))
			nextExec, err := h.resolveServerComputer(ctx, "tenant", space.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := h.acquireACPAuthLock(ctx, "tenant", space.ID, "codex", "device", "replacement-owner", time.Minute, nextExec); err != nil {
				t.Fatal(err)
			}
			if err := h.releaseACPAuthLock(ctx, "tenant", space.ID, "codex", token); err != nil {
				t.Fatal(err)
			}
			if err := h.renewACPAuthLock(ctx, "tenant", space.ID, "codex", "replacement-owner", time.Minute); err != nil {
				t.Fatal("old callback removed replacement ownership", err)
			}
		})
	}
}
