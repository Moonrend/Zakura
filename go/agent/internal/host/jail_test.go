package host

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestJailRejectsEscape(t *testing.T) {
	root := t.TempDir()
	if _, err := Jail(root, "../etc/passwd"); err == nil {
		t.Fatal("应拒绝 .. 越狱")
	}
	p, err := Jail(root, "a/b.txt")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "a", "b.txt")
	if p != want {
		t.Fatalf("got %s want %s", p, want)
	}
	if runtime.GOOS == "windows" {
		if _, err := Jail(root, `C:\Windows\System32`); err == nil {
			t.Fatal("Windows 应拒绝盘符绝对路径")
		}
	}
}

func TestJailWorkspaceAliases(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"shots/a.png", "/shots/a.png", "/workspace/shots/a.png", filepath.Join(root, "shots", "a.png"), "shots/old/../a.png"} {
		t.Run(rel, func(t *testing.T) {
			got, err := Jail(root, rel)
			want := filepath.Join(root, "shots", "a.png")
			if err != nil || got != want {
				t.Fatalf("Jail(%q) = %q, %v; want %q", rel, got, err, want)
			}
		})
	}
	for _, rel := range []string{"workspace/a.txt", "/workspace/workspace/a.txt", filepath.Join(root, "workspace", "a.txt")} {
		got, err := Jail(root, rel)
		if err != nil || got != filepath.Join(root, "workspace", "a.txt") {
			t.Fatalf("must strip only one prefix: %q => %q, %v", rel, got, err)
		}
	}
	for _, rel := range []string{"..notes/a.txt", "/workspace-other/a.txt"} {
		if _, err := Jail(root, rel); err != nil {
			t.Fatalf("valid workspace path %q rejected: %v", rel, err)
		}
	}
}

func TestJailRejectsEscapesAfterWorkspacePrefixes(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"../outside", "/../outside", "/workspace/../outside", root + "/../outside", `..\outside`, "a\x00b"} {
		if _, err := Jail(root, rel); err == nil {
			t.Errorf("must reject %q", rel)
		}
	}
}

func TestRoundtripWriteRead(t *testing.T) {
	root := t.TempDir()
	if _, err := WriteFile(root, "hello.txt", []byte("hi")); err != nil {
		t.Fatal(err)
	}
	b, err := ReadFile(root, "hello.txt", 1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "hi" {
		t.Fatalf("got %q", b)
	}
}
