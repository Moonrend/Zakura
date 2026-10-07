// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// This policy lives in the tenant-owned agent configuration, not tool arguments.
// All tools are denied by default; only the bounded execution transport is
// supported. It deliberately makes no claim to isolate arbitrary ACP adapters.
func (h *handler) agentSandboxRequired(ctx context.Context, tenant, agent string) (bool, error) {
	record, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return false, err
	}
	var config map[string]json.RawMessage
	if len(record.Config) > 0 && json.Unmarshal(record.Config, &config) != nil {
		return false, errors.New("invalid agent execution policy")
	}
	raw, present := config["executionMode"]
	if !present {
		return false, nil
	}
	var mode string
	if json.Unmarshal(raw, &mode) != nil || (mode != "host" && mode != "sandbox") {
		return false, errors.New("agent executionMode must be host or sandbox")
	}
	return mode == "sandbox", nil
}

func (h *handler) sandboxToolPolicy(ctx context.Context, tenant, agent, name string, args json.RawMessage) (json.RawMessage, error) {
	required, err := h.agentSandboxRequired(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if !required {
		return args, nil
	}
	if name == "ask_user" {
		return args, nil
	}
	if name != "shell_exec" {
		return nil, fmt.Errorf("tool %s is unavailable for sandbox agents", name)
	}
	var parsed map[string]any
	if err := json.Unmarshal(args, &parsed); err != nil || parsed == nil {
		return nil, errors.New("invalid sandbox tool arguments")
	}
	parsed["execution_mode"] = "sandbox"
	return json.Marshal(parsed)
}

func sandboxAgentCatalog() agentCatalog {
	return agentCatalog{Tools: []agentTool{directBuiltin("shell_exec", "Execute in the configured restricted sandbox. Workspace is read-only; only bounded /tmp is writable. No network. Only shell_exec and ask_user are allowed; ACP adapters are unavailable.", map[string]any{
		"command":    map[string]any{"type": "string"},
		"timeout_ms": map[string]any{"type": "integer", "description": "Deadline in ms, maximum 300000."},
	}, "command"), directBuiltin("ask_user", "Ask the user a question and wait for their reply.", map[string]any{"question": map[string]any{"type": "string"}, "title": map[string]any{"type": "string"}}, "question")}}
}
