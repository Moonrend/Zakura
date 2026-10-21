// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func mcpAgentBuiltin(name string) bool {
	switch name {
	case "memory_search", "memory_remember", "web_search", "web_fetch",
		"list_sessions", "get_messages", "import_session", "list_routines", "create_routine",
		"update_routine", "pause_routine", "delete_routine", "run_routine", "list_automation_runs":
		return true
	}
	return false
}

func mcpSpaceBuiltin(name string) bool {
	return name == "list_computers" || name == "list_skills" || name == "read_skill" ||
		computerBoundTool(name) && !strings.HasPrefix(name, "mcp__") && !strings.Contains(name, ":") && !strings.Contains(name, "mcp_resource")
}

func (policies mcpPolicies) builtinAllowed(name string) bool {
	for _, policy := range policies {
		if enabled, ok := policy["includeBuiltin"].(bool); ok && !enabled {
			return false
		}
		if !policyListAllows(policy, "toolAllowlist", name, "re_"+name) || listContains(mcpStringList(policy["toolDenylist"]), name, "re_"+name) {
			return false
		}
	}
	return true
}

func (h *handler) mcpBuiltinTools(ctx context.Context, p httpx.Principal, space string) ([]agentTool, error) {
	space, agentID, err := h.authorizeMCPScope(ctx, p, space, p.AgentID)
	if err != nil {
		return nil, err
	}
	policies, err := h.effectiveMCPPolicies(ctx, p.TenantID, agentID, space)
	if err != nil {
		return nil, err
	}
	agent := Agent{EnableMemory: true}
	if agentID != "" {
		agent, err = h.store.GetAgent(ctx, p.TenantID, agentID)
		if err != nil {
			return nil, err
		}
		sandbox, err := h.agentSandboxRequired(ctx, p.TenantID, agentID)
		if err != nil {
			return nil, err
		}
		if sandbox {
			tools := []agentTool{}
			for _, tool := range sandboxAgentCatalog().Tools {
				if tool.Name == "shell_exec" && policies.builtinAllowed(tool.Name) {
					tools = append(tools, tool)
				}
			}
			return tools, nil
		}
	}
	// Keep native entry points visible even while the Space computer is offline.
	// Dispatch reports unavailable capabilities without selecting another Space.
	definitions := builtinToolDefinitions(agent, true, false, h.platformWebToolDefaults(ctx))
	out := []agentTool{}
	for _, tool := range definitions {
		if (!mcpSpaceBuiltin(tool.Name) && !mcpAgentBuiltin(tool.Name)) || !policies.builtinAllowed(tool.Name) {
			continue
		}
		if tool.Name == "list_computers" {
			tool.Description = "List this Space's computers and default server computer. No credentials are returned. Use computerId on workspace tools to select a connected computer for one call."
		}
		if computerBoundTool(tool.Name) {
			props := tool.InputSchema["properties"].(map[string]any)
			props["computerId"] = map[string]any{"type": "string", "minLength": 1, "description": "Computer ID from list_computers. Defaults to this Space's server computer. Attached computers must already be connected; temporary computers require an Agent run."}
		}
		if mcpAgentBuiltin(tool.Name) && agentID == "" {
			tool.InputSchema["properties"].(map[string]any)["agentId"] = map[string]any{"type": "string", "description": "Agent ID in this Space. Required because this operation uses that Agent's memory or configuration."}
			required, _ := tool.InputSchema["required"].([]string)
			tool.InputSchema["required"] = append(required, "agentId")
		}
		out = append(out, tool)
	}
	return out, nil
}

func (h *handler) callMCPBuiltin(r *http.Request, p httpx.Principal, space, name string, raw json.RawMessage) (result json.RawMessage, err error) {
	started := time.Now()
	args := map[string]any{}
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	if json.Unmarshal(raw, &args) != nil || args == nil {
		return nil, errors.New("tool arguments must be a JSON object")
	}
	ctx := r.Context()
	auditAgent := p.AgentID
	defer func() {
		status, detail := "ok", ""
		if err != nil {
			status, detail = "error", err.Error()
		}
		h.auditToolCall(context.WithoutCancel(ctx), mcpScopedPrincipal(p, space, auditAgent), mcpInstance{Ref: "zakura"}, name, args, status, detail, time.Since(started))
	}()
	tools, err := h.mcpBuiltinTools(ctx, p, space)
	if err != nil {
		return nil, err
	}
	allowed := false
	for _, tool := range tools {
		if tool.Name == name {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, ErrNotFound
	}
	agentID := p.AgentID
	if requested, exists := args["agentId"]; exists {
		value, ok := requested.(string)
		if !ok || value == "" || agentID != "" && agentID != value {
			return nil, ErrNotFound
		}
		agentID = value
	}
	if mcpAgentBuiltin(name) && agentID == "" {
		return nil, errors.New("agentId is required for this tool on a Space MCP connection")
	}
	if agentID != "" {
		if _, _, err := h.authorizeMCPScope(ctx, p, space, agentID); err != nil {
			return nil, err
		}
		auditAgent = agentID
		policies, err := h.effectiveMCPPolicies(ctx, p.TenantID, agentID, space)
		if err != nil || !policies.builtinAllowed(name) {
			return nil, ErrNotFound
		}
		var policyErr error
		raw, policyErr = h.sandboxToolPolicy(ctx, p.TenantID, agentID, name, raw)
		if policyErr != nil {
			return nil, policyErr
		}
		_ = json.Unmarshal(raw, &args)
		a, err := h.store.GetAgent(ctx, p.TenantID, agentID)
		if err != nil {
			return nil, err
		}
		// An MCP connection has no interactive Agent run in which to ask. Never
		// silently bypass an Agent's deny/ask/AI approval configuration.
		approval, err := parseApprovalConfig(a.Config, "allow_all")
		if err != nil {
			return nil, err
		}
		if approval.decision(name, raw) != "allow" {
			return nil, errors.New("tool requires approval through an Agent run")
		}
		if mcpAgentBuiltin(name) {
			if err := h.authorizeAgentTool(ctx, p.TenantID, agentID, "", name, raw); err != nil {
				return nil, err
			}
			return h.runBuiltinToolForSession(ctx, p.TenantID, agentID, "", "", name, raw)
		}
	}
	if name == "list_skills" || name == "read_skill" {
		return h.runSkillTool(ctx, p.TenantID, space, agentID, name, raw)
	}
	if name == "list_computers" {
		items, err := h.computerStore().List(ctx, p.TenantID, space)
		if err != nil {
			return nil, err
		}
		var serverID *string
		for _, item := range items {
			if item.IsServer() {
				id := item.ID
				serverID = &id
				break
			}
		}
		return builtinJSON(map[string]any{"computers": items, "defaultComputerId": serverID, "serverComputerId": serverID})
	}
	exec, err := h.mcpBuiltinComputer(ctx, p.TenantID, space, name, args)
	if err != nil {
		return nil, err
	}
	ctx = context.WithValue(ctx, computerExecKey{}, exec)
	return h.runBuiltinTool(ctx, p.TenantID, agentID, name, raw)
}

func (h *handler) mcpBuiltinComputer(ctx context.Context, tenant, space, name string, args map[string]any) (*resolvedExecution, error) {
	if err := h.requireSpaceInfrastructureAvailable(ctx, tenant, space); err != nil {
		return nil, err
	}
	var c computers.Computer
	var err error
	if value, exists := args["computerId"]; exists {
		id, ok := value.(string)
		if !ok || strings.TrimSpace(id) == "" {
			return nil, errors.New("computerId must not be empty")
		}
		c, err = h.computerStore().Get(ctx, tenant, space, id)
	} else {
		c, err = h.computerStore().ServerComputer(ctx, tenant, space)
	}
	if err != nil {
		return nil, err
	}
	if err := h.authorizeContextLocalNode(ctx, tenant, c.RuntimeNodeID); err != nil {
		return nil, err
	}
	capability := computers.Commands
	switch name {
	case "fs_list", "fs_read", "fs_write", "apply_patch":
		capability = computers.Files
	case "computer_screenshot", "computer_click", "computer_type", "computer_key", "desktop_info":
		capability = computers.Desktop
	case "browser_open", "browser_click", "browser_type":
		capability = computers.Browser
	}
	if !c.Has(capability) {
		return nil, fmt.Errorf("%s is not available on this computer", capability)
	}
	if c.IsServer() {
		return serverComputerExecution(c), nil
	}
	if capability == computers.Desktop || capability == computers.Browser {
		return nil, errors.New("this tool requires the Space workspace")
	}
	scope, err := c.Scope("")
	if err != nil {
		return nil, err
	}
	active, err := h.computerStore().ActiveRuntime(ctx, tenant, space, c.ID, scope)
	if err != nil {
		return nil, err
	}
	target := computers.Target{TenantID: tenant, SpaceID: space, ComputerID: c.ID, RuntimeID: active.ID, Incarnation: active.Incarnation}
	if err = computers.CheckTarget(target, c, active, scope, capability, builtinStringArg(args, "execution_mode") == "sandbox", h.store.now()); err != nil {
		return nil, err
	}
	if err = h.computerStore().RecordActivity(ctx, target, scope, h.store.now()); err != nil {
		return nil, err
	}
	return &resolvedExecution{spaceID: space, nodeID: c.RuntimeNodeID, containerID: active.ExternalID, hostRoot: active.RootPath, computer: c, runtime: active}, nil
}
