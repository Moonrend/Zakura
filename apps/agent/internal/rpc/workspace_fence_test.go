package rpc

import (
	"strings"
	"testing"
)

func TestUnpinnedRequestsCannotReachManagedDisks(t *testing.T) {
	h, b := workspaceRPCFixture(t)
	denied := []struct {
		method string
		params map[string]any
	}{
		{"host.fs.read", map[string]any{"path": "/disks/disk/workspace/file"}},
		{"host.fs.write", map[string]any{"path": "disks/disk/workspace/file", "content": "x"}},
		{"host.fs.list", map[string]any{"path": "/.workspaces"}},
		{"host.fs.rename", map[string]any{"oldPath": "/tmp-file", "newPath": "/disks/disk/workspace/file"}},
		{"host.fs.list", map[string]any{"root": h.StorageRoot + "/disks/disk/workspace", "path": "/"}},
		{"host.exec", map[string]any{"command": []string{"true"}, "workingDir": "/disks/disk/workspace"}},
		{"docker.create", map[string]any{"image": "busybox", "volumes": []map[string]any{{"hostPath": h.StorageRoot + "/disks/disk/workspace", "containerPath": "/workspace"}}}},
	}
	for _, c := range denied {
		response := createReceiptRPCCall(t, h, c.method, c.params)
		if !strings.Contains(response.Error, "pinned workspace binding") {
			t.Fatalf("%s %v was not fenced: %+v", c.method, c.params, response)
		}
	}
	// A pinned request into the same disk still works.
	pinned := createReceiptRPCCall(t, h, "host.fs.write", map[string]any{"workspace": b, "path": "/file", "content": "x"})
	if pinned.Error != "" {
		t.Fatalf("pinned write: %+v", pinned)
	}
	// Legacy Space workspaces stay reachable without a binding.
	legacy := createReceiptRPCCall(t, h, "host.fs.mkdir", map[string]any{"spaceId": "space", "path": "/"})
	if legacy.Error != "" {
		t.Fatalf("legacy mkdir: %+v", legacy)
	}
}
