//go:build linux

package rpc

import (
	"os"

	"golang.org/x/sys/unix"
)

func migrationPromote(job, space *os.Root) error {
	source, err := job.Open(".")
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := space.Open(".")
	if err != nil {
		return err
	}
	defer target.Close()
	return unix.Renameat2(int(source.Fd()), "tree", int(target.Fd()), "workspace", unix.RENAME_NOREPLACE)
}
