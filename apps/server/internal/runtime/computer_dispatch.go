package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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

// guardLegacyComputer prevents the transitional Space-based executors from
// silently executing on a different computer. New adapters must replace this
// guard with runtime/incarnation resolution, never bypass it on lookup errors.
func (h *handler) guardLegacyComputer(ctx context.Context, tenant, agent, session string, args json.RawMessage) error {
	var selection struct {
		ComputerID *string `json:"computerId"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &selection); err != nil {
			return fmt.Errorf("invalid computer selection: %w", err)
		}
	}
	run, _ := ctx.Value(computerRunKey{}).(string)
	if run == "" {
		if session != "" || selection.ComputerID != nil {
			return errors.New("computer execution requires an immutable run target")
		}
		return nil // non-session legacy API; no selection was offered
	}
	a, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return err
	}
	// Bind the context to this exact chat as well as tenant/Space.
	var valid int
	err = h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT 1 FROM cloud_agent_runs r JOIN cloud_agent_sessions s ON s.id=r.session_id WHERE r.id=? AND s.id=? AND s.tenant_id=? AND s.agent_id=?`), run, session, tenant, agent).Scan(&valid)
	if err != nil {
		return err
	}
	explicit := ""
	if selection.ComputerID != nil {
		explicit = strings.TrimSpace(*selection.ComputerID)
		if explicit == "" {
			return errors.New("computerId must not be empty")
		}
	}
	c, err := h.computerStore().ResolveRunComputer(ctx, tenant, a.SpaceID, run, explicit)
	if err != nil {
		return err
	}
	var scope, kind, node, image sql.NullString
	err = h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT legacy_workspace_scope,legacy_workspace_kind,runtime_node_id,workspace_image FROM computers WHERE id=? AND tenant_id=? AND space_id=?`), c.ID, tenant, a.SpaceID).Scan(&scope, &kind, &node, &image)
	if err != nil {
		return err
	}
	if !scope.Valid || scope.String != a.SpaceID {
		return fmt.Errorf("computer %s has no connected execution adapter; refusing legacy workspace fallback", c.ID)
	}
	space, err := h.store.GetSpace(ctx, tenant, a.SpaceID)
	if err != nil {
		return err
	}
	currentNode, currentImage := "", ""
	if space.RuntimeNodeID != nil {
		currentNode = *space.RuntimeNodeID
	}
	if space.WorkspaceImage != nil {
		currentImage = *space.WorkspaceImage
	}
	if !space.EnableComputer || node.String != currentNode || kind.String != space.WorkspaceKind || image.String != currentImage {
		return errors.New("legacy computer configuration changed; refusing execution on an unbound workspace")
	}
	return nil
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
