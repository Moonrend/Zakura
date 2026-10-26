package host

import (
	"bytes"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestFilesystemRefusesSymlinkEscapes(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skip(err)
	}
	operations := map[string]func() error{
		"stat":             func() error { _, e := Stat(root, "escape/secret"); return e },
		"list":             func() error { _, e := List(root, "escape"); return e },
		"read":             func() error { _, e := ReadFile(root, "escape/secret", 100); return e },
		"write":            func() error { _, e := WriteFile(root, "escape/secret", []byte("stolen")); return e },
		"private":          func() error { _, e := WritePrivateFile(root, "escape/secret", []byte("stolen")); return e },
		"mkdir":            func() error { return Mkdir(root, "escape/new") },
		"remove":           func() error { return Remove(root, "escape/secret", false) },
		"remove-recursive": func() error { return Remove(root, "escape/secret", true) },
		"rename-source":    func() error { return Rename(root, "escape/secret", "new") },
		"rename-destination": func() error {
			if _, e := WriteFile(root, "source", []byte("data")); e != nil {
				return e
			}
			return Rename(root, "source", "escape/new")
		},
		"copy": func() error { return CopyFile(root, "escape/secret", &bytes.Buffer{}) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if e := operation(); e == nil {
				t.Fatal("symlink escaped workspace")
			}
		})
	}
	data, err := os.ReadFile(filepath.Join(outside, "secret"))
	if err != nil || string(data) != "outside" {
		t.Fatalf("outside changed: %q %v", data, err)
	}
}

func TestFilesystemParentSwapCannotEscape(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "test-link")); err != nil {
		t.Skip(err)
	}
	_ = os.Remove(filepath.Join(root, "test-link"))
	if err := os.WriteFile(filepath.Join(outside, "auth"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
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
			if os.Rename(target, filepath.Join(root, "held")) != nil {
				continue
			}
			if os.Symlink(outside, target) == nil {
				_ = os.Remove(target)
			}
			_ = os.Rename(filepath.Join(root, "held"), target)
		}
	}()
	for i := 0; i < 200; i++ {
		_, _ = WritePrivateFile(root, "target/auth", []byte("credential"))
		_, _ = WriteFile(root, "target/auth", []byte("regular"))
		if data, e := ReadFile(root, "target/auth", 100); e == nil && string(data) == "outside" {
			close(stop)
			wg.Wait()
			t.Fatal("read outside during parent swap")
		}
	}
	close(stop)
	wg.Wait()
	data, err := os.ReadFile(filepath.Join(outside, "auth"))
	if err != nil || string(data) != "outside" {
		t.Fatalf("outside file changed by race: %q %v", data, err)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 1 {
		t.Fatalf("outside secret/temp files created: %v %v", entries, err)
	}
}
