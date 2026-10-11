package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestInstallPreservesProjectDirectoryModesAndLocalOwnership(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base, original := diskSnapshot(t, r, map[string]string{"dir/existing": "old", "old-name": "move"})
	if err := os.Chmod(original, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(original, "dir"), 0775|os.ModeSetgid); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() == 0 {
		for path, identity := range map[string][2]int{
			original: {12340, 12341}, filepath.Join(original, "dir"): {12342, 12343},
			filepath.Join(original, "dir/existing"): {12344, 12345}, filepath.Join(original, "old-name"): {12346, 12347},
		} {
			if err := os.Chown(path, identity[0], identity[1]); err != nil {
				if os.IsPermission(err) || errors.Is(err, syscall.EINVAL) {
					t.Log("foreign ownership unavailable in this user namespace; checking mapped ownership and access modes")
					break
				}
				t.Fatal(err)
			}
		}
		if err := os.Chmod(filepath.Join(original, "dir"), 0775|os.ModeSetgid); err != nil {
			t.Fatal(err)
		}
	}
	rootInfo, _ := os.Stat(original)
	dirInfo, _ := os.Stat(filepath.Join(original, "dir"))
	fileInfo, _ := os.Stat(filepath.Join(original, "dir/existing"))
	renamedInfo, _ := os.Stat(filepath.Join(original, "old-name"))
	target, _ := diskSnapshot(t, r, map[string]string{"dir/existing": "updated", "dir/new": "new", "new-name": "move", "new-dir/file": "new"})
	if _, err := r.ApplyToDirectory(context.Background(), base.ID, target.ID, original); err != nil {
		t.Fatal(err)
	}
	for path, expected := range map[string]os.FileInfo{
		original: rootInfo, filepath.Join(original, "dir"): dirInfo,
		filepath.Join(original, "dir/existing"): fileInfo, filepath.Join(original, "new-name"): renamedInfo,
		filepath.Join(original, "dir/new"): dirInfo, filepath.Join(original, "new-dir/file"): rootInfo,
	} {
		got, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		expectedUID, expectedGID, supported := fileOwner(expected)
		uid, gid, _ := fileOwner(got)
		if supported && (uid != expectedUID || gid != expectedGID) {
			t.Fatalf("owner %s: %d:%d want %d:%d", path, uid, gid, expectedUID, expectedGID)
		}
		if got.IsDir() && got.Mode()&(os.ModePerm|os.ModeSetgid) != expected.Mode()&(os.ModePerm|os.ModeSetgid) {
			t.Fatalf("directory mode %s: %v want %v", path, got.Mode(), expected.Mode())
		}
	}
	newDirInfo, err := os.Stat(filepath.Join(original, "new-dir"))
	if err != nil || newDirInfo.Mode().Perm() != rootInfo.Mode().Perm() {
		t.Fatalf("new directory access %v %v", newDirInfo, err)
	}
	got, err := r.Snapshot(context.Background(), original)
	if err != nil || got.ID != target.ID {
		t.Fatalf("portable snapshot changed %#v %v", got, err)
	}
}
