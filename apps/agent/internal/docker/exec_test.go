package docker

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func execTestDocker(t *testing.T) string {
	t.Helper()
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "calls.jsonl")
	t.Setenv("ZAKURA_DOCKER", bin)
	t.Setenv("ZAKURA_TEST_CREATE_DOCKER_LOG", log)
	return log
}

func TestExecWithOptionsInputAndCombinedOutputLimit(t *testing.T) {
	log := execTestDocker(t)
	input := `{"event":"UserPromptSubmit","prompt":"fixture input"}`
	stdout, stderr, code, err := ExecWithOptions(context.Background(), "exact-container-id", []string{"sh", "-lc", "hook"}, "/workspace/projects/demo", map[string]string{"ZAKURA_PLUGIN_ROOT": "/workspace/plugins/demo"}, ExecOptions{Stdin: input})
	if err != nil || code != 0 || stdout != input || stderr != strings.Repeat("stderr", 10000) {
		t.Fatalf("input/output: stdout=%q stderr bytes=%d code=%d err=%v", stdout, len(stderr), code, err)
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	var commands [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var args []string
		if err := json.Unmarshal([]byte(line), &args); err != nil {
			t.Fatal(err)
		}
		if args[0] == "exec" {
			commands = append(commands, args)
		}
	}
	want := [][]string{{"exec", "-i", "-w", "/workspace/projects/demo", "-e", "ZAKURA_PLUGIN_ROOT=/workspace/plugins/demo", "exact-container-id", "sh", "-lc", "hook"}}
	if !reflect.DeepEqual(commands, want) {
		t.Fatalf("unexpected argv (stdin must stay on the pipe): %v", commands)
	}
	for _, limit := range []int{1, 1024, 16 << 10} {
		stdout, stderr, code, err = ExecWithOptions(context.Background(), "exact-container-id", []string{"hook"}, "", nil, ExecOptions{Stdin: strings.Repeat("input", 10000), MaxOutputBytes: limit})
		if err != nil || code != 0 || len(stdout)+len(stderr) != limit {
			t.Fatalf("limit %d: stdout=%d stderr=%d code=%d err=%v", limit, len(stdout), len(stderr), code, err)
		}
	}
}

func TestExecWithOptionsRejectsInvalidInputBeforeDocker(t *testing.T) {
	t.Setenv("ZAKURA_DOCKER", filepath.Join(t.TempDir(), "missing-docker"))
	for _, tc := range []struct {
		id      string
		command []string
		options ExecOptions
	}{
		{"", []string{"hook"}, ExecOptions{}},
		{"container", nil, ExecOptions{}},
		{"container", []string{"hook"}, ExecOptions{MaxOutputBytes: -1}},
		{"container", []string{"hook"}, ExecOptions{MaxOutputBytes: (16 << 20) + 1}},
		{"container", []string{"hook"}, ExecOptions{Stdin: strings.Repeat("x", (1<<20)+1)}},
	} {
		_, _, code, err := ExecWithOptions(context.Background(), tc.id, tc.command, "", nil, tc.options)
		if err == nil || errors.Is(err, ErrUnavailable) || code == 0 {
			t.Fatalf("invalid options reached Docker: code=%d err=%v", code, err)
		}
	}
}

func TestExecWithOptionsExitAndCancellation(t *testing.T) {
	execTestDocker(t)
	t.Setenv("ZAKURA_TEST_EXEC_EXIT", "1")
	_, _, code, err := ExecWithOptions(context.Background(), "container", []string{"hook"}, "", nil, ExecOptions{Stdin: "input"})
	if err != nil || code != 17 {
		t.Fatalf("exit status: code=%d err=%v", code, err)
	}
	t.Setenv("ZAKURA_TEST_EXEC_EXIT", "")
	ready := filepath.Join(t.TempDir(), "ready")
	t.Setenv("ZAKURA_TEST_EXEC_READY", ready)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, _, _, err := ExecWithOptions(ctx, "container", []string{"hook"}, "", nil, ExecOptions{Stdin: "input"})
		done <- err
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(ready); err == nil {
			cancel()
			break
		}
		select {
		case err := <-done:
			t.Fatalf("exec ended before cancellation: %v", err)
		case <-ticker.C:
		}
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("exec did not stop on cancellation")
	}
}
