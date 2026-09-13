//go:build !windows

package sys

func windowsAdmin() bool { return false }
