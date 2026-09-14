//go:build !windows

package docker

import (
	"errors"
	"io"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

func runPullCommand(cmd *exec.Cmd, out io.Writer) error {
	// Docker CLI 在非终端输出时省略下载字节数。PTY 保留进度，同时沿用
	// CLI 的 Docker context、凭据助手和远程 daemon 配置。
	terminal, slave, err := pty.Open()
	if err != nil {
		cmd.Stdout, cmd.Stderr = out, out
		return cmd.Run()
	}
	defer terminal.Close()
	_ = pty.Setsize(terminal, &pty.Winsize{Rows: 24, Cols: 120})
	cmd.Stdout, cmd.Stderr = slave, slave
	err = cmd.Start()
	_ = slave.Close()
	if err != nil {
		return err
	}
	_, readErr := io.Copy(out, terminal)
	if err := cmd.Wait(); err != nil {
		return err
	}
	// Linux PTY 在子进程关闭 slave 后用 EIO 表示 EOF。
	if errors.Is(readErr, syscall.EIO) {
		return nil
	}
	return readErr
}
