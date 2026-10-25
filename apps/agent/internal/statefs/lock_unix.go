//go:build !windows

package statefs

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func tryLock(file *os.File) error { return unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB) }
func unlock(file *os.File)        { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN) }
func lockBusy(err error) bool     { return errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) }
