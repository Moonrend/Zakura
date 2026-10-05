// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestStdioBridgeHelper(t *testing.T) {
	if os.Getenv("GO_WANT_STDIO_BRIDGE_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	initializeCount := 0
	for scanner.Scan() {
		var req struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
			Params any    `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			continue
		}
		var result any
		switch req.Method {
		case "initialize":
			initializeCount++
			if initializeCount > 1 {
				_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32600, "message": "already initialized"}})
				continue
			}
			result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "fake", "version": "1"}}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "echo", "inputSchema": map[string]any{"type": "object"}}}}
		case "tools/call":
			time.Sleep(30 * time.Millisecond)
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "ok"}}, "echo": req.Params}
		case "notifications/initialized":
			continue
		default:
			result = map[string]any{"method": req.Method}
		}
		_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
		if req.Method == "tools/list" {
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
		}
	}
	os.Exit(0)
}

func TestStdioBridgeConcurrentSessionsAndSSE(t *testing.T) {
	bridge, err := NewStdioBridge(StdioBridgeOptions{Command: os.Args[0], Args: []string{"-test.run=TestStdioBridgeHelper"}, Env: []string{"GO_WANT_STDIO_BRIDGE_HELPER=1"}, RequestTimeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(bridge)
	defer server.Close()
	defer bridge.Close(context.Background())
	post := func(body, sid string) (*http.Response, map[string]any, error) {
		req, _ := http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if sid != "" {
			req.Header.Set("Mcp-Session-Id", sid)
		}
		resp, err := server.Client().Do(req)
		if err != nil {
			return nil, nil, err
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp, out, nil
	}
	initBody := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`
	r1, first, err := post(initBody, "")
	if err != nil || r1.StatusCode != http.StatusOK || first["result"] == nil {
		t.Fatalf("first init: status=%v body=%#v err=%v", statusCode(r1), first, err)
	}
	r2, second, err := post(initBody, "")
	if err != nil || r2.StatusCode != http.StatusOK || second["result"] == nil {
		t.Fatalf("second init must use cached upstream handshake: status=%v body=%#v err=%v", statusCode(r2), second, err)
	}
	sids := []string{r1.Header.Get("Mcp-Session-Id"), r2.Header.Get("Mcp-Session-Id")}
	type result struct {
		body map[string]any
		err  error
	}
	results := make(chan result, 2)
	for i, sid := range sids {
		go func(i int, sid string) {
			_, body, err := post(fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"client":%d}}}`, i), sid)
			results <- result{body: body, err: err}
		}(i, sid)
	}
	for range sids {
		got := <-results
		if got.err != nil || got.body["result"] == nil || got.body["id"] != float64(1) {
			t.Fatalf("same-id concurrent request misrouted: body=%#v err=%v", got.body, got.err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	get, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/mcp", nil)
	get.Header.Set("Mcp-Session-Id", sids[0])
	stream, err := server.Client().Do(get)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	if stream.StatusCode != http.StatusOK || !strings.Contains(stream.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("SSE status=%d type=%q", stream.StatusCode, stream.Header.Get("Content-Type"))
	}
	lines := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stream.Body)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "notifications/tools/list_changed") {
				lines <- scanner.Text()
				return
			}
		}
		lines <- ""
	}()
	if _, _, err = post(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`, sids[0]); err != nil {
		t.Fatal(err)
	}
	select {
	case data := <-lines:
		if !strings.Contains(data, "notifications/tools/list_changed") {
			t.Fatalf("SSE missing upstream notification: %q", data)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for SSE notification")
	}
}

func statusCode(resp *http.Response) int {
	if resp == nil {
		return 0
	}
	return resp.StatusCode
}
func TestStdioBridgeSessionAndRPC(t *testing.T) {
	bridge, err := NewStdioBridge(StdioBridgeOptions{Command: os.Args[0], Args: []string{"-test.run=TestStdioBridgeHelper"}, Env: []string{"GO_WANT_STDIO_BRIDGE_HELPER=1"}, RequestTimeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(bridge)
	defer server.Close()
	defer bridge.Close(context.Background())
	post := func(body string, sid string) (*http.Response, map[string]any) {
		req, _ := http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if sid != "" {
			req.Header.Set("Mcp-Session-Id", sid)
		}
		resp, e := server.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp, out
	}
	resp, init := post(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`, "")
	sid := resp.Header.Get("Mcp-Session-Id")
	if resp.StatusCode != http.StatusOK || sid == "" || init["result"] == nil {
		t.Fatalf("initialize: %d %q %#v", resp.StatusCode, sid, init)
	}
	resp, listed := post(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`, sid)
	if resp.StatusCode != http.StatusOK || listed["result"] == nil {
		t.Fatalf("tools: %d %#v", resp.StatusCode, listed)
	}
	resp, _ = post(`{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}`, "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing session: %d", resp.StatusCode)
	}
	req, _ := http.NewRequest(http.MethodDelete, server.URL+"/mcp", nil)
	req.Header.Set("Mcp-Session-Id", sid)
	deleted, e := server.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	deleted.Body.Close()
	if deleted.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d", deleted.StatusCode)
	}
}
