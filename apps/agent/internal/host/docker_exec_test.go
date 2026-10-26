package host

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestDockerTTYArgumentsAreExplicit(t *testing.T) {
	got, err := dockerTTYArgs("container-id", []string{"bash", "--noprofile", "--norc", "-i"}, "/workspace", map[string]string{"HOME": "/workspace/.zakura/acp/pi/home"})
	want := []string{"exec", "-i", "-t", "-w", "/workspace", "-e", "HOME=/workspace/.zakura/acp/pi/home", "container-id", "bash", "--noprofile", "--norc", "-i"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("args=%q err=%v", got, err)
	}
	for _, id := range []string{"", "--privileged", "x\n-e"} {
		if _, e := dockerTTYArgs(id, []string{"sh"}, "", nil); e == nil {
			t.Fatalf("accepted %q", id)
		}
	}
	if _, e := dockerTTYArgs("container", []string{"sh"}, "", map[string]string{"BAD=ENV": "x"}); e == nil {
		t.Fatal("accepted malformed env")
	}
}

func TestPrivateFileAtomicReplacement(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "credentials.json")
	if err := os.WriteFile(file, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{"new-secret", "next-secret"} {
		rev, err := WritePrivateFile(root, "credentials.json", []byte(content))
		if err != nil || rev == "" {
			t.Fatal(err)
		}
		data, err := os.ReadFile(file)
		if err != nil || string(data) != content {
			t.Fatalf("file=%q err=%v", data, err)
		}
		info, _ := os.Stat(file)
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
			t.Fatalf("mode=%o", info.Mode().Perm())
		}
	}
	files, _ := filepath.Glob(filepath.Join(root, ".zakura-private-*"))
	if len(files) != 0 {
		t.Fatalf("temporary secret files left: %v", files)
	}
	if _, err := WritePrivateFile(root, "../outside", []byte("secret")); err == nil {
		t.Fatal("accepted escape")
	}
}

func TestPrivateFileRefusesSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skip(err)
	}
	if _, err := WritePrivateFile(root, "link/auth", []byte("secret")); err == nil {
		t.Fatal("followed parent symlink")
	}
	dest := filepath.Join(outside, "auth")
	if err := os.WriteFile(dest, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dest, filepath.Join(root, "auth")); err != nil {
		t.Fatal(err)
	}
	if _, err := WritePrivateFile(root, "auth", []byte("secret")); err == nil {
		t.Fatal("followed file symlink")
	}
	data, _ := os.ReadFile(dest)
	if string(data) != "original" {
		t.Fatal("overwrote symlink target")
	}
}
