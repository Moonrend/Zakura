package workspaces

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

const cleanupColumns = `id,request_id,tenant_id,space_id,workspace_instance_id,disk_id,delete_disk,phase,pending,attempts,next_attempt,token,snapshot_json,last_error`

func scanCleanup(row scanner) (Cleanup, error) {
	var c Cleanup
	var raw string
	err := row.Scan(&c.ID, &c.RequestID, &c.TenantID, &c.SpaceID, &c.InstanceID, &c.DiskID, &c.DeleteDisk, &c.Phase, &c.Pending, &c.Attempts, &c.NextAttempt, &c.Token, &raw, &c.LastError)
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal([]byte(raw), &c.Snapshot); err != nil {
		return c, err
	}
	if c.Snapshot.Version != 1 {
		return c, errors.New("unsupported workspace cleanup snapshot")
	}
	return c, nil
}

func (s Store) Cleanup(ctx context.Context, tenant, space, id string) (Cleanup, error) {
	return scanCleanup(s.DB.QueryRowContext(ctx, s.query(`SELECT `+cleanupColumns+` FROM workspace_cleanup_tombstones WHERE tenant_id=? AND space_id=? AND id=?`), tenant, space, id))
}

// Retire atomically transfers remote obligations away from the current slot.
// It may run while the node is offline; it never declares the disk released.
func (s Store) Retire(ctx context.Context, target Target, requestID, cleanupID string, deleteDisk bool, now time.Time) (Cleanup, error) {
	if err := target.Validate(); err != nil {
		return Cleanup{}, err
	}
	if !identityPattern.MatchString(requestID) || !identityPattern.MatchString(cleanupID) {
		return Cleanup{}, errors.New("invalid cleanup request identity")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Cleanup{}, err
	}
	defer tx.Rollback()
	// Lock the owner before testing idempotency, so concurrent requests cannot
	// snapshot different halves of a create/retire transaction.
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE spaces SET workspace_generation=workspace_generation WHERE tenant_id=? AND id=? AND deletion_pending=FALSE`), target.TenantID, target.SpaceID)); err != nil {
		return Cleanup{}, err
	}
	prior, err := scanCleanup(tx.QueryRowContext(ctx, s.query(`SELECT `+cleanupColumns+` FROM workspace_cleanup_tombstones WHERE tenant_id=? AND space_id=? AND request_id=?`), target.TenantID, target.SpaceID, requestID))
	if err == nil {
		if prior.Snapshot.Instance == nil || prior.Snapshot.Instance.Target != target || prior.DeleteDisk != deleteDisk {
			return Cleanup{}, ErrConflict
		}
		return prior, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Cleanup{}, err
	}
	var current sql.NullString
	var generation int64
	if err = tx.QueryRowContext(ctx, s.query(`SELECT current_workspace_instance_id,workspace_generation FROM spaces WHERE tenant_id=? AND id=?`), target.TenantID, target.SpaceID).Scan(&current, &generation); err != nil {
		return Cleanup{}, err
	}
	if current.String != target.InstanceID || generation != target.Generation {
		return Cleanup{}, ErrConflict
	}
	i, err := s.instance(ctx, tx, target.TenantID, target.SpaceID, target.InstanceID)
	if err != nil {
		return Cleanup{}, err
	}
	if i.Target != target || i.RevokedAt != nil {
		return Cleanup{}, ErrConflict
	}
	d, err := s.disk(ctx, tx, target.TenantID, target.DiskID)
	if err != nil {
		return Cleanup{}, err
	}
	if d.AttachedInstanceID == nil || *d.AttachedInstanceID != target.InstanceID || d.NodeID != target.NodeID || d.NodeIncarnation != target.NodeIncarnation || d.LocatorVersion != target.LocatorVersion {
		return Cleanup{}, ErrConflict
	}
	snapshot := CleanupSnapshot{Version: 1, Instance: &i, Disk: d, Locator: d.Locator}
	var lease struct {
		Token      string          `json:"token"`
		Operation  string          `json:"operation"`
		Intent     json.RawMessage `json:"intent"`
		InstanceID *string         `json:"instanceId"`
	}
	var intent string
	err = tx.QueryRowContext(ctx, s.query(`SELECT token,operation,intent_json,workspace_instance_id FROM computer_workspace_leases WHERE tenant_id=? AND space_id=?`), target.TenantID, target.SpaceID).Scan(&lease.Token, &lease.Operation, &intent, &lease.InstanceID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Cleanup{}, err
	}
	if err == nil {
		var metadata map[string]json.RawMessage
		if json.Unmarshal([]byte(intent), &metadata) != nil || lease.InstanceID == nil || *lease.InstanceID != target.InstanceID || lease.Operation == "migrating" || lease.Operation == "deleting" {
			return Cleanup{}, ErrConflict
		}
		if profile := string(metadata["sharedProfile"]); profile != "" && profile != `""` && profile != "null" && i.IdentityVersion != 2 {
			return Cleanup{}, ErrConflict
		}
		for _, key := range []string{"ownerCleanupPrepared", "tenantCleanupPrepared"} {
			if value := string(metadata[key]); value != "" && value != `""` && value != "false" && value != "null" {
				return Cleanup{}, ErrConflict
			}
		}
		lease.Intent = json.RawMessage(intent)
		snapshot.Lease, _ = json.Marshal(lease)
	}
	var evidence CreateEvidence
	err = tx.QueryRowContext(ctx, s.query(`SELECT operation_id,computer_id,name,config_digest,identity_version FROM workspace_create_operations WHERE tenant_id=? AND space_id=? AND workspace_instance_id=?`), target.TenantID, target.SpaceID, target.InstanceID).Scan(&evidence.OperationID, &evidence.ComputerID, &evidence.Name, &evidence.ConfigDigest, &evidence.IdentityVersion)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Cleanup{}, err
	}
	if err == nil {
		snapshot.Create = &evidence
	}
	if i.CreateOperationID != nil && (snapshot.Create == nil || *i.CreateOperationID != snapshot.Create.OperationID) {
		return Cleanup{}, ErrConflict
	}
	snapshot.Containers, err = snapshotRows(ctx, tx, s.query(`SELECT id,runtime_node_id,docker_id,name,image,purpose,labels_json FROM managed_containers WHERE tenant_id=? AND space_id=? AND workspace_instance_id=? AND (status<>'removed' OR docker_id IS NOT NULL)`), target.TenantID, target.SpaceID, target.InstanceID)
	if err != nil {
		return Cleanup{}, err
	}
	snapshot.Connections, err = snapshotRows(ctx, tx, s.query(`SELECT id,node_id,stream_owner,kind,stream_id,close_method,state FROM workspace_connections WHERE tenant_id=? AND space_id=? AND workspace_instance_id=?`), target.TenantID, target.SpaceID, target.InstanceID)
	if err != nil {
		return Cleanup{}, err
	}
	if i.IdentityVersion == 2 {
		if err := s.snapshotAuthentication(ctx, tx, i, &snapshot); err != nil {
			return Cleanup{}, err
		}
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return Cleanup{}, err
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	if _, err = tx.ExecContext(ctx, s.query(`INSERT INTO workspace_cleanup_tombstones(id,tenant_id,space_id,request_id,workspace_instance_id,disk_id,node_id,node_incarnation,snapshot_json,delete_disk,next_attempt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`), cleanupID, target.TenantID, target.SpaceID, requestID, target.InstanceID, target.DiskID, target.NodeID, target.NodeIncarnation, string(raw), deleteDisk, now.UnixMilli(), stamp, now.UnixMilli()); err != nil {
		return Cleanup{}, err
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_instances SET state='revoked',revoked_at=?,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND revoked_at IS NULL`), stamp, stamp, target.InstanceID, target.TenantID, target.SpaceID)); err != nil {
		return Cleanup{}, err
	}
	diskState := "release_pending"
	if deleteDisk {
		diskState = "delete_pending"
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_disks SET state=?,updated_at=? WHERE id=? AND tenant_id=? AND attached_instance_id=? AND locator_version=?`), diskState, stamp, target.DiskID, target.TenantID, target.InstanceID, target.LocatorVersion)); err != nil {
		return Cleanup{}, err
	}
	if i.IdentityVersion == 2 {
		if err := s.retireAuthentication(ctx, tx, i, now); err != nil {
			return Cleanup{}, err
		}
	}
	if lease.Token != "" {
		if err = changed(tx.ExecContext(ctx, s.query(`DELETE FROM computer_workspace_leases WHERE tenant_id=? AND space_id=? AND token=? AND workspace_instance_id=?`), target.TenantID, target.SpaceID, lease.Token, target.InstanceID)); err != nil {
			return Cleanup{}, err
		}
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE spaces SET current_workspace_instance_id=NULL,workspace_generation=workspace_generation+1,runtime_node_id=NULL,workspace_status='stopped',last_error=NULL,updated_at=? WHERE tenant_id=? AND id=? AND current_workspace_instance_id=? AND workspace_generation=?`), stamp, target.TenantID, target.SpaceID, target.InstanceID, target.Generation)); err != nil {
		return Cleanup{}, err
	}
	c, err := scanCleanup(tx.QueryRowContext(ctx, s.query(`SELECT `+cleanupColumns+` FROM workspace_cleanup_tombstones WHERE id=?`), cleanupID))
	if err != nil {
		return c, err
	}
	return c, tx.Commit()
}

func snapshotRows(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]json.RawMessage, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var out []json.RawMessage
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		snapshot := make(map[string]any, len(columns))
		for i, col := range columns {
			value := values[i]
			if raw, ok := value.([]byte); ok {
				value = string(raw)
			}
			snapshot[col] = value
		}
		raw, err := json.Marshal(snapshot)
		if err != nil {
			return nil, err
		}
		out = append(out, raw)
	}
	return out, rows.Err()
}

// ClaimCleanup is a bounded worker claim. It does not occupy the Space's current
// lifecycle lease, and a stale worker cannot commit after its token expires.
func (s Store) ClaimCleanup(ctx context.Context, tenant, space, id, token string, now time.Time) (Cleanup, error) {
	if token == "" {
		return Cleanup{}, errors.New("cleanup token required")
	}
	if err := changed(s.DB.ExecContext(ctx, s.query(`UPDATE workspace_cleanup_tombstones SET token=?,attempts=attempts+1,next_attempt=?,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND pending=TRUE AND next_attempt<=?`), token, now.Add(2*time.Minute).UnixMilli(), now.UnixMilli(), id, tenant, space, now.UnixMilli())); err != nil {
		return Cleanup{}, err
	}
	return s.Cleanup(ctx, tenant, space, id)
}

func (s Store) RetryCleanup(ctx context.Context, c Cleanup, phase string, cause error, now time.Time) error {
	if cause == nil {
		return errors.New("cleanup retry requires a cause")
	}
	return changed(s.DB.ExecContext(ctx, s.query(`UPDATE workspace_cleanup_tombstones SET phase=?,last_error=?,next_attempt=?,token='',updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND token=? AND pending=TRUE AND next_attempt>?`), phase, cause.Error(), now.Add(time.Minute).UnixMilli(), now.UnixMilli(), c.ID, c.TenantID, c.SpaceID, c.Token, now.UnixMilli()))
}

// CompleteRelease requires the node's durable release acknowledgment. Keeping
// disk deletion separate prevents a late container cleanup from erasing a disk
// which has since been selected for a new instance.
func (s Store) CompleteRelease(ctx context.Context, c Cleanup, released Target, now time.Time) error {
	if c.Token == "" || c.Snapshot.Instance == nil || c.Snapshot.Instance.Target != released {
		return ErrConflict
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	phase, pending, diskState := "completed", false, "available"
	if c.DeleteDisk {
		phase, pending, diskState = "deleting_disk", true, "delete_pending"
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_cleanup_tombstones SET phase=?,pending=?,token='',next_attempt=?,last_error=NULL,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND token=? AND pending=TRUE AND next_attempt>?`), phase, pending, now.UnixMilli(), now.UnixMilli(), c.ID, c.TenantID, c.SpaceID, c.Token, now.UnixMilli())); err != nil {
		return err
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_instances SET state='released',released_at=?,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND generation=? AND node_id=? AND node_incarnation=? AND disk_id=? AND locator_version=? AND revoked_at IS NOT NULL AND state IN ('revoked','releasing')`), stamp, stamp, released.InstanceID, released.TenantID, released.SpaceID, released.Generation, released.NodeID, released.NodeIncarnation, released.DiskID, released.LocatorVersion)); err != nil {
		return err
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_disks SET state=?,attached_instance_id=NULL,updated_at=? WHERE id=? AND tenant_id=? AND node_id=? AND node_incarnation=? AND locator_version=? AND attached_instance_id=? AND state IN ('release_pending','delete_pending')`), diskState, stamp, released.DiskID, released.TenantID, released.NodeID, released.NodeIncarnation, released.LocatorVersion, released.InstanceID)); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, s.query(`DELETE FROM workspace_connections WHERE tenant_id=? AND space_id=? AND node_id=? AND workspace_instance_id=?`), released.TenantID, released.SpaceID, released.NodeID, released.InstanceID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, s.query(`UPDATE managed_containers SET docker_id=NULL,status='removed',updated_at=? WHERE tenant_id=? AND space_id=? AND runtime_node_id=? AND workspace_instance_id=?`), stamp, released.TenantID, released.SpaceID, released.NodeID, released.InstanceID); err != nil {
		return err
	}
	return tx.Commit()
}
