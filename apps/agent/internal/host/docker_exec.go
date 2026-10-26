package host

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
)

// StartDockerExec 交互式 docker exec -i，复用 PtySession 的管道接口。
func StartDockerExec(container string, command []string, workdir string, env map[string]string) (*LiveStream, error) {
	bin := docker.Binary()
	ctx, cancel := context.WithCancel(context.Background())
	args := []string{"exec", "-i"}
	if workdir != "" {
		args = append(args, "-w", workdir)
	}
	for k, v := range env {
		args = append(args, "-e", k+"="+v)
	}
	args = append(args, container)
	args = append(args, command...)
	cmd := exec.CommandContext(ctx, bin, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	return wrapPipes(newID(), stdin, stdout, cmd, cancel), nil
}

// StartDockerExecTTY is deliberately separate from the non-TTY ACP JSON-RPC
// transport. Docker's CLI propagates the local PTY size to the exec PTY.
func StartDockerExecTTY(container string, command []string, workdir string, env map[string]string, cols, rows int) (*LiveStream, error) {
	args, err := dockerTTYArgs(container, command, workdir, env)
	if err != nil {
		return nil, err
	}
	if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
		return nil, fmt.Errorf("invalid terminal size")
	}
	bin := docker.Binary()
	return StartPty(os.TempDir(), ExecParams{Command: append([]string{bin}, args...), Env: map[string]string{"TERM": "xterm-256color"}}, cols, rows)
}

func dockerTTYArgs(container string, command []string, workdir string, env map[string]string) ([]string, error) {
	if container == "" || strings.HasPrefix(container, "-") || strings.ContainsAny(container, "\x00\r\n") || len(command) == 0 || command[0] == "" {
		return nil, fmt.Errorf("invalid interactive Docker command")
	}
	args := []string{"exec", "-i", "-t"}
	if workdir != "" {
		args = append(args, "-w", workdir)
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		if k == "" || strings.ContainsAny(k, "=\x00") || strings.ContainsRune(env[k], '\x00') {
			return nil, fmt.Errorf("invalid interactive Docker environment")
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "-e", k+"="+env[k])
	}
	return append(append(args, container), command...), nil
}

func wrapPipes(id string, stdin io.WriteCloser, stdout io.ReadCloser, cmd *exec.Cmd, cancel context.CancelFunc) *LiveStream {
	return newPipeSession(id, stdin, stdout, cmd, cancel)
}

// StartDockerAttach 接到容器 PID1 的 stdio（ACP adapter 用）。
func StartDockerAttach(container string) (*LiveStream, error) {
	bin := docker.Binary()
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, bin, "attach", "--sig-proxy=false", container)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	return wrapPipes(newID(), stdin, stdout, cmd, cancel), nil
}
