// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// Both consumers read every upstream page. A compressed downstream surface must
// not make tools after the upstream's first page undiscoverable.
func (h *handler) listMCPToolDefinitions(ctx context.Context, inst mcpInstance) ([]map[string]any, error) {
	tools := []map[string]any{}
	cursor := ""
	seen := map[string]bool{}
	for page := 0; page < 100; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		callCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		raw, err := h.mcpRPC(callCtx, inst, "tools/list", params)
		cancel()
		if err != nil {
			return nil, err
		}
		var response struct {
			Tools      []map[string]any `json:"tools"`
			NextCursor string           `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &response); err != nil {
			return nil, err
		}
		tools = append(tools, response.Tools...)
		if response.NextCursor == "" {
			return tools, nil
		}
		if seen[response.NextCursor] {
			return nil, errors.New("MCP tools/list repeated its cursor")
		}
		seen[response.NextCursor] = true
		cursor = response.NextCursor
	}
	return nil, errors.New("MCP tools/list exceeds page limit")
}
