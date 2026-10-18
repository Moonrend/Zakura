package computers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ErrNoServerComputer wraps sql.ErrNoRows so HTTP callers map it to 404.
var ErrNoServerComputer = fmt.Errorf("space has no server computer: %w", sql.ErrNoRows)
var ErrServerComputerManaged = errors.New("the space server computer is the space workspace; it is created, configured and removed with its space")
var ErrSpaceDefaultFixed = errors.New("new chats always start on the space server computer; choose another computer per chat instead")

// ServerComputerID is the identity given to a server computer created after
// roles existed. Spaces adopted from the pre-computers workspace keep their
// "legacy:<space>" identity, so look the server computer up by role, never by
// this prefix.
func ServerComputerID(space string) string { return "server:" + space }

// Statement is one parameterized SQL statement written with ? placeholders.
type Statement struct {
	SQL  string
	Args []any
}

// ServerComputerStatements are the idempotent statements that guarantee a
// Space's server computer and refresh its cached workspace columns. They run
// in the caller's Space transaction so a Space never commits without one. The
// cached columns are informational: reads always derive node, kind and
// capabilities from the Space row itself.
func ServerComputerStatements(tenant, space string, now time.Time) []Statement {
	stamp := now.UTC().Format(time.RFC3339Nano)
	return []Statement{
		{`INSERT INTO computers(id,tenant_id,space_id,name,provider,role,runtime_node_id,legacy_workspace_scope,legacy_workspace_kind,workspace_image,capabilities_json,created_at,updated_at)
 SELECT 'server:' || s.id,s.tenant_id,s.id,s.name,'server','server',s.runtime_node_id,s.id,s.workspace_kind,s.workspace_image,'[]',?,?
 FROM spaces s WHERE s.tenant_id=? AND s.id=?
 AND NOT EXISTS (SELECT 1 FROM computers c WHERE c.tenant_id=s.tenant_id AND c.space_id=s.id AND c.role='server')
 ON CONFLICT DO NOTHING`, []any{stamp, stamp, tenant, space}},
		{`UPDATE computers SET
 runtime_node_id=(SELECT s.runtime_node_id FROM spaces s WHERE s.id=computers.space_id AND s.tenant_id=computers.tenant_id),
 legacy_workspace_kind=(SELECT s.workspace_kind FROM spaces s WHERE s.id=computers.space_id AND s.tenant_id=computers.tenant_id),
 workspace_image=(SELECT s.workspace_image FROM spaces s WHERE s.id=computers.space_id AND s.tenant_id=computers.tenant_id)
 WHERE tenant_id=? AND space_id=? AND role='server'`, []any{tenant, space}},
		// Kept for readers of the retired Space default: it always names the
		// server computer now.
		{`INSERT INTO space_computer_defaults(space_id,tenant_id,computer_id)
 SELECT space_id,tenant_id,id FROM computers WHERE tenant_id=? AND space_id=? AND role='server'
 ON CONFLICT(space_id) DO UPDATE SET computer_id=excluded.computer_id`, []any{tenant, space}},
	}
}

// EnsureServerComputer runs ServerComputerStatements in its own transaction.
// It heals Spaces created by paths that bypassed the Space transaction.
func (s Store) EnsureServerComputer(ctx context.Context, tenant, space string, now time.Time) (Computer, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Computer{}, err
	}
	defer tx.Rollback()
	for _, statement := range ServerComputerStatements(tenant, space, now) {
		if _, err = tx.ExecContext(ctx, s.query(statement.SQL), statement.Args...); err != nil {
			return Computer{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return Computer{}, err
	}
	return s.ServerComputer(ctx, tenant, space)
}

// ServerComputer returns the Space's server computer. It is the target of
// every execution that names no computer and the home of the workspace
// filesystem, the ACP environment and installed skills.
func (s Store) ServerComputer(ctx context.Context, tenant, space string) (Computer, error) {
	c, err := scanComputer(s.DB.QueryRowContext(ctx, s.query(computerSelect+` WHERE c.tenant_id=? AND c.space_id=? AND c.role='server'`), tenant, space))
	if errors.Is(err, sql.ErrNoRows) {
		return Computer{}, ErrNoServerComputer
	}
	return c, err
}

// Get returns one computer's public configuration, scoped to tenant and Space.
func (s Store) Get(ctx context.Context, tenant, space, id string) (Computer, error) {
	return scanComputer(s.DB.QueryRowContext(ctx, s.query(computerSelect+` WHERE c.tenant_id=? AND c.space_id=? AND c.id=?`), tenant, space, id))
}

// computerSelect never reads settings or credentials. The Space join supplies
// the server computer's live workspace configuration.
const computerSelect = `SELECT c.id,c.tenant_id,c.space_id,c.name,c.provider,c.role,COALESCE(c.runtime_node_id,''),c.capabilities_json,c.idle_seconds,c.max_lifetime_seconds,COALESCE(s.runtime_node_id,''),COALESCE(s.workspace_kind,''),s.enable_computer
 FROM computers c JOIN spaces s ON s.id=c.space_id AND s.tenant_id=c.tenant_id`

func scanComputer(row runtimeScanner) (Computer, error) {
	var c Computer
	var caps, spaceNode, kind string
	var display bool
	if err := row.Scan(&c.ID, &c.TenantID, &c.SpaceID, &c.Name, &c.Provider, &c.Role, &c.RuntimeNodeID, &caps, &c.IdleSeconds, &c.MaxLifetimeSeconds, &spaceNode, &kind, &display); err != nil {
		return Computer{}, err
	}
	if c.IsServer() {
		c.RuntimeNodeID = spaceNode
		c.WorkspaceKind = serverWorkspaceKind(spaceNode, kind)
		c.Capabilities = serverCapabilities(c.WorkspaceKind, display)
		return c, nil
	}
	if err := json.Unmarshal([]byte(caps), &c.Capabilities); err != nil {
		return Computer{}, err
	}
	if c.Capabilities == nil {
		c.Capabilities = []Capability{}
	}
	return c, nil
}

// serverWorkspaceKind mirrors the workspace transports: a Space without a node
// only has the control-plane directory, "host" runs on the runner host, and
// every other kind runs in the Space's workspace container.
func serverWorkspaceKind(node, kind string) string {
	switch {
	case node == "":
		return "local"
	case kind == "host":
		return "host"
	default:
		return "container"
	}
}

// serverCapabilities grants what the workspace transport implements. The local
// fallback directory backs the file browser only, never agent execution, so it
// grants nothing. Only a container workspace with the computer stack enabled
// has a display for desktop and browser control.
func serverCapabilities(kind string, display bool) []Capability {
	switch kind {
	case "host":
		return []Capability{Commands, Files, PTY, RestrictedCommands}
	case "container":
		caps := []Capability{Commands, Files, PTY, Docker}
		if display {
			caps = append(caps, Browser, Desktop)
		}
		return caps
	default:
		return []Capability{}
	}
}
