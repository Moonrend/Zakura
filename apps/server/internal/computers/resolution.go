package computers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

var ErrNoComputerSelected = errors.New("no computer selected for this run")

// ResolveRunComputer selects configuration only. It must not create or restart a
// runtime. Dispatch must separately authorize use and check the pinned runtime.
// A blank explicitID uses only the immutable Run snapshot, never live defaults.
func (s Store) ResolveRunComputer(ctx context.Context, tenant, space, run, explicitID string) (Computer, error) {
	var selected sql.NullString
	err := s.DB.QueryRowContext(ctx, s.query(`SELECT t.computer_id FROM run_computer_targets t
 JOIN cloud_agent_runs r ON r.id=t.run_id
 JOIN cloud_agent_sessions cs ON cs.id=r.session_id AND cs.tenant_id=t.tenant_id
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id AND a.space_id=t.space_id
 WHERE t.run_id=? AND t.tenant_id=? AND t.space_id=?`), run, tenant, space).Scan(&selected)
	if err != nil {
		return Computer{}, err
	}
	id := explicitID
	if id == "" {
		if !selected.Valid {
			return Computer{}, ErrNoComputerSelected
		}
		id = selected.String
	}
	var c Computer
	var node sql.NullString
	var capabilities string
	// Do not retrieve settings or credentials on the execution selection path.
	err = s.DB.QueryRowContext(ctx, s.query(`SELECT id,tenant_id,space_id,name,provider,runtime_node_id,capabilities_json,idle_seconds,max_lifetime_seconds
 FROM computers WHERE id=? AND tenant_id=? AND space_id=?`), id, tenant, space).Scan(
		&c.ID, &c.TenantID, &c.SpaceID, &c.Name, &c.Provider, &node, &capabilities, &c.IdleSeconds, &c.MaxLifetimeSeconds)
	if err != nil {
		return Computer{}, err
	}
	c.RuntimeNodeID = node.String
	if err = json.Unmarshal([]byte(capabilities), &c.Capabilities); err != nil {
		return Computer{}, err
	}
	return c, nil
}
