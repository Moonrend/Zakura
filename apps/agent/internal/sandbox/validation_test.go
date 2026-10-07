package sandbox

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func testPolicy(t *testing.T) string {
	t.Helper()
	t.Setenv("ZAKURA_SANDBOX_IMAGE", "zakura-test:local")
	return t.TempDir()
}

func TestSandboxRestrictiveArgumentPolicy(t *testing.T) {
	root := testPolicy(t)
	args, err := buildArgs(root, ExecParams{Command: []string{"printf", "%s", "hello"}}, "test-policy")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--pull=never", "--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=64", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--ipc=none", "--log-driver=none", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777"} {
		found := false
		for _, arg := range args {
			if arg == want {
				found = true
			}
		}
		if !found {
			t.Errorf("missing restriction %s", want)
		}
	}
	joined := strings.Join(args, "\n")
	if !strings.Contains(joined, "dst=/workspace,readonly,bind-propagation=rprivate") {
		t.Error("workspace mount is not read-only/private")
	}
	if got := strings.Join(args[len(args)-3:], "|"); got != "zakura-test:local|%s|hello" {
		t.Fatalf("command arguments changed: %s", got)
	}
}

func TestSandboxInputPolicyRejectsBeforeExecution(t *testing.T) {
	root := testPolicy(t)
	cases := map[string]ExecParams{
		"empty": {}, "empty executable": {Command: []string{""}},
		"too many args":      {Command: make([]string, 257)},
		"oversize command":   {Command: []string{strings.Repeat("x", 64*1024+1)}},
		"oversize stdin":     {Command: []string{"printf"}, Stdin: strings.Repeat("x", MaxStdinBytes+1)},
		"negative timeout":   {Command: []string{"printf"}, TimeoutMs: -1},
		"excessive timeout":  {Command: []string{"printf"}, TimeoutMs: MaxTimeoutMs + 1},
		"custom environment": {Command: []string{"printf"}, Env: map[string]string{"EXAMPLE": "value"}},
	}
	for name, p := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := buildArgs(root, p, "validation"); err == nil {
				t.Fatal("invalid request accepted")
			}
		})
	}
	if _, err := buildArgs(root, ExecParams{Command: []string{"printf"}, TimeoutMs: MaxTimeoutMs, Stdin: strings.Repeat("x", MaxStdinBytes)}, "boundary"); err != nil {
		t.Fatal(err)
	}
}

func TestSandboxUnavailableFailsClosed(t *testing.T) {
	root := testPolicy(t)
	p := ExecParams{Command: []string{"printf", "hello"}}
	t.Setenv("ZAKURA_SANDBOX_IMAGE", "")
	if _, err := Run(context.Background(), root, p); err == nil {
		t.Fatal("missing image accepted")
	}
	t.Setenv("ZAKURA_SANDBOX_IMAGE", "zakura-test:local")
	t.Setenv("PATH", t.TempDir())
	if _, err := Run(context.Background(), root, p); err == nil || !strings.Contains(err.Error(), "host execution refused") {
		t.Fatalf("missing Docker must fail closed: %v", err)
	}
	if _, err := NewRegistry().Start(root, p); err == nil {
		t.Fatal("background execution accepted missing backend")
	}
}

func TestSandboxWorkingDirectoryMapping(t *testing.T) {
	root := testPolicy(t)
	if err := os.Mkdir(filepath.Join(root, "project"), 0755); err != nil {
		t.Fatal(err)
	}
	args, err := buildArgs(root, ExecParams{Command: []string{"pwd"}, WorkingDir: "project"}, "workdir")
	if err != nil {
		t.Fatal(err)
	}
	for i, arg := range args {
		if arg == "--workdir" && args[i+1] == "/workspace/project" {
			return
		}
	}
	t.Fatal("working directory was not mapped inside workspace")
}

func TestSandboxOutputCapAndConcurrentSnapshots(t *testing.T) {
	var w cappedWriter
	input := []byte(strings.Repeat("a", MaxOutputBytes))
	if n, err := w.Write(input); n != len(input) || err != nil {
		t.Fatalf("write: %d %v", n, err)
	}
	if _, truncated := w.snapshot(); truncated {
		t.Fatal("exact boundary marked truncated")
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				_, _ = w.Write([]byte("extra"))
				_, _ = w.snapshot()
			}
		}()
	}
	wg.Wait()
	output, truncated := w.snapshot()
	if len(output) != MaxOutputBytes || !truncated {
		t.Fatalf("cap failed: bytes=%d truncated=%v", len(output), truncated)
	}
}

// fakeDocker tests client orchestration only. It provides no container or OS isolation.
func fakeDocker(t *testing.T, runBody string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("synthetic POSIX client fixture")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\ncase \"$1\" in\nimage) printf 'null\\n' ;;\ncreate) exit 0 ;;\nstart) " + runBody + " ;;\nrm) exit 0 ;;\ncontainer) exit 0 ;;\n*) exit 1 ;;\nesac\n"
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
}

func TestSandboxSyntheticClientTimeoutAndCancellation(t *testing.T) {
	root := testPolicy(t)
	fakeDocker(t, "exec /bin/sleep 30")
	t.Run("timeout", func(t *testing.T) {
		result, err := Run(context.Background(), root, ExecParams{Command: []string{"sleep", "30"}, TimeoutMs: 30})
		if err != nil {
			t.Fatal(err)
		}
		if !result.TimedOut || result.Cancelled {
			t.Fatalf("wrong timeout state: %+v", result)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		result, _ := Run(ctx, root, ExecParams{Command: []string{"sleep", "30"}})
		if !result.Cancelled || result.TimedOut {
			t.Fatalf("wrong cancel state: %+v", result)
		}
	})
}

func TestSandboxSyntheticClientQuotaAndScopedPermission(t *testing.T) {
	root := testPolicy(t)
	fakeDocker(t, "exit 0")
	registry := NewRegistry()
	for i := 0; i < MaxJobs; i++ {
		id := string(rune(i + 1))
		registry.jobs[id] = &job{id: id, root: root, cancel: func() {}}
	}
	if _, err := registry.Start(root, ExecParams{Command: []string{"printf", "hello"}}); err == nil || !strings.Contains(err.Error(), "limit") {
		t.Fatalf("concurrent quota not enforced: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	registry.jobs["scoped"] = &job{id: "scoped", root: root, cancel: cancel}
	if registry.GetScoped("scoped", "other-workspace") != nil || registry.KillScoped("scoped", "other-workspace") != nil {
		t.Fatal("cross-workspace job exposed")
	}
	if ctx.Err() != nil {
		t.Fatal("cross-workspace kill cancelled job")
	}
	if registry.GetScoped("scoped", root) == nil || registry.KillScoped("scoped", root) == nil {
		t.Fatal("owner cannot access job")
	}
	if ctx.Err() != context.Canceled {
		t.Fatal("owner cancellation not delivered")
	}
}

func TestSandboxDockerClientDoesNotInheritSecrets(t *testing.T) {
	t.Setenv("ZAKURA_TEST_SECRET", "do-not-forward")
	t.Setenv("DOCKER_HOST", "example.invalid")
	cmd := dockerCommand(context.Background(), "docker", "version")
	for _, entry := range cmd.Env {
		if strings.HasPrefix(entry, "ZAKURA_TEST_SECRET=") || strings.HasPrefix(entry, "DOCKER_HOST=") {
			t.Fatalf("inherited disallowed environment: %s", entry)
		}
	}
	if cmd.WaitDelay <= 0 || cmd.WaitDelay > 5*time.Second {
		t.Fatal("client wait is not bounded")
	}
}

func TestSandboxGlobalExecutionQuota(t *testing.T) {
	for i := 0; i < MaxConcurrent; i++ {
		executionSlots <- struct{}{}
	}
	defer func() {
		for i := 0; i < MaxConcurrent; i++ {
			<-executionSlots
		}
	}()
	if _, err := Run(context.Background(), t.TempDir(), ExecParams{Command: []string{"printf", "hello"}}); err == nil || !strings.Contains(err.Error(), "concurrent execution limit") {
		t.Fatalf("global quota not enforced: %v", err)
	}
}

func TestSandboxImageVolumesFailClosed(t *testing.T) {
	root := testPolicy(t)
	fakeDocker(t, "exit 0")
	path := filepath.Join(os.Getenv("PATH"), "docker")
	if err := os.WriteFile(path, []byte("#!/bin/sh\ncase \"$1\" in\nimage) printf '{\"/data\":{}}\\n' ;;\n*) exit 1 ;;\nesac\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(context.Background(), root, ExecParams{Command: []string{"printf", "hello"}}); err == nil || !strings.Contains(strings.ToLower(err.Error()), "volume") {
		t.Fatalf("image with writable volume accepted: %v", err)
	}
}
