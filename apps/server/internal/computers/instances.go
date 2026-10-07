package computers

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// GetRuntime uses the entire pinned identity. Never look up an instance by a
// provider ID alone: different accounts can return identical provider IDs.
func (s Store) GetRuntime(ctx context.Context, t Target) (Runtime, error) {
	return scanRuntime(s.DB.QueryRowContext(ctx, s.query(`SELECT id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,external_id,expires_at,idle_deadline FROM computer_runtimes WHERE tenant_id=? AND space_id=? AND computer_id=? AND id=? AND incarnation=?`), t.TenantID, t.SpaceID, t.ComputerID, t.RuntimeID, t.Incarnation))
}

// CompleteCreation records an observed provider instance, never provisions one.
// A reconciler may complete an ambiguous create with the SAME operation ID.
// Exactly one completion wins. Replays cannot replace the instance or renew its
// lifetime. Temporary lifetime starts at approval, not at delayed reconciliation.
func (s Store) CompleteCreation(ctx context.Context, t Target, operation, externalID string, now time.Time) error {
	if strings.TrimSpace(externalID) == "" || operation == "" {
		return errors.New("provider instance and creation operation are required")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var provider Provider
	var idleSeconds, maxSeconds int
	var approved string
	err = tx.QueryRowContext(ctx, s.query(`SELECT c.provider,c.idle_seconds,c.max_lifetime_seconds,a.approved_at FROM computer_runtimes r JOIN computers c ON c.tenant_id=r.tenant_id AND c.space_id=r.space_id AND c.id=r.computer_id JOIN computer_creation_approvals a ON a.runtime_id=r.id AND a.create_operation_id=r.create_operation_id WHERE r.tenant_id=? AND r.space_id=? AND r.computer_id=? AND r.id=? AND r.incarnation=? AND r.create_operation_id=? AND r.state IN ('creating','unknown') AND r.external_id IS NULL`), t.TenantID, t.SpaceID, t.ComputerID, t.RuntimeID, t.Incarnation, operation).Scan(&provider, &idleSeconds, &maxSeconds, &approved)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrTransitionConflict
	}
	if err != nil {
		return err
	}
	start, err := time.Parse(time.RFC3339Nano, approved)
	if err != nil {
		return err
	}
	if now.Before(start) {
		return errors.New("creation completion precedes approval")
	}
	var expires, idle any
	if (Computer{Provider: provider}).SessionScoped() {
		deadline := start.Add(time.Duration(maxSeconds) * time.Second)
		idleDeadline := now.Add(time.Duration(idleSeconds) * time.Second)
		if idleDeadline.After(deadline) {
			idleDeadline = deadline
		}
		expires = deadline.UTC().Format(time.RFC3339Nano)
		idle = idleDeadline.UTC().Format(time.RFC3339Nano)
	}
	result, err := tx.ExecContext(ctx, s.query(`UPDATE computer_runtimes SET state='ready',external_id=?,expires_at=?,idle_deadline=?,updated_at=? WHERE tenant_id=? AND space_id=? AND computer_id=? AND id=? AND incarnation=? AND create_operation_id=? AND state IN ('creating','unknown') AND external_id IS NULL`), externalID, expires, idle, now.UTC().Format(time.RFC3339Nano), t.TenantID, t.SpaceID, t.ComputerID, t.RuntimeID, t.Incarnation, operation)
	if err = requireRow(result, err); errors.Is(err, sql.ErrNoRows) {
		return ErrTransitionConflict
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
