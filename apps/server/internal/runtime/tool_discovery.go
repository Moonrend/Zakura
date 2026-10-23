// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

const toolDiscoveryMaxResults = 20

// Discovery does not change the model's declared tool set. Scripts can inspect
// schemas and call deferred tools without loading them into every later turn.
type toolDiscoveryQuery struct {
	Query          string   `json:"query"`
	Names          []string `json:"names"`
	Server         string   `json:"server"`
	Limit          int      `json:"limit"`
	Offset         int      `json:"offset"`
	IncludeSchemas bool     `json:"includeSchemas"`
}

type toolDiscoveryEntry struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Server      string         `json:"server,omitempty"`
	InputSchema map[string]any `json:"inputSchema,omitempty"`
	Call        string         `json:"call,omitempty"`
	Execute     map[string]any `json:"execute,omitempty"`
}

type toolDiscoveryResult struct {
	Tools      []toolDiscoveryEntry `json:"tools"`
	Total      int                  `json:"total"`
	NextOffset *int                 `json:"nextOffset,omitempty"`
}

func discoverTools(tools []agentTool, disabled map[string]bool, query toolDiscoveryQuery) toolDiscoveryResult {
	limit := query.Limit
	if limit <= 0 {
		limit = 8
	}
	if limit > toolDiscoveryMaxResults {
		limit = toolDiscoveryMaxResults
	}
	names := map[string]bool{}
	for _, name := range query.Names {
		names[name] = true
	}
	candidates := []agentTool{}
	for _, tool := range tools {
		// Native tools are already declared; keyword discovery is for upstream
		// MCP tools. Exact names still let Code Mode inspect a native schema.
		if tool.Kind == "builtin" && len(names) == 0 {
			continue
		}
		if tool.Exposure == "hidden" || toolNameDisabled(disabled, tool.Name) {
			continue
		}
		if len(names) > 0 && !names[tool.Name] {
			continue
		}
		if query.Server != "" && mcpNamespaceKey(query.Server) != mcpNamespaceKey(tool.ServerName) && mcpNamespaceKey(query.Server) != mcpNamespaceKey(tool.ServerRef) {
			continue
		}
		candidates = append(candidates, tool)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Name < candidates[j].Name })
	if strings.TrimSpace(query.Query) != "" {
		docs := make([]toolSearchDoc, len(candidates))
		byName := make(map[string]agentTool, len(candidates))
		for i, tool := range candidates {
			docs[i] = buildToolSearchDoc(tool)
			byName[tool.Name] = tool
		}
		ranked := bm25Rank(query.Query, docs, len(docs))
		candidates = []agentTool{}
		for _, match := range ranked {
			candidates = append(candidates, byName[match.Name])
		}
	}
	out := toolDiscoveryResult{Tools: []toolDiscoveryEntry{}, Total: len(candidates)}
	start := max(0, min(query.Offset, len(candidates)))
	end := min(start+limit, len(candidates))
	for _, tool := range candidates[start:end] {
		entry := toolDiscoveryEntry{Name: tool.Name, Description: tool.Description, Server: tool.ServerRef}
		if query.IncludeSchemas || len(names) > 0 {
			entry.InputSchema = tool.InputSchema
			if entry.InputSchema == nil {
				entry.InputSchema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			name, _ := json.Marshal(tool.Name)
			entry.Call = fmt.Sprintf("await tools[%s](args)", name)
			entry.Execute = map[string]any{"name": tool.Name, "arguments": map[string]any{}}
		} else {
			entry.Description = truncateText(entry.Description, 240)
		}
		out.Tools = append(out.Tools, entry)
	}
	if end < len(candidates) {
		out.NextOffset = &end
	}
	return out
}

func toolDiscoveryProperties() map[string]any {
	return map[string]any{
		"query":          map[string]any{"type": "string", "description": "Keywords or an exact tool name. Omit to browse."},
		"names":          map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": toolDiscoveryMaxResults, "description": "Exact names to describe."},
		"server":         map[string]any{"type": "string", "description": "Optional server name or ref."},
		"limit":          map[string]any{"type": "integer", "minimum": 1, "maximum": toolDiscoveryMaxResults, "description": "Default 8."},
		"offset":         map[string]any{"type": "integer", "minimum": 0, "description": "Use nextOffset from the previous response."},
		"includeSchemas": map[string]any{"type": "boolean", "description": "Return full input schemas for selected tools. Default false."},
	}
}
