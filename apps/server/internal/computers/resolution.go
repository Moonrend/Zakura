package computers

import (
	"context"
	"database/sql"
)

// ResolveRunComputer selects configuration only. It must not create or restart a
// runtime. Dispatch must separately authorize use and check the pinned runtime.
// Resolution order, all scoped to the Run's own tenant and Space:
//  1. explicitID, a tool call naming its target for that call only;
//  2. the Run's immutable snapshot of the chat's choice;
//  3. the Space server computer.
//
// The server computer is unique per Space and never reassigned, so the fallback
// is as stable as the snapshot; it is never a mutable chat or Space default.
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
	switch {
	case explicitID != "":
		return s.Get(ctx, tenant, space, explicitID)
	case selected.Valid && selected.String != "":
		return s.Get(ctx, tenant, space, selected.String)
	default:
		return s.ServerComputer(ctx, tenant, space)
	}
}
