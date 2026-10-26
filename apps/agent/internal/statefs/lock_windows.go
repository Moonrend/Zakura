//go:build windows

package statefs

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func tryLock(file *os.File) error {
	return windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}
func unlock(file *os.File) {
	_ = windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &windows.Overlapped{})
}
func lockBusy(err error) bool { return errors.Is(err, windows.ERROR_LOCK_VIOLATION) }
