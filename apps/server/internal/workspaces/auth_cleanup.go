package workspaces

import (
	"context"
	"database/sql"
	"time"
)

// Retiring a managed instance cancels its control-plane login owners, not its
// remote writers. Their evidence stays in the tombstone until the node's durable
// release barrier has stopped every container and fenced pending file writes.
func (s Store) snapshotAuthentication(ctx context.Context, tx *sql.Tx, i Instance, snapshot *CleanupSnapshot) error {
	var uncertain int
	if err := tx.QueryRowContext(ctx, s.query(`SELECT COUNT(*) FROM acp_profile_auth_locks WHERE tenant_id=? AND space_id=? AND (workspace_instance_id<>? OR workspace_generation<>? OR node_id<>? OR computer_id<>?)`), i.TenantID, i.SpaceID, i.InstanceID, i.Generation, i.NodeID, i.ComputerID).Scan(&uncertain); err != nil {
		return err
	}
	if uncertain != 0 {
		return ErrConflict
	}
	if err := tx.QueryRowContext(ctx, s.query(`SELECT COUNT(*) FROM acp_device_auth_attempts WHERE tenant_id=? AND space_id=? AND status IN ('starting','pending','polling','persisting','unknown') AND (workspace_instance_id<>? OR workspace_generation<>? OR node_id<>? OR computer_id<>?)`), i.TenantID, i.SpaceID, i.InstanceID, i.Generation, i.NodeID, i.ComputerID).Scan(&uncertain); err != nil {
		return err
	}
	if uncertain != 0 {
		return ErrConflict
	}
	var err error
	snapshot.Authentication, err = snapshotRows(ctx, tx, s.query(`SELECT profile_id,kind,node_id,computer_id,workspace_instance_id,workspace_generation FROM acp_profile_auth_locks WHERE tenant_id=? AND space_id=? AND workspace_instance_id=?`), i.TenantID, i.SpaceID, i.InstanceID)
	if err != nil {
		return err
	}
	snapshot.DeviceAttempts, err = snapshotRows(ctx, tx, s.query(`SELECT id,profile_id,status,version,node_id,computer_id,workspace_instance_id,workspace_generation FROM acp_device_auth_attempts WHERE tenant_id=? AND space_id=? AND workspace_instance_id=? AND status IN ('starting','pending','polling','persisting','unknown')`), i.TenantID, i.SpaceID, i.InstanceID)
	return err
}

func (s Store) retireAuthentication(ctx context.Context, tx *sql.Tx, i Instance, now time.Time) error {
	if _, err := tx.ExecContext(ctx, s.query(`UPDATE acp_device_auth_attempts SET status='cancelled',encrypted_payload='',user_code='',verification_uri='',error='Original workspace retired; remote cleanup is pending',version=version+1,updated_at=? WHERE tenant_id=? AND space_id=? AND workspace_instance_id=? AND workspace_generation=? AND status IN ('starting','pending','polling','persisting','unknown')`), now.UTC().Format(time.RFC3339Nano), i.TenantID, i.SpaceID, i.InstanceID, i.Generation); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, s.query(`DELETE FROM acp_profile_auth_locks WHERE tenant_id=? AND space_id=? AND workspace_instance_id=? AND workspace_generation=?`), i.TenantID, i.SpaceID, i.InstanceID, i.Generation)
	return err
}
