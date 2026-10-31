package rpc

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
)

func TestMCPRelayReachesOnlyComponentContainers(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var seen *http.Request
	var seenBody string
	go func() {
		_ = http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			seen, seenBody = r, string(body)
			w.Header().Set("Mcp-Session-Id", "s1")
			w.Header().Set("Set-Cookie", "leak=1")
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
		}))
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "docker.jsonl")
	t.Setenv("ZAKURA_DOCKER", bin)
	t.Setenv("ZAKURA_TEST_RECEIPT_RPC_LOG", log)
	write := func(labels map[string]string) {
		raw, _ := json.Marshal(docker.ContainerInfo{DockerID: "receipt-rpc-id", Name: "c", Status: "running", Image: "i", Labels: labels, IPs: map[string]string{"bridge": "127.0.0.1"}})
		if err := os.WriteFile(log+".container", raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	h := New("server", t.TempDir())
	request := map[string]any{"container": "receipt-rpc-id", "port": port, "method": "POST", "path": "/mcp",
		"headers": map[string]string{"Content-Type": "application/json", "Mcp-Session-Id": "s0", "Cookie": "host-cookie"},
		"body":    base64.StdEncoding.EncodeToString([]byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))}

	write(map[string]string{"zakura.purpose": "workspace"})
	if response := createReceiptRPCCall(t, h, "mcp.http", request); !strings.Contains(response.Error, "not a running MCP component") {
		t.Fatalf("relayed to a workspace: %+v", response)
	}
	write(map[string]string{"zakura.purpose": "component", "zakura.instance": "inst"})
	response := createReceiptRPCCall(t, h, "mcp.http", request)
	if response.Error != "" {
		t.Fatal(response.Error)
	}
	var out struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	}
	if err := json.Unmarshal(response.Result, &out); err != nil {
		t.Fatal(err)
	}
	body, _ := base64.StdEncoding.DecodeString(out.Body)
	if out.Status != 200 || out.Headers["Mcp-Session-Id"] != "s1" || out.Headers["Set-Cookie"] != "" || !strings.Contains(string(body), `"result"`) {
		t.Fatalf("relay response: %+v %s", out, body)
	}
	if seen == nil || seen.URL.Path != "/mcp" || seen.Header.Get("Mcp-Session-Id") != "s0" || seen.Header.Get("Cookie") != "" || !strings.Contains(seenBody, "ping") {
		t.Fatalf("relayed request: %+v %q", seen, seenBody)
	}
	for _, bad := range []map[string]any{
		{"container": "receipt-rpc-id", "port": port, "method": "PUT", "path": "/mcp", "body": ""},
		{"container": "receipt-rpc-id", "port": port, "method": "GET", "path": "/../etc", "body": ""},
		{"container": "receipt-rpc-id", "port": 0, "method": "GET", "path": "/health", "body": ""},
	} {
		if response := createReceiptRPCCall(t, h, "mcp.http", bad); response.Error == "" {
			t.Fatalf("accepted %v", bad)
		}
	}
}
