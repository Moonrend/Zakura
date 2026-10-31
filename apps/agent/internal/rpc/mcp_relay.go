package rpc

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
)

// MCP bridges publish no host port. The control plane reaches them through
// this relay: the node resolves the container by ID, checks it is a Zakura
// component, and forwards one HTTP request to its address on the Docker
// network. Bridges can then sit on the internal egress network, and no MCP
// endpoint is reachable from the LAN.

const mcpRelayMaxBody = 16 << 20

var mcpRelayClient = &http.Client{
	Timeout: 5 * time.Minute,
	// Never follow redirects: the relay targets exactly one container.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	Transport:     &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext},
}

var mcpRelayHeaders = map[string]bool{"content-type": true, "accept": true, "mcp-session-id": true, "mcp-protocol-version": true, "authorization": true, "last-event-id": true}

func (h *Handler) mcpHTTP(ctx context.Context, raw json.RawMessage) (any, error) {
	var request struct {
		Container string            `json:"container"`
		Port      int               `json:"port"`
		Method    string            `json:"method"`
		Path      string            `json:"path"`
		Headers   map[string]string `json:"headers"`
		Body      string            `json:"body"` // base64
	}
	if err := decodeDockerCreate(raw, &request); err != nil {
		return nil, err
	}
	switch request.Method {
	case http.MethodGet, http.MethodPost, http.MethodDelete:
	default:
		return nil, fmt.Errorf("unsupported relay method")
	}
	if request.Port < 1 || request.Port > 65535 || !strings.HasPrefix(request.Path, "/") || strings.Contains(request.Path, "..") {
		return nil, fmt.Errorf("invalid relay target")
	}
	container, err := docker.Inspect(ctx, request.Container)
	if err != nil {
		return nil, err
	}
	// Only Zakura MCP components are relay targets; never workspaces or
	// arbitrary containers that happen to listen on the port.
	if container.Labels["zakura.purpose"] != "component" || container.Labels["zakura.instance"] == "" || container.Status != "running" {
		return nil, fmt.Errorf("relay target is not a running MCP component")
	}
	address := ""
	for _, network := range []string{docker.EgressNetworkName, "bridge"} {
		if ip := container.IPs[network]; ip != "" {
			address = ip
			break
		}
	}
	if address == "" {
		for _, ip := range container.IPs {
			address = ip
			break
		}
	}
	if address == "" {
		return nil, fmt.Errorf("MCP component has no network address")
	}
	body, err := base64.StdEncoding.DecodeString(request.Body)
	if err != nil || len(body) > mcpRelayMaxBody {
		return nil, fmt.Errorf("invalid relay body")
	}
	target := "http://" + net.JoinHostPort(address, strconv.Itoa(request.Port)) + request.Path
	req, err := http.NewRequestWithContext(ctx, request.Method, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for key, value := range request.Headers {
		if mcpRelayHeaders[strings.ToLower(key)] {
			req.Header.Set(key, value)
		}
	}
	resp, err := mcpRelayClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, mcpRelayMaxBody+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > mcpRelayMaxBody {
		return nil, fmt.Errorf("MCP response exceeds %d bytes", mcpRelayMaxBody)
	}
	headers := map[string]string{}
	for _, key := range []string{"Content-Type", "Mcp-Session-Id"} {
		if value := resp.Header.Get(key); value != "" {
			headers[key] = value
		}
	}
	return map[string]any{"status": resp.StatusCode, "headers": headers, "body": base64.StdEncoding.EncodeToString(payload)}, nil
}
