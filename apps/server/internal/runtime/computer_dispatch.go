package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

type computerRunKey struct{}

func computerBoundTool(name string) bool {
	switch name {
	case "fs_list", "fs_read", "fs_write", "shell_exec", "apply_patch",
		"computer_screenshot", "computer_click", "computer_type", "computer_key", "desktop_info",
		"browser_open", "browser_click", "browser_type", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource":
		return true
	}
	// Until MCP transports carry a pinned runtime, fail closed for both catalog
	// and qualified calls. A provider must not escape selection through MCP.
	return strings.HasPrefix(name, "mcp__") || strings.Contains(name, ":")
}

// runListComputers exposes only public configuration and this Run's snapshot.
// A missing snapshot is an error, not permission to consult mutable defaults.
func (h *handler) runListComputers(ctx context.Context, tenant, agent, session string) (json.RawMessage, error) {
	run, _ := ctx.Value(computerRunKey{}).(string)
	if run == "" {
		return nil, errors.New("listing computers requires an immutable run target")
	}
	var space string
	var selected sql.NullString
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT t.space_id,t.computer_id FROM run_computer_targets t
 JOIN cloud_agent_runs r ON r.id=t.run_id
 JOIN cloud_agent_sessions s ON s.id=r.session_id AND s.tenant_id=t.tenant_id
 JOIN agents a ON a.id=s.agent_id AND a.tenant_id=s.tenant_id AND a.space_id=t.space_id
 WHERE r.id=? AND s.id=? AND s.tenant_id=? AND s.agent_id=?`), run, session, tenant, agent).Scan(&space, &selected)
	if err != nil {
		return nil, err
	}
	catalog, err := h.computerStore().List(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	var defaultID *string
	if selected.Valid {
		defaultID = &selected.String
	}
	return json.Marshal(struct {
		Computers         any     `json:"computers"`
		DefaultComputerID *string `json:"defaultComputerId"`
	}{catalog, defaultID})
}
