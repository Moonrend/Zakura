//go:build windows

package sys

import (
	"path/filepath"
	"syscall"
	"unsafe"
)

func diskUsage(path string) DiskInfo {
	dir := filepath.VolumeName(path) + `\`
	if dir == `\` {
		dir = `C:\`
	}
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceEx := kernel32.NewProc("GetDiskFreeSpaceExW")
	var free, total, totalFree uint64
	p, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return DiskInfo{}
	}
	r, _, _ := getDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&free)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return DiskInfo{}
	}
	return DiskInfo{TotalBytes: total, FreeBytes: free}
}
