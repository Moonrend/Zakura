package sandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This test requires a real local Docker daemon and a pre-pulled trusted image.
// Explicit opt-in makes backend failure fatal, never a successful skipped check.
func TestSandboxRealDockerIntegration(t *testing.T) {
	if os.Getenv("ZAKURA_SANDBOX_INTEGRATION") != "1" {
		t.Skip("real Docker isolation not requested; unit fixtures do not prove isolation")
	}
	if os.Getenv("ZAKURA_SANDBOX_IMAGE") == "" {
		t.Fatal("integration requires pre-pulled ZAKURA_SANDBOX_IMAGE")
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Fatalf("Docker required for opted-in integration: %v", err)
	}
	listContainers := func() map[string]bool {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := dockerCommand(ctx, "docker", "container", "ls", "--all", "--filter", "name=zakura-sandbox-", "--format", "{{.ID}}")
		output, err := cmd.Output()
		if err != nil {
			t.Fatalf("cannot verify real Docker containers: %v", err)
		}
		ids := map[string]bool{}
		for _, id := range strings.Fields(string(output)) {
			ids[id] = true
		}
		return ids
	}
	baseline := listContainers()
	t.Cleanup(func() {
		for id := range listContainers() {
			if !baseline[id] {
				t.Errorf("sandbox container remains after execution: %s", id)
			}
		}
	})
	root := t.TempDir()
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "input.txt"), []byte("workspace fixture"), 0644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_TEST_PARENT_SECRET", "must-not-be-inherited")
	run := func(t *testing.T, command ...string) ExecResult {
		t.Helper()
		result, err := Run(context.Background(), root, ExecParams{Command: command, TimeoutMs: 10000})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	t.Run("workspace and user", func(t *testing.T) {
		result := run(t, "sh", "-c", "cat /workspace/input.txt; printf '\n'; id -u; pwd")
		if result.ExitCode != 0 || result.Stdout != "workspace fixture\n65534\n/workspace\n" {
			t.Fatalf("workspace/user mismatch: %+v", result)
		}
	})
	t.Run("read only workspace", func(t *testing.T) {
		result := run(t, "touch", "/workspace/ordinary-output.txt")
		if result.ExitCode == 0 {
			t.Fatal("workspace unexpectedly writable")
		}
		if _, err := os.Stat(filepath.Join(root, "ordinary-output.txt")); !os.IsNotExist(err) {
			t.Fatalf("unexpected host output: %v", err)
		}
	})
	t.Run("network and clean environment", func(t *testing.T) {
		result := run(t, "sh", "-c", "test -z \"${ZAKURA_TEST_PARENT_SECRET+x}\" && test \"$(ls /sys/class/net)\" = lo")
		if result.ExitCode != 0 {
			t.Fatalf("network/environment policy failed: %+v", result)
		}
	})
	t.Run("temporary scratch", func(t *testing.T) {
		result := run(t, "sh", "-c", "printf scratch > /tmp/ordinary-output.txt; cat /tmp/ordinary-output.txt")
		if result.ExitCode != 0 || result.Stdout != "scratch" {
			t.Fatalf("scratch failed: %+v", result)
		}
	})
	t.Run("output cap", func(t *testing.T) {
		result := run(t, "sh", "-c", "head -c 300000 /dev/zero")
		if result.ExitCode != 0 || !result.Truncated || len(result.Stdout) != MaxOutputBytes {
			t.Fatalf("output bound failed: code=%d bytes=%d truncated=%v", result.ExitCode, len(result.Stdout), result.Truncated)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		result, err := Run(context.Background(), root, ExecParams{Command: []string{"sleep", "30"}, TimeoutMs: 3000})
		if err != nil || !result.TimedOut {
			t.Fatalf("timeout/cleanup failure: %+v %v", result, err)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		timer := time.AfterFunc(3*time.Second, cancel)
		defer timer.Stop()
		result, err := Run(ctx, root, ExecParams{Command: []string{"sleep", "30"}})
		if err != nil || !result.Cancelled {
			t.Fatalf("cancellation/cleanup failure: %+v %v", result, err)
		}
	})
	t.Run("nonzero exit", func(t *testing.T) {
		result := run(t, "sh", "-c", "printf diagnostic >&2; exit 7")
		if result.ExitCode != 7 || !strings.Contains(result.Stderr, "diagnostic") {
			t.Fatalf("exit semantics: %+v", result)
		}
	})
}
