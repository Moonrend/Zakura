//go:build unix

package host

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func prepareSourceProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = 2 * time.Second
}

// WaitSourceProcessGroup includes ordinary children that outlive their parent.
// A trusted host command can deliberately escape its group with setsid; that
// detached daemon is outside this coordination protocol and must be quiesced by
// the operator. A group containing persistent zombies stays conservatively
// active because /proc cannot atomically prove absence of live descendants.
func WaitSourceProcessGroup(ctx context.Context, cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	group := cmd.Process.Pid
	cancelled := false
	for {
		alive, err := sourceGroupAlive(group)
		if err != nil {
			return err
		}
		if !alive {
			return nil
		}
		if ctx.Err() != nil && !cancelled {
			cancelled = true
			if err := syscall.Kill(-group, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
				return err
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
}
func sourceGroupAlive(group int) (bool, error) {
	// Kernel membership is authoritative. A /proc directory scan is not atomic:
	// a parent may fork after enumeration and exit before its metadata is read,
	// hiding its live child behind a seemingly zombie-only group. Conservatively
	// retain protection while the kernel reports any member, including zombies.
	probe := syscall.Kill(-group, 0)
	if errors.Is(probe, syscall.ESRCH) {
		return false, nil
	}
	if probe != nil && !errors.Is(probe, syscall.EPERM) {
		return false, probe
	}
	return true, nil
}
