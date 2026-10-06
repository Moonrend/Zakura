// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	browserDriverRemotePath = "/.zakura/browser/driver.mjs"
	browserDriverExecPath   = "/workspace/.zakura/browser/driver.mjs"
	browserDriverTimeoutMS  = 30000
)

func validBrowserURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return parsed.Scheme == "http" || parsed.Scheme == "https"
}

func browserStdout(result map[string]any) string {
	if result == nil {
		return ""
	}
	value, _ := result["stdout"].(string)
	return strings.TrimSpace(value)
}

func browserStderrFirstLine(result map[string]any) string {
	if result == nil {
		return ""
	}
	value, _ := result["stderr"].(string)
	value = strings.TrimSpace(value)
	if idx := strings.IndexByte(value, '\n'); idx >= 0 {
		value = strings.TrimSpace(value[:idx])
	}
	return value
}

func (h *handler) runBuiltinToolBrowser(ctx context.Context, tenant, agent, name string, args json.RawMessage) (json.RawMessage, error) {
	parsed := map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return nil, fmt.Errorf("invalid tool arguments: %w", err)
		}
	}
	if parsed == nil {
		parsed = map[string]any{}
	}
	op := ""
	switch name {
	case "browser_open":
		op = "open"
		rawURL := strings.TrimSpace(builtinStringArg(parsed, "url"))
		if rawURL == "" {
			return nil, errors.New("url is required")
		}
		if !validBrowserURL(rawURL) {
			return nil, errors.New("url must be http(s)")
		}
	case "browser_click":
		op = "click"
		if strings.TrimSpace(builtinStringArg(parsed, "selector")) == "" {
			return nil, errors.New("selector is required")
		}
	case "browser_type":
		op = "type"
		if builtinStringArg(parsed, "text") == "" {
			return nil, errors.New("text is required")
		}
	default:
		return nil, fmt.Errorf("unknown builtin tool %q", name)
	}
	payload, err := json.Marshal(parsed)
	if err != nil {
		return nil, err
	}
	runCtx, cancel := context.WithTimeout(ctx, browserDriverTimeoutMS*time.Millisecond)
	defer cancel()
	remote, selected, err := h.remoteWorkspace(runCtx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if !selected {
		return nil, errors.New("no runtime node bound to this space")
	}
	if _, err := remote.write(runCtx, browserDriverRemotePath, []byte(browserDriverJS)); err != nil {
		return nil, err
	}
	result, execErr := h.runtimeExec(runCtx, tenant, agent, "node", browserDriverExecPath, op, base64.StdEncoding.EncodeToString(payload))
	stdout := browserStdout(result)
	if stdout != "" {
		var parsedOut struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		if json.Unmarshal([]byte(stdout), &parsedOut) == nil {
			if parsedOut.OK {
				return json.RawMessage(stdout), nil
			}
			if parsedOut.Error != "" {
				return nil, errors.New(parsedOut.Error)
			}
		}
	}
	if detail := browserStderrFirstLine(result); detail != "" {
		return nil, errors.New(detail)
	}
	if execErr != nil {
		return nil, execErr
	}
	return nil, errors.New("browser driver produced no result")
}
