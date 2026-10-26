//go:build windows

package rpc

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Handle-relative NT rename keeps both parents pinned and deliberately leaves
// ReplaceIfExists false. No path-based fallback may overwrite a racing target.
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
	name, err := windows.NewNTUnicodeString("tree")
	if err != nil {
		return err
	}
	attrs := windows.OBJECT_ATTRIBUTES{RootDirectory: windows.Handle(source.Fd()), ObjectName: name, Attributes: windows.OBJ_DONT_REPARSE}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&handle, windows.SYNCHRONIZE|windows.DELETE, &attrs, &status, nil, 0, windows.FILE_SHARE_DELETE|windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, windows.FILE_OPEN, windows.FILE_OPEN_REPARSE_POINT|windows.FILE_OPEN_FOR_BACKUP_INTENT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var info struct {
		ReplaceIfExists byte
		RootDirectory   windows.Handle
		FileNameLength  uint32
		FileName        [32]uint16
	}
	info.RootDirectory = windows.Handle(target.Fd())
	chars, err := windows.UTF16FromString("workspace")
	if err != nil {
		return err
	}
	copy(info.FileName[:], chars)
	info.FileNameLength = uint32((len(chars) - 1) * 2)
	const fileRenameInformation = 10
	return windows.NtSetInformationFile(handle, &status, (*byte)(unsafe.Pointer(&info)), uint32(unsafe.Offsetof(info.FileName))+info.FileNameLength, fileRenameInformation)
}
