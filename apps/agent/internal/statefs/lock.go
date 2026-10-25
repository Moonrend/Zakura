package statefs

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"time"
)

// Lock serializes processes as well as handlers. The lock file is permanent;
// removing it could let another process lock a different inode at the same path.
func Lock(ctx context.Context, root *os.Root) (func(), error) {
	file, err := root.OpenFile("lock", os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, fs.ErrExist) {
		before, statErr := root.Lstat("lock")
		if statErr != nil {
			return nil, statErr
		}
		if !before.Mode().IsRegular() {
			return nil, fmt.Errorf("invalid state lock")
		}
		file, err = root.OpenFile("lock", os.O_RDWR, 0)
		if err == nil {
			after, statErr := file.Stat()
			if statErr != nil || !os.SameFile(before, after) {
				file.Close()
				return nil, fmt.Errorf("state lock changed during access")
			}
		}
	}
	if err != nil {
		return nil, err
	}
	for {
		if err := ctx.Err(); err != nil {
			file.Close()
			return nil, err
		}
		err = tryLock(file)
		if err == nil {
			return func() { unlock(file); file.Close() }, nil
		}
		if !lockBusy(err) {
			file.Close()
			return nil, err
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			file.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
