package host

import (
	"context"
	"io"
	"os"
	"os/exec"
)

// StartDockerExec 交互式 docker exec -i，复用 PtySession 的管道接口。
func StartDockerExec(container string, command []string, workdir string, env map[string]string) (*LiveStream, error) {
	bin := os.Getenv("ZAKURA_DOCKER")
	if bin == "" {
		bin = "docker"
	}
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

func wrapPipes(id string, stdin io.WriteCloser, stdout io.ReadCloser, cmd *exec.Cmd, cancel context.CancelFunc) *LiveStream {
	return newPipeSession(id, stdin, stdout, cmd, cancel)
}

// StartDockerAttach 接到容器 PID1 的 stdio（ACP adapter 用）。
func StartDockerAttach(container string) (*LiveStream, error) {
	bin := os.Getenv("ZAKURA_DOCKER")
	if bin == "" {
		bin = "docker"
	}
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
