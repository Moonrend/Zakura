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
