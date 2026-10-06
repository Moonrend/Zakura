package sys

import (
	"net"
	"os"
	"runtime"

	"zakura.dev/agent/internal/docker"
)

// Version 由 -ldflags 注入。
var Version = "dev"

type DiskInfo struct {
	TotalBytes uint64 `json:"totalBytes"`
	FreeBytes  uint64 `json:"freeBytes"`
}

type HostInfo struct {
	Hostname    string   `json:"hostname"`
	Platform    string   `json:"platform"`
	Arch        string   `json:"arch"`
	PrimaryIP   string   `json:"primaryIp,omitempty"`
	DockerOK    bool     `json:"-"`
	DockerVer   string   `json:"dockerVersion,omitempty"`
	StorageRoot string   `json:"storageRoot"`
	Disk        DiskInfo `json:"disk"`
}

type InfoResult struct {
	Version      string         `json:"version"`
	Kind         string         `json:"kind"`
	Capabilities map[string]any `json:"capabilities"`
	HostInfo     HostInfo       `json:"hostInfo"`
	StorageRoot  string         `json:"storageRoot"`
	Docker       docker.Ping    `json:"docker"`
	BinPath      string         `json:"binPath"`
	GOOS         string         `json:"goos"`
	GOARCH       string         `json:"goarch"`
	SHA256       string         `json:"sha256,omitempty"`
}

// VersionInfo does not invoke Docker, scan disks or probe the network.
func VersionInfo() map[string]any {
	return map[string]any{
		"version": Version, "binPath": currentBin(), "sha256": currentSHA256(),
		"goos": runtime.GOOS, "goarch": runtime.GOARCH,
		"updateError": selfUpdater.errorMessage(),
	}
}

func Collect(kind, storageRoot string) InfoResult {
	host, _ := os.Hostname()
	d := docker.Probe()
	hi := HostInfo{
		Hostname:    host,
		Platform:    runtime.GOOS,
		Arch:        runtime.GOARCH,
		PrimaryIP:   primaryIP(),
		DockerVer:   d.Version,
		StorageRoot: storageRoot,
		Disk:        diskUsage(storageRoot),
	}
	return InfoResult{
		Version: Version,
		Kind:    kind,
		Capabilities: map[string]any{
			"host":   true,
			"docker": d.OK,
			// Windows 走管道伪终端（见 pty_windows.go），三端都有交互壳。
			"pty": true,
		},
		HostInfo:    hi,
		StorageRoot: storageRoot,
		Docker:      d,
		BinPath:     currentBin(),
		GOOS:        runtime.GOOS,
		GOARCH:      runtime.GOARCH,
		SHA256:      currentSHA256(),
	}
}

func currentBin() string {
	p, err := executablePath()
	if err != nil {
		return DefaultBinPath()
	}
	return p
}

func primaryIP() string {
	// UDP 拨号取本机出口地址；Windows 上 Get-NetRoute.NextHop 是网关不是本机 IP。
	c, err := net.Dial("udp", "1.1.1.1:80")
	if err != nil {
		return ""
	}
	defer c.Close()
	if a, ok := c.LocalAddr().(*net.UDPAddr); ok && a.IP != nil {
		return a.IP.String()
	}
	return ""
}
