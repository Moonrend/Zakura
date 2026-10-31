package workspacestate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

func fixture(t *testing.T) (Store, protocol.Binding) {
	t.Helper()
	s := Store{StateRoot: t.TempDir(), DataRoot: t.TempDir()}
	identity, err := s.Identity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	d := protocol.Disk{TenantID: "tenant", DiskID: "disk", NodeIncarnation: identity.Incarnation, LocatorVersion: 1,
		Locator: protocol.Locator{Kind: "directory", RelativePath: "disks/disk/workspace"}}
	binding := protocol.Binding{Disk: d, Target: protocol.Target{TenantID: "tenant", SpaceID: "space", DiskID: "disk", NodeID: "node", NodeIncarnation: identity.Incarnation, LocatorVersion: 1, InstanceID: "instance", Generation: 1}}
	return s, binding
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestIdentityAndDiskSurviveRestart(t *testing.T) {
	s, binding := fixture(t)
	ctx := context.Background()
	before, err := s.Identity(ctx)
	must(t, err)
	must(t, s.Allocate(ctx, binding.Disk))
	must(t, s.Allocate(ctx, binding.Disk))
	must(t, s.Attach(ctx, binding))
	must(t, os.WriteFile(filepath.Join(s.localPath(binding.Disk), "keep.txt"), []byte("persistent"), 0600))
	restarted := Store{StateRoot: s.StateRoot, DataRoot: s.DataRoot}
	after, err := restarted.Identity(ctx)
	must(t, err)
	if before != after {
		t.Fatalf("identity changed: %+v %+v", before, after)
	}
	guard, err := restarted.Begin(ctx, binding)
	must(t, err)
	content, err := guard.Root.ReadFile("keep.txt")
	must(t, err)
	guard.Close()
	if string(content) != "persistent" {
		t.Fatalf("wrong disk: %s", content)
	}
	used, err := restarted.Usage(ctx, binding.Disk)
	must(t, err)
	if used != 10 {
		t.Fatalf("usage %d", used)
	}
}

func TestMissingOrReplacedStorageNeverBecomesEmptyDisk(t *testing.T) {
	for _, which := range []string{"pool", "workspace", "directory-replaced", "marker"} {
		t.Run(which, func(t *testing.T) {
			s, b := fixture(t)
			ctx := context.Background()
			must(t, s.Allocate(ctx, b.Disk))
			must(t, s.Attach(ctx, b))
			switch which {
			case "pool":
				must(t, os.Remove(filepath.Join(s.DataRoot, ".zakura-workspace-pool.json")))
			case "workspace":
				must(t, os.Rename(s.localPath(b.Disk), s.localPath(b.Disk)+".retained"))
			case "directory-replaced":
				must(t, os.Rename(s.localPath(b.Disk), s.localPath(b.Disk)+".retained"))
				must(t, os.Mkdir(s.localPath(b.Disk), 0755))
			case "marker":
				must(t, os.Remove(filepath.Join(filepath.Dir(s.localPath(b.Disk)), ".zakura-disk.json")))
			}
			if err := s.Allocate(ctx, b.Disk); err == nil {
				t.Fatal("lost data enrolled as a new disk")
			}
			if guard, err := s.Begin(ctx, b); err == nil {
				guard.Close()
				t.Fatal("unverified disk admitted")
			}
			if which == "workspace" {
				if _, err := os.Stat(s.localPath(b.Disk)); !os.IsNotExist(err) {
					t.Fatalf("missing workspace recreated: %v", err)
				}
			}
		})
	}
}

func TestLegacyAdoptionDoesNotCreateOrReplaceContents(t *testing.T) {
	s, b := fixture(t)
	ctx := context.Background()
	b.Disk.SpaceID, b.Disk.Locator = "space", protocol.Locator{Kind: "legacy-bind", RelativePath: "spaces/space/workspace"}
	if err := s.Allocate(ctx, b.Disk); !os.IsNotExist(err) {
		t.Fatalf("missing legacy data: %v", err)
	}
	if _, err := os.Stat(s.localPath(b.Disk)); !os.IsNotExist(err) {
		t.Fatalf("empty legacy disk created: %v", err)
	}
	must(t, os.MkdirAll(s.localPath(b.Disk), 0750))
	must(t, os.WriteFile(filepath.Join(s.localPath(b.Disk), "keep"), []byte("original"), 0600))
	must(t, s.Allocate(ctx, b.Disk))
	must(t, s.Verify(ctx, b.Disk))
	raw, err := os.ReadFile(filepath.Join(s.localPath(b.Disk), "keep"))
	must(t, err)
	if string(raw) != "original" {
		t.Fatal("legacy data changed")
	}
	other := b.Disk
	other.DiskID = "another-disk"
	if err := s.Allocate(ctx, other); !errors.Is(err, ErrConflict) {
		t.Fatalf("directory enrolled twice: %v", err)
	}
}

func TestRevokeBeforeAttachAndRestart(t *testing.T) {
	s, b := fixture(t)
	ctx := context.Background()
	must(t, s.Revoke(ctx, b))
	must(t, s.Allocate(ctx, b.Disk))
	restarted := Store{StateRoot: s.StateRoot, DataRoot: s.DataRoot}
	if err := restarted.Attach(ctx, b); !errors.Is(err, ErrRevoked) {
		t.Fatalf("late attach accepted: %v", err)
	}
	if guard, err := restarted.Begin(ctx, b); !errors.Is(err, ErrRevoked) {
		if guard != nil {
			guard.Close()
		}
		t.Fatalf("late operation accepted: %v", err)
	}
}

func TestReleaseWaitsForActiveOperationAndUnknownEffects(t *testing.T) {
	s, b := fixture(t)
	ctx := context.Background()
	must(t, s.Allocate(ctx, b.Disk))
	must(t, s.Attach(ctx, b))
	guard, err := s.Begin(ctx, b)
	must(t, err)
	effect := Effect{Version: 1, ID: "create-1", Kind: "container"}
	must(t, guard.RecordEffect(effect))
	must(t, s.Revoke(ctx, b))
	bounded, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if released, err := s.BeginRelease(bounded, b); !errors.Is(err, context.DeadlineExceeded) {
		if released != nil {
			released.Close()
		}
		t.Fatalf("release passed an active writer: %v", err)
	}
	guard.Close()
	release, err := s.BeginRelease(ctx, b)
	must(t, err)
	if err := s.CompleteRelease(ctx, release); !errors.Is(err, ErrUnverified) {
		t.Fatalf("unknown create released: %v", err)
	}
	must(t, release.ConfirmEffectReleased(effect))
	must(t, s.CompleteRelease(ctx, release))
	release.Close()
	newBinding := b
	newBinding.Target.InstanceID, newBinding.Target.Generation = "replacement", 2
	must(t, s.Attach(ctx, newBinding))
	old, err := s.BeginRelease(ctx, b)
	must(t, err)
	must(t, s.CompleteRelease(ctx, old))
	old.Close()
	current, err := s.Begin(ctx, newBinding)
	must(t, err)
	current.Close()
	if err := s.Attach(ctx, b); !errors.Is(err, ErrRevoked) {
		t.Fatalf("old instance resurrected: %v", err)
	}
}

func TestConcurrentDiskAttachHasOneWinner(t *testing.T) {
	s, b := fixture(t)
	ctx := context.Background()
	must(t, s.Allocate(ctx, b.Disk))
	second := b
	second.Target.InstanceID, second.Target.Generation = "other", 2
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, binding := range []protocol.Binding{b, second} {
		wg.Add(1)
		go func() { defer wg.Done(); results <- s.Attach(ctx, binding) }()
	}
	wg.Wait()
	close(results)
	wins := 0
	for err := range results {
		if err == nil {
			wins++
		} else if !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	if wins != 1 {
		t.Fatalf("attach winners: %d", wins)
	}
}

func TestDiskRejectsForeignIdentityAndSymlink(t *testing.T) {
	s, b := fixture(t)
	ctx := context.Background()
	must(t, s.Allocate(ctx, b.Disk))
	for _, field := range []string{"tenant", "node", "version", "locator"} {
		other := b.Disk
		switch field {
		case "tenant":
			other.TenantID = "other"
		case "node":
			other.NodeIncarnation = "other"
		case "version":
			other.LocatorVersion++
		case "locator":
			other.Locator.RelativePath = "disks/other/workspace"
		}
		if err := s.Verify(ctx, other); err == nil {
			t.Fatalf("changed %s accepted", field)
		}
	}
	must(t, os.Rename(s.localPath(b.Disk), s.localPath(b.Disk)+".saved"))
	if err := os.Symlink(t.TempDir(), s.localPath(b.Disk)); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlinks unavailable: %v", err)
		}
		t.Fatal(err)
	}
	if err := s.Verify(ctx, b.Disk); err == nil {
		t.Fatal("symlink accepted")
	}
}

func TestNamedVolumeMountUsesDiskSubpath(t *testing.T) {
	s, b := fixture(t)
	s.VolumeName = "installation-workspace-data"
	mount, err := s.Mount(b.Disk)
	must(t, err)
	if mount.HostPath != "" || mount.VolumeName != s.VolumeName || mount.VolumeSubpath != b.Disk.Locator.RelativePath || !mount.NoCopy {
		t.Fatalf("mount is not scoped to the disk: %+v", mount)
	}
}
