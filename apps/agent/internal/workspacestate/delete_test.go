package workspacestate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Moonrend/Zakura/apps/agent/internal/statefs"
)

func TestDiskDeletionRequiresReleaseAndCannotReplayOntoReplacement(t *testing.T) {
	s, b := fixture(t)
	ctx := context.Background()
	must(t, s.Allocate(ctx, b.Disk))
	must(t, s.Attach(ctx, b))
	must(t, os.WriteFile(filepath.Join(s.localPath(b.Disk), "keep"), []byte("data"), 0600))
	if err := s.Delete(ctx, b.Disk, "delete"); !errors.Is(err, ErrConflict) {
		t.Fatalf("attached disk deleted: %v", err)
	}
	guard, err := s.BeginRelease(ctx, b)
	must(t, err)
	must(t, s.CompleteRelease(ctx, guard))
	guard.Close()
	must(t, s.Delete(ctx, b.Disk, "delete"))
	must(t, s.Delete(ctx, b.Disk, "delete"))
	if err := s.Delete(ctx, b.Disk, "different-request"); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete authority replaced: %v", err)
	}
	entries, err := os.ReadDir(s.localPath(b.Disk))
	must(t, err)
	if len(entries) != 0 {
		t.Fatalf("disk files remain: %+v", entries)
	}
	if err := s.Allocate(ctx, b.Disk); !errors.Is(err, ErrConflict) {
		t.Fatalf("deleted disk reallocated: %v", err)
	}
	b.Target.InstanceID, b.Target.Generation = "replacement", 2
	if err := s.Attach(ctx, b); !errors.Is(err, ErrConflict) {
		t.Fatalf("deleted disk reattached: %v", err)
	}
}

func TestInterruptedDeleteAuthorityBlocksAttach(t *testing.T) {
	s, b := fixture(t)
	ctx := context.Background()
	must(t, s.Allocate(ctx, b.Disk))
	opened, err := s.open(ctx)
	must(t, err)
	meta, err := opened.diskRoot(b.Disk, false)
	must(t, err)
	must(t, statefs.Write(meta, "delete.json", deleteRecord{Version: 1, Disk: b.Disk, RequestID: "delete"}, false))
	meta.Close()
	opened.close()
	if err := s.Attach(ctx, b); !errors.Is(err, ErrConflict) {
		t.Fatalf("attach passed durable deletion intent: %v", err)
	}
	must(t, s.Delete(ctx, b.Disk, "delete"))
}

func TestDeleteRejectsReplacedDirectory(t *testing.T) {
	s, b := fixture(t)
	ctx := context.Background()
	must(t, s.Allocate(ctx, b.Disk))
	must(t, os.Rename(s.localPath(b.Disk), s.localPath(b.Disk)+".retained"))
	must(t, os.Mkdir(s.localPath(b.Disk), 0755))
	path := filepath.Join(s.localPath(b.Disk), "replacement")
	must(t, os.WriteFile(path, []byte("do-not-delete"), 0600))
	if err := s.Delete(ctx, b.Disk, "delete"); !errors.Is(err, ErrConflict) {
		t.Fatalf("replacement deleted: %v", err)
	}
	raw, err := os.ReadFile(path)
	must(t, err)
	if string(raw) != "do-not-delete" {
		t.Fatal("replacement data changed")
	}
}
