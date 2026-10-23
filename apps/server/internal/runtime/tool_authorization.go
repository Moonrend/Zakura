// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// Authorization is read-only: no provider allocation, hooks, MCP initialization
// or runner RPC may happen while deciding whether a call can reach approval.
func (h *handler) authorizeAgentTool(ctx context.Context, tenant, agent, session, name string, args json.RawMessage) error {
	if _, err := h.sandboxToolPolicy(ctx, tenant, agent, name, args); err != nil {
		return err
	}
	a, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return err
	}
	var parsed map[string]any
	if json.Unmarshal(args, &parsed) != nil || parsed == nil {
		return errors.New("tool arguments must be a JSON object")
	}
	if (name == "memory_search" || name == "memory_remember") && !a.EnableMemory {
		return errors.New("memory is not enabled for this agent")
	}
	if name == "web_search" || name == "web_fetch" {
		var config map[string]any
		if len(a.Config) > 0 && json.Unmarshal(a.Config, &config) != nil {
			return errors.New("invalid agent configuration")
		}
		providers, _ := config["providers"].(map[string]any)
		defaults := h.platformWebToolDefaults(ctx)
		key, fallback := "webSearch", defaults.webSearchEnabled
		if name == "web_fetch" {
			key, fallback = "webFetch", defaults.webFetchEnabled
		}
		if !providerToolEnabled(providers, key, fallback) {
			return fmt.Errorf("tool %s is disabled for this agent", name)
		}
	}
	if computerBoundTool(name) || name == "codemode" {
		if err := h.authorizeToolComputer(ctx, tenant, a.SpaceID, session, name, parsed); err != nil {
			return err
		}
	}
	if strings.HasPrefix(name, "mcp__") || strings.Contains(name, ":") {
		var instanceID, local string
		if strings.HasPrefix(name, "mcp__") {
			h.agentToolMu.Lock()
			for _, tool := range h.agentToolCache[tenant+"/"+agent].catalog.Tools {
				if tool.Kind == "mcp" && tool.Name == name {
					instanceID, local = tool.InstanceID, tool.LocalName
					break
				}
			}
			h.agentToolMu.Unlock()
		} else {
			instanceID, local, _ = strings.Cut(name, ":")
		}
		if instanceID == "" || local == "" {
			return errors.New("tool is no longer available")
		}
		return h.authorizeMCPToolOperation(ctx, tenant, agent, a.SpaceID, instanceID, "tools/call", local)
	}
	if name == "read_mcp_resource" {
		inst, ok := findMCPResourceInstance(h.agentMCPInstances(ctx, tenant, agent, a.SpaceID), builtinStringArg(parsed, "server"))
		if !ok {
			return errors.New("MCP resource server is unavailable")
		}
		return h.authorizeMCPToolOperation(ctx, tenant, agent, a.SpaceID, inst.ID, "resources/read", builtinStringArg(parsed, "uri"))
	}
	return nil
}

func (h *handler) authorizeMCPToolOperation(ctx context.Context, tenant, agent, space, id, method, name string) error {
	if _, err := h.mcpAgentContext(ctx, tenant, agent); err != nil {
		return err
	}
	for _, inst := range h.agentMCPInstances(ctx, tenant, agent, space) {
		if inst.ID != id {
			continue
		}
		cfg := map[string]any{}
		_ = json.Unmarshal(inst.Config, &cfg)
		if method == "tools/call" && toolExposureOf(cfg, name) == "hidden" {
			return ErrNotFound
		}
		policies, err := h.effectiveMCPPolicies(ctx, tenant, agent, space)
		if err != nil {
			return err
		}
		if name != "" && policies.operationAllowed(inst, method, name) {
			return nil
		}
		break
	}
	return ErrNotFound
}

func (h *handler) authorizeToolComputer(ctx context.Context, tenant, space, session, name string, args map[string]any) error {
	run, _ := ctx.Value(computerRunKey{}).(string)
	if run == "" {
		return errors.New("computer execution requires an immutable run target")
	}
	explicit := ""
	if value, present := args["computerId"]; present {
		var ok bool
		explicit, ok = value.(string)
		if !ok || strings.TrimSpace(explicit) == "" {
			return errors.New("computerId must not be empty")
		}
	}
	c, err := h.computerStore().ResolveRunComputer(ctx, tenant, space, run, explicit)
	if err != nil {
		return err
	}
	if err := h.authorizeContextLocalNode(ctx, tenant, c.RuntimeNodeID); err != nil {
		return err
	}
	if err := h.requireSpaceInfrastructureAvailable(ctx, tenant, space); err != nil {
		return err
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
		return fmt.Errorf("%s is not available on this computer", capability)
	}
	if !c.IsServer() && (name == "codemode" || capability == computers.Desktop || capability == computers.Browser || strings.HasPrefix(name, "mcp__") || strings.Contains(name, ":") || strings.Contains(name, "mcp_resource")) {
		return errors.New("this tool requires the Space workspace")
	}
	if !c.IsServer() {
		if _, err := c.Scope(session); err != nil {
			return err
		}
	}
	return nil
}
