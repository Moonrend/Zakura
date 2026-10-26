//go:build windows

package statefs

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

func Sync(root *os.Root) error {
	file, err := root.Open(".")
	if err != nil {
		return err
	}
	defer file.Close()
	// Reopen the pinned directory itself, without resolving its pathname.
	name, err := windows.NewNTUnicodeString("")
	if err != nil {
		return err
	}
	attributes := windows.OBJECT_ATTRIBUTES{RootDirectory: windows.Handle(file.Fd()), ObjectName: name, Attributes: windows.OBJ_DONT_REPARSE}
	attributes.Length = uint32(unsafe.Sizeof(attributes))
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&handle, windows.FILE_GENERIC_WRITE, &attributes, &status, nil, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_OPEN,
		windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_FOR_BACKUP_INTENT, 0, 0)
	if err != nil {
		return fmt.Errorf("open writable state directory: %w", err)
	}
	defer windows.CloseHandle(handle)
	return windows.FlushFileBuffers(handle)
}
