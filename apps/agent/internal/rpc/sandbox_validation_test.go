package rpc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sandboxCall(t *testing.T, h *Handler, method string, p any) Msg {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var response Msg
	h.Dispatch(context.Background(), Msg{ID: "sandbox-test", Method: method, Params: raw}, func(msg Msg) { response = msg })
	return response
}

func TestSandboxRPCPolicyAndEnforcement(t *testing.T) {
	t.Setenv("ZAKURA_SANDBOX_ENABLED", "")
	h := New("computer", t.TempDir())
	for _, mode := range []string{"", "host"} {
		enabled, err := h.sandboxRequested(json.RawMessage(`{"executionMode":"` + mode + `"}`))
		if err != nil || enabled {
			t.Fatalf("legacy mode unexpectedly isolated: %v %v", enabled, err)
		}
	}
	t.Setenv("ZAKURA_SANDBOX_ENABLED", "true")
	enforced := New("computer", t.TempDir())
	t.Setenv("ZAKURA_SANDBOX_ENABLED", "")
	enabled, err := enforced.sandboxRequested(json.RawMessage(`{"executionMode":"host"}`))
	if err != nil || !enabled {
		t.Fatalf("request downgraded operator policy: %v %v", enabled, err)
	}
	result := sandboxCall(t, enforced, "sandbox.policy", map[string]any{})
	var policy struct {
		Enforced     bool   `json:"enforced"`
		Default      string `json:"defaultExecutionMode"`
		HostIsolated bool   `json:"hostModeIsolated"`
	}
	if err := json.Unmarshal(result.Result, &policy); err != nil {
		t.Fatal(err)
	}
	if !policy.Enforced || policy.Default != "sandbox" || policy.HostIsolated {
		t.Fatalf("incorrect policy disclosure: %+v", policy)
	}
}

func TestSandboxRPCRejectsUnsupportedTransports(t *testing.T) {
	t.Setenv("ZAKURA_SANDBOX_ENABLED", "")
	h := New("computer", t.TempDir())
	for _, method := range []string{"host.pty.start", "docker.run", "docker.exec", "docker.exec.start", "docker.attach", "docker.recreate"} {
		t.Run(method, func(t *testing.T) {
			result := sandboxCall(t, h, method, map[string]any{"executionMode": "sandbox", "spaceId": "space-a"})
			if result.Error == "" || !strings.Contains(result.Error, "sandbox") {
				t.Fatalf("unsupported transport was not refused: %+v", result)
			}
		})
	}
	for _, method := range []string{"host.exec", "host.exec.start", "host.exec.get", "host.exec.kill"} {
		result := sandboxCall(t, h, method, map[string]any{"executionMode": "unknown"})
		if result.Error == "" {
			t.Fatalf("%s accepted unknown execution mode", method)
		}
	}
	var response Msg
	h.Dispatch(context.Background(), Msg{ID: "invalid", Method: "host.exec", Params: json.RawMessage(`{"`)}, func(msg Msg) { response = msg })
	if response.Error == "" {
		t.Fatal("malformed policy accepted")
	}
}

func TestSandboxRPCRequiresWorkspaceAndAvailableBackend(t *testing.T) {
	t.Setenv("ZAKURA_SANDBOX_ENABLED", "")
	t.Setenv("ZAKURA_SANDBOX_IMAGE", "")
	h := New("computer", t.TempDir())
	for _, method := range []string{"host.exec", "host.exec.start", "host.exec.get", "host.exec.kill"} {
		result := sandboxCall(t, h, method, map[string]any{"executionMode": "sandbox", "command": []string{"printf", "hello"}})
		if result.Error == "" || !strings.Contains(result.Error, "spaceId") {
			t.Fatalf("%s accepted absent workspace: %+v", method, result)
		}
	}
	result := sandboxCall(t, h, "host.exec", map[string]any{"executionMode": "sandbox", "spaceId": "space-a", "command": []string{"printf", "hello"}})
	if result.Error == "" || !strings.Contains(result.Error, "ZAKURA_SANDBOX_IMAGE") {
		t.Fatalf("missing image did not fail closed: %+v", result)
	}
	for _, method := range []string{"host.exec.get", "host.exec.kill"} {
		result = sandboxCall(t, h, method, map[string]any{"executionMode": "sandbox", "spaceId": "space-b", "id": "unknown-job"})
		if result.Error == "" || !strings.Contains(result.Error, "not found") {
			t.Fatalf("unknown job exposed: %+v", result)
		}
	}
}

func TestSandboxRPCRejectsSymlinkWorkspaceRoot(t *testing.T) {
	t.Setenv("ZAKURA_SANDBOX_ENABLED", "")
	storage := t.TempDir()
	target := t.TempDir()
	if err := os.MkdirAll(filepath.Join(storage, "spaces", "space-a"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(storage, "spaces", "space-a", "workspace")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	h := New("computer", storage)
	if _, err := h.sandboxRoot("space-a"); err == nil {
		t.Fatal("symlink workspace accepted")
	}
}
