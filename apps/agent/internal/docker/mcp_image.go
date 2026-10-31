package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// ImageCommand returns the entrypoint and default command an image runs, so an
// OCI MCP server can be started under the stdio bridge exactly as `docker run
// IMAGE ARGS…` would start it, without giving anything access to Docker.
func ImageCommand(ctx context.Context, image string) (entrypoint, cmd []string, err error) {
	if err := Require(); err != nil {
		return nil, nil, err
	}
	out, err := exec.CommandContext(ctx, dockerBin(), "image", "inspect", "--format", "{{json .Config}}", image).CombinedOutput()
	if err != nil {
		return nil, nil, fmt.Errorf("docker image inspect: %s", strings.TrimSpace(string(out)))
	}
	var config struct {
		Entrypoint []string `json:"Entrypoint"`
		Cmd        []string `json:"Cmd"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(out))), &config); err != nil {
		return nil, nil, fmt.Errorf("parse image config: %w", err)
	}
	return config.Entrypoint, config.Cmd, nil
}

// MCPInvocation is what the bridge should execute inside the container:
// arguments replace the image Cmd, as with `docker run IMAGE ARGS…`.
func MCPInvocation(entrypoint, cmd, args []string) ([]string, error) {
	argv := append([]string(nil), entrypoint...)
	if len(args) > 0 {
		argv = append(argv, args...)
	} else {
		argv = append(argv, cmd...)
	}
	if len(argv) == 0 {
		return nil, fmt.Errorf("image defines no entrypoint or command")
	}
	return argv, nil
}
