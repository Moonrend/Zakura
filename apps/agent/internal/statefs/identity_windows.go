//go:build windows

package statefs

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func DirectoryID(root *os.Root) (string, error) {
	file, err := root.Open(".")
	if err != nil {
		return "", err
	}
	defer file.Close()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x:%x:%x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}
