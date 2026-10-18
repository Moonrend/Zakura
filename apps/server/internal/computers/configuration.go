package computers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var ErrComputerInUse = errors.New("computer is in use: wait for its running chats or runtime cleanup to finish")

// Create records configuration for an attached computer only. It never contacts
// a provider or incurs cost. A Space's server computer is created with the
// Space (ServerComputerStatements), never through this path.
// encryptedSettings must be an encrypted envelope, not provider credentials.
func (s Store) Create(ctx context.Context, c Computer, encryptedSettings string) error {
	if c.Role == "" {
		c.Role = RoleAttached
	}
	if c.IsServer() {
		return ErrServerComputerManaged
	}
	if err := c.Validate(); err != nil {
		return err
	}
	if encryptedSettings == "" {
		return errors.New("encrypted configuration is required")
	}
	caps, err := json.Marshal(c.Capabilities)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := s.DB.ExecContext(ctx, s.query(`INSERT INTO computers(id,tenant_id,space_id,name,provider,role,runtime_node_id,secret_ref,capabilities_json,idle_seconds,max_lifetime_seconds,created_at,updated_at)
 SELECT ?,tenant_id,id,?,?,'attached',?,?,?,?,?,?,? FROM spaces WHERE tenant_id=? AND id=?`), c.ID, c.Name, c.Provider, nullable(c.RuntimeNodeID), encryptedSettings, string(caps), c.IdleSeconds, c.MaxLifetimeSeconds, now, now, c.TenantID, c.SpaceID)
	return requireRow(result, err)
}
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// Rename cannot mutate provider, filesystem identity or a running target.
func (s Store) Rename(ctx context.Context, tenant, space, id, name string) error {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 200 {
		return errors.New("invalid computer name")
	}
	result, err := s.DB.ExecContext(ctx, s.query(`UPDATE computers SET name=?,updated_at=? WHERE tenant_id=? AND space_id=? AND id=?`), name, time.Now().UTC().Format(time.RFC3339Nano), tenant, space, id)
	return requireRow(result, err)
}

// UpdateCredentials replaces only the sealed envelope of one computer, leaving its
// policy and capabilities untouched. It is tenant/space scoped and is the write
// path for trust-on-first-use host key persistence; a missing row is sql.ErrNoRows.
func (s Store) UpdateCredentials(ctx context.Context, tenant, space, computerID, sealed string) error {
	result, err := s.DB.ExecContext(ctx, s.query(`UPDATE computers SET secret_ref=?,updated_at=? WHERE tenant_id=? AND space_id=? AND id=?`), sealed, time.Now().UTC().Format(time.RFC3339Nano), tenant, space, computerID)
	return requireRow(result, err)
}

// UpdateConfiguration serializes configuration changes with creation and deletion.
// The sealed envelope is compared with the one read by the caller so merging a
// partial update cannot silently overwrite another edit or a pinned host key.
func (s Store) UpdateConfiguration(ctx context.Context, c Computer, previousSecret, sealed string, routeChanged bool) error {
	if c.IsServer() {
		return ErrServerComputerManaged
	}
	if err := c.Validate(); err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.lockCreationOwners(ctx, tx, c.TenantID, c.SpaceID, c.ID); err != nil {
		return err
	}
	if routeChanged {
		var busy int
		if err = tx.QueryRowContext(ctx, s.query(`SELECT COUNT(*) FROM computer_runtimes WHERE tenant_id=? AND space_id=? AND computer_id=? AND (state IN ('creating','ready','disconnected','stopping','unknown') OR (state<>'destroyed' AND COALESCE(external_id,'')<>'' AND NOT EXISTS (SELECT 1 FROM computer_cleanup_intents i WHERE i.runtime_id=computer_runtimes.id AND i.incarnation=computer_runtimes.incarnation AND i.pending=FALSE)))`), c.TenantID, c.SpaceID, c.ID).Scan(&busy); err != nil {
			return err
		}
		if busy != 0 {
			return ErrComputerInUse
		}
	}
	res, err := tx.ExecContext(ctx, s.query(`UPDATE computers SET name=?,runtime_node_id=?,secret_ref=?,idle_seconds=?,max_lifetime_seconds=?,updated_at=? WHERE tenant_id=? AND space_id=? AND id=? AND role='attached' AND provider=? AND COALESCE(secret_ref,'')=?`), c.Name, nullable(c.RuntimeNodeID), sealed, c.IdleSeconds, c.MaxLifetimeSeconds, time.Now().UTC().Format(time.RFC3339Nano), c.TenantID, c.SpaceID, c.ID, c.Provider, previousSecret)
	if err = requireRow(res, err); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrTransitionConflict
		}
		return err
	}
	return tx.Commit()
}

// SpaceDefault returns the computer new chats start on, which is always the
// Space server computer.
func (s Store) SpaceDefault(ctx context.Context, tenant, space string) (*string, error) {
	c, err := s.ServerComputer(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	return &c.ID, nil
}

// Delete removes an attached computer's configuration together with its
// finished runtimes and Run pins; chats that chose it fall back to the Space
// server computer. It refuses the server computer, a computer a queued or
// running Run is pinned to, and one whose runtime may still own a provider
// instance, because removing the record would leak that instance. An SSH
// runtime is only a verified connection and never blocks removal.
func (s Store) Delete(ctx context.Context, tenant, space, id string) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var role Role
	var provider Provider
	err = tx.QueryRowContext(ctx, s.query(`SELECT role,provider FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), tenant, space, id).Scan(&role, &provider)
	if err != nil {
		return err
	}
	if role == RoleServer {
		return ErrServerComputerManaged
	}
	var busy int
	if provider != SSH {
		if err = tx.QueryRowContext(ctx, s.query(`SELECT COUNT(*) FROM computer_runtimes WHERE tenant_id=? AND space_id=? AND computer_id=? AND state IN ('creating','ready','disconnected','stopping','unknown')`), tenant, space, id).Scan(&busy); err != nil {
			return err
		}
		if busy > 0 {
			return ErrComputerInUse
		}
	}
	if err = tx.QueryRowContext(ctx, s.query(`SELECT COUNT(*) FROM run_computer_targets t JOIN cloud_agent_runs r ON r.id=t.run_id WHERE t.tenant_id=? AND t.space_id=? AND t.computer_id=? AND r.status IN ('queued','running')`), tenant, space, id).Scan(&busy); err != nil {
		return err
	}
	if busy > 0 {
		return ErrComputerInUse
	}
	scope := []any{tenant, space, id}
	for _, q := range []string{
		`UPDATE session_computer_defaults SET computer_id=NULL WHERE tenant_id=? AND space_id=? AND computer_id=?`,
		`DELETE FROM space_computer_defaults WHERE tenant_id=? AND space_id=? AND computer_id=?`,
		`DELETE FROM run_computer_targets WHERE tenant_id=? AND space_id=? AND computer_id=?`,
		`DELETE FROM computer_execution_targets WHERE tenant_id=? AND space_id=? AND computer_id=?`,
		`DELETE FROM computer_project_workspaces WHERE tenant_id=? AND space_id=? AND computer_id=?`,
		`DELETE FROM computer_creation_approvals WHERE runtime_id IN (SELECT id FROM computer_runtimes WHERE tenant_id=? AND space_id=? AND computer_id=?)`,
		`DELETE FROM computer_runtimes WHERE tenant_id=? AND space_id=? AND computer_id=?`,
		`DELETE FROM computers WHERE tenant_id=? AND space_id=? AND id=?`,
	} {
		if _, err = tx.ExecContext(ctx, s.query(q), scope...); err != nil {
			return err
		}
	}
	return tx.Commit()
}
