//go:build !windows

package rpc

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceMigrationPreservesModesAndSafeSymlinks(t *testing.T) {
	source, sourceRoot := migrationFixture(t)
	if err := os.Chmod(sourceRoot, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(sourceRoot, ".acp", "skills", "run.sh"), 0751); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".acp/skills/run.sh", filepath.Join(sourceRoot, "run")); err != nil {
		t.Fatal(err)
	}
	exported, err := migrationCall(t, source, migrationRequest{SpaceID: "space", MigrationID: "job", Operation: "export"})
	if err != nil {
		t.Fatal(err)
	}
	targetStorage := t.TempDir()
	target := New("computer", targetStorage)
	for _, op := range []string{"prepare", "import", "verify", "commit"} {
		if _, err := migrationCall(t, target, migrationRequest{SpaceID: "space", MigrationID: "job", Operation: op, ArchiveSHA256: exported.ArchiveSHA256, ArchiveBase64: exported.ArchiveBase64}); err != nil {
			t.Fatalf("%s: %v", op, err)
		}
	}
	canonical := filepath.Join(targetStorage, "spaces", "space", "workspace")
	for name, want := range map[string]os.FileMode{".": 0750, ".acp/skills/run.sh": 0751} {
		info, err := os.Stat(filepath.Join(canonical, name))
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("mode %s: %v %v", name, info, err)
		}
	}
	if link, err := os.Readlink(filepath.Join(canonical, "run")); err != nil || link != ".acp/skills/run.sh" {
		t.Fatalf("link: %s %v", link, err)
	}
	if err := os.Symlink("../../outside", filepath.Join(sourceRoot, "unsafe")); err != nil {
		t.Fatal(err)
	}
	if _, err := migrationCall(t, source, migrationRequest{SpaceID: "space", MigrationID: "unsafe", Operation: "inspect"}); err == nil {
		t.Fatal("escaping source link accepted")
	}
}

func TestWorkspaceMigrationRefusesSymlinkParent(t *testing.T) {
	storage := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(storage, "spaces")); err != nil {
		t.Fatal(err)
	}
	h := New("computer", storage)
	if _, err := migrationCall(t, h, migrationRequest{SpaceID: "space", MigrationID: "job", Operation: "prepare"}); err == nil {
		t.Fatal("symlinked spaces parent accepted")
	}
	root, err := os.OpenRoot(outside)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if archive, _, err := migrationArchive(context.Background(), root); err != nil || len(archive) == 0 {
		t.Fatalf("empty archive failed: %v", err)
	}
}
