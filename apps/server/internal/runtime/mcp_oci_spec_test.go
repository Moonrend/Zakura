package runtime

import (
	"errors"
	"slices"
	"testing"
)

func TestParseOCIMCPCommand(t *testing.T) {
	spec, err := parseOCIMCPCommand("docker", []string{"run", "-i", "--rm", "-e", "GITHUB_TOKEN", "-e", "MODE=readonly", "--name", "gh", "ghcr.io/github/github-mcp-server", "stdio", "--toolsets", "repos"})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Image != "ghcr.io/github/github-mcp-server" || !slices.Equal(spec.Args, []string{"stdio", "--toolsets", "repos"}) || spec.Env["MODE"] != "readonly" || !slices.Equal(spec.EnvPass, []string{"GITHUB_TOKEN"}) {
		t.Fatalf("spec: %+v", spec)
	}
	if spec, err := parseOCIMCPCommand("/usr/bin/podman", []string{"run", "--interactive=true", "mcp/time"}); err != nil || spec.Image != "mcp/time" {
		t.Fatalf("podman: %+v %v", spec, err)
	}
	for name, args := range map[string][]string{
		"privileged":   {"run", "--privileged", "img"},
		"socket mount": {"run", "-v", "/var/run/docker.sock:/var/run/docker.sock", "img"},
		"inline mount": {"run", "--volume=/:/host", "img"},
		"mount":        {"run", "--mount", "type=bind,src=/,dst=/h", "img"},
		"host network": {"run", "--network", "host", "img"},
		"host pid":     {"run", "--pid=host", "img"},
		"cap add":      {"run", "--cap-add", "SYS_ADMIN", "img"},
		"device":       {"run", "--device", "/dev/kvm", "img"},
		"security opt": {"run", "--security-opt", "seccomp=unconfined", "img"},
		"env file":     {"run", "--env-file", "/etc/shadow", "img"},
		"entrypoint":   {"run", "--entrypoint", "/bin/sh", "img"},
		"unknown flag": {"run", "--some-new-option", "img"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseOCIMCPCommand("docker", args); !errors.Is(err, errOCIMCPUnsafe) {
				t.Fatalf("accepted %v: %v", args, err)
			}
		})
	}
	for _, args := range [][]string{{"run"}, {"exec", "x"}, {"run", "-e"}} {
		if _, err := parseOCIMCPCommand("docker", args); err == nil {
			t.Fatalf("malformed accepted: %v", args)
		}
	}
	if _, err := parseOCIMCPCommand("sh", []string{"-c", "docker run img"}); err == nil {
		t.Fatal("shell wrapper accepted")
	}
}
