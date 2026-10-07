package computers

import (
	"context"
	"database/sql"
	"errors"
)

// Store only accepts tenant/space-scoped identities. HTTP callers must additionally
// enforce Space membership (execute for use, manage for configuration changes).
// No method in this store starts a provider or retrieves credentials.
type Store struct {
	DB     *sql.DB
	Rebind func(string) string
}

func (s Store) query(q string) string {
	if s.Rebind != nil {
		return s.Rebind(q)
	}
	return q
}

// SetSpaceDefault never changes an existing chat's selection.
func (s Store) SetSpaceDefault(ctx context.Context, tenant, space, computer string) error {
	result, err := s.DB.ExecContext(ctx, s.query(`INSERT INTO space_computer_defaults(space_id,tenant_id,computer_id)
 SELECT space_id,tenant_id,id FROM computers WHERE tenant_id=? AND space_id=? AND id=?
 ON CONFLICT(space_id) DO UPDATE SET computer_id=excluded.computer_id WHERE space_computer_defaults.tenant_id=excluded.tenant_id`), tenant, space, computer)
	return requireRow(result, err)
}

// InitializeSessionDefault snapshots the Space default exactly once. Invoke at
// chat creation, not at Run start; no default is represented by sql.ErrNoRows.
func (s Store) InitializeSessionDefault(ctx context.Context, tenant, space, session string) (string, error) {
	_, err := s.DB.ExecContext(ctx, s.query(`INSERT INTO session_computer_defaults(session_id,tenant_id,space_id,computer_id)
 SELECT cs.id,cs.tenant_id,a.space_id,d.computer_id FROM cloud_agent_sessions cs
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id
 LEFT JOIN space_computer_defaults d ON d.space_id=a.space_id AND d.tenant_id=cs.tenant_id
 WHERE cs.id=? AND cs.tenant_id=? AND a.space_id=?
 ON CONFLICT(session_id) DO NOTHING`), session, tenant, space)
	if err != nil {
		return "", err
	}
	var id sql.NullString
	err = s.DB.QueryRowContext(ctx, s.query(`SELECT computer_id FROM session_computer_defaults WHERE session_id=? AND tenant_id=? AND space_id=?`), session, tenant, space).Scan(&id)
	if err == nil && !id.Valid {
		err = sql.ErrNoRows
	}
	return id.String, err
}

// SetSessionDefault affects subsequent Runs only; run_computer_targets is immutable.
func (s Store) SetSessionDefault(ctx context.Context, tenant, space, session, computer string) error {
	result, err := s.DB.ExecContext(ctx, s.query(`INSERT INTO session_computer_defaults(session_id,tenant_id,space_id,computer_id)
 SELECT cs.id,c.tenant_id,c.space_id,c.id FROM cloud_agent_sessions cs
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id
 JOIN computers c ON c.space_id=a.space_id AND c.tenant_id=cs.tenant_id
 WHERE cs.id=? AND cs.tenant_id=? AND a.space_id=? AND c.id=?
 ON CONFLICT(session_id) DO UPDATE SET computer_id=excluded.computer_id
 WHERE session_computer_defaults.tenant_id=excluded.tenant_id AND session_computer_defaults.space_id=excluded.space_id`), session, tenant, space, computer)
	return requireRow(result, err)
}

// SnapshotRunTarget is retry-safe: the first persisted target wins even if the
// chat default changes while a Run is active. It deliberately has no Space fallback.
func (s Store) SnapshotRunTarget(ctx context.Context, tenant, space, run string) (string, error) {
	_, err := s.DB.ExecContext(ctx, s.query(`INSERT INTO run_computer_targets(run_id,tenant_id,space_id,computer_id)
 SELECT r.id,cs.tenant_id,a.space_id,d.computer_id FROM cloud_agent_runs r
 JOIN cloud_agent_sessions cs ON cs.id=r.session_id
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id
 LEFT JOIN session_computer_defaults d ON d.session_id=cs.id AND d.tenant_id=cs.tenant_id AND d.space_id=a.space_id
 WHERE r.id=? AND cs.tenant_id=? AND a.space_id=?
 ON CONFLICT(run_id) DO NOTHING`), run, tenant, space)
	if err != nil {
		return "", err
	}
	var id sql.NullString
	err = s.DB.QueryRowContext(ctx, s.query(`SELECT computer_id FROM run_computer_targets WHERE run_id=? AND tenant_id=? AND space_id=?`), run, tenant, space).Scan(&id)
	if err == nil && !id.Valid {
		err = sql.ErrNoRows
	}
	return id.String, err
}

var ErrTransitionConflict = errors.New("computer runtime state changed or target does not exist")

// Transition is a compare-and-swap. A restart or stale cleanup worker cannot
// overwrite the state of a replacement instance or release an unknown active slot.
func (s Store) Transition(ctx context.Context, t Target, from, to State, updatedAt string) error {
	if from == PendingApproval && to == Creating {
		return ErrApprovalRequired
	}
	if to == Ready && from == Creating {
		return errors.New("creation must be completed with a provider instance identity")
	}
	if !CanTransition(from, to) {
		return errors.New("invalid computer runtime transition")
	}
	result, err := s.DB.ExecContext(ctx, s.query(`UPDATE computer_runtimes SET state=?,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND computer_id=? AND incarnation=? AND state=? AND (? <> 'ready' OR (external_id IS NOT NULL AND external_id <> ''))`), to, updatedAt, t.RuntimeID, t.TenantID, t.SpaceID, t.ComputerID, t.Incarnation, from, to)
	if err = requireRow(result, err); errors.Is(err, sql.ErrNoRows) {
		return ErrTransitionConflict
	}
	return err
}
func requireRow(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// PinExecution records an already-resolved runtime before dispatch. A retry with
// the same id must match the original target and tool call; it may not redirect
// an existing job to the chat's new default or to a replacement incarnation.
func (s Store) PinExecution(ctx context.Context, id, run, toolCall string, target Target, createdAt string) error {
	if id == "" || run == "" || toolCall == "" || target.Incarnation == "" {
		return errors.New("execution binding is incomplete")
	}
	_, err := s.DB.ExecContext(ctx, s.query(`INSERT INTO computer_execution_targets(id,tenant_id,space_id,computer_id,runtime_id,incarnation,run_id,tool_call_id,created_at)
 SELECT ?,rt.tenant_id,rt.space_id,rt.computer_id,rt.id,rt.incarnation,r.id,?,?
 FROM computer_runtimes rt
 JOIN computers c ON c.id=rt.computer_id AND c.tenant_id=rt.tenant_id AND c.space_id=rt.space_id
 JOIN cloud_agent_runs r ON r.id=?
 JOIN cloud_agent_sessions cs ON cs.id=r.session_id AND cs.tenant_id=rt.tenant_id
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id AND a.space_id=rt.space_id
 WHERE rt.tenant_id=? AND rt.space_id=? AND rt.computer_id=? AND rt.id=? AND rt.incarnation=?
 AND ((c.provider IN ('temporary','e2b') AND rt.session_scope=cs.id) OR (c.provider NOT IN ('temporary','e2b') AND rt.session_scope=''))
 ON CONFLICT(id) DO NOTHING`), id, toolCall, createdAt, run, target.TenantID, target.SpaceID, target.ComputerID, target.RuntimeID, target.Incarnation)
	if err != nil {
		return err
	}
	var actual Target
	var actualRun, actualTool string
	err = s.DB.QueryRowContext(ctx, s.query(`SELECT tenant_id,space_id,computer_id,runtime_id,incarnation,run_id,tool_call_id FROM computer_execution_targets WHERE id=? AND tenant_id=? AND space_id=?`), id, target.TenantID, target.SpaceID).Scan(&actual.TenantID, &actual.SpaceID, &actual.ComputerID, &actual.RuntimeID, &actual.Incarnation, &actualRun, &actualTool)
	if err != nil {
		return err
	}
	if actual != target || actualRun != run || actualTool != toolCall {
		return errors.New("execution binding already pinned to a different target or tool call")
	}
	return nil
}

// ExecutionTarget looks up a job's persisted identity, not the current computer
// selection. Authorization of the Run/session belongs to the caller.
func (s Store) ExecutionTarget(ctx context.Context, tenant, space, run, id string) (Target, error) {
	var t Target
	err := s.DB.QueryRowContext(ctx, s.query(`SELECT tenant_id,space_id,computer_id,runtime_id,incarnation FROM computer_execution_targets WHERE id=? AND tenant_id=? AND space_id=? AND run_id=?`), id, tenant, space, run).Scan(&t.TenantID, &t.SpaceID, &t.ComputerID, &t.RuntimeID, &t.Incarnation)
	return t, err
}

// ClearSessionDefault records an explicit absence, rather than deleting the row.
// This prevents initialization retries from restoring a later Space default.
func (s Store) ClearSessionDefault(ctx context.Context, tenant, space, session string) error {
	result, err := s.DB.ExecContext(ctx, s.query(`INSERT INTO session_computer_defaults(session_id,tenant_id,space_id,computer_id)
 SELECT cs.id,cs.tenant_id,a.space_id,NULL FROM cloud_agent_sessions cs
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id
 WHERE cs.id=? AND cs.tenant_id=? AND a.space_id=?
 ON CONFLICT(session_id) DO UPDATE SET computer_id=NULL
 WHERE session_computer_defaults.tenant_id=excluded.tenant_id AND session_computer_defaults.space_id=excluded.space_id`), session, tenant, space)
	return requireRow(result, err)
}
