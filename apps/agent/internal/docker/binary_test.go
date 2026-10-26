package docker

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDockerBinaryHonorsOverride(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "missing-docker")
	t.Setenv("ZAKURA_DOCKER", bin)
	if got := Binary(); got != bin {
		t.Fatalf("override replaced: %q", got)
	}
	if p := Probe(); p.OK || p.Error != ErrUnavailable.Error() {
		t.Fatalf("missing binary: %+v", p)
	}
}

func TestDockerBinaryUsesPath(t *testing.T) {
	root := t.TempDir()
	name := "docker"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	bin := filepath.Join(root, name)
	if err := os.WriteFile(bin, nil, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", "")
	t.Setenv("PATH", root)
	if got := Binary(); got != bin {
		t.Fatalf("PATH binary: %q, want %q", got, bin)
	}
}

func TestDockerBinaryFindsDesktopWithoutPath(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows Desktop service PATH regression")
	}
	root := t.TempDir()
	bin := filepath.Join(root, "Docker", "Docker", "resources", "bin", "docker.exe")
	if err := os.MkdirAll(filepath.Dir(bin), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, nil, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", "")
	t.Setenv("PATH", t.TempDir())
	t.Setenv("ProgramW6432", root)
	if got := Binary(); got != bin {
		t.Fatalf("Desktop not found: %q, want %q", got, bin)
	}
}

func TestDockerProbePreservesDaemonError(t *testing.T) {
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", bin)
	t.Setenv("ZAKURA_TEST_CREATE_DOCKER_LOG", filepath.Join(t.TempDir(), "calls.jsonl"))
	for _, detail := range []string{"Cannot connect to the Docker daemon", "permission denied while trying to connect to the Docker API"} {
		t.Run(detail, func(t *testing.T) {
			t.Setenv("ZAKURA_TEST_DOCKER_VERSION_ERROR", detail)
			p := Probe()
			if p.OK || !strings.Contains(p.Error, detail) || strings.Contains(p.Error, "未检测到") {
				t.Fatalf("daemon error masked as missing Docker: %+v", p)
			}
			if err := Require(); err == nil || !strings.Contains(err.Error(), detail) {
				t.Fatalf("Require dropped diagnostic: %v", err)
			}
		})
	}
}
