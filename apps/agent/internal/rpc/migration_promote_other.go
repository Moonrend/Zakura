//go:build !linux && !darwin && !windows

package rpc

import (
	"fmt"
	"os"
)

func migrationPromote(job, space *os.Root) error {
	return fmt.Errorf("atomic workspace migration is unavailable on this platform")
}
