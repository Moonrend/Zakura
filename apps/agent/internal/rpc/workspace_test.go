package rpc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/agent/internal/workspacestate"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

func workspaceRPCFixture(t *testing.T) (*Handler, protocol.Binding) {
	t.Helper()
	t.Setenv("ZAKURA_AGENT_STATE_DIR", t.TempDir())
	t.Setenv("ZAKURA_WORKSPACE_VOLUME", "")
	h := New("server", t.TempDir())
	response := createReceiptRPCCall(t, h, "workspace.identity", map[string]any{})
	var identity workspacestate.Identity
	if err := json.Unmarshal(response.Result, &identity); err != nil || response.Error != "" {
		t.Fatalf("identity: %+v %v", response, err)
	}
	b := protocol.Binding{
		Target: protocol.Target{TenantID: "tenant", SpaceID: "space", InstanceID: "instance", Generation: 1, NodeID: "node", NodeIncarnation: identity.Incarnation, DiskID: "disk", LocatorVersion: 1},
		Disk:   protocol.Disk{TenantID: "tenant", DiskID: "disk", NodeIncarnation: identity.Incarnation, LocatorVersion: 1, Locator: protocol.Locator{Kind: "directory", RelativePath: "disks/disk/workspace"}},
	}
	for method, params := range map[string]any{"workspace.disk.allocate": b.Disk} {
		if response := createReceiptRPCCall(t, h, method, params); response.Error != "" {
			t.Fatal(response.Error)
		}
	}
	if response := createReceiptRPCCall(t, h, "workspace.attach", b); response.Error != "" {
		t.Fatal(response.Error)
	}
	return h, b
}

func TestPinnedWorkspaceFileRPCAndRevocation(t *testing.T) {
	h, b := workspaceRPCFixture(t)
	params := map[string]any{"workspace": b, "path": "/workspace/keep.txt", "content": "persistent"}
	for _, method := range []string{"host.fs.write", "host.fs.read", "host.fs.stat"} {
		response := createReceiptRPCCall(t, h, method, params)
		if response.Error != "" || !strings.Contains(string(response.Result), `"path":"/keep.txt"`) {
			t.Fatalf("%s: %+v", method, response)
		}
	}
	if response := createReceiptRPCCall(t, h, "workspace.revoke", b); response.Error != "" {
		t.Fatal(response.Error)
	}
	h = New("server", h.StorageRoot)
	for _, method := range []string{"host.fs.write", "host.fs.read", "host.fs.stat", "host.fs.mkdir"} {
		response := createReceiptRPCCall(t, h, method, params)
		if response.Error == "" || !strings.Contains(response.Error, "revoked") {
			t.Fatalf("revoked %s: %+v", method, response)
		}
	}
	raw, err := os.ReadFile(filepath.Join(h.StorageRoot, "disks/disk/workspace/keep.txt"))
	if err != nil || string(raw) != "persistent" {
		t.Fatalf("revocation changed disk contents: %q %v", raw, err)
	}
}

func TestPinnedWorkspaceNeverFallsBackToLegacyPath(t *testing.T) {
	h, b := workspaceRPCFixture(t)
	for _, value := range []any{nil, "invalid", map[string]any{}, map[string]any{"target": b.Target, "disk": b.Disk, "unknown": true}} {
		response := createReceiptRPCCall(t, h, "host.fs.write", map[string]any{"workspace": value, "spaceId": "space", "path": "fallback", "content": "bad"})
		if response.Error == "" {
			t.Fatalf("invalid binding fell back: %+v", response)
		}
	}
	for _, field := range []string{"root", "spaceId"} {
		params := map[string]any{"workspace": b, "path": "fallback", "content": "bad", field: "other"}
		if response := createReceiptRPCCall(t, h, "host.fs.write", params); response.Error == "" {
			t.Fatalf("%s override accepted", field)
		}
	}
	for _, method := range []string{"host.exec", "host.exec.start", "host.pty.start", "host.fs.migration", "docker.run"} {
		if response := createReceiptRPCCall(t, h, method, map[string]any{"workspace": b}); response.Error == "" {
			t.Fatalf("unfenced %s accepted", method)
		}
	}
	if _, err := os.Stat(filepath.Join(h.StorageRoot, "spaces")); !os.IsNotExist(err) {
		t.Fatalf("legacy root created: %v", err)
	}
}
