package computers

import (
	"context"
	"database/sql"
	"errors"
)

var ErrOwnerDeleting = errors.New("computer or Space deletion is pending")

// Serialize creation claims with owner deletion. No-op updates take ordinary
// row write locks on PostgreSQL and SQLite, unlike an unlocked EXISTS precheck.
func (s Store) lockCreationOwners(ctx context.Context, tx *sql.Tx, tenant, space, computer string) error {
	for _, item := range []struct {
		q    string
		args []any
	}{
		{`UPDATE spaces SET deletion_pending=deletion_pending WHERE tenant_id=? AND id=? AND deletion_pending=FALSE`, []any{tenant, space}},
		{`UPDATE computers SET deletion_pending=deletion_pending WHERE tenant_id=? AND space_id=? AND id=? AND deletion_pending=FALSE`, []any{tenant, space, computer}},
	} {
		result, err := tx.ExecContext(ctx, s.query(item.q), item.args...)
		if err != nil {
			return err
		}
		if err = requireRow(result, nil); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				var pending bool
				lookup := `SELECT deletion_pending FROM spaces WHERE tenant_id=? AND id=?`
				if len(item.args) == 3 {
					lookup = `SELECT deletion_pending FROM computers WHERE tenant_id=? AND space_id=? AND id=?`
				}
				if lookupErr := tx.QueryRowContext(ctx, s.query(lookup), item.args...).Scan(&pending); lookupErr != nil {
					return lookupErr
				}
				return ErrOwnerDeleting
			}
			return err
		}
	}
	return nil
}
