package docker

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Binary also finds Desktop installations when a service inherited a minimal PATH.
// An explicit override is authoritative, including when it is unavailable.
func Binary() string {
	if override := strings.TrimSpace(os.Getenv("ZAKURA_DOCKER")); override != "" {
		return override
	}
	if bin, err := exec.LookPath("docker"); err == nil {
		return bin
	}
	for _, bin := range dockerCandidates(runtime.GOOS, os.Getenv) {
		if info, err := os.Stat(bin); err == nil && !info.IsDir() && (runtime.GOOS == "windows" || info.Mode()&0111 != 0) {
			return bin
		}
	}
	return "docker"
}

func dockerCandidates(platform string, getenv func(string) string) []string {
	switch platform {
	case "windows":
		var paths []string
		for _, key := range []string{"ProgramW6432", "ProgramFiles", "LOCALAPPDATA"} {
			if root := getenv(key); root != "" {
				paths = append(paths, filepath.Join(root, "Docker", "Docker", "resources", "bin", "docker.exe"))
			}
		}
		if root := getenv("LOCALAPPDATA"); root != "" {
			paths = append(paths, filepath.Join(root, "Programs", "DockerDesktop", "resources", "bin", "docker.exe"))
		}
		return append(paths, `C:\Program Files\Docker\Docker\resources\bin\docker.exe`)
	case "darwin":
		paths := []string{"/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"}
		if home := getenv("HOME"); home != "" {
			paths = append(paths, filepath.Join(home, ".docker", "bin", "docker"))
		}
		return paths
	default:
		return []string{"/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker"}
	}
}
