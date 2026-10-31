package rpc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
	"github.com/Moonrend/Zakura/apps/agent/internal/sys"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

// bridgeBinary returns the static stdio bridge that is bind-mounted read-only
// into OCI MCP containers, so any image can be served without a bridge-equipped
// base image and without the Docker socket. The control plane supplies the
// download URL and its SHA-256; a cached copy is reused only if it matches.
func (h *Handler) bridgeBinary(ctx context.Context, source, digest string) (string, error) {
	if configured := strings.TrimSpace(os.Getenv("ZAKURA_STDIO_BRIDGE_BIN")); configured != "" {
		return configured, nil
	}
	if !strings.HasPrefix(source, "/api/") || len(digest) != 64 || h.ServerURL == "" {
		return "", fmt.Errorf("stdio bridge path and sha256 are required")
	}
	// Only fetch from the control plane this node is enrolled with.
	source = strings.TrimRight(h.ServerURL, "/") + source
	dir := filepath.Join(h.workspaceState.StateRoot, ".bridges")
	path := filepath.Join(dir, "zakura-stdio-bridge-"+digest[:16])
	if fileDigest(path) == digest {
		return path, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, ".download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	got, err := sys.Download(ctx, source, tmp)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", fmt.Errorf("download stdio bridge: %w", err)
	}
	if got != digest {
		return "", fmt.Errorf("stdio bridge checksum mismatch")
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", err
	}
	return path, nil
}

func fileDigest(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return ""
	}
	return hex.EncodeToString(sum.Sum(nil))
}

const mcpBridgePath = "/opt/zakura/zakura-stdio-bridge"

// mcpOCICreate starts an OCI MCP image as a hardened container whose PID 1 is
// the stdio bridge. The image's own entrypoint runs as the bridge's child, so
// the MCP server never gets Docker access and cannot influence container
// options: only image, arguments and environment come from the request.
func (h *Handler) mcpOCICreate(ctx context.Context, raw json.RawMessage) (any, error) {
	var request struct {
		Name    string            `json:"name"`
		Image   string            `json:"image"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
		Labels  map[string]string `json:"labels"`
		DataDir string            `json:"dataDir"`
		Port    int               `json:"port"`
		// Bridge download path on the control plane, verified by digest.
		BridgeURL    string `json:"bridgeUrl"`
		BridgeSHA256 string `json:"bridgeSha256"`
	}
	if err := decodeDockerCreate(raw, &request); err != nil {
		return nil, err
	}
	if !protocol.ValidIdentity(request.Name) || strings.TrimSpace(request.Image) == "" || request.Port < 1 || request.Port > 65535 {
		return nil, fmt.Errorf("name, image and port are required")
	}
	if request.Labels["zakura.purpose"] != "component" || !protocol.ValidIdentity(request.Labels["zakura.instance"]) {
		return nil, fmt.Errorf("OCI MCP containers must carry a component identity")
	}
	for key := range request.Env {
		if strings.HasPrefix(key, "MCP_") {
			return nil, fmt.Errorf("environment cannot override bridge control variables")
		}
	}
	bridge, err := h.bridgeBinary(ctx, request.BridgeURL, request.BridgeSHA256)
	if err != nil {
		return nil, err
	}
	if err := docker.Pull(ctx, request.Image); err != nil {
		return nil, err
	}
	entrypoint, cmd, err := docker.ImageCommand(ctx, request.Image)
	if err != nil {
		return nil, err
	}
	argv, err := docker.MCPInvocation(entrypoint, cmd, request.Args)
	if err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(argv[1:])
	env := map[string]string{"MCP_COMMAND": argv[0], "MCP_ARGS": string(encoded), "MCP_PORT": fmt.Sprint(request.Port), "MCP_PATH": "/mcp"}
	for key, value := range request.Env {
		env[key] = value
	}
	volumes := []docker.Volume{{HostPath: bridge, ContainerPath: mcpBridgePath, ReadOnly: true}}
	if request.DataDir != "" {
		root, err := filepath.Abs(filepath.Join(h.StorageRoot, "spaces"))
		if err != nil {
			return nil, err
		}
		data, err := filepath.Abs(request.DataDir)
		if err != nil || !strings.HasPrefix(data, root+string(filepath.Separator)) {
			return nil, fmt.Errorf("MCP data directory must be inside node workspace storage")
		}
		if h.insideManagedStorage(data) {
			return nil, fmt.Errorf("managed workspace disks require a pinned workspace binding")
		}
		volumes = append(volumes, docker.Volume{HostPath: data, ContainerPath: "/data"})
	}
	return docker.CreateWithEntrypoint(ctx, docker.RunSpec{
		Name: request.Name, Image: request.Image, Env: env, Labels: request.Labels,
		Ports: []docker.Port{{ContainerPort: request.Port, Protocol: "tcp"}}, Volumes: volumes,
		Restart: "unless-stopped", StdinOpen: false,
	}, mcpBridgePath)
}
