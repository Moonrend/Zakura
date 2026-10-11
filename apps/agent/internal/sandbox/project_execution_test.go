package sandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectExecutionPolicyKeepsExistingSandboxReadOnly(t *testing.T) {
	t.Setenv("ZAKURA_PROJECT_IMAGE", "operator/project:test")
	t.Setenv("ZAKURA_SANDBOX_IMAGE", "operator/sandbox:test")
	root := t.TempDir()
	project, err := BuildProjectArgs(root, ProjectExecParams{Command: []string{"sh", "-c", "echo ok"}}, "project-test")
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := buildArgs(root, ExecParams{Command: []string{"true"}}, "legacy-test")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(project, "\n")
	for _, required := range []string{"--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=64", "--memory=512m", "--cpus=1", "--ulimit=fsize=8388608:8388608", "bind-recursive=disabled"} {
		if !strings.Contains(joined, required) {
			t.Errorf("missing isolation option %s", required)
		}
	}
	mounts := 0
	for i, arg := range project {
		if arg == "--mount" {
			mounts++
			if i+1 >= len(project) || !strings.Contains(project[i+1], "src="+root+",dst=/workspace,") || strings.Contains(project[i+1], ",readonly,") {
				t.Fatal("project branch mount is wrong")
			}
		}
	}
	if mounts != 1 {
		t.Fatal("project mounted more than one workspace")
	}
	if !strings.Contains(strings.Join(legacy, "\n"), ",dst=/workspace,readonly,") {
		t.Fatal("project execution made legacy sandbox writable")
	}
	if ProjectPolicy().SourceWorkspaceMounted || ProjectPolicy().WorkspaceReadOnly || !Policy().WorkspaceReadOnly {
		t.Fatal("incorrect isolation policy declaration")
	}
}

func TestProjectExecutionRejectsUnsafeDirectoryAndImage(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ZAKURA_PROJECT_IMAGE", "operator/project:test")
	for _, directory := range []string{"..", "/etc", "C:/Windows", "/workspace/../etc"} {
		if _, err := BuildProjectArgs(root, ProjectExecParams{Command: []string{"true"}, WorkingDir: directory}, "test"); err == nil {
			t.Fatalf("unsafe working directory accepted: %q", directory)
		}
	}
	if _, err := BuildProjectArgs(root, ProjectExecParams{Command: []string{"true"}, TimeoutMs: MaxTimeoutMs + 1}, "test"); err == nil {
		t.Fatal("excess timeout accepted")
	}
	if _, err := BuildProjectArgs(root, ProjectExecParams{Command: []string{"true"}, Stdin: strings.Repeat("x", MaxStdinBytes+1)}, "test"); err == nil {
		t.Fatal("excess stdin accepted")
	}
	t.Setenv("ZAKURA_PROJECT_IMAGE", "-privileged")
	if _, err := BuildProjectArgs(root, ProjectExecParams{Command: []string{"true"}}, "test"); err == nil {
		t.Fatal("unsafe image accepted")
	}
	t.Setenv("ZAKURA_PROJECT_IMAGE", "operator/project:test")
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := BuildProjectArgs(root, ProjectExecParams{Command: []string{"true"}}, "test"); err == nil {
		t.Fatal("workspace symlink accepted")
	}
}

func TestProjectDockerIntegration(t *testing.T) {
	if os.Getenv("ZAKURA_PROJECT_DOCKER_TEST") != "1" {
		t.Skip("real project Docker execution requires ZAKURA_PROJECT_DOCKER_TEST=1 and an existing ZAKURA_PROJECT_IMAGE with /bin/sh")
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Fatalf("Docker integration explicitly requested but Docker unavailable: %v", err)
	}
	if strings.TrimSpace(os.Getenv("ZAKURA_PROJECT_IMAGE")) == "" {
		t.Fatal("Docker integration requires an operator-provided project image")
	}
	branch := t.TempDir()
	source := t.TempDir()
	secret := filepath.Join(source, "source-only.txt")
	if err := os.WriteFile(secret, []byte("source secret"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := RunProject(context.Background(), branch, ProjectExecParams{Command: []string{"/bin/sh", "-c", "printf result > /workspace/result.txt; if test -e \"$1\"; then exit 93; fi; exit 17", "sh", secret}, TimeoutMs: 10000})
	if err != nil {
		t.Fatalf("real isolated execution failed: %+v %v", result, err)
	}
	if result.ExitCode != 17 {
		t.Fatalf("workload exit status %d", result.ExitCode)
	}
	content, err := os.ReadFile(filepath.Join(branch, "result.txt"))
	if err != nil || string(content) != "result" {
		t.Fatalf("writable branch did not persist: %q %v", content, err)
	}
	unchanged, _ := os.ReadFile(secret)
	if string(unchanged) != "source secret" {
		t.Fatal("source changed")
	}
	result, err = RunProject(context.Background(), branch, ProjectExecParams{Command: []string{"/bin/sh", "-c", "sleep 30"}, TimeoutMs: 100})
	if !result.TimedOut {
		t.Fatalf("real deadline not recorded %+v %v", result, err)
	}
	result, err = RunProject(context.Background(), branch, ProjectExecParams{Command: []string{"/bin/sh", "-c", "exit 125"}, TimeoutMs: 10000})
	if err != nil || result.ExitCode != 125 {
		t.Fatalf("legitimate exit code 125 treated as infrastructure failure: %+v %v", result, err)
	}
}

func TestProjectDiskPreflightAndPostflightLimits(t *testing.T) {
	t.Setenv("ZAKURA_PROJECT_IMAGE", "operator/project:test")
	root := t.TempDir()
	large, err := os.Create(filepath.Join(root, "oversized"))
	if err != nil {
		t.Fatal(err)
	}
	if err := large.Truncate((8 << 20) + 1); err != nil {
		t.Fatal(err)
	}
	large.Close()
	if _, err := BuildProjectArgs(root, ProjectExecParams{Command: []string{"true"}}, "test"); err == nil {
		t.Fatal("oversized single file passed preflight")
	}
	if err := os.Remove(filepath.Join(root, "oversized")); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 65; i++ {
		file, err := os.CreateTemp(root, "sparse-")
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Truncate(8 << 20); err != nil {
			t.Fatal(err)
		}
		file.Close()
	}
	if err := checkProjectResources(root); err == nil {
		t.Fatal("aggregate logical disk limit was ignored")
	}
	if ProjectPolicy().DiskEnforcement == "" {
		t.Fatal("policy omitted watchdog allocation limitations")
	}
}
