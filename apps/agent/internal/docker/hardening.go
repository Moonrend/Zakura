package docker

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// Every container this node starts is unprivileged, whatever the caller asks
// for. There is no switch to turn this off: a privileged container (or one that
// is privileged in effect) owns the node and every tenant's data on it.

// keptCapabilities is what a workspace entrypoint needs after --cap-drop ALL:
// ownership fixes, switching to the session user, signalling its own children
// and binding low ports inside the container. Nothing here crosses the
// container boundary (no SYS_ADMIN, NET_ADMIN, SYS_PTRACE, SYS_MODULE, MKNOD…).
var keptCapabilities = []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID", "SETPCAP", "KILL", "NET_BIND_SERVICE", "AUDIT_WRITE"}

const defaultPidsLimit = 4096

// Host paths a container may never see. The Docker socket gives full control of
// the node; the rest expose the host root, kernel interfaces, devices or other
// containers' storage. Exact entries deny only that path; tree entries also
// deny everything below them.
var deniedHostExact = []string{"/", "/etc", "/root", "/home", "/var", "/run", "/usr"}
var deniedHostTrees = []string{"/proc", "/sys", "/dev", "/boot", "/var/run/docker.sock", "/run/docker.sock", "/var/run/containerd", "/run/containerd", "/var/lib/docker", "/var/lib/containerd", "/etc/zakura", "/root/.ssh", "/root/.docker"}

var deniedNetworkModes = map[string]bool{"host": true}

func validateHardening(spec RunSpec) error {
	if spec.Privileged {
		return fmt.Errorf("privileged containers are not allowed")
	}
	mode := strings.ToLower(strings.TrimSpace(spec.Network))
	if deniedNetworkModes[mode] || strings.HasPrefix(mode, "container:") {
		return fmt.Errorf("network mode %q is not allowed", spec.Network)
	}
	for _, v := range spec.Volumes {
		if v.HostPath == "" {
			continue
		}
		if reason := deniedHostPath(v.HostPath); reason != "" {
			return fmt.Errorf("mounting %s is not allowed: %s", v.HostPath, reason)
		}
	}
	return nil
}

func deniedHostPath(hostPath string) string {
	slashed := filepath.ToSlash(hostPath)
	if strings.HasSuffix(strings.TrimRight(slashed, "/"), ".sock") {
		return "host socket"
	}
	if len(slashed) >= 2 && slashed[1] == ':' {
		// Windows drive paths only occur on Docker Desktop development nodes.
		return ""
	}
	clean := path.Clean("/" + strings.TrimLeft(slashed, "/"))
	for _, denied := range deniedHostExact {
		if clean == denied {
			return "host system path"
		}
	}
	for _, denied := range deniedHostTrees {
		if clean == denied || strings.HasPrefix(clean, denied+"/") {
			return "host system path"
		}
	}
	return ""
}

// hardeningArgs are appended to every docker run. Callers cannot weaken them:
// RunSpec has no fields for capabilities, security options or devices.
func hardeningArgs(spec RunSpec) []string {
	args := []string{"--security-opt", "no-new-privileges=true", "--cap-drop", "ALL"}
	for _, capability := range keptCapabilities {
		args = append(args, "--cap-add", capability)
	}
	args = append(args, "--pids-limit", strconv.Itoa(envInt("ZAKURA_CONTAINER_PIDS_LIMIT", defaultPidsLimit)))
	if memory := strings.TrimSpace(os.Getenv("ZAKURA_CONTAINER_MEMORY")); memory != "" {
		args = append(args, "--memory", memory)
	}
	if cpus := strings.TrimSpace(os.Getenv("ZAKURA_CONTAINER_CPUS")); cpus != "" {
		args = append(args, "--cpus", cpus)
	}
	if spec.Labels["zakura.purpose"] == "workspace" {
		// Chrome renders into shared memory; 1g avoids tab crashes without
		// widening any boundary.
		args = append(args, "--shm-size", "1g")
	}
	if egress := egressNetwork(); egress != "" && (spec.Network == "" || spec.Network == "bridge" || spec.Network == "default") {
		// Docker cannot publish ports from an internal network. MCP bridges no
		// longer publish (the node relays to them), so only legacy callers that
		// still request a port stay on the bridge with proxy settings.
		if len(spec.Ports) == 0 {
			args = append(args, "--network", egress)
		}
		for key, value := range egressProxyEnv() {
			if _, set := spec.Env[key]; !set {
				args = append(args, "-e", key+"="+value)
			}
		}
	}
	return args
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}
