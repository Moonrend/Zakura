//go:build !windows

package sys

import (
	"os"
	"syscall"
)

// Re-exec keeps the PID, arguments, environment and service supervision intact.
// It also works for a foreground agent without systemd or launchd. If exec fails,
// the old process remains alive and the caller restores its executable.
func restartSelf(bin, _ string) error {
	return syscall.Exec(bin, os.Args, os.Environ())
}
