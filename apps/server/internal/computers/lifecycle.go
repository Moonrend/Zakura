package computers

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"
)

var ErrRuntimeEnded = errors.New("computer runtime ended; explicit replacement is required")
var ErrApprovalRequired = errors.New("computer creation requires approval")

func runtimeID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// ReserveRuntime records intent only. It never calls a provider. Retrying returns
// the same operation, including Unknown outcomes; terminal sessions are never
// silently recreated. Provider and scope are read from storage, not caller data.
func (s Store) ReserveRuntime(ctx context.Context, tenant, space, computer, session string, now time.Time) (Runtime, error) {
	var c Computer
	c.ID, c.TenantID, c.SpaceID = computer, tenant, space
	if err := s.DB.QueryRowContext(ctx, s.query(`SELECT provider FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), tenant, space, computer).Scan(&c.Provider); err != nil {
		return Runtime{}, err
	}
	scope, err := c.Scope(session)
	if err != nil {
		return Runtime{}, err
	}
	if session != "" {
		var valid int
		err = s.DB.QueryRowContext(ctx, s.query(`SELECT 1 FROM cloud_agent_sessions cs JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id WHERE cs.id=? AND cs.tenant_id=? AND a.space_id=?`), session, tenant, space).Scan(&valid)
		if err != nil {
			return Runtime{}, err
		}
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	_, err = s.DB.ExecContext(ctx, s.query(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at)
 SELECT ?,?,?,?,?,?,?,'pending_approval',?,? WHERE NOT EXISTS (SELECT 1 FROM computer_runtimes WHERE tenant_id=? AND space_id=? AND computer_id=? AND session_scope=?) ON CONFLICT DO NOTHING`), runtimeID(), tenant, space, computer, scope, runtimeID(), runtimeID(), stamp, stamp, tenant, space, computer, scope)
	if err != nil {
		return Runtime{}, err
	}
	r, err := scanRuntime(s.DB.QueryRowContext(ctx, s.query(`SELECT id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,external_id,expires_at,idle_deadline FROM computer_runtimes WHERE tenant_id=? AND space_id=? AND computer_id=? AND session_scope=? ORDER BY created_at DESC,id DESC LIMIT 1`), tenant, space, computer, scope))
	if err != nil {
		return Runtime{}, err
	}
	switch r.State {
	case Expired, Destroyed, Failed:
		return r, ErrRuntimeEnded
	}
	return r, nil
}

type runtimeScanner interface{ Scan(...any) error }

func scanRuntime(row runtimeScanner) (Runtime, error) {
	var r Runtime
	var external, expires, idle sql.NullString
	err := row.Scan(&r.ID, &r.TenantID, &r.SpaceID, &r.ComputerID, &r.SessionScope, &r.Incarnation, &r.CreateOperationID, &r.State, &external, &expires, &idle)
	if err != nil {
		return r, err
	}
	r.ExternalID = external.String
	if expires.Valid {
		r.ExpiresAt, err = time.Parse(time.RFC3339Nano, expires.String)
		if err != nil {
			return r, err
		}
	}
	if idle.Valid {
		r.IdleDeadline, err = time.Parse(time.RFC3339Nano, idle.String)
	}
	return r, err
}

// ApproveCreation must only be called after the HTTP layer checks management
// authorization and explicit confirmation. The audit and transition are atomic.
// Exactly one caller may start provisioning; repeated approval cannot retry it.
func (s Store) ApproveCreation(ctx context.Context, target Target, operation, actor string, now time.Time) error {
	if actor == "" || operation == "" {
		return ErrApprovalRequired
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stamp := now.UTC().Format(time.RFC3339Nano)
	result, err := tx.ExecContext(ctx, s.query(`UPDATE computer_runtimes SET state='creating',updated_at=? WHERE tenant_id=? AND space_id=? AND computer_id=? AND id=? AND incarnation=? AND create_operation_id=? AND state='pending_approval'`), stamp, target.TenantID, target.SpaceID, target.ComputerID, target.RuntimeID, target.Incarnation, operation)
	if err = requireRow(result, err); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, s.query(`INSERT INTO computer_creation_approvals(runtime_id,create_operation_id,approved_by,approved_at) VALUES(?,?,?,?)`), target.RuntimeID, operation, actor, stamp)
	if err != nil {
		return err
	}
	return tx.Commit()
}
