// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func browserHarness(t *testing.T, run func(command []string) (map[string]any, error)) (*handler, Agent, *[]string) {
	t.Helper()
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
	var lastCommand []string
	h := builtinToolHarness(t, d, "rnr_browser", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{}}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "labels": map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "host.fs.write":
			return map[string]any{"ok": true, "path": fmt.Sprint(params["path"])}, nil
		case "docker.exec":
			command, _ := params["command"].([]any)
			argv := make([]string, 0, len(command))
			for _, item := range command {
				argv = append(argv, fmt.Sprint(item))
			}
			lastCommand = argv
			return run(argv)
		}
		return nil, fmt.Errorf("unexpected method %s", method)
	})
	return h, agent, &lastCommand
}

func TestRunBuiltinToolBrowserOpen(t *testing.T) {
	h, agent, last := browserHarness(t, func([]string) (map[string]any, error) {
		return map[string]any{"exitCode": 0, "stdout": `{"ok":true,"url":"https://example.com","title":"Example","text":"hi"}`, "stderr": ""}, nil
	})
	openRaw, openErr := h.runBuiltinToolBrowser(context.Background(), "tenant", agent.ID, "browser_open", raw(map[string]any{"url": "https://example.com"}))
	out := decodeBuiltinResult(t, openRaw, openErr)
	if out["ok"] != true || out["url"] != "https://example.com" || out["title"] != "Example" || out["text"] != "hi" {
		t.Fatalf("browser_open result: %#v", out)
	}
	argv := *last
	if len(argv) != 4 || argv[0] != "node" || argv[1] != "/workspace/.zakura/browser/driver.mjs" || argv[2] != "open" {
		t.Fatalf("browser argv: %#v", argv)
	}
	decoded, decErr := base64.StdEncoding.DecodeString(argv[3])
	if decErr != nil {
		t.Fatalf("decode payload: %v", decErr)
	}
	args := map[string]any{}
	if json.Unmarshal(decoded, &args) != nil || args["url"] != "https://example.com" {
		t.Fatalf("decoded payload: %s", decoded)
	}
}

func TestRunBuiltinToolBrowserClickNotFound(t *testing.T) {
	h, agent, last := browserHarness(t, func([]string) (map[string]any, error) {
		return map[string]any{"exitCode": 1, "stdout": `{"ok":false,"error":"element not found: #x"}`, "stderr": ""}, nil
	})
	_, err := h.runBuiltinToolBrowser(context.Background(), "tenant", agent.ID, "browser_click", raw(map[string]any{"selector": "#x"}))
	if err == nil || err.Error() != "element not found: #x" {
		t.Fatalf("browser_click error: %v", err)
	}
	if argv := *last; len(argv) != 4 || argv[2] != "click" || argv[1] != "/workspace/.zakura/browser/driver.mjs" {
		t.Fatalf("browser argv: %#v", argv)
	}
}

func TestRunBuiltinToolBrowserTypePayload(t *testing.T) {
	h, agent, last := browserHarness(t, func([]string) (map[string]any, error) {
		return map[string]any{"exitCode": 0, "stdout": `{"ok":true,"typed":4,"title":"T"}`, "stderr": ""}, nil
	})
	typedRaw, typedErr := h.runBuiltinToolBrowser(context.Background(), "tenant", agent.ID, "browser_type", raw(map[string]any{"selector": "#q", "text": "term", "submit": true}))
	out := decodeBuiltinResult(t, typedRaw, typedErr)
	if out["ok"] != true || out["typed"] != float64(4) {
		t.Fatalf("browser_type result: %#v", out)
	}
	argv := *last
	if argv[2] != "type" {
		t.Fatalf("browser argv: %#v", argv)
	}
	decoded, decErr := base64.StdEncoding.DecodeString(argv[3])
	if decErr != nil {
		t.Fatalf("decode payload: %v", decErr)
	}
	args := map[string]any{}
	if json.Unmarshal(decoded, &args) != nil || args["selector"] != "#q" || args["text"] != "term" || args["submit"] != true {
		t.Fatalf("decoded payload: %s", decoded)
	}
}

func TestRunBuiltinToolBrowserDriverFailure(t *testing.T) {
	h, agent, _ := browserHarness(t, func([]string) (map[string]any, error) {
		return map[string]any{"exitCode": 1, "stdout": "not json", "stderr": "boom\ntrace"}, nil
	})
	_, err := h.runBuiltinToolBrowser(context.Background(), "tenant", agent.ID, "browser_open", raw(map[string]any{"url": "https://example.com"}))
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("driver failure error: %v", err)
	}
}

func TestRunBuiltinToolBrowserURLScheme(t *testing.T) {
	h := &handler{}
	_, err := h.runBuiltinTool(context.Background(), "tenant", "agent", "browser_open", raw(map[string]any{"url": "ftp://example.com"}))
	if err == nil || err.Error() != "url must be http(s)" {
		t.Fatalf("url scheme error: %v", err)
	}
}

func TestWriteBrowserDriverRepeatedly(t *testing.T) {
	var writes int
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
	files := map[string]string{}
	h := builtinToolHarness(t, d, "rnr_browser_write", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{}}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "labels": map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "host.fs.write":
			writes++
			path := fmt.Sprint(params["path"])
			data, decodeErr := base64.StdEncoding.DecodeString(fmt.Sprint(params["base64"]))
			if decodeErr != nil {
				return nil, decodeErr
			}
			files[path] = string(data)
			return map[string]any{"ok": true, "path": path}, nil
		case "docker.exec":
			return map[string]any{"exitCode": 0, "stdout": `{"ok":true}`, "stderr": ""}, nil
		}
		return nil, fmt.Errorf("unexpected method %s", method)
	})
	ctx := context.Background()
	_, _ = h.runBuiltinToolBrowser(ctx, "tenant", agent.ID, "browser_open", raw(map[string]any{"url": "https://example.com"}))
	_, _ = h.runBuiltinToolBrowser(ctx, "tenant", agent.ID, "browser_open", raw(map[string]any{"url": "https://example.com"}))
	if writes != 2 {
		t.Fatalf("expected driver written each call, got %d", writes)
	}
	if files["/.zakura/browser/driver.mjs"] != browserDriverJS {
		t.Fatalf("driver content mismatch")
	}
}

func TestAgentToolCatalogBrowserGroup(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	insertRuntimeNode(t, d, "node", "tenant", "online")
	node := "node"
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "WS", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	h := &handler{deps: d, store: store}
	catalog, err := h.agentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	byName := catalogByName(catalog)
	for _, name := range []string{"browser_open", "browser_click", "browser_type"} {
		tool, ok := byName[name]
		if !ok {
			t.Fatalf("missing browser tool %s: %v", name, catalog.Tools)
		}
		if tool.Kind != "builtin" || tool.Exposure != "deferred" || tool.LocalName != name {
			t.Fatalf("browser tool %s metadata: %+v", name, tool)
		}
	}

	plainSpace, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "Plain", WorkspaceKind: "container"})
	plainAgent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "B", SpaceID: plainSpace.ID})
	plainCatalog, err := h.agentToolCatalog(context.Background(), "tenant", plainAgent.ID)
	if err != nil {
		t.Fatal(err)
	}
	plainByName := catalogByName(plainCatalog)
	for _, name := range []string{"browser_open", "browser_click", "browser_type"} {
		if _, ok := plainByName[name]; ok {
			t.Fatalf("browser tool %s present without workspace", name)
		}
	}
}

func TestBrowserDriverScriptSmoke(t *testing.T) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	dir := t.TempDir()
	driverPath := filepath.Join(dir, "driver.mjs")
	if err := os.WriteFile(driverPath, []byte(browserDriverJS), 0o644); err != nil {
		t.Fatal(err)
	}
	payload := base64.StdEncoding.EncodeToString([]byte(`{"url":"https://example.com"}`))
	cmd := exec.Command(nodePath, driverPath, "open", payload)
	output, runErr := cmd.CombinedOutput()
	if runErr == nil {
		t.Fatalf("expected nonzero exit, output: %s", output)
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	result := map[string]any{}
	if json.Unmarshal([]byte(last), &result) != nil {
		t.Fatalf("driver output not JSON: %q", output)
	}
	if result["ok"] != false {
		t.Fatalf("driver result: %#v", result)
	}
	message, _ := result["error"].(string)
	if !strings.Contains(message, "CDP") {
		t.Fatalf("driver error: %q", message)
	}
}
