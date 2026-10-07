// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm/clause"
)

type agentTool struct {
	Name              string
	Kind              string
	InstanceID        string
	LocalName         string
	Description       string
	InputSchema       map[string]any
	Exposure          string
	ServerName        string
	ServerRef         string
	ServerDescription string
}

type agentCatalog struct {
	Tools  []agentTool
	Loaded []string
}

const TOOL_SEARCH_DESCRIPTION = "Some tools, such as MCP server tools, are not declared upfront. Use this tool with a short natural-language query to search for and load matching tools. Loaded tools become callable on your next turn."

func sanitizeToolName(v string) string {
	var b strings.Builder
	for _, r := range v {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

func mcpToolModelName(ref, instanceName, local string) string {
	slug := slugify(ref)
	if slug == "" {
		slug = slugify(instanceName)
	}
	name := "mcp__" + slug + "__" + sanitizeToolName(local)
	if len(name) > 64 {
		sum := sha256.Sum256([]byte(slug + "\x00" + local))
		name = name[:55] + hex.EncodeToString(sum[:])[:8]
	}
	return name
}

func mcpExposureValue(value string) bool {
	switch value {
	case "direct", "deferred", "hidden":
		return true
	}
	return false
}

func mcpToolPatternRegExp(pattern string) string {
	var b strings.Builder
	b.WriteString("^")
	for _, r := range pattern {
		switch r {
		case '*':
			b.WriteString(".*")
		case '.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteString("$")
	return b.String()
}

func toolExposureOf(config map[string]any, localToolName string) string {
	exposure := "deferred"
	if value, ok := config["exposure"].(string); ok && mcpExposureValue(value) {
		exposure = value
	}
	overrides, _ := config["toolExposure"].(map[string]any)
	if len(overrides) == 0 {
		return exposure
	}
	if value, ok := overrides[localToolName].(string); ok && mcpExposureValue(value) {
		return value
	}
	patterns := make([]string, 0, len(overrides))
	for pattern := range overrides {
		if strings.Contains(pattern, "*") {
			patterns = append(patterns, pattern)
		}
	}
	sort.Strings(patterns)
	for _, pattern := range patterns {
		value, ok := overrides[pattern].(string)
		if !ok || !mcpExposureValue(value) {
			continue
		}
		if regexp.MustCompile(mcpToolPatternRegExp(pattern)).MatchString(localToolName) {
			return value
		}
	}
	return exposure
}

func directBuiltin(name, description string, properties map[string]any, required ...string) agentTool {
	schema := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		schema["required"] = required
	}
	return agentTool{Name: name, Kind: "builtin", LocalName: name, Description: description, InputSchema: schema, Exposure: "direct"}
}

func deferredBuiltin(name, description string, properties map[string]any, required ...string) agentTool {
	tool := directBuiltin(name, description, properties, required...)
	tool.Exposure = "deferred"
	return tool
}

func normalizeToolSchema(schema map[string]any) map[string]any {
	if schema == nil {
		schema = map[string]any{}
	}
	if _, ok := schema["type"]; !ok {
		schema["type"] = "object"
	}
	if _, ok := schema["properties"]; !ok {
		schema["properties"] = map[string]any{}
	}
	return schema
}

func (h *handler) workspaceAvailable(ctx context.Context, tenant, agentID string) bool {
	var rec struct {
		EnableComputer bool `gorm:"column:enable_computer"`
	}
	err := h.deps.Gorm.WithContext(ctx).Table("agents AS a").
		Select("s.enable_computer AS enable_computer").
		Joins("JOIN spaces s ON s.id=a.space_id").
		Joins("JOIN runtime_nodes n ON n.id=s.runtime_node_id").
		Where("a.tenant_id=? AND a.id=? AND n.status IN ('online','draining')", tenant, agentID).
		Take(&rec).Error
	if err != nil {
		return false
	}
	return rec.EnableComputer
}

func (h *handler) agentMCPInstances(ctx context.Context, tenant, agentID, spaceID string) []mcpInstance {
	type row struct {
		ID   string `gorm:"column:id"`
		Name string `gorm:"column:name"`
		Ref  string `gorm:"column:component_ref"`
	}
	seen := map[string]bool{}
	out := []mcpInstance{}
	add := func(id string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		if inst, err := h.getMCPInstance(ctx, tenant, id); err == nil {
			out = append(out, inst)
		}
	}
	var spaceRows []row
	if spaceID != "" {
		_ = h.deps.Gorm.WithContext(ctx).Raw(`SELECT DISTINCT i.id AS id,i.name AS name,i.component_ref AS component_ref FROM component_instances i JOIN agent_bindings b ON b.instance_id=i.id AND b.tenant_id=i.tenant_id WHERE i.tenant_id=? AND b.space_id=? AND b.agent_id IS NULL AND i.component_type='mcp' AND i.status IN ('ready','running') ORDER BY i.name,i.id`, tenant, spaceID).Scan(&spaceRows).Error
	}
	for _, item := range spaceRows {
		add(item.ID)
	}
	var agentRows []row
	_ = h.deps.Gorm.WithContext(ctx).Raw(`SELECT DISTINCT id,name,component_ref FROM component_instances WHERE tenant_id=? AND agent_id=? AND component_type='mcp' AND status IN ('ready','running') ORDER BY name,id`, tenant, agentID).Scan(&agentRows).Error
	for _, item := range agentRows {
		add(item.ID)
	}
	return out
}

func (h *handler) mcpToolPolicy(ctx context.Context, tenant, agentID, spaceID string) (allow, deny, instanceAllow []string) {
	var row struct {
		PolicyJSON string `gorm:"column:policy_json"`
	}
	err := h.deps.Gorm.WithContext(ctx).Table("mcp_policies").Select("policy_json").
		Where("tenant_id=? AND (agent_id=? OR (space_id=? AND agent_id IS NULL) OR (agent_id IS NULL AND space_id IS NULL))", tenant, agentID, spaceID).
		Order(clause.OrderBy{Expression: clause.Expr{SQL: "CASE WHEN agent_id=? THEN 0 WHEN space_id=? AND agent_id IS NULL THEN 1 ELSE 2 END,created_at", Vars: []any{agentID, spaceID}}}).
		Take(&row).Error
	if err != nil {
		return nil, nil, nil
	}
	policy := map[string]any{}
	_ = json.Unmarshal([]byte(row.PolicyJSON), &policy)
	return mcpStringList(policy["toolAllowlist"]), mcpStringList(policy["toolDenylist"]), mcpStringList(policy["instanceIds"])
}

func (h *handler) agentMCPCatalogTools(ctx context.Context, tenant, agentID, spaceID string) []agentTool {
	instances := h.agentMCPInstances(ctx, tenant, agentID, spaceID)
	allow, deny, instanceAllow := h.mcpToolPolicy(ctx, tenant, agentID, spaceID)
	out := []agentTool{}
	for _, inst := range instances {
		if len(instanceAllow) > 0 && !listContains(instanceAllow, inst.ID) {
			continue
		}
		cfg := map[string]any{}
		_ = json.Unmarshal(inst.Config, &cfg)
		serverDescription, _ := cfg["description"].(string)
		if serverDescription == "" {
			serverDescription = inst.Name
		}
		callCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		result, err := h.mcpRPC(callCtx, inst, "tools/list", map[string]any{})
		cancel()
		if err != nil {
			continue
		}
		var listed struct {
			Tools []struct {
				Name        string         `json:"name"`
				Description string         `json:"description"`
				InputSchema map[string]any `json:"inputSchema"`
			} `json:"tools"`
		}
		_ = json.Unmarshal(result, &listed)
		for _, tool := range listed.Tools {
			local := tool.Name
			if local == "" {
				continue
			}
			rawQualified := slugify(inst.Ref) + "__" + local
			qualified := rawQualified
			if len(allow) > 0 && !listContains(allow, qualified, rawQualified, "re_"+qualified, "re_"+local, local) {
				continue
			}
			if listContains(deny, qualified, rawQualified, "re_"+qualified, "re_"+local, local) {
				continue
			}
			out = append(out, agentTool{
				Name:              mcpToolModelName(inst.Ref, inst.Name, local),
				Kind:              "mcp",
				InstanceID:        inst.ID,
				LocalName:         local,
				Description:       tool.Description,
				InputSchema:       normalizeToolSchema(tool.InputSchema),
				Exposure:          toolExposureOf(cfg, local),
				ServerName:        inst.Name,
				ServerRef:         inst.Ref,
				ServerDescription: serverDescription,
			})
		}
	}
	return out
}

func (h *handler) agentToolCatalog(ctx context.Context, tenant, agentID string) (catalog agentCatalog, err error) {
	agent, err := h.store.GetAgent(ctx, tenant, agentID)
	if err != nil {
		return agentCatalog{}, err
	}
	if _, err = h.store.GetSpace(ctx, tenant, agent.SpaceID); err != nil {
		return agentCatalog{}, err
	}
	mcpTools := h.agentMCPCatalogTools(ctx, tenant, agentID, agent.SpaceID)
	hasSearchableMCP := false
	for _, tool := range mcpTools {
		if tool.Exposure != "hidden" {
			hasSearchableMCP = true
			break
		}
	}
	tools := []agentTool{}
	if agent.EnableMemory {
		tools = append(tools,
			directBuiltin("memory_search", "Search the agent's long-term memory for relevant notes.", map[string]any{
				"query": map[string]any{"type": "string", "description": "Search query."},
				"limit": map[string]any{"type": "integer", "description": "Max results. Default 8."},
			}, "query"),
			directBuiltin("memory_remember", "Store a note in the agent's long-term memory.", map[string]any{
				"content": map[string]any{"type": "string", "description": "The note to remember."},
				"title":   map[string]any{"type": "string", "description": "Short title."},
			}, "content"),
		)
	}
	if h.workspaceAvailable(ctx, tenant, agentID) {
		tools = append(tools,
			directBuiltin("fs_list", "List files in a workspace directory.", map[string]any{
				"path": map[string]any{"type": "string", "description": `Directory path under /workspace. Default ".".`},
			}),
			directBuiltin("fs_read", "Read a text file from the workspace.", map[string]any{
				"path":   map[string]any{"type": "string"},
				"offset": map[string]any{"type": "integer", "description": "Line offset, 0-based."},
				"limit":  map[string]any{"type": "integer", "description": "Max bytes to read. Default 65536."},
			}, "path"),
			directBuiltin("fs_write", "Write a text file in the workspace.", map[string]any{
				"path":    map[string]any{"type": "string"},
				"content": map[string]any{"type": "string"},
			}, "path", "content"),
			directBuiltin("shell_exec", "Run a shell command in the workspace environment.", map[string]any{
				"command":    map[string]any{"type": "string", "description": "Shell command to run in the workspace."},
				"timeout_ms": map[string]any{"type": "integer", "description": "Deadline in ms. Default 60000, max 300000."},
			}, "command"),
			directBuiltin("codemode", "Run JavaScript that calls the agent's other tools. The script runs as the body of an async function (top-level await and return allowed) inside the workspace. Call tools as async functions on the tools object, e.g. const r = await tools.mcp__github__search_issues({query: \"x\"}). Use text(value) to append output; return a value to finish. Compose calls and filter results so only what you need comes back.", map[string]any{
				"code":       map[string]any{"type": "string", "description": "JavaScript source."},
				"timeout_ms": map[string]any{"type": "integer", "description": "Deadline in ms. Default 120000, max 600000."},
			}, "code"),
			directBuiltin("apply_patch", "Apply a unified diff patch to the workspace.", map[string]any{
				"patch": map[string]any{"type": "string", "description": "Unified diff (git style)."},
			}, "patch"),
			deferredBuiltin("computer_screenshot", "Take a screenshot of the workspace desktop.", map[string]any{}),
			deferredBuiltin("computer_click", "Click on the workspace desktop at pixel coordinates.", map[string]any{
				"x":          map[string]any{"type": "integer", "description": "Pixel x coordinate."},
				"y":          map[string]any{"type": "integer", "description": "Pixel y coordinate."},
				"button":     map[string]any{"type": "string", "enum": []any{"left", "right", "middle"}, "description": "Mouse button. Default left."},
				"count":      map[string]any{"type": "integer", "description": "Click count 1-3. Default 1. Use 2 for a double-click."},
				"move_first": map[string]any{"type": "boolean", "description": "Move the pointer before clicking. Default true."},
			}, "x", "y"),
			deferredBuiltin("computer_type", "Type text into the focused window on the workspace desktop.", map[string]any{
				"text":     map[string]any{"type": "string", "description": "Text to type."},
				"delay_ms": map[string]any{"type": "integer", "description": "Delay between keystrokes in ms. Default 25, max 200."},
			}, "text"),
			deferredBuiltin("computer_key", "Press a key or key combination (e.g. Return, ctrl+c) on the workspace desktop.", map[string]any{
				"key": map[string]any{"type": "string", "description": "Key or combination, e.g. Return or ctrl+c."},
			}, "key"),
			deferredBuiltin("desktop_info", "Inspect the workspace desktop: screen geometry, focused window and uptime.", map[string]any{}),
			deferredBuiltin("browser_open", "Open a URL in the workspace browser (Chromium via CDP) and return the page title and visible text.", map[string]any{
				"url": map[string]any{"type": "string", "description": "http(s) URL to open."},
			}, "url"),
			deferredBuiltin("browser_click", "Click an element in the workspace browser by CSS selector.", map[string]any{
				"selector":   map[string]any{"type": "string", "description": "CSS selector of the element to click."},
				"timeout_ms": map[string]any{"type": "integer", "description": "Deadline in ms waiting for the element. Default 5000."},
			}, "selector"),
			deferredBuiltin("browser_type", "Type text into an element (or the focused element) in the workspace browser; optionally submit.", map[string]any{
				"selector": map[string]any{"type": "string", "description": "CSS selector of the target element. Defaults to the focused element."},
				"text":     map[string]any{"type": "string", "description": "Text to type."},
				"submit":   map[string]any{"type": "boolean", "description": "Submit the surrounding form after typing."},
			}, "text"),
		)
	}
	agentConfig := map[string]any{}
	_ = json.Unmarshal(agent.Config, &agentConfig)
	toolProviders, _ := agentConfig["providers"].(map[string]any)
	if providerToolEnabled(toolProviders, "webSearch") {
		tools = append(tools, deferredBuiltin("web_search", "Search the web for current information. Returns ranked results with titles, URLs and text snippets.", map[string]any{
			"query": map[string]any{"type": "string", "description": "Search query."},
			"limit": map[string]any{"type": "integer", "description": "Max results 1-10. Default 5."},
		}, "query"))
	}
	if providerToolEnabled(toolProviders, "webFetch") {
		tools = append(tools, deferredBuiltin("web_fetch", "Fetch a web page and return its text content.", map[string]any{
			"url":       map[string]any{"type": "string", "description": "The http(s) URL to fetch."},
			"max_bytes": map[string]any{"type": "integer", "description": "Max content bytes. Default 20000, max 100000."},
		}, "url"))
	}
	tools = append(tools,
		directBuiltin("ask_user", "Ask the user a question and wait for their reply. Use when a decision, confirmation, or missing information blocks progress.", map[string]any{
			"question": map[string]any{"type": "string", "description": "The question to ask the user."},
			"title":    map[string]any{"type": "string", "description": "Optional short title for the question."},
			"options": map[string]any{
				"type": "array",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":          map[string]any{"type": "string"},
						"label":       map[string]any{"type": "string"},
						"description": map[string]any{"type": "string"},
					},
					"required": []any{"id", "label"},
				},
			},
			"allowMultiple":    map[string]any{"type": "boolean"},
			"secret":           map[string]any{"type": "boolean"},
			"mode":             map[string]any{"type": "string", "enum": []any{"sync", "async"}},
			"timeoutSeconds":   map[string]any{"type": "integer", "description": "Deadline in seconds. Default 600."},
			"defaultOptionIds": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"placeholder":      map[string]any{"type": "string"},
		}, "question"),
	)
	tools = append(tools,
		deferredBuiltin("list_sessions", "List recent sessions for this agent.", map[string]any{
			"limit": map[string]any{"type": "integer", "description": "Max sessions. Default 20."},
			"kind":  map[string]any{"type": "string", "description": "Filter by session kind."},
		}),
		deferredBuiltin("search_sessions", "Search sessions by text across titles and messages.", map[string]any{
			"query": map[string]any{"type": "string"},
			"limit": map[string]any{"type": "integer", "description": "Max sessions. Default 20."},
		}, "query"),
		deferredBuiltin("get_messages", "Read recent messages from a session.", map[string]any{
			"session_id": map[string]any{"type": "string", "description": "Session id. Defaults to the current session."},
			"limit":      map[string]any{"type": "integer", "description": "Max messages. Default 200."},
		}),
		deferredBuiltin("import_session", "Create a session from a list of chat messages.", map[string]any{
			"title": map[string]any{"type": "string", "description": "Session title. Default \"Imported session\"."},
			"messages": map[string]any{
				"type": "array",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"role":    map[string]any{"type": "string", "enum": []any{"user", "assistant"}},
						"content": map[string]any{"type": "string"},
					},
					"required": []any{"role", "content"},
				},
			},
		}, "messages"),
		deferredBuiltin("list_routines", "List automation routines for this agent.", map[string]any{}),
		deferredBuiltin("create_routine", "Create a cron automation routine.", map[string]any{
			"name":     map[string]any{"type": "string"},
			"prompt":   map[string]any{"type": "string"},
			"schedule": map[string]any{"type": "string", "description": "Cron expression, e.g. \"0 * * * *\" or @hourly."},
		}, "name", "prompt", "schedule"),
		deferredBuiltin("update_routine", "Update a routine's name, prompt, schedule or enabled state.", map[string]any{
			"id":       map[string]any{"type": "string"},
			"name":     map[string]any{"type": "string"},
			"prompt":   map[string]any{"type": "string"},
			"schedule": map[string]any{"type": "string"},
			"enabled":  map[string]any{"type": "boolean"},
		}, "id"),
		deferredBuiltin("pause_routine", "Pause a routine.", map[string]any{
			"id": map[string]any{"type": "string"},
		}, "id"),
		deferredBuiltin("delete_routine", "Delete a routine.", map[string]any{
			"id": map[string]any{"type": "string"},
		}, "id"),
		deferredBuiltin("run_routine", "Run a routine now.", map[string]any{
			"id": map[string]any{"type": "string"},
		}, "id"),
		deferredBuiltin("list_automation_runs", "List recent automation runs.", map[string]any{
			"limit": map[string]any{"type": "integer", "description": "Max runs. Default 20."},
		}),
		deferredBuiltin("delegate_agent", "Delegate a task to another agent and wait for its result.", map[string]any{
			"agent":  map[string]any{"type": "string", "description": "Target agent id, slug or name."},
			"prompt": map[string]any{"type": "string"},
		}, "agent", "prompt"),
	)
	if hasSearchableMCP {
		tools = append(tools,
			directBuiltin("tool_search", TOOL_SEARCH_DESCRIPTION, map[string]any{
				"query": map[string]any{"type": "string"},
				"limit": map[string]any{"type": "integer", "description": "Max tools to load. Default 8."},
			}, "query"),
			deferredBuiltin("list_mcp_resources", "List resources provided by MCP servers. Resources share data such as files, database schemas or application-specific information. Prefer resources over web search when possible.", map[string]any{
				"server": map[string]any{"type": "string", "description": "MCP server name, component ref or mcp__ slug. Omit to list every server with resources."},
				"cursor": map[string]any{"type": "string", "description": "Opaque cursor from a previous call with the same server; omit for the first page."},
			}),
			deferredBuiltin("list_mcp_resource_templates", "List resource templates provided by MCP servers. Parameterized templates share data that takes parameters.", map[string]any{
				"server": map[string]any{"type": "string", "description": "MCP server name, component ref or mcp__ slug. Omit to list every server with resources."},
			}),
			deferredBuiltin("read_mcp_resource", "Read a specific resource from an MCP server given the server name and resource URI.", map[string]any{
				"server": map[string]any{"type": "string", "description": "MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources."},
				"uri":    map[string]any{"type": "string", "description": "Resource URI to read. Must be one of the URIs returned by list_mcp_resources."},
			}, "server", "uri"),
		)
	}
	tools = append(tools, mcpTools...)
	return agentCatalog{Tools: tools}, nil
}

type cachedCatalog struct {
	catalog agentCatalog
	at      time.Time
}

func (h *handler) cachedAgentToolCatalog(ctx context.Context, tenant, agentID string) (agentCatalog, error) {
	key := tenant + "/" + agentID
	h.agentToolMu.Lock()
	if h.agentToolCache != nil {
		if entry, ok := h.agentToolCache[key]; ok && h.store.now().Sub(entry.at) < 30*time.Second {
			catalog := entry.catalog
			h.agentToolMu.Unlock()
			return catalog, nil
		}
	}
	h.agentToolMu.Unlock()
	redisKey := "zakura:agenttools:" + tenant + ":" + agentID
	if h.deps.Redis != nil && h.deps.Redis.Enabled() {
		if raw, ok := h.deps.Redis.Get(ctx, redisKey); ok {
			var catalog agentCatalog
			if json.Unmarshal(raw, &catalog) == nil {
				h.storeCatalogCache(key, catalog)
				return catalog, nil
			}
		}
	}
	catalog, err := h.agentToolCatalog(ctx, tenant, agentID)
	if err != nil {
		return agentCatalog{}, err
	}
	if h.deps.Redis != nil && h.deps.Redis.Enabled() {
		if raw, err := json.Marshal(catalog); err == nil {
			h.deps.Redis.Set(ctx, redisKey, raw, 30*time.Second)
		}
	}
	h.storeCatalogCache(key, catalog)
	return catalog, nil
}

func (h *handler) storeCatalogCache(key string, catalog agentCatalog) {
	h.agentToolMu.Lock()
	if h.agentToolCache == nil {
		h.agentToolCache = map[string]cachedCatalog{}
	}
	h.agentToolCache[key] = cachedCatalog{catalog: catalog, at: h.store.now()}
	h.agentToolMu.Unlock()
}
