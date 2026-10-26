package workspaces

import (
	"context"
	"encoding/json"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

// Read revocations without due-time filtering: a reconnect must fence every
// retired writer, even when its cleanup worker is in backoff or holds a lease.
// The snapshot remains usable after a parent Space or node record is removed.
func (s Store) NodeRevocations(ctx context.Context, node string) ([]protocol.Binding, error) {
	rows, err := s.DB.QueryContext(ctx, s.query(`SELECT snapshot_json FROM workspace_cleanup_tombstones WHERE node_id=? AND pending=TRUE AND workspace_instance_id IS NOT NULL ORDER BY id`), node)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bindings := []protocol.Binding{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var snapshot CleanupSnapshot
		if json.Unmarshal([]byte(raw), &snapshot) != nil || snapshot.Version != 1 || snapshot.Instance == nil {
			return nil, ErrUnverified
		}
		// Legacy writers require adoption; their old identity must not be
		// presented to a new executor as a v2 release authority.
		if snapshot.Instance.IdentityVersion != 2 {
			continue
		}
		binding := protocol.Binding{Target: snapshot.Instance.Target, Disk: snapshot.Disk.Wire()}
		binding.Disk.Locator = snapshot.Locator
		if binding.Validate() != nil || binding.Target.NodeID != node {
			return nil, ErrUnverified
		}
		bindings = append(bindings, binding)
	}
	return bindings, rows.Err()
}
