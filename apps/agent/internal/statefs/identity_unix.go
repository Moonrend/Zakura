//go:build !windows

package statefs

import (
	"fmt"
	"os"
	"syscall"
)

func DirectoryID(root *os.Root) (string, error) {
	file, err := root.Open(".")
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("directory identity unavailable")
	}
	return fmt.Sprintf("%x:%x", stat.Dev, stat.Ino), nil
}
