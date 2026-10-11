//go:build !unix

package host

import (
	"context"
	"os/exec"
)

// Non-POSIX hosts coordinate the foreground process only. Project writable
// Docker execution separately rejects hosts without POSIX UID/GID support.
func prepareSourceProcess(cmd *exec.Cmd)                              {}
func WaitSourceProcessGroup(ctx context.Context, cmd *exec.Cmd) error { return nil }
