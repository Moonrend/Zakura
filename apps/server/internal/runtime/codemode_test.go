// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/go-chi/chi/v5"
)

func startCodemodeRunner(t *testing.T, serverURL, token string, handle func(method string, params map[string]any, emit func(string, string, any)) (any, func())) {
	t.Helper()
	go func() {
		u, _ := url.Parse(serverURL)
		conn, err := net.Dial("tcp", u.Host)
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = fmt.Fprintf(conn, "GET /api/runtime-nodes/hub HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", u.Host, token)
		reader := bufio.NewReader(conn)
		_, _ = reader.ReadString('\n')
		for {
			line, _ := reader.ReadString('\n')
			if line == "\r\n" {
				break
			}
		}
		emit := func(process, channel string, message any) {
			raw, _ := json.Marshal(message)
			raw = append(raw, '\n')
			frame, _ := json.Marshal(map[string]any{"type": "stream", "stream": process, "chan": channel, "data": base64.StdEncoding.EncodeToString(raw)})
			writeMaskedText(t, conn, string(frame))
		}
		for {
			raw, err := readRunnerServerText(reader)
			if err != nil {
				return
			}
			var frame struct {
				Type   string         `json:"type"`
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.Unmarshal([]byte(raw), &frame) != nil || frame.Type != "req" {
				continue
			}
			result, after := handle(frame.Method, frame.Params, emit)
			response, _ := json.Marshal(map[string]any{"type": "res", "id": frame.ID, "ok": true, "result": result})
			writeMaskedText(t, conn, string(response))
			if after != nil {
				after()
			}
		}
	}()
}

func codemodeToolHarness(t *testing.T, d *appdeps.Dependencies, runnerToken string, handle func(string, map[string]any, func(string, string, any)) (any, func())) *handler {
	t.Helper()
	now := d.Clock()
	hash := sha256.Sum256([]byte(runnerToken))
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now); err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: NewStore(d), mcpSessions: map[string]spaceMCPSession{}}
	h.hub = newRunnerHub(d)
	h.service = NewService(h.store)
	router := chi.NewRouter()
	router.Handle("/api/runtime-nodes/hub", http.HandlerFunc(h.runnerHubHTTP))
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	startCodemodeRunner(t, server.URL, runnerToken, handle)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := h.hub.get("node"); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := h.hub.get("node"); err != nil {
		t.Fatalf("runner did not come online: %v", err)
	}
	return h
}

func codemodeInfo() map[string]any {
	return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{}}
}

func TestRunCodemodeToolProtocol(t *testing.T) {
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
	var mu sync.Mutex
	var gotName string
	var gotArgs map[string]any
	mcp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     any            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		result := map[string]any{}
		switch req.Method {
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "echo", "description": "Echo", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"value": map[string]any{"type": "string"}}}}}}
		case "tools/call":
			mu.Lock()
			gotName, _ = req.Params["name"].(string)
			gotArgs, _ = req.Params["arguments"].(map[string]any)
			mu.Unlock()
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "echoed:hi"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}))
	t.Cleanup(mcp.Close)
	insertAgentMCPInstance(t, d, "mcp1", "echo", "Echo", mcp.URL, agent.ID, nil)

	h := codemodeToolHarness(t, d, "rnr_codemode", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
		switch method {
		case "sys.info":
			return codemodeInfo(), nil
		case "host.fs.write":
			return map[string]any{"ok": true, "path": fmt.Sprint(params["path"])}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "labels": map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.exec.start":
			return map[string]any{"id": "proc1"}, nil
		case "docker.exec.close":
			return map[string]any{"ok": true}, nil
		case "docker.exec.write":
			data, _ := base64.StdEncoding.DecodeString(fmt.Sprint(params["base64"]))
			line := strings.TrimSpace(string(data))
			if strings.Contains(line, `"op":"run"`) {
				return map[string]any{"ok": true}, func() {
					emit("proc1", "stdout", map[string]any{"op": "call", "id": 1, "name": "mcp__echo__echo", "args": map[string]any{"value": "hi"}})
				}
			}
			if strings.Contains(line, `"op":"result"`) {
				return map[string]any{"ok": true}, func() {
					emit("proc1", "stdout", map[string]any{"op": "done", "ok": true, "output": []string{"echoed:hi"}})
					emit("proc1", "exit", map[string]any{})
				}
			}
			return map[string]any{"ok": true}, nil
		default:
			return nil, nil
		}
	})
	raw, err := h.runCodemodeTool(context.Background(), "tenant", agent.ID, "", "", json.RawMessage(`{"code":"const r = await tools.mcp__echo__echo({ value: \"hi\" }); return r;"}`))
	if err != nil {
		t.Fatalf("runCodemodeTool: %v", err)
	}
	out := decodeBuiltinResult(t, raw, nil)
	output, _ := out["output"].([]any)
	if len(output) != 1 || output[0] != "echoed:hi" {
		t.Fatalf("codemode output: %#v", out)
	}
	if _, ok := out["wallMs"].(float64); !ok {
		t.Fatalf("codemode missing wallMs: %#v", out)
	}
	mu.Lock()
	name, args := gotName, gotArgs
	mu.Unlock()
	if name != "echo" {
		t.Fatalf("mcp tool name: %q", name)
	}
	if fmt.Sprint(args["value"]) != "hi" {
		t.Fatalf("mcp tool args: %#v", args)
	}
}

func TestRunCodemodeToolRejectsNested(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	node := "node"
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	var mu sync.Mutex
	var results []string
	h := codemodeToolHarness(t, d, "rnr_nested", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
		switch method {
		case "sys.info":
			return codemodeInfo(), nil
		case "host.fs.write":
			return map[string]any{"ok": true}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "labels": map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.exec.start":
			return map[string]any{"id": "proc1"}, nil
		case "docker.exec.close":
			return map[string]any{"ok": true}, nil
		case "docker.exec.write":
			data, _ := base64.StdEncoding.DecodeString(fmt.Sprint(params["base64"]))
			line := strings.TrimSpace(string(data))
			if strings.Contains(line, `"op":"run"`) {
				return map[string]any{"ok": true}, func() {
					emit("proc1", "stdout", map[string]any{"op": "call", "id": 7, "name": "codemode", "args": map[string]any{"code": "1"}})
				}
			}
			if strings.Contains(line, `"op":"result"`) {
				mu.Lock()
				results = append(results, line)
				mu.Unlock()
				return map[string]any{"ok": true}, func() {
					emit("proc1", "stdout", map[string]any{"op": "done", "ok": true, "output": []string{}})
					emit("proc1", "exit", map[string]any{})
				}
			}
			return map[string]any{"ok": true}, nil
		default:
			return nil, nil
		}
	})
	if _, err := h.runCodemodeTool(context.Background(), "tenant", agent.ID, "", "", json.RawMessage(`{"code":"await tools.codemode({});"}`)); err != nil {
		t.Fatalf("runCodemodeTool: %v", err)
	}
	mu.Lock()
	captured := append([]string(nil), results...)
	mu.Unlock()
	if len(captured) != 1 {
		t.Fatalf("nested codemode results: %#v", captured)
	}
	if !strings.Contains(captured[0], `"ok":false`) || !strings.Contains(captured[0], "codemode cannot start codemode scripts") {
		t.Fatalf("nested codemode result: %s", captured[0])
	}
}

func TestRunCodemodeToolScriptFailure(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	node := "node"
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	h := codemodeToolHarness(t, d, "rnr_fail", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
		switch method {
		case "sys.info":
			return codemodeInfo(), nil
		case "host.fs.write":
			return map[string]any{"ok": true}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "labels": map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.exec.start":
			return map[string]any{"id": "proc1"}, nil
		case "docker.exec.close":
			return map[string]any{"ok": true}, nil
		case "docker.exec.write":
			data, _ := base64.StdEncoding.DecodeString(fmt.Sprint(params["base64"]))
			if strings.Contains(strings.TrimSpace(string(data)), `"op":"run"`) {
				return map[string]any{"ok": true}, func() {
					emit("proc1", "stdout", map[string]any{"op": "done", "ok": false, "error": "boom"})
					emit("proc1", "exit", map[string]any{})
				}
			}
			return map[string]any{"ok": true}, nil
		default:
			return nil, nil
		}
	})
	if _, err := h.runCodemodeTool(context.Background(), "tenant", agent.ID, "", "", json.RawMessage(`{"code":"throw new Error('boom')"}`)); err == nil || !strings.Contains(err.Error(), "codemode script failed: boom") {
		t.Fatalf("script failure error: %v", err)
	}
}

func TestCodemodeHarnessNodeSmoke(t *testing.T) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not available")
	}
	harnessPath := filepath.Join(t.TempDir(), "harness.mjs")
	if err := os.WriteFile(harnessPath, []byte(codemodeHarnessJS), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(nodePath, harnessPath)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill() }()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	write := func(value any) {
		raw, _ := json.Marshal(value)
		raw = append(raw, '\n')
		_, _ = stdin.Write(raw)
	}
	write(map[string]any{"op": "run", "code": `const r = await tools.echo({ value: "hi" }); text("echoed:" + r.text);`})
	if !scanner.Scan() {
		t.Fatalf("no call line: %v", scanner.Err())
	}
	var call struct {
		Op   string         `json:"op"`
		ID   int            `json:"id"`
		Name string         `json:"name"`
		Args map[string]any `json:"args"`
	}
	if err := json.Unmarshal(scanner.Bytes(), &call); err != nil {
		t.Fatalf("call line %q: %v", scanner.Text(), err)
	}
	if call.Op != "call" || call.Name != "echo" || fmt.Sprint(call.Args["value"]) != "hi" {
		t.Fatalf("call: %#v", call)
	}
	write(map[string]any{"op": "result", "id": call.ID, "ok": true, "result": map[string]any{"text": "hello"}})
	if !scanner.Scan() {
		t.Fatalf("no done line: %v", scanner.Err())
	}
	var done struct {
		Op     string   `json:"op"`
		OK     bool     `json:"ok"`
		Output []string `json:"output"`
	}
	if err := json.Unmarshal(scanner.Bytes(), &done); err != nil {
		t.Fatalf("done line %q: %v", scanner.Text(), err)
	}
	if done.Op != "done" || !done.OK || len(done.Output) != 1 || done.Output[0] != "echoed:hello" {
		t.Fatalf("done: %#v", done)
	}
	_ = stdin.Close()
	_ = cmd.Wait()
}

func TestAgentToolCatalogIncludesCodemode(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	h := builtinToolHarness(t, d, "rnr_catalog", func(method string, params map[string]any) (any, error) {
		if method == "sys.info" {
			return codemodeInfo(), nil
		}
		return nil, fmt.Errorf("unexpected method %s", method)
	})
	catalog, err := h.agentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range catalog.Tools {
		if tool.Name != "codemode" {
			continue
		}
		if tool.Kind != "builtin" || tool.Exposure != "direct" {
			t.Fatalf("codemode tool metadata: %#v", tool)
		}
		required, _ := tool.InputSchema["required"].([]string)
		if len(required) != 1 || required[0] != "code" {
			t.Fatalf("codemode required: %#v", tool.InputSchema["required"])
		}
		return
	}
	t.Fatalf("codemode missing from catalog: %#v", catalog.Tools)
}
