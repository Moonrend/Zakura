//go:build !windows

package sys

import "golang.org/x/sys/unix"

func diskUsage(path string) DiskInfo {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return DiskInfo{}
	}
	bs := uint64(st.Bsize) // Darwin 上 Bsize 是 int32
	return DiskInfo{
		TotalBytes: uint64(st.Blocks) * bs,
		FreeBytes:  uint64(st.Bavail) * bs,
	}
}
