//go:build windows

package host

import "context"

// Windows 第一期降级为管道，不用 ConPTY。
func StartPty(root string, p ExecParams, cols, rows int) (*LiveStream, error) {
	_ = cols
	_ = rows
	if len(p.Command) == 0 {
		p.Command = []string{"powershell.exe", "-NoLogo"}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd, err := buildCmd(ctx, root, p)
	if err != nil {
		cancel()
		return nil, err
	}
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
	return newPipeSession(newID(), stdin, stdout, cmd, cancel), nil
}
