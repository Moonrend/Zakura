package rpc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
)

func TestWorkspaceContainerReleaseAndDiskReuse(t *testing.T) {
	for _, purpose := range []string{"", "acp-adapter", "acp-login", "component"} {
		t.Run("purpose="+purpose, func(t *testing.T) { testWorkspaceContainerRelease(t, purpose) })
	}
}

func testWorkspaceContainerRelease(t *testing.T, purpose string) {
	h, b := workspaceRPCFixture(t)
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "docker.jsonl")
	t.Setenv("ZAKURA_DOCKER", bin)
	t.Setenv("ZAKURA_TEST_RECEIPT_RPC_LOG", log)
	target := b.Target
	op := docker.CreateOperation{ID: "create-1", TenantID: target.TenantID, SpaceID: target.SpaceID, ComputerID: "computer", InstanceID: target.InstanceID, Generation: target.Generation, DiskID: target.DiskID, LocatorVersion: target.LocatorVersion, NodeIncarnation: target.NodeIncarnation}
	op.Purpose = purpose
	labelPurpose := purpose
	if labelPurpose == "" {
		labelPurpose = "workspace"
	}
	mount, err := h.workspaceState.Mount(b.Disk)
	if err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"workspace": b, "operation": op, "name": "instance-workspace", "image": "workspace:1", "volumes": []docker.Volume{mount},
		"labels": map[string]string{"zakura.tenant": target.TenantID, "zakura.space": target.SpaceID, "zakura.computer": "computer", "zakura.purpose": labelPurpose,
			"zakura.workspace-instance": target.InstanceID, "zakura.workspace-generation": strconv.FormatInt(target.Generation, 10), "zakura.disk": target.DiskID, "zakura.disk-version": strconv.FormatInt(target.LocatorVersion, 10), "zakura.node-incarnation": target.NodeIncarnation}}
	if purpose == "component" {
		request["labels"].(map[string]string)["zakura.instance"] = "component-1"
		if response := createReceiptRPCCall(t, h, "docker.create", request); response.Error == "" {
			t.Fatal("component mounted entire workspace")
		}
		request["volumes"] = []docker.Volume{componentWorkspaceMount(mount, "component-1")}
	}
	for range 2 {
		response := createReceiptRPCCall(t, h, "docker.create", request)
		if response.Error != "" {
			t.Fatal(response.Error)
		}
		h = New("server", h.StorageRoot)
	}
	if response := createReceiptRPCCall(t, h, "host.fs.write", map[string]any{"workspace": b, "path": "keep", "content": "data"}); response.Error != "" {
		t.Fatal(response.Error)
	}
	for _, method := range []string{"docker.start", "docker.stop", "docker.exec", "docker.exec.start", "docker.attach"} {
		response := createReceiptRPCCall(t, h, method, map[string]any{"id": "receipt-rpc-id", "command": []string{"true"}})
		if !strings.Contains(response.Error, "pinned") {
			t.Fatalf("unbound %s: %+v", method, response)
		}
	}
	for _, id := range []string{"instance-workspace", "receipt", "other-container"} {
		response := createReceiptRPCCall(t, h, "docker.exec", map[string]any{"workspace": b, "id": id, "command": []string{"true"}})
		if response.Error == "" {
			t.Fatal("non-exact container accepted")
		}
	}
	response := createReceiptRPCCall(t, h, "docker.exec", map[string]any{"workspace": b, "id": "receipt-rpc-id", "command": []string{"true"}, "timeoutMs": 10000})
	if response.Error != "" || !strings.Contains(string(response.Result), "pinned-execution") {
		t.Fatalf("pinned execution: %+v", response)
	}
	if purpose != "" {
		for range 2 {
			response := createReceiptRPCCall(t, h, "docker.stop", map[string]any{"workspace": b, "id": "receipt-rpc-id", "remove": true})
			if response.Error != "" {
				t.Fatalf("sidecar cleanup: %+v", response)
			}
			h = New("server", h.StorageRoot)
		}
		if response := createReceiptRPCCall(t, h, "host.fs.write", map[string]any{"workspace": b, "path": "still-attached", "content": "yes"}); response.Error != "" {
			t.Fatalf("sidecar cleanup revoked workspace: %+v", response)
		}
		if response := createReceiptRPCCall(t, h, "docker.create", request); response.Error == "" {
			t.Fatal("released sidecar operation restarted")
		}
	}
	for range 2 {
		response := createReceiptRPCCall(t, h, "workspace.release", b)
		if response.Error != "" || !strings.Contains(string(response.Result), `"released":true`) {
			t.Fatalf("release: %+v", response)
		}
	}
	if response := createReceiptRPCCall(t, h, "docker.create", request); !strings.Contains(response.Error, "revoked") {
		t.Fatalf("late create: %+v", response)
	}
	delete(request, "workspace")
	if response := createReceiptRPCCall(t, h, "docker.create", request); !strings.Contains(response.Error, "pinned") {
		t.Fatalf("unfenced create: %+v", response)
	}
	b.Target.InstanceID, b.Target.Generation = "replacement", 2
	if response := createReceiptRPCCall(t, h, "workspace.attach", b); response.Error != "" {
		t.Fatal(response.Error)
	}
	response = createReceiptRPCCall(t, h, "host.fs.read", map[string]any{"workspace": b, "path": "keep"})
	if response.Error != "" || !strings.Contains(string(response.Result), `"content":"data"`) {
		t.Fatalf("retained file: %+v", response)
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	runs, removes := 0, 0
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var args []string
		if err := json.Unmarshal([]byte(line), &args); err != nil {
			t.Fatal(err)
		}
		if args[0] == "run" {
			runs++
		}
		if args[0] == "rm" {
			removes++
		}
	}
	if runs != 1 || removes != 1 {
		t.Fatalf("unexpected repeated effects: run=%d rm=%d", runs, removes)
	}
}
