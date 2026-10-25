package workspaces

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// AdoptLegacy records the existing directory and creation identity, but does not
// claim that the node, path or container has been observed. Only an explicit
// node verification may make the resulting disk usable.
func (s Store) AdoptLegacy(ctx context.Context, tenant, space, diskID, instanceID string, now time.Time) (Instance, error) {
	for _, id := range []string{tenant, space, diskID, instanceID} {
		if !identityPattern.MatchString(id) {
			return Instance{}, errors.New("invalid adoption identity")
		}
	}
	locator := Locator{Kind: "legacy-bind", RelativePath: "spaces/" + space + "/workspace"}
	if err := locator.Validate(); err != nil {
		return Instance{}, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Instance{}, err
	}
	defer tx.Rollback()
	// Lock in the same order as current workspace operations. A no-op update
	// obtains the row lock on both SQLite and PostgreSQL without changing time.
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE spaces SET workspace_generation=workspace_generation WHERE tenant_id=? AND id=? AND deletion_pending=FALSE`), tenant, space)); err != nil {
		return Instance{}, err
	}
	var current, node, image sql.NullString
	var generation int64
	var kind, status string
	var display bool
	if err = tx.QueryRowContext(ctx, s.query(`SELECT current_workspace_instance_id,workspace_generation,runtime_node_id,workspace_kind,workspace_status,workspace_image,enable_computer FROM spaces WHERE tenant_id=? AND id=?`), tenant, space).Scan(&current, &generation, &node, &kind, &status, &image, &display); err != nil {
		return Instance{}, err
	}
	if current.Valid {
		i, err := s.instance(ctx, tx, tenant, space, current.String)
		if err != nil {
			return i, err
		}
		return i, tx.Commit()
	}
	if generation != 0 || !node.Valid || node.String == "" {
		return Instance{}, ErrConflict
	}
	var computer, incarnation string
	if err = tx.QueryRowContext(ctx, s.query(`SELECT id FROM computers WHERE tenant_id=? AND space_id=? AND role='server' AND deletion_pending=FALSE`), tenant, space).Scan(&computer); err != nil {
		return Instance{}, err
	}
	if err = tx.QueryRowContext(ctx, s.query(`SELECT incarnation FROM runtime_nodes WHERE id=? AND (tenant_id=? OR is_shared=TRUE)`), node.String, tenant).Scan(&incarnation); err != nil {
		return Instance{}, err
	}
	if incarnation == "" {
		// Legacy registration IDs are immutable. The next node handshake must
		// verify this adoption identity, rather than replacing it silently.
		incarnation = "legacy:" + node.String
		if err = changed(tx.ExecContext(ctx, s.query(`UPDATE runtime_nodes SET incarnation=? WHERE id=? AND incarnation=''`), incarnation, node.String)); err != nil {
			return Instance{}, err
		}
	}
	var operation sql.NullString
	var evidence CreateEvidence
	err = tx.QueryRowContext(ctx, s.query(`SELECT operation_id,computer_id,name,config_digest,identity_version FROM workspace_create_operations WHERE tenant_id=? AND space_id=? AND node_id=? AND workspace_instance_id IS NULL`), tenant, space, node.String).Scan(&evidence.OperationID, &evidence.ComputerID, &evidence.Name, &evidence.ConfigDigest, &evidence.IdentityVersion)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Instance{}, err
	}
	if err == nil {
		if evidence.ComputerID != computer {
			return Instance{}, ErrConflict
		}
		operation = sql.NullString{String: evidence.OperationID, Valid: true}
	}
	rows, err := tx.QueryContext(ctx, s.query(`SELECT docker_id,runtime_node_id FROM managed_containers WHERE tenant_id=? AND space_id=? AND purpose='workspace' AND (status<>'removed' OR docker_id IS NOT NULL)`), tenant, space)
	if err != nil {
		return Instance{}, err
	}
	var dockerID sql.NullString
	for rows.Next() {
		var id, rowNode sql.NullString
		if err = rows.Scan(&id, &rowNode); err != nil {
			break
		}
		if rowNode.Valid && rowNode.String != node.String || id.Valid && dockerID.Valid && id.String != dockerID.String {
			err = ErrConflict
			break
		}
		if id.Valid && id.String != "" {
			dockerID = id
		}
	}
	rowsErr := rows.Err()
	rows.Close()
	if err != nil {
		return Instance{}, err
	}
	if rowsErr != nil {
		return Instance{}, rowsErr
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	locatorJSON, _ := json.Marshal(locator)
	config, _ := json.Marshal(map[string]any{"workspaceKind": kind, "workspaceImage": image.String, "enableComputer": display, "previousStatus": status})
	if _, err = tx.ExecContext(ctx, s.query(`INSERT INTO workspace_disks(id,tenant_id,space_id,name,node_id,node_incarnation,locator_json,locator_key,state,attached_instance_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'unknown',?,?,?)`), diskID, tenant, space, "Existing workspace", node.String, incarnation, string(locatorJSON), locator.RelativePath, instanceID, stamp, stamp); err != nil {
		return Instance{}, err
	}
	if _, err = tx.ExecContext(ctx, s.query(`INSERT INTO workspace_instances(id,tenant_id,space_id,computer_id,generation,node_id,node_incarnation,disk_id,locator_version,config_json,identity_version,state,docker_id,create_operation_id,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,1,?,1,'unknown',?,?,?,?)`), instanceID, tenant, space, computer, node.String, incarnation, diskID, string(config), dockerID, operation, stamp, stamp); err != nil {
		return Instance{}, err
	}
	if operation.Valid {
		if err = changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_create_operations SET workspace_instance_id=? WHERE operation_id=? AND workspace_instance_id IS NULL AND tenant_id=? AND space_id=?`), instanceID, operation.String, tenant, space)); err != nil {
			return Instance{}, err
		}
	}
	if _, err = tx.ExecContext(ctx, s.query(`UPDATE managed_containers SET workspace_instance_id=? WHERE tenant_id=? AND space_id=? AND purpose='workspace' AND (status<>'removed' OR docker_id IS NOT NULL)`), instanceID, tenant, space); err != nil {
		return Instance{}, err
	}
	if _, err = tx.ExecContext(ctx, s.query(`UPDATE computer_workspace_leases SET workspace_instance_id=?,workspace_generation=1 WHERE tenant_id=? AND space_id=?`), instanceID, tenant, space); err != nil {
		return Instance{}, err
	}
	if _, err = tx.ExecContext(ctx, s.query(`UPDATE workspace_connections SET workspace_instance_id=? WHERE tenant_id=? AND space_id=?`), instanceID, tenant, space); err != nil {
		return Instance{}, err
	}
	if _, err = tx.ExecContext(ctx, s.query(`UPDATE run_computer_targets SET workspace_instance_id=?,workspace_generation=1 WHERE tenant_id=? AND space_id=? AND computer_id=? AND workspace_instance_id IS NULL`), instanceID, tenant, space, computer); err != nil {
		return Instance{}, err
	}
	if _, err = tx.ExecContext(ctx, s.query(`INSERT INTO workspace_disk_projects(tenant_id,space_id,disk_id,project_id,path) SELECT tenant_id,space_id,?,id,'projects/' || slug FROM space_projects WHERE tenant_id=? AND space_id=? AND has_workspace=TRUE`), diskID, tenant, space); err != nil {
		return Instance{}, err
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE spaces SET current_workspace_instance_id=?,workspace_generation=1 WHERE tenant_id=? AND id=? AND current_workspace_instance_id IS NULL AND workspace_generation=0`), instanceID, tenant, space)); err != nil {
		return Instance{}, err
	}
	i, err := s.instance(ctx, tx, tenant, space, instanceID)
	if err != nil {
		return i, err
	}
	return i, tx.Commit()
}
