package computers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Create records configuration only. It never contacts a provider or incurs cost.
// encryptedSettings must be an encrypted envelope, not provider credentials.
func (s Store) Create(ctx context.Context, c Computer, encryptedSettings string) error {
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
	result, err := s.DB.ExecContext(ctx, s.query(`INSERT INTO computers(id,tenant_id,space_id,name,provider,runtime_node_id,secret_ref,capabilities_json,idle_seconds,max_lifetime_seconds,created_at,updated_at)
 SELECT ?,tenant_id,id,?,?,?,?,?,?,?,?,? FROM spaces WHERE tenant_id=? AND id=?`), c.ID, c.Name, c.Provider, nullable(c.RuntimeNodeID), encryptedSettings, string(caps), c.IdleSeconds, c.MaxLifetimeSeconds, now, now, c.TenantID, c.SpaceID)
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
func (s Store) SpaceDefault(ctx context.Context, tenant, space string) (*string, error) {
	var id sql.NullString
	err := s.DB.QueryRowContext(ctx, s.query(`SELECT d.computer_id FROM spaces s LEFT JOIN space_computer_defaults d ON d.space_id=s.id AND d.tenant_id=s.tenant_id WHERE s.tenant_id=? AND s.id=?`), tenant, space).Scan(&id)
	if err != nil {
		return nil, err
	}
	if !id.Valid {
		return nil, nil
	}
	return &id.String, nil
}
func (s Store) ClearSpaceDefault(ctx context.Context, tenant, space string) error {
	_, err := s.DB.ExecContext(ctx, s.query(`DELETE FROM space_computer_defaults WHERE tenant_id=? AND space_id=?`), tenant, space)
	return err
}
