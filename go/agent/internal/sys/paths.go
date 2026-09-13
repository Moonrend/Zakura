package sys

import (
	"os"
	"path/filepath"
	"runtime"
)

const (
	// ServiceName 三端服务名（systemd / launchd / Windows 服务）
	ServiceName = "zakura-agent"
	// LaunchdLabel macOS launchd 标识
	LaunchdLabel = "dev.zakura.agent"
	// WindowsService Windows 服务名（sc / net / schtasks 共用）
	WindowsService = "zakura-agent"
	// WindowsServiceDisplay 控制台里看到的显示名
	WindowsServiceDisplay = "Zakura Agent"
)

// DefaultDataDir 按平台惯例选数据目录，不写死 /var/zakura。
func DefaultDataDir() string {
	if override := os.Getenv("ZAKURA_AGENT_DATA_DIR"); override != "" {
		return override
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if programData := os.Getenv("PROGRAMDATA"); programData != "" && isPrivileged() {
			return filepath.Join(programData, "zakura", "agent")
		}
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			return filepath.Join(local, "zakura", "agent")
		}
		return filepath.Join(home, "AppData", "Local", "zakura", "agent")
	case "darwin":
		if isPrivileged() {
			return "/Library/Application Support/zakura/agent"
		}
		return filepath.Join(home, "Library", "Application Support", "zakura", "agent")
	default:
		if isPrivileged() {
			return "/var/lib/zakura/agent"
		}
		xdg := os.Getenv("XDG_DATA_HOME")
		if xdg == "" {
			xdg = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(xdg, "zakura", "agent")
	}
}

// DefaultBinPath 安装后的二进制路径。
func DefaultBinPath() string {
	if override := os.Getenv("ZAKURA_AGENT_BIN"); override != "" {
		return override
	}
	switch runtime.GOOS {
	case "windows":
		root := os.Getenv("PROGRAMDATA")
		if root == "" {
			root = `C:\ProgramData`
		}
		return filepath.Join(root, "zakura", "bin", "zakura-agent.exe")
	default:
		return "/usr/local/bin/zakura-agent"
	}
}

func isPrivileged() bool {
	if runtime.GOOS == "windows" {
		return windowsAdmin()
	}
	return os.Geteuid() == 0
}
