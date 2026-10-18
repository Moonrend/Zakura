//go:build !windows

package host

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestFilesystemNoFollowSpecialMetadata(t *testing.T) {
	// A short /tmp path also fits the Unix-domain socket limit on macOS.
	root, err := os.MkdirTemp("/tmp", "fs-mode-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	if err := unix.Mkfifo(filepath.Join(root, "fifo"), 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(root, "socket"))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	for name, prefix := range map[string]string{"fifo": "p", "socket": "S"} {
		t.Run(name, func(t *testing.T) {
			info, err := os.Lstat(filepath.Join(root, name))
			if err != nil {
				t.Fatal(err)
			}
			for _, stat := range []func(string, string) (Entry, error){Stat, Lstat} {
				entry, err := stat(root, name)
				if err != nil || entry.Mode != info.Mode().String() || !strings.HasPrefix(entry.Mode, prefix) || entry.IsDir {
					t.Fatalf("special metadata=%+v mode=%s err=%v", entry, info.Mode(), err)
				}
			}
		})
	}
	entries, err := List(root, ".")
	if err != nil || len(entries) != 2 {
		t.Fatalf("special list=%+v err=%v", entries, err)
	}
	for _, entry := range entries {
		info, err := os.Lstat(filepath.Join(root, entry.Name))
		if err != nil || entry.Mode != info.Mode().String() {
			t.Fatalf("special list lost mode: %+v info=%v err=%v", entry, info, err)
		}
	}
}
