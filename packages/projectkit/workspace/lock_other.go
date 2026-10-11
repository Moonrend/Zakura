//go:build !linux && !darwin && !freebsd && !netbsd && !openbsd && !dragonfly

package workspace

import (
	"context"
	"errors"
	"io/fs"
	"os"
)

func fileLock(ctx context.Context, file *os.File) error {
	return errors.New("workspace repository requires a platform with durable process file locks")
}
func fileUnlock(file *os.File) {}

func fileOwner(info fs.FileInfo) (int, int, bool) { return 0, 0, false }
