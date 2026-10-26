package computers

import (
	"context"
	"database/sql"
)

// List returns public configuration only; provider credentials and settings are
// deliberately excluded even when the caller has configuration privileges. The
// Space's server computer is always listed first.
func (s Store) List(ctx context.Context, tenant, space string) ([]Computer, error) {
	rows, err := s.DB.QueryContext(ctx, s.query(computerSelect+` WHERE c.tenant_id=? AND c.space_id=? ORDER BY CASE WHEN c.role='server' THEN 0 ELSE 1 END,c.created_at,c.id`), tenant, space)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Computer, 0)
	for rows.Next() {
		c, err := scanComputer(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

// SessionDefault is read-only and returns the chat's explicit choice. Nil means
// the chat follows the Space server computer; a missing chat is sql.ErrNoRows.
func (s Store) SessionDefault(ctx context.Context, tenant, space, session string) (*string, error) {
	var id sql.NullString
	err := s.DB.QueryRowContext(ctx, s.query(`SELECT d.computer_id FROM cloud_agent_sessions cs
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id
 LEFT JOIN session_computer_defaults d ON d.session_id=cs.id AND d.tenant_id=cs.tenant_id AND d.space_id=a.space_id
 WHERE cs.tenant_id=? AND a.space_id=? AND cs.id=?`), tenant, space, session).Scan(&id)
	if err != nil {
		return nil, err
	}
	if !id.Valid {
		return nil, nil
	}
	return &id.String, nil
}

// SessionComputer resolves the computer a chat's next Run will use: its
// explicit choice, otherwise the Space server computer. explicit is false when
// the chat follows the server computer.
func (s Store) SessionComputer(ctx context.Context, tenant, space, session string) (c Computer, explicit bool, err error) {
	selected, err := s.SessionDefault(ctx, tenant, space, session)
	if err != nil {
		return Computer{}, false, err
	}
	if selected == nil {
		c, err = s.ServerComputer(ctx, tenant, space)
		return c, false, err
	}
	c, err = s.Get(ctx, tenant, space, *selected)
	return c, true, err
}
