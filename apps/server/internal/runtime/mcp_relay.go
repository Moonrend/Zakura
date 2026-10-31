package runtime

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Relay endpoints name a container, not an address:
// "zakura-relay://<node>/<dockerId>:<port>/mcp". Requests travel over the node
// connection (mcp.http), so MCP bridges publish no host port, are unreachable
// from the network, and can sit on the internal egress network.
const mcpRelayScheme = "zakura-relay"

func mcpRelayEndpoint(node, dockerID string, port int) string {
	return mcpRelayScheme + "://" + node + "/" + dockerID + ":" + strconv.Itoa(port) + "/mcp"
}

func isMCPRelayEndpoint(endpoint string) bool {
	return strings.HasPrefix(endpoint, mcpRelayScheme+"://")
}

type mcpRelayTransport struct{ h *handler }

func (t mcpRelayTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != mcpRelayScheme {
		return nil, errors.New("not a relay endpoint")
	}
	target, path, _ := strings.Cut(strings.TrimPrefix(req.URL.Path, "/"), "/")
	container, portText, ok := strings.Cut(target, ":")
	port, err := strconv.Atoi(portText)
	if !ok || container == "" || err != nil {
		return nil, errors.New("invalid relay endpoint")
	}
	var body []byte
	if req.Body != nil {
		if body, err = io.ReadAll(io.LimitReader(req.Body, 16<<20)); err != nil {
			return nil, err
		}
		_ = req.Body.Close()
	}
	headers := map[string]string{}
	for key := range req.Header {
		headers[key] = req.Header.Get(key)
	}
	runner, err := t.h.hubSession(req.URL.Host)
	if err != nil {
		return nil, err
	}
	var out struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	}
	params := map[string]any{"container": container, "port": port, "method": req.Method, "path": "/" + path, "headers": headers, "body": base64.StdEncoding.EncodeToString(body)}
	if err := runner.call(req.Context(), "mcp.http", params, &out); err != nil {
		return nil, err
	}
	payload, err := base64.StdEncoding.DecodeString(out.Body)
	if err != nil {
		return nil, err
	}
	resp := &http.Response{StatusCode: out.Status, Status: http.StatusText(out.Status), Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(payload)), ContentLength: int64(len(payload)), Request: req, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1}
	for key, value := range out.Headers {
		resp.Header.Set(key, value)
	}
	return resp, nil
}

// mcpHTTPClient relays through the node for relay endpoints and uses the
// gateway client for ordinary HTTP MCP servers.
func (h *handler) mcpHTTPClient(endpoint string) *http.Client {
	if isMCPRelayEndpoint(endpoint) {
		return &http.Client{Transport: mcpRelayTransport{h: h}}
	}
	return h.service.gateway.client
}
