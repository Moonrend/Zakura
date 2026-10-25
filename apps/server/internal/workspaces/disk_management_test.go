package workspaces

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDiskDeletionIndependentOfCurrentWorkspace(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	i, err := s.AdoptLegacy(ctx, "tenant", "space", "old-disk", "old-instance", now)
	if err != nil {
		t.Fatal(err)
	}
	d, err := s.RegisterDisk(ctx, "tenant", "space", "spare-disk", "Spare", "node", i.NodeIncarnation, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.VerifyDisk(ctx, d, 123, now); err != nil {
		t.Fatal(err)
	}
	if err := s.RenameDisk(ctx, "other", "space", d.ID, "Unauthorized", now); !errors.Is(err, ErrConflict) {
		t.Fatalf("foreign disk renamed: %v", err)
	}
	if err := s.RenameDisk(ctx, "tenant", "space", d.ID, "Retained", now); err != nil {
		t.Fatal(err)
	}
	c, err := s.DeleteDisk(ctx, "tenant", "space", d.ID, "request", "cleanup", now)
	if err != nil {
		t.Fatal(err)
	}
	if c.InstanceID != nil || c.Phase != "deleting_disk" || !c.DeleteDisk || !c.Pending {
		t.Fatalf("invalid disk cleanup: %+v", c)
	}
	repeated, err := s.DeleteDisk(ctx, "tenant", "space", d.ID, "request", "ignored", now)
	if err != nil || repeated.ID != c.ID {
		t.Fatalf("delete retry: %+v %v", repeated, err)
	}
	if err := s.SampleUsage(ctx, d, 999, now.Add(time.Second)); !errors.Is(err, ErrConflict) {
		t.Fatalf("late sample changed deletion: %v", err)
	}
	claimed, err := s.ClaimCleanup(ctx, "tenant", "space", c.ID, "worker", now)
	if err != nil {
		t.Fatal(err)
	}
	wrong := d.Wire()
	wrong.LocatorVersion++
	if err := s.CompleteDiskDeletion(ctx, claimed, wrong, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("wrong disk acknowledgment accepted: %v", err)
	}
	if err := s.CompleteDiskDeletion(ctx, claimed, d.Wire(), now); err != nil {
		t.Fatal(err)
	}
	if err := s.CompleteDiskDeletion(ctx, claimed, d.Wire(), now); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale worker committed twice: %v", err)
	}
	current, err := s.Current(ctx, "tenant", "space")
	if err != nil || current.Target != i.Target {
		t.Fatalf("disk deletion changed workspace: %+v %v", current, err)
	}
	d, err = s.Disk(ctx, "tenant", "space", d.ID)
	if err != nil || d.State != "deleted" || d.UsedBytes == nil || *d.UsedBytes != 0 {
		t.Fatalf("disk not deleted: %+v %v", d, err)
	}
	if _, err := s.DeleteDisk(ctx, "tenant", "space", i.DiskID, "attached", "attached-cleanup", now); !errors.Is(err, ErrConflict) {
		t.Fatalf("attached disk deleted: %v", err)
	}
}

func TestCleanupQueueSurvivesParentDeletion(t *testing.T) {
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
	execTest(t, s, `DELETE FROM tenants WHERE id='tenant'`)
	due, err := s.DueCleanups(ctx, now, 10)
	if err != nil || len(due) != 1 || due[0].ID != c.ID || due[0].Snapshot.Create == nil {
		t.Fatalf("cleanup lost with parent: %+v %v", due, err)
	}
	claimed, err := s.ClaimCleanup(ctx, "tenant", "space", c.ID, "worker", now)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CompleteRelease(ctx, claimed, i.Target, now); err != nil {
		t.Fatal(err)
	}
	claimed, err = s.ClaimCleanup(ctx, "tenant", "space", c.ID, "disk-worker", now)
	if err != nil {
		t.Fatal(err)
	}
	disk := claimed.Snapshot.Disk.Wire()
	disk.Locator = claimed.Snapshot.Locator
	if err := s.CompleteDiskDeletion(ctx, claimed, disk, now); err != nil {
		t.Fatal(err)
	}
}
