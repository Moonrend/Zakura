package rpc

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func migrationCall(t *testing.T, h *Handler, p migrationRequest) (migrationResult, error) {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	value, err := h.workspaceMigration(context.Background(), raw)
	if err != nil {
		return migrationResult{}, err
	}
	return value.(migrationResult), nil
}
func migrationFixture(t *testing.T) (*Handler, string) {
	t.Helper()
	storage := t.TempDir()
	root := filepath.Join(storage, "spaces", "space", "workspace")
	if err := os.MkdirAll(filepath.Join(root, ".acp", "skills"), 0750); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"project.txt": "project", ".acp/HOME": "private sentinel", ".acp/skills/run.sh": "#!/bin/sh\nprintf migrated"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0750); err != nil {
			t.Fatal(err)
		}
	}
	return New("computer", storage), root
}
func TestWorkspaceMigrationStagedVerifiedCommitAndRestart(t *testing.T) {
	source, sourceRoot := migrationFixture(t)
	exported, err := migrationCall(t, source, migrationRequest{SpaceID: "space", MigrationID: "job", Operation: "export"})
	if err != nil {
		t.Fatal(err)
	}
	targetStorage := t.TempDir()
	target := New("computer", targetStorage)
	call := func(operation string) migrationResult {
		t.Helper()
		result, err := migrationCall(t, target, migrationRequest{SpaceID: "space", MigrationID: "job", Operation: operation, ArchiveSHA256: exported.ArchiveSHA256, ArchiveBase64: exported.ArchiveBase64})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	prepared, err := migrationCall(t, target, migrationRequest{SpaceID: "space", MigrationID: "job", Operation: "prepare"})
	if err != nil || prepared.Phase != "prepared" {
		t.Fatalf("prepare: %#v %v", prepared, err)
	}
	if result := call("import"); result.Phase != "imported" {
		t.Fatal(result.Phase)
	}
	canonical := filepath.Join(targetStorage, "spaces", "space", "workspace")
	if _, err := os.Stat(canonical); !os.IsNotExist(err) {
		t.Fatal("import wrote canonical workspace")
	}
	if result := call("verify"); result.Phase != "verified" || !result.Verified {
		t.Fatal(result)
	}
	// Reconcile a commit that happened after durable promoting intent but before
	// its committed manifest write (lost response / process restart).
	storageRoot, err := os.OpenRoot(targetStorage)
	if err != nil {
		t.Fatal(err)
	}
	space, err := migrationSpaceRoot(storageRoot, "space", false)
	storageRoot.Close()
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := migrationRealRoot(space, ".workspace-migrations")
	if err != nil {
		t.Fatal(err)
	}
	job, err := migrationRealRoot(jobs, "job")
	jobs.Close()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := migrationReadManifest(job)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Phase = "promoting"
	if err := migrationSaveManifest(job, manifest); err != nil {
		t.Fatal(err)
	}
	if err := space.Rename(".workspace-migrations/job/tree", "workspace"); err != nil {
		t.Fatal(err)
	}
	job.Close()
	space.Close()
	target = New("computer", targetStorage)
	if result := call("status"); result.Phase != "committed" || result.ArchiveSHA256 != exported.ArchiveSHA256 {
		t.Fatal(result)
	}
	if result := call("commit"); result.Phase != "committed" {
		t.Fatal(result)
	}
	for _, root := range []string{sourceRoot, canonical} {
		if b, err := os.ReadFile(filepath.Join(root, ".acp", "HOME")); err != nil || string(b) != "private sentinel" {
			t.Fatalf("HOME missing in %s: %v", root, err)
		}
	}
}

func TestWorkspaceMigrationTamperAndNonemptyTargetRejected(t *testing.T) {
	source, _ := migrationFixture(t)
	exported, err := migrationCall(t, source, migrationRequest{SpaceID: "space", MigrationID: "job", Operation: "export"})
	if err != nil {
		t.Fatal(err)
	}
	targetStorage := t.TempDir()
	target := New("computer", targetStorage)
	p := migrationRequest{SpaceID: "space", MigrationID: "job", Operation: "prepare", ArchiveSHA256: exported.ArchiveSHA256}
	if _, err := migrationCall(t, target, p); err != nil {
		t.Fatal(err)
	}
	p.Operation = "import"
	p.ArchiveBase64 = exported.ArchiveBase64
	if _, err := migrationCall(t, target, p); err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(targetStorage, "spaces", "space", ".workspace-migrations", "job", "tree")
	if err := os.WriteFile(filepath.Join(staged, "extra"), []byte("unexpected"), 0600); err != nil {
		t.Fatal(err)
	}
	p.Operation = "verify"
	if _, err := migrationCall(t, target, p); err == nil {
		t.Fatal("extra entry passed verification")
	}
	if err := os.Remove(filepath.Join(staged, "extra")); err != nil {
		t.Fatal(err)
	}
	canonical := filepath.Join(targetStorage, "spaces", "space", "workspace")
	if err := os.Mkdir(canonical, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(canonical, "keep"), []byte("mine"), 0600); err != nil {
		t.Fatal(err)
	}
	p.Operation = "commit"
	if _, err := migrationCall(t, target, p); err == nil {
		t.Fatal("nonempty canonical overwritten")
	}
	p.Operation = "import"
	p.ArchiveSHA256 = strings.Repeat("0", 64)
	if _, err := migrationCall(t, target, p); err == nil {
		t.Fatal("different digest reused job")
	}
	if b, err := os.ReadFile(filepath.Join(canonical, "keep")); err != nil || string(b) != "mine" {
		t.Fatal("target user data lost")
	}
}

func TestWorkspaceMigrationRejectsUnsafeArchives(t *testing.T) {
	for _, tc := range []struct {
		name   string
		header tar.Header
	}{{"traversal", tar.Header{Name: "../escape", Typeflag: tar.TypeReg, Mode: 0600}}, {"device", tar.Header{Name: "device", Typeflag: tar.TypeChar, Mode: 0600}}, {"suid", tar.Header{Name: "suid", Typeflag: tar.TypeReg, Mode: 04755}}, {"unsafe-link", tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Mode: 0777, Linkname: "../../escape"}}, {"absolute", tar.Header{Name: "/escape", Typeflag: tar.TypeReg, Mode: 0600}}} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			gz := gzip.NewWriter(&buf)
			writer := tar.NewWriter(gz)
			_ = writer.WriteHeader(&tar.Header{Name: ".", Typeflag: tar.TypeDir, Mode: 0755})
			_ = writer.WriteHeader(&tc.header)
			writer.Close()
			gz.Close()
			target := New("computer", t.TempDir())
			p := migrationRequest{SpaceID: "space", MigrationID: "job", Operation: "prepare", ArchiveSHA256: migrationDigest(buf.Bytes())}
			if _, err := migrationCall(t, target, p); err != nil {
				t.Fatal(err)
			}
			p.Operation = "import"
			p.ArchiveBase64 = base64.StdEncoding.EncodeToString(buf.Bytes())
			if _, err := migrationCall(t, target, p); err == nil {
				t.Fatal("unsafe archive imported")
			}
		})
	}
}

func TestMigrationPromoteDoesNotReplaceRacingTarget(t *testing.T) {
	storage := t.TempDir()
	if err := os.MkdirAll(filepath.Join(storage, "job", "tree"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(storage, "workspace"), 0700); err != nil {
		t.Fatal(err)
	}
	space, err := os.OpenRoot(storage)
	if err != nil {
		t.Fatal(err)
	}
	defer space.Close()
	job, err := migrationRealRoot(space, "job")
	if err != nil {
		t.Fatal(err)
	}
	defer job.Close()
	if err := migrationPromote(job, space); err == nil {
		t.Fatal("existing target replaced")
	}
	if _, err := job.Stat("tree"); err != nil {
		t.Fatal("staging tree lost on failed promotion")
	}
}

func TestWorkspaceMigrationInspectionLimitAndIdentity(t *testing.T) {
	source, root := migrationFixture(t)
	file, err := os.Create(filepath.Join(root, "too-large"))
	if err != nil {
		t.Fatal(err)
	}
	err = file.Truncate(migrationExpandedLimit + 1)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := migrationCall(t, source, migrationRequest{SpaceID: "space", MigrationID: "job", Operation: "inspect"}); err == nil || !strings.Contains(err.Error(), "64 MiB") {
		t.Fatalf("limit not rejected before downtime: %v", err)
	}
	if _, err := migrationCall(t, source, migrationRequest{SpaceID: "../other", MigrationID: "job", Operation: "inspect"}); err == nil {
		t.Fatal("invalid space accepted")
	}
	if _, err := migrationCall(t, source, migrationRequest{SpaceID: "space", MigrationID: "../job", Operation: "prepare"}); err == nil {
		t.Fatal("invalid job accepted")
	}
}
