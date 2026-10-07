package computers

import (
	"context"
	"database/sql"
	"encoding/json"
)

// List returns public configuration only; provider credentials and settings are
// deliberately excluded even when the caller has configuration privileges.
func (s Store) List(ctx context.Context, tenant, space string) ([]Computer, error) {
	rows, err := s.DB.QueryContext(ctx, s.query(`SELECT id,tenant_id,space_id,name,provider,COALESCE(runtime_node_id,''),capabilities_json,idle_seconds,max_lifetime_seconds FROM computers WHERE tenant_id=? AND space_id=? ORDER BY created_at,id`), tenant, space)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Computer, 0)
	for rows.Next() {
		var c Computer
		var caps string
		if err := rows.Scan(&c.ID, &c.TenantID, &c.SpaceID, &c.Name, &c.Provider, &c.RuntimeNodeID, &caps, &c.IdleSeconds, &c.MaxLifetimeSeconds); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(caps), &c.Capabilities); err != nil {
			return nil, err
		}
		if c.Capabilities == nil {
			c.Capabilities = []Capability{}
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

// SessionDefault is read-only: viewing a chat must not backfill from a new
// Space default. A missing snapshot and an explicitly empty choice differ.
func (s Store) SessionDefault(ctx context.Context, tenant, space, session string) (*string, error) {
	var id sql.NullString
	err := s.DB.QueryRowContext(ctx, s.query(`SELECT d.computer_id FROM session_computer_defaults d JOIN cloud_agent_sessions cs ON cs.id=d.session_id AND cs.tenant_id=d.tenant_id JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id AND a.space_id=d.space_id WHERE d.tenant_id=? AND d.space_id=? AND d.session_id=?`), tenant, space, session).Scan(&id)
	if err != nil {
		return nil, err
	}
	if !id.Valid {
		return nil, nil
	}
	return &id.String, nil
}
