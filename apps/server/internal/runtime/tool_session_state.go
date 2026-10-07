// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

func isBuiltinToolName(name string) bool {
	switch name {
	case "memory_search", "memory_remember", "fs_list", "fs_read", "fs_write", "shell_exec",
		"list_sessions", "search_sessions", "get_messages", "import_session",
		"list_routines", "create_routine", "update_routine", "pause_routine", "delete_routine", "run_routine",
		"list_automation_runs", "delegate_agent", "apply_patch",
		"computer_screenshot", "computer_click", "computer_type", "computer_key", "desktop_info",
		"browser_open", "browser_click", "browser_type", "web_search", "web_fetch",
		"list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource":
		return true
	}
	return false
}

func (h *handler) dispatchAgentTool(ctx context.Context, tenant, agent, session, toolCallID, name string, args json.RawMessage) (json.RawMessage, error) {
	var policyErr error
	args, policyErr = h.sandboxToolPolicy(ctx, tenant, agent, name, args)
	if policyErr != nil {
		return nil, policyErr
	}
	if toolDisabled(ctx, name) {
		return nil, fmt.Errorf("tool %s is disabled for this run", name)
	}
	switch {
	case name == "tool_search":
		return h.runToolSearchTool(ctx, tenant, agent, session, toolCallID, args)
	case name == "codemode":
		return h.runCodemodeTool(ctx, tenant, agent, session, toolCallID, args)
	case name == "ask_user":
		return h.runAskUserTool(ctx, tenant, agent, session, toolCallID, args)
	case isBuiltinToolName(name):
		return h.runBuiltinToolForSession(ctx, tenant, agent, session, toolCallID, name, args)
	case strings.HasPrefix(name, "mcp__"):
		return h.runCatalogMCPTool(ctx, tenant, agent, name, args)
	default:
		parts := strings.SplitN(name, ":", 2)
		if len(parts) != 2 {
			return nil, errors.New("qualified tool name must be instanceId:tool")
		}
		inst, e := h.getMCPInstance(ctx, tenant, parts[0])
		if e != nil {
			return nil, e
		}
		result, e := h.mcpRPC(ctx, inst, "tools/call", map[string]any{"name": parts[1], "arguments": json.RawMessage(args)})
		if e != nil {
			return nil, e
		}
		return h.capToolResultJSON(ctx, tenant, agent, result, sanitizeToolName(parts[1])), nil
	}
}

func (h *handler) runToolSearchTool(ctx context.Context, tenant, agent, session, toolCallID string, args json.RawMessage) (json.RawMessage, error) {
	parsed := map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return nil, fmt.Errorf("invalid tool arguments: %w", err)
		}
	}
	query := strings.TrimSpace(builtinStringArg(parsed, "query"))
	if query == "" {
		return nil, errors.New("query must not be empty")
	}
	limit := builtinIntArg(parsed, "limit", 8)
	catalog, err := h.cachedAgentToolCatalog(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	loaded := h.sessionLoadedTools(ctx, tenant, agent, session)
	matches := runToolSearch(catalog, loaded, query, limit)
	if disabled := disabledToolsFromContext(ctx); len(disabled) > 0 {
		filtered := matches[:0]
		for _, tool := range matches {
			if !toolNameDisabled(disabled, tool.Name) {
				filtered = append(filtered, tool)
			}
		}
		matches = filtered
	}
	newly := make([]string, 0, len(matches))
	for _, tool := range matches {
		if !loaded[tool.Name] {
			newly = append(newly, tool.Name)
		}
	}
	if len(newly) > 0 {
		_ = h.persistSessionLoadedTools(context.WithoutCancel(ctx), tenant, agent, session, newly)
	}
	if len(matches) == 0 {
		return []byte("No matching tools found."), nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Loaded %d tool(s). They are available from your next turn:", len(matches))
	for _, tool := range matches {
		description := strings.TrimSpace(tool.Description)
		if idx := strings.IndexByte(description, '\n'); idx >= 0 {
			description = strings.TrimSpace(description[:idx])
		}
		if description == "" {
			b.WriteString("\n- " + tool.Name)
		} else {
			b.WriteString("\n- " + tool.Name + ": " + description)
		}
	}
	return []byte(b.String()), nil
}

type cachedLoaded struct {
	tools map[string]bool
	at    time.Time
}

func (h *handler) loadedToolsMemoryKey(tenant, agent, session string) string {
	return tenant + "/" + agent + "/" + session
}

func (h *handler) loadedToolsRedisKey(tenant, agent, session string) string {
	return "zakura:toolsloaded:" + tenant + ":" + agent + ":" + session
}

func (h *handler) storeLoadedToolsCache(memKey string, tools map[string]bool) {
	h.loadedToolMu.Lock()
	if h.loadedToolCache == nil {
		h.loadedToolCache = map[string]cachedLoaded{}
	}
	h.loadedToolCache[memKey] = cachedLoaded{tools: tools, at: h.store.now()}
	h.loadedToolMu.Unlock()
}

func (h *handler) sessionLoadedTools(ctx context.Context, tenant, agent, session string) map[string]bool {
	out := map[string]bool{}
	if session == "" {
		return out
	}
	memKey := h.loadedToolsMemoryKey(tenant, agent, session)
	h.loadedToolMu.Lock()
	if h.loadedToolCache != nil {
		if entry, ok := h.loadedToolCache[memKey]; ok && h.store.now().Sub(entry.at) < 5*time.Second {
			cached := entry.tools
			h.loadedToolMu.Unlock()
			return cached
		}
	}
	h.loadedToolMu.Unlock()
	redisKey := h.loadedToolsRedisKey(tenant, agent, session)
	if h.deps.Redis != nil && h.deps.Redis.Enabled() {
		if raw, ok := h.deps.Redis.Get(ctx, redisKey); ok {
			var names []string
			if json.Unmarshal(raw, &names) == nil {
				for _, name := range names {
					if name != "" {
						out[name] = true
					}
				}
				h.storeLoadedToolsCache(memKey, out)
				return out
			}
		}
	}
	var rows []struct {
		PayloadJSON string `gorm:"column:payload_json"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").Select("payload_json").Where("session_id=? AND type='tools_loaded'", session).Order("seq").Find(&rows).Error; err != nil {
		return out
	}
	for _, row := range rows {
		var payload struct {
			Tools []string `json:"tools"`
		}
		if json.Unmarshal([]byte(row.PayloadJSON), &payload) != nil {
			continue
		}
		for _, name := range payload.Tools {
			if name != "" {
				out[name] = true
			}
		}
	}
	if h.deps.Redis != nil && h.deps.Redis.Enabled() {
		names := make([]string, 0, len(out))
		for name := range out {
			names = append(names, name)
		}
		if raw, err := json.Marshal(names); err == nil {
			h.deps.Redis.Set(ctx, redisKey, raw, 10*time.Second)
		}
	}
	h.storeLoadedToolsCache(memKey, out)
	return out
}

func (h *handler) persistSessionLoadedTools(ctx context.Context, tenant, agent, session string, names []string) error {
	if len(names) == 0 {
		return nil
	}
	_, err := h.store.AppendEvent(ctx, tenant, agent, session, "tools_loaded", nil, map[string]any{"tools": names})
	if err != nil {
		return err
	}
	h.invalidateSessionLoadedTools(tenant, agent, session)
	return nil
}

func (h *handler) invalidateSessionLoadedTools(tenant, agent, session string) {
	if session == "" {
		return
	}
	memKey := h.loadedToolsMemoryKey(tenant, agent, session)
	h.loadedToolMu.Lock()
	if h.loadedToolCache != nil {
		delete(h.loadedToolCache, memKey)
	}
	h.loadedToolMu.Unlock()
	if h.deps.Redis != nil && h.deps.Redis.Enabled() {
		h.deps.Redis.Del(h.deps.RunContext(), h.loadedToolsRedisKey(tenant, agent, session))
	}
}

func (h *handler) runCatalogMCPTool(ctx context.Context, tenant, agent, name string, args json.RawMessage) (json.RawMessage, error) {
	catalog, err := h.cachedAgentToolCatalog(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	for _, tool := range catalog.Tools {
		if tool.Kind != "mcp" || tool.Name != name {
			continue
		}
		inst, err := h.getMCPInstance(ctx, tenant, tool.InstanceID)
		if err != nil {
			return nil, err
		}
		result, err := h.mcpRPC(ctx, inst, "tools/call", map[string]any{"name": tool.LocalName, "arguments": json.RawMessage(args)})
		if err != nil {
			return nil, err
		}
		return h.capToolResultJSON(ctx, tenant, agent, result, sanitizeToolName(tool.LocalName)), nil
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}
