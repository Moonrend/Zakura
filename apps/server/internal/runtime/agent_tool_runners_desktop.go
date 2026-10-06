// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	agentDesktopButtonDefault = "left"
	agentDesktopTypeDelayMS   = 25
)

func (h *handler) runBuiltinToolDesktop(ctx context.Context, tenant, agent, name string, args map[string]any) (json.RawMessage, error) {
	switch name {
	case "computer_screenshot":
		return h.runComputerScreenshot(ctx, tenant, agent, args)
	case "computer_click":
		return h.runComputerClick(ctx, tenant, agent, args)
	case "computer_type":
		return h.runComputerType(ctx, tenant, agent, args)
	case "computer_key":
		return h.runComputerKey(ctx, tenant, agent, args)
	case "desktop_info":
		return h.runDesktopInfo(ctx, tenant, agent, args)
	}
	return nil, fmt.Errorf("unknown builtin tool %q", name)
}

func builtinRequiredIntArg(args map[string]any, key string) (int, bool) {
	switch value := args[key].(type) {
	case float64:
		return int(value), true
	case json.Number:
		if n, err := value.Int64(); err == nil {
			return int(n), true
		}
	}
	return 0, false
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func validDesktopKey(key string) bool {
	if key == "" {
		return false
	}
	for _, r := range key {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '+' {
			continue
		}
		return false
	}
	return true
}

func desktopStderr(result map[string]any) string {
	if result == nil {
		return ""
	}
	for _, key := range []string{"stderr", "stdout"} {
		value, ok := result[key].(string)
		if !ok || strings.TrimSpace(value) == "" {
			continue
		}
		detail := strings.TrimSpace(value)
		if idx := strings.IndexByte(detail, '\n'); idx >= 0 {
			detail = strings.TrimSpace(detail[:idx])
		}
		if detail != "" {
			return detail
		}
	}
	return ""
}

func desktopExecError(action string, result map[string]any, err error) error {
	if err == nil {
		return nil
	}
	if detail := desktopStderr(result); detail != "" {
		return fmt.Errorf("%s failed: %s", action, detail)
	}
	return fmt.Errorf("%s failed: %v", action, err)
}

func (h *handler) runComputerScreenshot(ctx context.Context, tenant, agent string, _ map[string]any) (json.RawMessage, error) {
	nonce := make([]byte, 4)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	path := "/workspace/.zakura/screenshots/shot-" + hex.EncodeToString(nonce) + ".png"
	script := "DISPLAY=:99 tmp=" + path + "; mkdir -p /workspace/.zakura/screenshots; import -window root $tmp 2>/dev/null || scrot -o $tmp; echo $(stat -c%s $tmp 2>/dev/null || echo 0)"
	result, err := h.runtimeExec(ctx, tenant, agent, "bash", "-lc", script)
	if err != nil {
		return nil, desktopExecError("screenshot", result, err)
	}
	size, _ := strconv.Atoi(strings.TrimSpace(fmt.Sprint(result["stdout"])))
	return builtinJSON(map[string]any{"path": path, "size": size})
}

func (h *handler) runComputerClick(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	x, ok := builtinRequiredIntArg(args, "x")
	if !ok {
		return nil, errors.New("x is required")
	}
	y, ok := builtinRequiredIntArg(args, "y")
	if !ok {
		return nil, errors.New("y is required")
	}
	button := strings.ToLower(strings.TrimSpace(builtinStringArg(args, "button")))
	if button == "" {
		button = agentDesktopButtonDefault
	}
	switch button {
	case "left", "right", "middle":
	default:
		return nil, errors.New("button must be left, right or middle")
	}
	count := builtinIntArg(args, "count", 1)
	if count < 1 {
		count = 1
	}
	if count > 3 {
		count = 3
	}
	moveFirst := true
	if value, ok := args["move_first"].(bool); ok {
		moveFirst = value
	}
	script := "DISPLAY=:99 xdotool "
	if moveFirst {
		script += fmt.Sprintf("mousemove %d %d ", x, y)
	}
	script += fmt.Sprintf("click --button %s --repeat %d", button, count)
	result, err := h.runtimeExec(ctx, tenant, agent, "bash", "-lc", script)
	if err != nil {
		return nil, desktopExecError("click", result, err)
	}
	return builtinJSON(map[string]any{"ok": true, "x": x, "y": y})
}

func (h *handler) runComputerType(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	text := builtinStringArg(args, "text")
	delay := builtinIntArg(args, "delay_ms", agentDesktopTypeDelayMS)
	if delay < 0 {
		delay = 0
	}
	if delay > 200 {
		delay = 200
	}
	script := "DISPLAY=:99 xdotool type --delay " + strconv.Itoa(delay) + " -- " + shellSingleQuote(text)
	result, err := h.runtimeExec(ctx, tenant, agent, "bash", "-lc", script)
	if err != nil {
		return nil, desktopExecError("type", result, err)
	}
	return builtinJSON(map[string]any{"ok": true, "typed": len(text)})
}

func (h *handler) runComputerKey(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	key := builtinStringArg(args, "key")
	if !validDesktopKey(key) {
		return nil, errors.New("invalid key")
	}
	script := "DISPLAY=:99 xdotool key -- " + shellSingleQuote(key)
	result, err := h.runtimeExec(ctx, tenant, agent, "bash", "-lc", script)
	if err != nil {
		return nil, desktopExecError("key", result, err)
	}
	return builtinJSON(map[string]any{"ok": true, "key": key})
}

func (h *handler) runDesktopInfo(ctx context.Context, tenant, agent string, _ map[string]any) (json.RawMessage, error) {
	script := "DISPLAY=:99 xdotool getdisplaygeometry; echo ---; xdotool getwindowfocus getwindowname 2>/dev/null; echo ---; uptime"
	result, err := h.runtimeExec(ctx, tenant, agent, "bash", "-lc", script)
	if err != nil {
		return nil, desktopExecError("desktop_info", result, err)
	}
	stdout := ""
	if value, ok := result["stdout"].(string); ok {
		stdout = value
	}
	parts := strings.SplitN(stdout, "---", 3)
	var geometry, focusedWindow, uptime any
	if len(parts) > 0 {
		if value := strings.TrimSpace(parts[0]); value != "" {
			geometry = value
		}
	}
	if len(parts) > 1 {
		if value := strings.TrimSpace(parts[1]); value != "" {
			focusedWindow = value
		}
	}
	if len(parts) > 2 {
		if value := strings.TrimSpace(parts[2]); value != "" {
			uptime = value
		}
	}
	return builtinJSON(map[string]any{"geometry": geometry, "focusedWindow": focusedWindow, "uptime": uptime, "display": ":99"})
}
