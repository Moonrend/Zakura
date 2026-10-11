package workspace

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func diskSnapshot(t *testing.T, r *Repository, files map[string]string) (Snapshot, string) {
	t.Helper()
	root := t.TempDir()
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	snapshot, err := r.Snapshot(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot, root
}

func TestDiskSnapshotsAreDeterministicAndVerifyObjects(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	first, root := diskSnapshot(t, r, map[string]string{"中文/a.txt": "你好\n", "empty": "", "dup": "你好\n"})
	second, err := r.Snapshot(context.Background(), root)
	if err != nil || second.ID != first.ID || len(first.Entries) != 3 {
		t.Fatalf("snapshot %#v %v", second, err)
	}
	if first.Entries[0].Hash == "" || first.TotalBytes != int64(len("你好\n")*2) {
		t.Fatal(first)
	}
	objects, err := os.ReadDir(filepath.Join(r.root, "objects"))
	if err != nil || len(objects) != 2 {
		t.Fatalf("deduplication: %d %v", len(objects), err)
	}
	manifest := ArtifactManifest{SnapshotID: first.ID, Entries: []Entry{first.Entries[0]}}
	if err = r.VerifyArtifacts(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Entries[0].Mode ^= 0100
	if err = r.VerifyArtifacts(context.Background(), manifest); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("metadata tampering %v", err)
	}
	if err = os.WriteFile(filepath.Join(r.root, "objects", first.Entries[0].Hash), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = r.GetSnapshot(context.Background(), first.ID); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("object tampering %v", err)
	}
}

func TestImmutableReadDoesNotUseMutableBranchOrMaterialize(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	snapshot, source := diskSnapshot(t, r, map[string]string{"file": "immutable"})
	if err := os.WriteFile(filepath.Join(source, "file"), []byte("changed"), 0644); err != nil {
		t.Fatal(err)
	}
	data, err := r.ReadSnapshot(context.Background(), snapshot.ID, "file")
	if err != nil || string(data) != "immutable" {
		t.Fatalf("read %q %v", data, err)
	}
	if _, err = r.ReadSnapshot(context.Background(), snapshot.ID, "../file"); !errors.Is(err, ErrUnsafePath) {
		t.Fatal(err)
	}
	if _, err = r.ReadSnapshot(context.Background(), snapshot.ID, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(r.root, "objects", snapshot.Entries[0].Hash), []byte("corrupted"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = r.ReadSnapshot(context.Background(), snapshot.ID, "file"); !errors.Is(err, ErrCorrupt) {
		t.Fatal(err)
	}
}

func TestLockWaitHonorsCancellation(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	snapshot, _ := diskSnapshot(t, r, map[string]string{"a": "a"})
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		_ = r.locked(context.Background(), func() error { close(started); <-release; return nil })
	}()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := r.GetSnapshot(ctx, snapshot.ID)
	close(release)
	<-finished
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock cancellation %v", err)
	}
}

func TestMaterializeSwapsCompleteTreeIntoExistingEmptyDirectory(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	snapshot, _ := diskSnapshot(t, r, map[string]string{"dir/a": "one", "b": "two"})
	target := filepath.Join(t.TempDir(), "target")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := r.Materialize(context.Background(), snapshot.ID, target); err != nil {
		t.Fatal(err)
	}
	got, err := r.Snapshot(context.Background(), target)
	if err != nil || got.ID != snapshot.ID {
		t.Fatalf("materialized %#v %v", got, err)
	}
	if err = r.Materialize(context.Background(), snapshot.ID, target); !errors.Is(err, ErrConflict) {
		t.Fatalf("replaced nonempty target %v", err)
	}
}

func TestCrashTemporaryFilesRemainOutsideBranchAndAreCollected(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base, _ := diskSnapshot(t, r, map[string]string{"file": "old"})
	ctx := context.Background()
	if _, err := r.CreateBranch(ctx, "temp", base.ID); err != nil {
		t.Fatal(err)
	}
	if err := r.Write(ctx, "temp", ".pending-user-file", []byte("legitimate"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{"objects", "manifests", "branches", "plans", "journals", "tmp"} {
		if err := os.WriteFile(filepath.Join(r.root, directory, ".pending-crash"), []byte("unfinished"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := r.GC(ctx, GCOptions{DryRun: true}); err != nil {
		t.Fatalf("pending files broke dry-run GC %v", err)
	}
	reopened, err := New(r.root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{"objects", "manifests", "branches", "plans", "journals", "tmp"} {
		if _, err := os.Lstat(filepath.Join(r.root, directory, ".pending-crash")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("temporary survived in %s: %v", directory, err)
		}
	}
	data, err := reopened.Read(ctx, "temp", ".pending-user-file")
	if err != nil || string(data) != "legitimate" {
		t.Fatalf("cleanup removed user file %q %v", data, err)
	}
}

func TestBranchIsolationCaptureCASAndRestart(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base, _ := diskSnapshot(t, r, map[string]string{"file": "base"})
	ctx := context.Background()
	for _, name := range []string{"left", "right"} {
		if _, err := r.CreateBranch(ctx, name, base.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Write(ctx, "left", "dir/file", []byte("new"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := r.Rename(ctx, "left", "file", "renamed"); err != nil {
		t.Fatal(err)
	}
	if data, err := r.Read(ctx, "right", "file"); err != nil || string(data) != "base" {
		t.Fatalf("isolation %q %v", data, err)
	}
	if _, err := r.Read(ctx, "right", "dir/file"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errorsOut := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := r.CaptureBranch(ctx, "left", base.ID); errorsOut <- err }()
	}
	wg.Wait()
	close(errorsOut)
	succeeded, conflicted := 0, 0
	for err := range errorsOut {
		if err == nil {
			succeeded++
		} else if errors.Is(err, ErrConflict) {
			conflicted++
		} else {
			t.Fatal(err)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("CAS %d %d", succeeded, conflicted)
	}
	reopened, err := New(r.root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	branch, err := reopened.GetBranch(ctx, "left")
	if err != nil || branch.Head == base.ID || branch.Base != base.ID || branch.Generation != 2 {
		t.Fatalf("branch %#v %v", branch, err)
	}
	if err = reopened.DeleteBranch(ctx, "left", base.ID); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if err = reopened.DeleteBranch(ctx, "left", branch.Head); err != nil {
		t.Fatal(err)
	}
	if _, err = reopened.GetBranch(ctx, "left"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestSafePathsLinksAndLimits(t *testing.T) {
	r := mergeTestRepository(t, Options{MaxFileBytes: 8, MaxTotalBytes: 12, MaxFiles: 2, MaxPathBytes: 80})
	base, source := diskSnapshot(t, r, map[string]string{"a": "one"})
	ctx := context.Background()
	if _, err := r.CreateBranch(ctx, "safe", base.ID); err != nil {
		t.Fatal(err)
	}
	if err := r.Write(ctx, "safe", "a", []byte("new"), 0200); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("accepted unreadable mode %v", err)
	}
	for _, path := range []string{"../escape", "/absolute", "a/../escape", "a//b", "C:drive", "a\\b", "nul\x00", "line\nfile", strings.Repeat("a", 81)} {
		if err := r.Write(ctx, "safe", path, []byte("x"), 0644); !errors.Is(err, ErrUnsafePath) {
			t.Fatalf("path %q %v", path, err)
		}
	}
	if err := r.Write(ctx, "safe", "b", []byte("123456789"), 0644); !errors.Is(err, ErrLimit) {
		t.Fatal(err)
	}
	if err := r.Write(ctx, "safe", "b", []byte("12345678"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := r.Write(ctx, "safe", "c", []byte("x"), 0644); !errors.Is(err, ErrLimit) {
		t.Fatal(err)
	}
	if err := r.Write(ctx, "safe", "a", []byte("12345"), 0644); !errors.Is(err, ErrLimit) {
		t.Fatal(err)
	}
	root, err := r.BranchRoot(ctx, "safe")
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err = os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skip("symlinks unavailable")
	}
	if err = r.Write(ctx, "safe", "linked/escape", []byte("x"), 0644); !errors.Is(err, ErrUnsafePath) {
		t.Fatal(err)
	}
	if _, err = r.CaptureBranch(ctx, "safe", base.ID); !errors.Is(err, ErrUnsafePath) {
		t.Fatal(err)
	}
	if err = os.Symlink(outside, filepath.Join(source, "linked")); err != nil {
		t.Fatal(err)
	}
	if _, err = r.Snapshot(ctx, source); !errors.Is(err, ErrUnsafePath) {
		t.Fatal(err)
	}
	if _, err = r.Snapshot(ctx, filepath.Dir(r.root)); !errors.Is(err, ErrUnsafePath) {
		t.Fatal(err)
	}
}

func TestApplyRequiresHeadAndMutableBaseline(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base, original := diskSnapshot(t, r, map[string]string{"file": "base"})
	target, _ := diskSnapshot(t, r, map[string]string{"file": "target", "extra": "new"})
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(original, "file"), []byte("user edit"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ApplyToDirectory(ctx, base.ID, target.ID, original); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(original, "file")); string(data) != "user edit" {
		t.Fatal("overwrote dirty original")
	}
	if err := os.WriteFile(filepath.Join(original, "file"), []byte("base"), 0644); err != nil {
		t.Fatal(err)
	}
	result, err := r.ApplyToDirectory(ctx, base.ID, target.ID, original)
	if err != nil || result.Snapshot.ID != target.ID {
		t.Fatalf("apply %#v %v", result, err)
	}
	if _, err = r.CreateBranch(ctx, "merge", base.ID); err != nil {
		t.Fatal(err)
	}
	plan, err := r.PlanMerge(ctx, base.ID, base.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = r.Write(ctx, "merge", "file", []byte("uncommitted"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = r.ApplyMerge(ctx, plan, nil, "merge", base.ID); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if err = r.Write(ctx, "merge", "file", []byte("base"), 0644); err != nil {
		t.Fatal(err)
	}
	result, err = r.ApplyMerge(ctx, plan, nil, "merge", base.ID)
	if err != nil || result.Branch == nil || result.Branch.Head != target.ID {
		t.Fatalf("merge %#v %v", result, err)
	}
}

func TestDirectoryRecoveryAtEverySwapBoundary(t *testing.T) {
	for _, phase := range []string{"preparing", "prepared", "backed-up", "installed", "missing-stage"} {
		t.Run(phase, func(t *testing.T) {
			r := mergeTestRepository(t, Options{})
			base, original := diskSnapshot(t, r, map[string]string{"file": "base"})
			target, _ := diskSnapshot(t, r, map[string]string{"file": "target"})
			j, err := r.newJournal(original, base.ID, target.ID, nil, "")
			if err != nil {
				t.Fatal(err)
			}
			if err = r.materialize(context.Background(), target, j.Stage); err != nil {
				t.Fatal(err)
			}
			if phase == "preparing" {
				j.Phase = "preparing"
				if err = os.WriteFile(filepath.Join(j.Stage, "file"), []byte("incomplete materialization"), 0644); err != nil {
					t.Fatal(err)
				}
			}
			if err = r.saveJournal(j); err != nil {
				t.Fatal(err)
			}
			if phase != "prepared" && phase != "preparing" {
				if err = os.Rename(original, j.Backup); err != nil {
					t.Fatal(err)
				}
			}
			if phase == "installed" {
				if err = os.Rename(j.Stage, original); err != nil {
					t.Fatal(err)
				}
			}
			if phase == "missing-stage" {
				if err = os.RemoveAll(j.Stage); err != nil {
					t.Fatal(err)
				}
			}
			reopened, err := New(r.root, Options{})
			if err != nil {
				t.Fatal(err)
			}
			// New must leave original-directory intents for the runner's FS lock.
			journals, _ := os.ReadDir(filepath.Join(r.root, "journals"))
			if len(journals) != 1 {
				t.Fatal("New recovered external workspace without runner lock")
			}
			results, err := reopened.Recover(context.Background())
			if err != nil || len(results) != 1 {
				t.Fatalf("recovery %v %v", results, err)
			}
			want := "target"
			if phase == "prepared" || phase == "preparing" || phase == "missing-stage" {
				want = "base"
			}
			content, err := os.ReadFile(filepath.Join(original, "file"))
			if err != nil || string(content) != want {
				t.Fatalf("tree %q %v want %q", content, err, want)
			}
			results, err = reopened.Recover(context.Background())
			if err != nil || len(results) != 0 {
				t.Fatalf("idempotence %v %v", results, err)
			}
		})
	}
}

func TestBranchRecoveryCommitsMetadataAfterInstalledTree(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base, _ := diskSnapshot(t, r, map[string]string{"file": "base"})
	target, _ := diskSnapshot(t, r, map[string]string{"file": "target"})
	branch, err := r.CreateBranch(context.Background(), "resume", base.ID)
	if err != nil {
		t.Fatal(err)
	}
	root, err := r.BranchRoot(context.Background(), branch.ID)
	if err != nil {
		t.Fatal(err)
	}
	branch.Head = target.ID
	branch.Generation++
	branch.UpdatedAt = time.Now().UTC()
	j, err := r.newJournal(root, base.ID, target.ID, &branch, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = r.materialize(context.Background(), target, j.Stage); err != nil {
		t.Fatal(err)
	}
	if err = r.saveJournal(j); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(root, j.Backup); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(j.Stage, root); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(r.root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := reopened.GetBranch(context.Background(), branch.ID)
	if err != nil || got.Head != target.ID || got.Generation != 2 {
		t.Fatalf("recovered metadata %#v %v", got, err)
	}
	if _, err = os.Lstat(j.Backup); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("backup retained after complete recovery")
	}
}

func TestArchiveRoundTripAndRejectedImportNeverPublishesManifest(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	snapshot, _ := diskSnapshot(t, r, map[string]string{"a": "same", "b": "same", "dir/empty": ""})
	var archive bytes.Buffer
	if err := r.Export(context.Background(), snapshot.ID, &archive); err != nil {
		t.Fatal(err)
	}
	other := mergeTestRepository(t, Options{})
	got, err := other.Import(context.Background(), bytes.NewReader(archive.Bytes()))
	if err != nil || got.ID != snapshot.ID {
		t.Fatalf("import %#v %v", got, err)
	}
	for _, kind := range []string{"bad-hash", "symlink", "duplicate", "missing"} {
		t.Run(kind, func(t *testing.T) {
			bad := mergeTestRepository(t, Options{})
			var payload bytes.Buffer
			writer := tar.NewWriter(&payload)
			manifest, _ := json.Marshal(snapshot)
			writer.WriteHeader(&tar.Header{Name: "manifest.json", Typeflag: tar.TypeReg, Size: int64(len(manifest))})
			writer.Write(manifest)
			entry := snapshot.Entries[0]
			data, _ := r.readObject(entry.Hash, entry.Size)
			if kind != "missing" {
				header := &tar.Header{Name: "objects/" + entry.Hash, Typeflag: tar.TypeReg, Size: entry.Size}
				if kind == "symlink" {
					header.Typeflag = tar.TypeSymlink
					header.Linkname = "/etc/passwd"
					header.Size = 0
				}
				if kind == "bad-hash" {
					data = []byte("evil")
				}
				writer.WriteHeader(header)
				writer.Write(data)
				if kind == "duplicate" {
					writer.WriteHeader(header)
					writer.Write(data)
				}
			}
			writer.Close()
			if _, err := bad.Import(context.Background(), bytes.NewReader(payload.Bytes())); err == nil {
				t.Fatal("accepted invalid archive")
			}
			manifests, _ := os.ReadDir(filepath.Join(bad.root, "manifests"))
			if len(manifests) != 0 {
				t.Fatal("published a partial manifest")
			}
		})
	}
}

func TestGCMarksBranchesPlansAndAgeProtectedManifests(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base, _ := diskSnapshot(t, r, map[string]string{"base": "base"})
	keep, _ := diskSnapshot(t, r, map[string]string{"keep": "keep"})
	orphan, _ := diskSnapshot(t, r, map[string]string{"orphan": "orphan"})
	if _, err := r.CreateBranch(context.Background(), "kept", base.ID); err != nil {
		t.Fatal(err)
	}
	plan, err := r.PlanMerge(context.Background(), base.ID, base.ID, keep.ID)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := r.GC(context.Background(), GCOptions{DryRun: true})
	if err != nil || preview.Manifests != 1 || preview.Objects != 1 {
		t.Fatalf("preview %#v %v", preview, err)
	}
	if _, err = r.GetSnapshot(context.Background(), orphan.ID); err != nil {
		t.Fatal("dry run deleted data")
	}
	result, err := r.GC(context.Background(), GCOptions{MinAge: time.Hour})
	if err != nil || result.Manifests != 0 {
		t.Fatalf("age %#v %v", result, err)
	}
	if _, err = r.GC(context.Background(), GCOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err = r.GetSnapshot(context.Background(), orphan.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if _, err = r.GetMergePlan(context.Background(), plan.ID); err != nil {
		t.Fatal("plan references not preserved", err)
	}
	if err = r.DeleteMergePlan(context.Background(), plan.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = r.GC(context.Background(), GCOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err = r.GetSnapshot(context.Background(), base.ID); err != nil {
		t.Fatal("branch base removed", err)
	}
}
