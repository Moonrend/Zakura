// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func newWebHandler(t *testing.T) (*handler, string) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	return &handler{deps: d, store: store}, agent.ID
}

func newWebHandlerWithConfig(t *testing.T, config string) (*handler, string) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, Config: json.RawMessage(config)})
	if err != nil {
		t.Fatal(err)
	}
	return &handler{deps: d, store: store}, agent.ID
}

func TestTruncateToolTextShort(t *testing.T) {
	h, _ := newWebHandler(t)
	ctx := context.Background()
	text := strings.Repeat("a", 100)
	out, err := h.truncateToolText(ctx, "tenant", "missing-agent", text, "shell")
	if err != nil {
		t.Fatal(err)
	}
	if out != text {
		t.Fatalf("short text should be unchanged, got %q", out)
	}
}

func TestTruncateToolTextNoWorkspace(t *testing.T) {
	h, _ := newWebHandler(t)
	ctx := context.Background()
	text := strings.Repeat("a", toolOutputMaxBytes+5000)
	out, err := h.truncateToolText(ctx, "tenant", "missing-agent", text, "shell")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "[output truncated; no workspace to store the full output]") {
		t.Fatalf("missing fallback marker: %q", out)
	}
	if len(out) >= len(text) {
		t.Fatalf("truncated text should be shorter")
	}
}

func TestTruncateToolTextWritesWorkspaceFile(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	node := "node"
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	h := builtinToolHarness(t, d, "rnr_web_trunc", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true}, "hostInfo": map[string]any{}}, nil
		case "host.fs.write":
			path := fmt.Sprint(params["path"])
			data, decodeErr := base64.StdEncoding.DecodeString(fmt.Sprint(params["base64"]))
			if decodeErr != nil {
				return nil, decodeErr
			}
			files[path] = string(data)
			return map[string]any{"ok": true, "path": path}, nil
		case "host.fs.read":
			path := fmt.Sprint(params["path"])
			return map[string]any{"path": path, "content": files[path], "size": len(files[path])}, nil
		default:
			return nil, fmt.Errorf("unexpected method %s", method)
		}
	})
	text := strings.Repeat("b", toolOutputMaxBytes+10000)
	out, err := h.truncateToolText(context.Background(), "tenant", agent.ID, text, "shell")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "chars truncated; full output: /workspace/.zakura/outputs/") {
		t.Fatalf("missing full output marker: %q", out)
	}
	if !strings.HasPrefix(out, strings.Repeat("b", toolOutputHeadBytes)) {
		t.Fatalf("missing head bytes")
	}
	found := false
	for path, content := range files {
		if strings.HasPrefix(path, "/.zakura/outputs/") && content == text {
			found = true
		}
	}
	if !found {
		t.Fatalf("full output was not written to the workspace: %#v", files)
	}
}

func TestCapToolResultJSON(t *testing.T) {
	h, _ := newWebHandler(t)
	ctx := context.Background()
	small := json.RawMessage(`{"a":1}`)
	if string(h.capToolResultJSON(ctx, "tenant", "missing-agent", small, "mcp_tool")) != string(small) {
		t.Fatalf("small JSON should be unchanged")
	}
	big := json.RawMessage(`{"payload":"` + strings.Repeat("x", toolOutputMaxBytes+1000) + `"}`)
	out := h.capToolResultJSON(ctx, "tenant", "missing-agent", big, "mcp_tool")
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("truncated JSON invalid: %v", err)
	}
	if parsed["truncated"] != true {
		t.Fatalf("expected truncated flag: %#v", parsed)
	}
	preview, _ := parsed["preview"].(string)
	if len(preview) != toolOutputJSONPreviewSize {
		t.Fatalf("preview length = %d", len(preview))
	}
}

func TestRunWebSearchTavily(t *testing.T) {
	h, agentID := newWebHandler(t)
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{{"title": "Go", "url": "https://go.dev", "content": "The Go language", "score": 0.9}}})
	}))
	defer server.Close()
	if err := h.putSetting(context.Background(), "tenant:tenant", "web-search", map[string]any{"engines": map[string]any{"tavily": map[string]any{"apiKey": "secret-key", "baseUrl": server.URL}}}); err != nil {
		t.Fatal(err)
	}
	raw, err := h.runBuiltinTool(context.Background(), "tenant", agentID, "web_search", json.RawMessage(`{"query":"go"}`))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, "- Go") || !strings.Contains(text, "https://go.dev") || !strings.Contains(text, "The Go language") {
		t.Fatalf("unexpected result: %q", text)
	}
	if body["api_key"] != "secret-key" || body["query"] != "go" || body["max_results"] != float64(5) {
		t.Fatalf("unexpected request body: %#v", body)
	}
}

func TestRunWebSearchSerper(t *testing.T) {
	h, agentID := newWebHandler(t)
	var apiKeyHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiKeyHeader = r.Header.Get("X-API-KEY")
		_ = json.NewEncoder(w).Encode(map[string]any{"organic": []map[string]any{{"title": "Serper Result", "link": "https://example.com/s", "snippet": "Snippet text"}}})
	}))
	defer server.Close()
	if err := h.putSetting(context.Background(), "tenant:tenant", "web-search", map[string]any{"engines": map[string]any{"serper": map[string]any{"apiKey": "serper-key", "baseUrl": server.URL}}}); err != nil {
		t.Fatal(err)
	}
	raw, err := h.runBuiltinTool(context.Background(), "tenant", agentID, "web_search", json.RawMessage(`{"query":"rust","limit":3}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "Serper Result") || !strings.Contains(string(raw), "Snippet text") {
		t.Fatalf("unexpected result: %q", string(raw))
	}
	if apiKeyHeader != "serper-key" {
		t.Fatalf("X-API-KEY header = %q", apiKeyHeader)
	}
}

func TestRunWebSearchDefaultEngine(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, Config: json.RawMessage(`{"providers":{"webSearch":{"defaultEngine":"serper"}}}`)})
	if err != nil {
		t.Fatal(err)
	}
	var tavilyHits, serperHits atomic.Int64
	tavily := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tavilyHits.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{{"title": "Tavily", "url": "https://t", "content": "t"}}})
	}))
	defer tavily.Close()
	serper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serperHits.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"organic": []map[string]any{{"title": "Serper", "link": "https://s", "snippet": "s"}}})
	}))
	defer serper.Close()
	h := &handler{deps: d, store: store}
	if err := h.putSetting(context.Background(), "tenant:tenant", "web-search", map[string]any{
		"defaultEngine": "tavily",
		"engines":       map[string]any{"tavily": map[string]any{"apiKey": "t", "baseUrl": tavily.URL}, "serper": map[string]any{"apiKey": "s", "baseUrl": serper.URL}},
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := h.runWebSearch(context.Background(), "tenant", agent.ID, json.RawMessage(`{"query":"q"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "Serper") {
		t.Fatalf("expected serper result: %q", string(raw))
	}
	if serperHits.Load() != 1 || tavilyHits.Load() != 0 {
		t.Fatalf("engine selection wrong: tavily=%d serper=%d", tavilyHits.Load(), serperHits.Load())
	}
}

func TestRunWebSearchNotConfigured(t *testing.T) {
	h, agentID := newWebHandler(t)
	_, err := h.runWebSearch(context.Background(), "tenant", agentID, json.RawMessage(`{"query":"q"}`))
	if err == nil || err.Error() != "web search is not configured" {
		t.Fatalf("expected not configured error, got %v", err)
	}
}

func TestRunWebSearchDisabled(t *testing.T) {
	h, agentID := newWebHandlerWithConfig(t, `{"providers":{"webSearch":{"enabled":false}}}`)
	_, err := h.runWebSearch(context.Background(), "tenant", agentID, json.RawMessage(`{"query":"q"}`))
	if err == nil || err.Error() != "web search is disabled for this agent" {
		t.Fatalf("expected disabled error, got %v", err)
	}
}

func catalogToolNames(t *testing.T, h *handler, agentID string) map[string]bool {
	t.Helper()
	catalog, err := h.agentToolCatalog(context.Background(), "tenant", agentID)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range catalog.Tools {
		names[tool.Name] = true
	}
	return names
}

func TestAgentToolCatalogWebTools(t *testing.T) {
	h, agentID := newWebHandler(t)
	names := catalogToolNames(t, h, agentID)
	if !names["web_search"] || !names["web_fetch"] {
		t.Fatalf("web tools should be registered by default: %#v", names)
	}
}

func TestAgentToolCatalogWebToolsDisabled(t *testing.T) {
	h, agentID := newWebHandlerWithConfig(t, `{"providers":{"webSearch":{"enabled":false},"webFetch":{"enabled":false}}}`)
	names := catalogToolNames(t, h, agentID)
	if names["web_search"] || names["web_fetch"] {
		t.Fatalf("web tools should be hidden when disabled: %#v", names)
	}
}

func TestRunWebFetchNative(t *testing.T) {
	h, agentID := newWebHandler(t)
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head><style>body{color:red}</style><script>var secret=1;</script></head><body><h1>Hello</h1><p>World &amp; friends</p></body></html>`))
	}))
	defer page.Close()
	if err := h.putSetting(context.Background(), "tenant:tenant", "web-fetch", map[string]any{"allowPrivateHosts": true}); err != nil {
		t.Fatal(err)
	}
	raw, err := h.runWebFetch(context.Background(), "tenant", agentID, json.RawMessage(`{"url":"`+page.URL+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, "# Content from "+page.URL) || !strings.Contains(text, "Hello") || !strings.Contains(text, "World & friends") {
		t.Fatalf("unexpected native content: %q", text)
	}
	if strings.Contains(text, "secret") || strings.Contains(text, "color:red") {
		t.Fatalf("script/style not stripped: %q", text)
	}
}

func TestRunWebFetchSSRF(t *testing.T) {
	h, agentID := newWebHandler(t)
	for _, target := range []string{"http://127.0.0.1/x", "http://192.168.1.1/x", "http://localhost/x", "http://10.0.0.5/x", "http://169.254.1.1/x", "http://[::1]/x", "http://[::ffff:127.0.0.1]/x"} {
		_, err := h.runWebFetch(context.Background(), "tenant", agentID, json.RawMessage(`{"url":"`+target+`"}`))
		if err == nil || !strings.Contains(err.Error(), "private addresses is not allowed") {
			t.Fatalf("expected SSRF rejection for %s, got %v", target, err)
		}
	}
	for address, wantPublic := range map[string]bool{
		"8.8.8.8":              true,
		"2606:4700:4700::1111": true,
		"10.0.0.5":             false,
		"100.64.0.1":           false,
		"192.0.2.1":            false,
		"198.18.0.1":           false,
		"224.0.0.1":            false,
		"fc00::1":              false,
		"2001:db8::1":          false,
		"2002:7f00:1::":        false,
	} {
		if got := publicWebFetchIP(net.ParseIP(address)); got != wantPublic {
			t.Fatalf("publicWebFetchIP(%s) = %v, want %v", address, got, wantPublic)
		}
	}
}

func TestPublicWebFetchDialPinsResolvedAddress(t *testing.T) {
	lookup := func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
	}
	var dialedAddress string
	var peer net.Conn
	dial := newPublicWebFetchDialContext(lookup, func(_ context.Context, _ string, address string) (net.Conn, error) {
		dialedAddress = address
		connection, other := net.Pipe()
		peer = other
		return connection, nil
	})
	connection, err := dial(context.Background(), "tcp", "example.com:443")
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	defer peer.Close()
	if dialedAddress != "93.184.216.34:443" {
		t.Fatalf("dialed address = %q", dialedAddress)
	}
}

func TestPublicWebFetchDialRejectsMixedDNS(t *testing.T) {
	lookup := func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}, {IP: net.ParseIP("127.0.0.1")}}, nil
	}
	dialed := false
	dial := newPublicWebFetchDialContext(lookup, func(context.Context, string, string) (net.Conn, error) {
		dialed = true
		return nil, errors.New("unexpected dial")
	})
	_, err := dial(context.Background(), "tcp", "mixed.example:80")
	if !errors.Is(err, errWebFetchPrivateAddress) || dialed {
		t.Fatalf("mixed DNS answer was not rejected before dial: err=%v dialed=%v", err, dialed)
	}
}

func TestPublicWebFetchClientRevalidatesRedirects(t *testing.T) {
	lookup := func(_ context.Context, host string) ([]net.IPAddr, error) {
		if host == "redirect.example" {
			return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}}, nil
		}
		return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
	}
	client := newPublicWebFetchHTTPClient(lookup, func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("not used")
	})
	redirect, err := http.NewRequest(http.MethodGet, "https://redirect.example/private", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = client.CheckRedirect(redirect, []*http.Request{{}}); !errors.Is(err, errWebFetchPrivateAddress) {
		t.Fatalf("private redirect was not rejected: %v", err)
	}
	publicRedirect, err := http.NewRequest(http.MethodGet, "https://public.example/page", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = client.CheckRedirect(publicRedirect, []*http.Request{{}}); err != nil {
		t.Fatalf("public redirect was rejected: %v", err)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil || transport.Dial != nil || transport.DialContext == nil || transport.DialTLS != nil || transport.DialTLSContext != nil {
		t.Fatalf("public web fetch transport permits proxy bypass: %#v", client.Transport)
	}
}

func TestRunWebFetchJinaReader(t *testing.T) {
	h, agentID := newWebHandler(t)
	var gotPath string
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if r.Header.Get("Accept") != "text/plain" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte("# Markdown\nhello"))
	}))
	defer reader.Close()
	if err := h.putSetting(context.Background(), "tenant:tenant", "web-fetch", map[string]any{"defaultBackend": "jina-reader", "backends": map[string]any{"jina-reader": map[string]any{"baseUrl": reader.URL}}}); err != nil {
		t.Fatal(err)
	}
	raw, err := h.runWebFetch(context.Background(), "tenant", agentID, json.RawMessage(`{"url":"https://example.com/page"}`))
	if err != nil {
		t.Fatal(err)
	}
	expected := "# Content from https://example.com/page\n\n# Markdown\nhello"
	if string(raw) != expected {
		t.Fatalf("jina reader output = %q", string(raw))
	}
	if gotPath != "/r/https://example.com/page" {
		t.Fatalf("jina reader path = %q", gotPath)
	}
}

func TestRunShellExecTruncation(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	node := "node"
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	big := strings.Repeat("z", toolOutputMaxBytes+8000)
	h := builtinToolHarness(t, d, "rnr_web_shell", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{}}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "labels": map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.exec":
			return map[string]any{"exitCode": 0, "stdout": big, "stderr": ""}, nil
		default:
			return nil, fmt.Errorf("unexpected method %s", method)
		}
	})
	raw, err := h.runBuiltinTool(context.Background(), "tenant", agent.ID, "shell_exec", json.RawMessage(`{"command":"emit"}`))
	if err != nil {
		t.Fatal(err)
	}
	out := decodeBuiltinResult(t, raw, nil)
	stdout, _ := out["stdout"].(string)
	if !strings.Contains(stdout, "truncated") {
		t.Fatalf("shell stdout was not truncated: len=%d", len(stdout))
	}
	if len(stdout) >= len(big) {
		t.Fatalf("shell stdout not shortened: %d -> %d", len(big), len(stdout))
	}
}
