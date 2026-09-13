package docker

import (
	"io"
	"os/exec"
)

func runPullCommand(cmd *exec.Cmd, out io.Writer) error {
	// 无 PTY 时仍逐行回传 Docker 的层状态；没有字节数就显示不定进度。
	cmd.Stdout, cmd.Stderr = out, out
	return cmd.Run()
}
