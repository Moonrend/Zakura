package runtime

import (
	"errors"
	"fmt"
	"strings"
)

// ociMCPSpec is the only part of a `docker run …` MCP command Zakura honours.
// The command line is never executed: the node starts the image itself with
// the standard hardening, so nothing in the MCP configuration can request a
// privileged container, host namespaces, devices or host mounts, and no
// container is ever given the Docker socket.
type ociMCPSpec struct {
	Image   string
	Args    []string
	Env     map[string]string
	EnvPass []string // -e NAME without a value: taken from the MCP's configured env
}

var errOCIMCPUnsafe = errors.New("unsupported docker option in MCP command")

// Options that only change container lifetime or I/O and are safe to ignore,
// because the node sets them itself.
var ociIgnoredFlags = map[string]bool{"-i": true, "--interactive": true, "--rm": true, "-t": true, "--tty": true, "-it": true, "-ti": true, "--init": true, "-d": true, "--detach": true}

// Options with a value that are safe to ignore.
var ociIgnoredValueFlags = map[string]bool{"--name": true, "--pull": true, "--platform": true, "--label": true, "-l": true, "--log-driver": true, "--hostname": true, "-h": true}

// Options that weaken isolation. They are rejected with an explicit reason
// rather than silently dropped, so the operator knows the server will not run
// as its author intended.
var ociDeniedFlags = map[string]string{
	"--privileged":    "privileged containers are never allowed",
	"--cap-add":       "extra Linux capabilities are not allowed",
	"--device":        "host devices are not allowed",
	"--pid":           "host PID namespace is not allowed",
	"--ipc":           "host IPC namespace is not allowed",
	"--uts":           "host UTS namespace is not allowed",
	"--userns":        "user namespace changes are not allowed",
	"--network":       "network is set by the node egress policy",
	"--net":           "network is set by the node egress policy",
	"-v":              "host and volume mounts are not allowed",
	"--volume":        "host and volume mounts are not allowed",
	"--mount":         "host and volume mounts are not allowed",
	"--volumes-from":  "sharing another container's volumes is not allowed",
	"--security-opt":  "security options cannot be changed",
	"--cgroup-parent": "cgroup placement cannot be changed",
	"-p":              "publishing ports is not allowed",
	"--publish":       "publishing ports is not allowed",
	"-P":              "publishing ports is not allowed",
	"--publish-all":   "publishing ports is not allowed",
	"-u":              "the container user cannot be changed",
	"--user":          "the container user cannot be changed",
	"--entrypoint":    "the entrypoint cannot be changed",
	"--add-host":      "host resolution cannot be changed",
	"--dns":           "DNS is set by the node",
	"--sysctl":        "kernel parameters cannot be changed",
	"--env-file":      "env files are read from the host and are not allowed; use -e",
}

// parseOCIMCPCommand accepts `docker run [options] IMAGE [ARG…]` (or podman) and
// returns the image, its arguments and environment.
func parseOCIMCPCommand(command string, args []string) (ociMCPSpec, error) {
	spec := ociMCPSpec{Env: map[string]string{}}
	tool := command
	if i := strings.LastIndexAny(tool, `/\`); i >= 0 {
		tool = tool[i+1:]
	}
	if tool != "docker" && tool != "podman" {
		return spec, fmt.Errorf("OCI MCP command must be docker or podman, got %q", command)
	}
	if len(args) == 0 || args[0] != "run" {
		return spec, fmt.Errorf("OCI MCP command must be `%s run …`", tool)
	}
	rest := args[1:]
	for len(rest) > 0 {
		arg := rest[0]
		if !strings.HasPrefix(arg, "-") {
			break
		}
		rest = rest[1:]
		if arg == "--" {
			break
		}
		name, value, inline := strings.Cut(arg, "=")
		if ociIgnoredFlags[name] {
			continue
		}
		if reason, denied := ociDeniedFlags[name]; denied {
			return spec, fmt.Errorf("%w: %s (%s)", errOCIMCPUnsafe, name, reason)
		}
		takeValue := func() (string, error) {
			if inline {
				return value, nil
			}
			if len(rest) == 0 {
				return "", fmt.Errorf("%s requires a value", name)
			}
			v := rest[0]
			rest = rest[1:]
			return v, nil
		}
		switch {
		case name == "-e" || name == "--env":
			v, err := takeValue()
			if err != nil {
				return spec, err
			}
			key, val, hasValue := strings.Cut(v, "=")
			if key == "" {
				return spec, fmt.Errorf("invalid environment entry %q", v)
			}
			if hasValue {
				spec.Env[key] = val
			} else {
				spec.EnvPass = append(spec.EnvPass, key)
			}
		case name == "-w" || name == "--workdir":
			if _, err := takeValue(); err != nil {
				return spec, err
			}
		case ociIgnoredValueFlags[name]:
			if _, err := takeValue(); err != nil {
				return spec, err
			}
		default:
			return spec, fmt.Errorf("%w: %s", errOCIMCPUnsafe, name)
		}
	}
	if len(rest) == 0 || strings.TrimSpace(rest[0]) == "" {
		return spec, errors.New("OCI MCP command has no image")
	}
	spec.Image, spec.Args = rest[0], append([]string(nil), rest[1:]...)
	return spec, nil
}
