// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

func localFSTest(t *testing.T) (workspaceFS, string) {
	t.Helper()
	return workspaceFS{root: t.TempDir()}, t.TempDir()
}
func linkForTest(t *testing.T, target, name string) {
	t.Helper()
	if err := os.Symlink(target, name); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
}
func TestWorkspaceRootedOperationsRejectEscapingSymlinks(t *testing.T) {
	f, outside := localFSTest(t)
	secret := filepath.Join(outside, "secret")
	_ = os.WriteFile(secret, []byte("untouched"), 0600)
	linkForTest(t, outside, filepath.Join(f.root, "escape"))
	if file, err := f.openLocal("/escape/secret"); err == nil {
		file.Close()
		t.Fatal("read escaped root")
	}
	if _, err := f.statLocal("escape/secret"); err == nil {
		t.Fatal("stat escaped root")
	}
	if _, err := f.writeLocal("escape/secret", []byte("bad"), false, "", 0640); err == nil {
		t.Fatal("write escaped root")
	}
	if err := f.uploadLocal("escape/upload", bytes.NewBufferString("bad")); err == nil {
		t.Fatal("upload escaped root")
	}
	if err := f.mkdirLocal("escape/dir"); err == nil {
		t.Fatal("mkdir escaped root")
	}
	if err := f.removeLocal("escape/secret", true); err == nil {
		t.Fatal("remove escaped root")
	}
	if err := f.renameLocal("escape/secret", "stolen"); err == nil {
		t.Fatal("rename source escaped root")
	}
	_, _ = f.writeLocal("inside", []byte("ok"), false, "", 0640)
	if err := f.renameLocal("inside", "escape/stolen"); err == nil {
		t.Fatal("rename target escaped root")
	}
	if _, err := archiveRootedWorkspace(f, []string{"escape"}); err == nil {
		t.Fatal("archive followed escaping symlink")
	}
	data, _ := os.ReadFile(secret)
	if string(data) != "untouched" {
		t.Fatalf("outside file changed %q", data)
	}
	if err := f.removeLocal("escape", true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(secret); err != nil {
		t.Fatal("removing symlink removed target")
	}
}
func TestWorkspaceRootedWriteRevisionAppendAndUpload(t *testing.T) {
	f, _ := localFSTest(t)
	written, err := f.writeLocal("/nested/note", []byte("one"), false, "", 0640)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.writeLocal("nested/note", []byte("bad"), false, "stale", 0640); !errors.Is(err, ErrConflict) {
		t.Fatalf("revision conflict %v", err)
	}
	written, err = f.writeLocal("nested/note", []byte("two"), true, workspaceRevision(written), 0640)
	if err != nil || string(written) != "onetwo" {
		t.Fatalf("append %q %v", written, err)
	}
	if err = f.uploadLocal("uploads/image.bin", bytes.NewReader([]byte{0, 255})); err != nil {
		t.Fatal(err)
	}
	file, err := f.openLocal("uploads/image.bin")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(file)
	file.Close()
	if !bytes.Equal(data, []byte{0, 255}) {
		t.Fatal("upload bytes changed")
	}
	if err = f.renameLocal("nested/note", "renamed/note"); err != nil {
		t.Fatal(err)
	}
	if err = f.removeLocal("/", true); err == nil {
		t.Fatal("removed workspace root")
	}
	if err = f.renameLocal(".", "moved"); err == nil {
		t.Fatal("renamed workspace root")
	}
}
func makeLocalTar(t *testing.T, name, content string, flag byte) []byte {
	t.Helper()
	var raw bytes.Buffer
	writer := tar.NewWriter(&raw)
	size := int64(len(content))
	if flag != tar.TypeReg {
		size = 0
	}
	if err := writer.WriteHeader(&tar.Header{Name: name, Typeflag: flag, Mode: 0640, Size: size, Linkname: "outside"}); err != nil {
		t.Fatal(err)
	}
	if size > 0 {
		_, _ = writer.Write([]byte(content))
	}
	_ = writer.Close()
	return raw.Bytes()
}
func makeLocalZip(t *testing.T, name, content string) []byte {
	t.Helper()
	var raw bytes.Buffer
	writer := zip.NewWriter(&raw)
	file, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte(content))
	_ = writer.Close()
	return raw.Bytes()
}
func TestWorkspaceRootedArchiveAndExtract(t *testing.T) {
	f, _ := localFSTest(t)
	_, err := f.writeLocal("nested/note", []byte("payload"), false, "", 0640)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := archiveRootedWorkspace(f, []string{"nested", "nested/note"})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.uploadLocal("bundle.tgz", bytes.NewReader(archive)); err != nil {
		t.Fatal(err)
	}
	if err = extractRootedWorkspace(f, "bundle.tgz", "out"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(f.root, "out", "nested", "note"))
	if string(data) != "payload" {
		t.Fatalf("archive roundtrip %q", data)
	}
	for _, format := range []string{"tar", "zip"} {
		t.Run(format, func(t *testing.T) {
			outside := t.TempDir()
			secret := filepath.Join(outside, "secret")
			_ = os.WriteFile(secret, []byte("untouched"), 0600)
			dest := filepath.Join(f.root, "destination-"+format)
			_ = os.MkdirAll(dest, 0750)
			linkForTest(t, outside, filepath.Join(dest, "escape"))
			var archive []byte
			if format == "tar" {
				archive = makeLocalTar(t, "escape/secret", "bad", tar.TypeReg)
			} else {
				archive = makeLocalZip(t, "escape/secret", "bad")
			}
			source := "attack." + format
			_ = f.uploadLocal(source, bytes.NewReader(archive))
			if err := extractRootedWorkspace(f, source, "destination-"+format); err == nil {
				t.Fatal("extraction escaped destination")
			}
			data, _ := os.ReadFile(secret)
			if string(data) != "untouched" {
				t.Fatal("extraction changed outside file")
			}
		})
	}
	for _, name := range []string{"../escape", "/absolute", "C:/drive", "dir\\escape", "a/../../escape"} {
		archive := makeLocalTar(t, name, "bad", tar.TypeReg)
		_ = f.uploadLocal("bad.tar", bytes.NewReader(archive))
		if err = extractRootedWorkspace(f, "bad.tar", "safe"); err == nil {
			t.Fatalf("accepted archive path %q", name)
		}
	}
	_ = f.uploadLocal("links.tar", bytes.NewReader(makeLocalTar(t, "link", "", tar.TypeSymlink)))
	if err = extractRootedWorkspace(f, "links.tar", "safe"); err == nil {
		t.Fatal("accepted archive symlink")
	}
}
func TestWorkspaceRootedExistingLeafSymlinkIsNotFollowedOnWrite(t *testing.T) {
	f, outside := localFSTest(t)
	secret := filepath.Join(outside, "secret")
	_ = os.WriteFile(secret, []byte("untouched"), 0600)
	linkForTest(t, secret, filepath.Join(f.root, "leaf"))
	if _, err := f.writeLocal("leaf", []byte("new"), false, "", 0640); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(secret)
	if string(data) != "untouched" {
		t.Fatal("atomic replacement followed leaf symlink")
	}
}
func TestWorkspaceRootedConcurrentParentSwapCannotEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows directory junction replacement has different sharing semantics; static rooted symlink tests cover Windows")
	}
	f, outside := localFSTest(t)
	_ = os.WriteFile(filepath.Join(outside, "secret"), []byte("untouched"), 0600)
	dir := filepath.Join(f.root, "dir")
	park := filepath.Join(f.root, "park")
	_ = os.Mkdir(dir, 0750)
	_ = os.WriteFile(filepath.Join(dir, "secret"), []byte("inside"), 0640)
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if os.Rename(dir, park) == nil {
				_ = os.Symlink(outside, dir)
				_ = os.Remove(dir)
				_ = os.Rename(park, dir)
			}
		}
	}()
	for i := 0; i < 200; i++ {
		file, err := f.openLocal("dir/secret")
		if err == nil {
			data, _ := io.ReadAll(file)
			file.Close()
			if string(data) == "untouched" {
				close(stop)
				wg.Wait()
				t.Fatal("read raced outside root")
			}
		}
		_, _ = f.writeLocal("dir/secret", []byte("inside"), false, "", 0640)
		_ = f.uploadLocal("dir/upload", bytes.NewBufferString("inside"))
		_ = f.removeLocal("dir/delete", true)
		_, _ = archiveRootedWorkspace(f, []string{"dir"})
	}
	close(stop)
	wg.Wait()
	data, _ := os.ReadFile(filepath.Join(outside, "secret"))
	if string(data) != "untouched" {
		t.Fatal("parent swap modified outside file")
	}
	if _, err := os.Stat(filepath.Join(outside, "upload")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("parent swap uploaded outside root")
	}
}
