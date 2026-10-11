//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package workspace

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"syscall"
	"time"
)

func fileLock(ctx context.Context, file *os.File) error {
	for {
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return err
		}
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func fileUnlock(file *os.File) { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }

func fileOwner(info fs.FileInfo) (int, int, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	return int(stat.Uid), int(stat.Gid), true
}
