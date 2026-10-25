package workspaces

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

func TestOfflineRetireTransfersUnknownCreateAndAllowsNewInstance(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	old, err := s.AdoptLegacy(ctx, "tenant", "space", "old-disk", "old-instance", now)
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Retire(ctx, old.Target, "delete-request", "cleanup", false, now)
	if err != nil {
		t.Fatal(err)
	}
	if !c.Pending || c.Phase != "queued" || c.Snapshot.Create == nil || c.Snapshot.Create.OperationID != "op" || len(c.Snapshot.Lease) == 0 || len(c.Snapshot.Containers) != 1 {
		t.Fatalf("remote obligations not retained: %+v", c)
	}
	if _, err := s.Current(ctx, "tenant", "space"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("old instance still current: %v", err)
	}
	d, err := s.Disk(ctx, "tenant", "space", "old-disk")
	if err != nil || d.State != "release_pending" || d.AttachedInstanceID == nil || *d.AttachedInstanceID != old.InstanceID {
		t.Fatalf("offline disk released prematurely: %+v %v", d, err)
	}
	var count int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM computer_workspace_leases`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("old claim blocks new lifecycle: %d %v", count, err)
	}
	if _, _, err := s.Resolve(ctx, old.Target); !errors.Is(err, ErrTargetRevoked) {
		t.Fatalf("retired target usable: %v", err)
	}
	newDisk, err := s.RegisterDisk(ctx, "tenant", "space", "new-disk", "New disk", "node", old.NodeIncarnation, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.VerifyDisk(ctx, newDisk, 0, now); err != nil {
		t.Fatal(err)
	}
	execTest(t, s, `INSERT INTO computer_workspace_leases(space_id,tenant_id,token,operation,expires_at,updated_at) VALUES('space','tenant','new-lease','configuring',?,?)`, now.Add(time.Hour).UnixMilli(), now.UnixMilli())
	config := Config{Kind: "container", Image: "custom:image"}
	if _, err := s.Attach(ctx, "tenant", "space", "invalid", old.DiskID, "new-lease", config, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("unreleased old disk reattached: %v", err)
	}
	newInstance, err := s.Attach(ctx, "tenant", "space", "new-instance", newDisk.ID, "new-lease", config, now)
	if err != nil {
		t.Fatal(err)
	}
	if newInstance.Generation <= old.Generation || newInstance.InstanceID == old.InstanceID || newInstance.DiskID == old.DiskID {
		t.Fatalf("new instance reused old target: %+v", newInstance)
	}
	if _, _, err := s.Resolve(ctx, newInstance.Target); err != nil {
		t.Fatal(err)
	}
	// Repeated deletion must resolve its original request, not the new current
	// instance. Changing the retained-disk choice under that key is rejected.
	repeated, err := s.Retire(ctx, old.Target, "delete-request", "ignored-id", false, now)
	if err != nil || repeated.ID != c.ID {
		t.Fatalf("delete retry changed identity: %+v %v", repeated, err)
	}
	if _, err := s.Retire(ctx, old.Target, "delete-request", "ignored-id", true, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("idempotency key changed disk deletion authority: %v", err)
	}
	if _, err := s.Retire(ctx, old.Target, "stale-page", "stale-cleanup", false, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale page deleted new current instance: %v", err)
	}
	claimed, err := s.ClaimCleanup(ctx, "tenant", "space", c.ID, "worker", now)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CompleteRelease(ctx, claimed, newInstance.Target, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("old cleanup accepted new instance: %v", err)
	}
	execTest(t, s, `INSERT INTO workspace_connections(id,tenant_id,space_id,node_id,stream_owner,kind,state,created_at,workspace_instance_id) VALUES('old-stream','tenant','space','node','owner','terminal','unknown','now',?),('new-stream','tenant','space','node','owner','terminal','active','now',?)`, old.InstanceID, newInstance.InstanceID)
	if err := s.CompleteRelease(ctx, claimed, old.Target, now); err != nil {
		t.Fatal(err)
	}
	var remaining string
	if err := s.DB.QueryRow(`SELECT id FROM workspace_connections`).Scan(&remaining); err != nil || remaining != "new-stream" {
		t.Fatalf("old release changed new connection: %s %v", remaining, err)
	}
	var dockerID sql.NullString
	if err := s.DB.QueryRow(`SELECT docker_id FROM managed_containers WHERE id='container'`).Scan(&dockerID); err != nil || dockerID.Valid {
		t.Fatalf("released instance retained live cache: %+v %v", dockerID, err)
	}
	current, err := s.Current(ctx, "tenant", "space")
	if err != nil || current.Target != newInstance.Target {
		t.Fatalf("old cleanup changed current instance: %+v %v", current, err)
	}
	d, err = s.Disk(ctx, "tenant", "space", old.DiskID)
	if err != nil || d.AttachedInstanceID != nil || d.State != "available" {
		t.Fatalf("retained disk not released: %+v %v", d, err)
	}
	if err := s.CompleteRelease(ctx, claimed, old.Target, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("old worker committed twice: %v", err)
	}
}

func TestRetireKeepsMigrationAndProfileClaims(t *testing.T) {
	for _, operation := range []string{"migrating", "deleting", "profile"} {
		t.Run(operation, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			i, err := s.AdoptLegacy(ctx, "tenant", "space", "disk", "instance", time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if operation == "profile" {
				execTest(t, s, `UPDATE computer_workspace_leases SET intent_json='{"previousStatus":"running","sharedProfile":"auth"}'`)
			} else {
				execTest(t, s, `UPDATE computer_workspace_leases SET operation=?`, operation)
			}
			if _, err := s.Retire(ctx, i.Target, "request", "cleanup", false, time.Now()); !errors.Is(err, ErrConflict) {
				t.Fatalf("unrelated obligation discarded: %v", err)
			}
			current, err := s.Current(ctx, "tenant", "space")
			if err != nil || current.Target != i.Target {
				t.Fatalf("failed delete changed binding: %+v %v", current, err)
			}
			var n int
			if err := s.DB.QueryRow(`SELECT COUNT(*) FROM workspace_cleanup_tombstones`).Scan(&n); err != nil || n != 0 {
				t.Fatalf("failed delete retained incomplete task: %d %v", n, err)
			}
		})
	}
}

func TestCleanupWorkerFencingAndDeleteDiskPhase(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	i, err := s.AdoptLegacy(ctx, "tenant", "space", "disk", "instance", now)
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Retire(ctx, i.Target, "request", "cleanup", true, now)
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.ClaimCleanup(ctx, "tenant", "space", c.ID, "first", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimCleanup(ctx, "tenant", "space", c.ID, "parallel", now); !errors.Is(err, ErrConflict) {
		t.Fatalf("parallel cleanup claimed: %v", err)
	}
	later := now.Add(3 * time.Minute)
	second, err := s.ClaimCleanup(ctx, "tenant", "space", c.ID, "second", later)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CompleteRelease(ctx, first, i.Target, later); !errors.Is(err, ErrConflict) {
		t.Fatalf("expired worker released a disk: %v", err)
	}
	if err := s.RetryCleanup(ctx, first, "waiting_node", errors.New("offline"), later); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale worker changed retry: %v", err)
	}
	if err := s.CompleteRelease(ctx, second, i.Target, later); err != nil {
		t.Fatal(err)
	}
	d, err := s.Disk(ctx, "tenant", "space", "disk")
	if err != nil || d.State != "delete_pending" || d.AttachedInstanceID != nil {
		t.Fatalf("release erased deletion authority: %+v %v", d, err)
	}
	c, err = s.Cleanup(ctx, "tenant", "space", c.ID)
	if err != nil || !c.Pending || c.Phase != "deleting_disk" {
		t.Fatalf("container release prematurely completed disk deletion: %+v %v", c, err)
	}
}
