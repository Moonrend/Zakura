package projectexec

import (
	"context"
	"database/sql"
	"errors"
)

// RequireTenantActive reads the durable shutdown fence. Callers that mutate
// execution state already hold the project or tenant lock; it deliberately
// acquires no tenant lock, so tenant shutdown cannot invert that lock order.
// A nil transaction is only a precheck; mutations must repeat it under their
// project lock (or tenant lock when creating a project).
func (s *Store) RequireTenantActive(ctx context.Context, tx *sql.Tx, tenant string) error {
	var q sqlReader = s.db
	if tx != nil {
		q = tx
	}
	draining, err := s.tenantDraining(ctx, q, tenant)
	if err != nil {
		return err
	}
	if draining {
		return ErrTenantDraining
	}
	return nil
}

func (s *Store) TenantDraining(ctx context.Context, tenant string) (bool, error) {
	return s.tenantDraining(ctx, s.db, tenant)
}

func (s *Store) tenantDraining(ctx context.Context, q sqlReader, tenant string) (bool, error) {
	var draining int
	err := q.QueryRowContext(ctx, s.rebind(`SELECT draining FROM execution_tenant_controls WHERE tenant_id=?`), tenant).Scan(&draining)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return draining != 0, err
}
