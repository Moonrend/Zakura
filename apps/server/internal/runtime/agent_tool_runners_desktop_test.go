// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func desktopHarness(t *testing.T, exec func(script string) (map[string]any, error)) (*handler, Agent, *string) {
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
	last := ""
	h := builtinToolHarness(t, d, "rnr_desktop", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{}}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "labels": map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.exec":
			command, _ := params["command"].([]any)
			script := ""
			if len(command) >= 3 {
				script = fmt.Sprint(command[2])
			}
			last = script
			return exec(script)
		}
		return nil, fmt.Errorf("unexpected method %s", method)
	})
	return h, agent, &last
}

func TestRunBuiltinToolComputerScreenshot(t *testing.T) {
	h, agent, last := desktopHarness(t, func(string) (map[string]any, error) {
		return map[string]any{"exitCode": 0, "stdout": "12345\n", "stderr": ""}, nil
	})
	shotRaw, shotErr := h.runBuiltinTool(context.Background(), "tenant", agent.ID, "computer_screenshot", raw(map[string]any{}))
	shot := decodeBuiltinResult(t, shotRaw, shotErr)
	path, _ := shot["path"].(string)
	if !strings.HasPrefix(path, "/workspace/.zakura/screenshots/") {
		t.Fatalf("screenshot path: %#v", shot)
	}
	if shot["size"] != float64(12345) {
		t.Fatalf("screenshot size: %#v", shot)
	}
	if !strings.Contains(*last, "DISPLAY=:99") || !strings.Contains(*last, "import -window root") {
		t.Fatalf("screenshot command: %q", *last)
	}
}

func TestRunBuiltinToolComputerClick(t *testing.T) {
	h, agent, last := desktopHarness(t, func(string) (map[string]any, error) {
		return map[string]any{"exitCode": 0, "stdout": "", "stderr": ""}, nil
	})
	ctx := context.Background()
	clickRaw, clickErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "computer_click", raw(map[string]any{"x": 10, "y": 20}))
	click := decodeBuiltinResult(t, clickRaw, clickErr)
	if click["ok"] != true || click["x"] != float64(10) || click["y"] != float64(20) {
		t.Fatalf("click result: %#v", click)
	}
	if !strings.Contains(*last, "mousemove 10 20 click --button left --repeat 1") {
		t.Fatalf("click command: %q", *last)
	}
	_, _ = h.runBuiltinTool(ctx, "tenant", agent.ID, "computer_click", raw(map[string]any{"x": 5, "y": 6, "button": "right", "count": 2}))
	if !strings.Contains(*last, "mousemove 5 6 click --button right --repeat 2") {
		t.Fatalf("click variant command: %q", *last)
	}
	if _, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "computer_click", raw(map[string]any{"x": 1, "y": 2, "button": "scroll"})); err == nil || !strings.Contains(err.Error(), "button") {
		t.Fatalf("invalid button should fail: %v", err)
	}
}

func TestRunBuiltinToolComputerType(t *testing.T) {
	h, agent, last := desktopHarness(t, func(string) (map[string]any, error) {
		return map[string]any{"exitCode": 0, "stdout": "", "stderr": ""}, nil
	})
	typedRaw, typedErr := h.runBuiltinTool(context.Background(), "tenant", agent.ID, "computer_type", raw(map[string]any{"text": "it's"}))
	typed := decodeBuiltinResult(t, typedRaw, typedErr)
	if typed["ok"] != true || typed["typed"] != float64(4) {
		t.Fatalf("type result: %#v", typed)
	}
	if !strings.Contains(*last, `type --delay 25 -- 'it'\''s'`) {
		t.Fatalf("type command: %q", *last)
	}
}

func TestRunBuiltinToolComputerKey(t *testing.T) {
	h, agent, last := desktopHarness(t, func(string) (map[string]any, error) {
		return map[string]any{"exitCode": 0, "stdout": "", "stderr": ""}, nil
	})
	ctx := context.Background()
	keyRaw, keyErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "computer_key", raw(map[string]any{"key": "ctrl+c"}))
	key := decodeBuiltinResult(t, keyRaw, keyErr)
	if key["ok"] != true || key["key"] != "ctrl+c" {
		t.Fatalf("key result: %#v", key)
	}
	if !strings.Contains(*last, "xdotool key -- 'ctrl+c'") {
		t.Fatalf("key command: %q", *last)
	}
	if _, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "computer_key", raw(map[string]any{"key": "bad;key"})); err == nil || err.Error() != "invalid key" {
		t.Fatalf("invalid key should fail: %v", err)
	}
}

func TestRunBuiltinToolDesktopInfo(t *testing.T) {
	h, agent, _ := desktopHarness(t, func(string) (map[string]any, error) {
		return map[string]any{"exitCode": 0, "stdout": "1280 720\n---\nTerminal\n---\n 10:00 up 1 day", "stderr": ""}, nil
	})
	infoRaw, infoErr := h.runBuiltinTool(context.Background(), "tenant", agent.ID, "desktop_info", raw(map[string]any{}))
	info := decodeBuiltinResult(t, infoRaw, infoErr)
	if info["geometry"] != "1280 720" || info["focusedWindow"] != "Terminal" || info["uptime"] != "10:00 up 1 day" || info["display"] != ":99" {
		t.Fatalf("desktop_info: %#v", info)
	}
}

func TestAgentToolCatalogDesktopGroup(t *testing.T) {
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
	for _, name := range []string{"computer_screenshot", "computer_click", "computer_type", "computer_key", "desktop_info"} {
		tool, ok := byName[name]
		if !ok {
			t.Fatalf("missing desktop tool %s: %v", name, catalog.Tools)
		}
		if tool.Kind != "builtin" || tool.Exposure != "deferred" || tool.LocalName != name {
			t.Fatalf("desktop tool %s metadata: %+v", name, tool)
		}
	}

	plainSpace, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "Plain", WorkspaceKind: "container"})
	plainAgent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "B", SpaceID: plainSpace.ID})
	plainCatalog, err := h.agentToolCatalog(context.Background(), "tenant", plainAgent.ID)
	if err != nil {
		t.Fatal(err)
	}
	plainByName := catalogByName(plainCatalog)
	for _, name := range []string{"computer_screenshot", "computer_click", "computer_type", "computer_key", "desktop_info"} {
		if _, ok := plainByName[name]; ok {
			t.Fatalf("desktop tool %s present without workspace", name)
		}
	}
}
