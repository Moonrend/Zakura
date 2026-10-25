package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path"
	"strconv"
	"strings"
)

// VerifyWorkspaceVolume proves that the node sees the same named volume the
// daemon will mount into workspaces. Container-local paths are not host paths.
func VerifyWorkspaceVolume(ctx context.Context, name, dataRoot string) error {
	if !createName.MatchString(name) || !path.IsAbs(dataRoot) || path.Clean(dataRoot) != dataRoot {
		return fmt.Errorf("invalid workspace volume configuration")
	}
	version, err := exec.CommandContext(ctx, dockerBin(), "version", "--format", "{{json .}}").Output()
	if err != nil {
		return fmt.Errorf("workspace Docker version preflight failed")
	}
	var versions struct {
		Client struct {
			APIVersion string `json:"ApiVersion"`
		} `json:"Client"`
		Server struct {
			APIVersion string `json:"ApiVersion"`
			OS         string `json:"Os"`
		} `json:"Server"`
	}
	if json.Unmarshal(version, &versions) != nil || !supportsVolumeSubpath(versions.Client.APIVersion) || !supportsVolumeSubpath(versions.Server.APIVersion) || versions.Server.OS != "linux" {
		return fmt.Errorf("workspace named volumes require Linux Docker with client and server API 1.45 or newer")
	}
	hostname, err := os.Hostname()
	if err != nil || !createName.MatchString(hostname) {
		return fmt.Errorf("node container identity is unavailable")
	}
	raw, err := exec.CommandContext(ctx, dockerBin(), "container", "inspect", hostname).Output()
	if err != nil {
		return fmt.Errorf("cannot inspect node container; keep its default Docker hostname")
	}
	var containers []struct {
		ID     string `json:"Id"`
		Config struct {
			Hostname string `json:"Hostname"`
		} `json:"Config"`
		Mounts []struct {
			Type, Name, Destination string
			RW                      bool
		} `json:"Mounts"`
	}
	if json.Unmarshal(raw, &containers) != nil || len(containers) != 1 || containers[0].Config.Hostname != hostname || !strings.HasPrefix(containers[0].ID, hostname) {
		return fmt.Errorf("node container identity could not be verified")
	}
	matched := false
	for _, mount := range containers[0].Mounts {
		if mount.Destination == dataRoot {
			if mount.Type != "volume" || mount.Name != name || !mount.RW {
				return fmt.Errorf("node workspace mount does not match the configured named volume")
			}
			matched = true
		} else if strings.HasPrefix(dataRoot, strings.TrimRight(mount.Destination, "/")+"/") || strings.HasPrefix(mount.Destination, dataRoot+"/") {
			return fmt.Errorf("workspace pool must use one exact volume mount without overlapping mounts")
		}
	}
	if !matched {
		return fmt.Errorf("node is not mounted on the configured workspace volume")
	}
	raw, err = exec.CommandContext(ctx, dockerBin(), "volume", "inspect", name).Output()
	if err != nil {
		return fmt.Errorf("workspace volume inspection failed")
	}
	var volumes []struct {
		Name, Driver, Scope string
		Options             map[string]string
	}
	if json.Unmarshal(raw, &volumes) != nil || len(volumes) != 1 || volumes[0].Name != name || volumes[0].Driver != "local" || volumes[0].Scope != "local" || len(volumes[0].Options) != 0 {
		return fmt.Errorf("workspace pool requires a local Docker named volume without driver options")
	}
	return nil
}

func supportsVolumeSubpath(api string) bool {
	major, minor, ok := strings.Cut(api, ".")
	if !ok {
		return false
	}
	a, errA := strconv.Atoi(major)
	b, errB := strconv.Atoi(minor)
	return errA == nil && errB == nil && (a > 1 || a == 1 && b >= 45)
}
