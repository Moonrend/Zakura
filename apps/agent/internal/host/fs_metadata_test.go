package host

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFilesystemEntrySerializesRealMode(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o750); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"file", "dir"} {
		t.Run(name, func(t *testing.T) {
			info, err := os.Lstat(filepath.Join(root, name))
			if err != nil {
				t.Fatal(err)
			}
			for _, stat := range []func(string, string) (Entry, error){Stat, Lstat} {
				entry, err := stat(root, "/workspace/"+name)
				if err != nil {
					t.Fatal(err)
				}
				if entry.Mode != info.Mode().String() || entry.IsDir != info.IsDir() || entry.Size != info.Size() || entry.Path != "/"+name {
					t.Fatalf("metadata=%+v, mode=%s", entry, info.Mode())
				}
				data, err := json.Marshal(entry)
				if err != nil {
					t.Fatal(err)
				}
				var wire map[string]any
				if err := json.Unmarshal(data, &wire); err != nil || wire["mode"] != info.Mode().String() {
					t.Fatalf("mode not serialized: %s (%v)", data, err)
				}
			}
		})
	}
	entries, err := List(root, ".")
	if err != nil || len(entries) != 2 {
		t.Fatalf("list=%+v err=%v", entries, err)
	}
	for _, entry := range entries {
		info, err := os.Lstat(filepath.Join(root, entry.Name))
		if err != nil || entry.Mode != info.Mode().String() {
			t.Fatalf("list mode=%q info=%v err=%v", entry.Mode, info, err)
		}
	}
}

func metadataSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlinks unavailable: %v", err)
		}
		t.Fatal(err)
	}
}

func TestFilesystemNoFollowLinkMetadataAndBoundaries(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("inside"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	relativeOutside, err := filepath.Rel(root, filepath.Join(outside, "secret"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, target string
		followOK     bool
		isDir        bool
	}{
		{"inside-link", "file", true, false},
		{"directory-link", "dir", true, true},
		{"outside-link", filepath.Join(outside, "secret"), false, false},
		{"relative-outside-link", relativeOutside, false, false},
		{"dangling-link", "missing", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			link := filepath.Join(root, tc.name)
			metadataSymlink(t, tc.target, link)
			info, err := os.Lstat(link)
			if err != nil {
				t.Fatal(err)
			}
			entry, err := Lstat(root, tc.name)
			if err != nil || entry.Mode != info.Mode().String() || !strings.Contains(entry.Mode, "L") || entry.IsDir || entry.Size != info.Size() {
				t.Fatalf("no-follow metadata=%+v err=%v", entry, err)
			}
			followed, err := Stat(root, tc.name)
			if !tc.followOK {
				if err == nil {
					t.Fatalf("followed dangling/outside link: %+v", followed)
				}
				return
			}
			target, statErr := os.Stat(link)
			if err != nil || statErr != nil || followed.Mode != target.Mode().String() || followed.IsDir != tc.isDir || followed.Path != "/"+tc.name {
				t.Fatalf("legacy stat=%+v err=%v target=%v err=%v", followed, err, target, statErr)
			}
		})
	}
	entries, err := List(root, ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		info, err := os.Lstat(filepath.Join(root, entry.Name))
		if err != nil || entry.Mode != info.Mode().String() || entry.IsDir != info.IsDir() {
			t.Fatalf("list follows link or loses metadata: %+v info=%v err=%v", entry, info, err)
		}
	}

	metadataSymlink(t, outside, filepath.Join(root, "escape"))
	for _, path := range []string{"escape/secret", "escape/missing", "../secret"} {
		if entry, err := Lstat(root, path); err == nil {
			t.Fatalf("no-follow escaped through parent %q: %+v", path, entry)
		}
	}
	// In-root parent links remain compatible. Lstat does not promise that every
	// intermediate component is a directory rather than a link, or a snapshot.
	if err := os.WriteFile(filepath.Join(root, "dir", "child"), []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	metadataSymlink(t, "dir", filepath.Join(root, "parent"))
	entry, err := Lstat(root, "parent/child")
	if err != nil || !strings.HasPrefix(entry.Mode, "-") {
		t.Fatalf("bounded in-root parent metadata=%+v err=%v", entry, err)
	}
}
