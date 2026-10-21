// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func mcpDiscoveryCatalog(exposed []exposedMCPTool) agentCatalog {
	catalog := agentCatalog{}
	for _, item := range exposed {
		cfg := map[string]any{}
		_ = json.Unmarshal(item.Instance.Config, &cfg)
		description, _ := item.Tool["description"].(string)
		schema, _ := item.Tool["inputSchema"].(map[string]any)
		serverDescription, _ := cfg["description"].(string)
		catalog.Tools = append(catalog.Tools, agentTool{
			Name: mcpToolModelName(item.Instance.Ref, item.Instance.Name, item.LocalName),
			Kind: "mcp", InstanceID: item.Instance.ID, LocalName: item.LocalName,
			Description: description, InputSchema: schema,
			Exposure:   toolExposureOf(cfg, item.LocalName),
			ServerName: item.Instance.Name, ServerRef: item.Instance.Ref, ServerDescription: serverDescription,
		})
	}
	return catalog
}

func mcpListedTool(tool agentTool) map[string]any {
	schema := tool.InputSchema
	if schema == nil {
		schema = map[string]any{"type": "object", "properties": map[string]any{}}
	}
	return map[string]any{"name": tool.Name, "description": tool.Description, "inputSchema": schema}
}

func compactMCPTools(catalog agentCatalog) []map[string]any {
	search := directBuiltin("tool_search", TOOL_SEARCH_DESCRIPTION, toolDiscoveryProperties())
	if hints := renderServerHints(catalog); hints != "" {
		search.Description += "\n\n" + hints
	}
	out := []map[string]any{mcpListedTool(search), mcpListedTool(toolExecuteDefinition())}
	for _, tool := range catalog.Tools {
		if tool.Exposure == "direct" {
			out = append(out, mcpListedTool(tool))
		}
	}
	return out
}

func mcpStructuredResult(value any) map[string]any {
	raw, _ := json.Marshal(value)
	return map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(raw)}},
		"structuredContent": value,
	}
}

func (h *handler) callExposedMCPTool(r *http.Request, p httpx.Principal, space string, exposed []exposedMCPTool, name string, args json.RawMessage) (json.RawMessage, error) {
	var object map[string]any
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	if json.Unmarshal(args, &object) != nil || object == nil {
		return nil, errors.New("tool arguments must be a JSON object")
	}
	for _, item := range exposed {
		canonical := mcpToolModelName(item.Instance.Ref, item.Instance.Name, item.LocalName)
		legacy := strings.TrimPrefix(name, "re_")
		if name != canonical && legacy != item.Name && legacy != item.Instance.ID+":"+item.LocalName {
			continue
		}
		// Resolve the current binding/config again; discovered names never grant
		// access after a policy change, disable, or unbind.
		inst, err := h.accessibleMCPInstance(r, p, space, item.Instance.ID)
		if err != nil {
			return nil, err
		}
		cfg := map[string]any{}
		_ = json.Unmarshal(inst.Config, &cfg)
		if toolExposureOf(cfg, item.LocalName) == "hidden" {
			return nil, ErrNotFound
		}
		return h.authorizedMCPRPC(r, p, space, inst, "tools/call", map[string]any{"name": item.LocalName, "arguments": json.RawMessage(args)})
	}
	return nil, fmt.Errorf("unknown tool %q; use tool_search to discover available tools", name)
}
