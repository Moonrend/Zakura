package workspaces

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

func (d Disk) Wire() protocol.Disk {
	return protocol.Disk{TenantID: d.TenantID, SpaceID: d.SpaceID, DiskID: d.ID, NodeIncarnation: d.NodeIncarnation, LocatorVersion: d.LocatorVersion, Locator: d.Locator}
}

func (s Store) RenameDisk(ctx context.Context, tenant, id, name string, now time.Time) error {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 200 {
		return errors.New("disk name is required and must not exceed 200 bytes")
	}
	return changed(s.DB.ExecContext(ctx, s.query(`UPDATE workspace_disks SET name=?,updated_at=? WHERE tenant_id=? AND id=? AND state NOT IN ('deleted','delete_pending')`), name, now.UTC().Format(time.RFC3339Nano), tenant, id))
}

func (s Store) DiskError(ctx context.Context, d Disk, cause error, now time.Time) error {
	if cause == nil {
		return errors.New("disk error required")
	}
	return changed(s.DB.ExecContext(ctx, s.query(`UPDATE workspace_disks SET last_error=?,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND node_id=? AND node_incarnation=? AND locator_version=? AND state='pending' AND node_removed_at IS NULL`), cause.Error(), now.UTC().Format(time.RFC3339Nano), d.ID, d.TenantID, d.SpaceID, d.NodeID, d.NodeIncarnation, d.LocatorVersion))
}

func (s Store) SampleUsage(ctx context.Context, d Disk, bytes int64, now time.Time) error {
	if bytes < 0 {
		return errors.New("invalid disk usage")
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	return changed(s.DB.ExecContext(ctx, s.query(`UPDATE workspace_disks SET used_bytes=?,sampled_at=?,updated_at=? WHERE tenant_id=? AND space_id=? AND id=? AND node_id=? AND node_incarnation=? AND locator_version=? AND locator_key=? AND state NOT IN ('deleted','delete_pending') AND node_removed_at IS NULL AND (sampled_at IS NULL OR sampled_at<=?)`), bytes, stamp, stamp, d.TenantID, d.SpaceID, d.ID, d.NodeID, d.NodeIncarnation, d.LocatorVersion, d.Locator.RelativePath, stamp))
}

// DeleteDisk creates an independent deletion authorization for a released disk.
// An attached/releasing disk must be retired and released before this operation.
func (s Store) DeleteDisk(ctx context.Context, tenant, diskID, requestID, cleanupID string, now time.Time) (Cleanup, error) {
	if !identityPattern.MatchString(requestID) || !identityPattern.MatchString(cleanupID) {
		return Cleanup{}, ErrConflict
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Cleanup{}, err
	}
	defer tx.Rollback()
	d, err := s.disk(ctx, tx, tenant, diskID)
	if err != nil {
		return Cleanup{}, err
	}
	// Tombstones are keyed by the disk's owner slot: '' for managed disks.
	space := d.SpaceID
	prior, err := scanCleanup(tx.QueryRowContext(ctx, s.query(`SELECT `+cleanupColumns+` FROM workspace_cleanup_tombstones WHERE tenant_id=? AND space_id=? AND request_id=?`), tenant, space, requestID))
	if err == nil {
		if prior.DiskID != diskID || prior.InstanceID != nil || !prior.DeleteDisk {
			return Cleanup{}, ErrConflict
		}
		return prior, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Cleanup{}, err
	}
	if d.NodeRemovedAt == nil {
		// Node removal also changes this disk and cancels its cleanup. Serialize
		// before recording an authorization which would otherwise miss that pass.
		if err := changed(tx.ExecContext(ctx, s.query(`UPDATE runtime_nodes SET incarnation=incarnation WHERE id=? AND (tenant_id=? OR is_shared=TRUE) AND incarnation=?`), d.NodeID, tenant, d.NodeIncarnation)); err != nil {
			return Cleanup{}, err
		}
		if d.AttachedInstanceID != nil || d.State != "available" || d.VerifiedAt == nil {
			return Cleanup{}, ErrConflict
		}
	}
	snapshot := CleanupSnapshot{Version: 1, Disk: d, Locator: d.Locator}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return Cleanup{}, err
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	phase, pending := "deleting_disk", true
	if d.NodeRemovedAt != nil {
		// Forgetting a removed node's disk is a control-plane operation only.
		// Keep its frozen snapshot and never enqueue a remote deletion.
		phase, pending = "node_removed", false
		if err := changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_disks SET state='deleted',updated_at=? WHERE tenant_id=? AND id=? AND node_removed_at IS NOT NULL AND state<>'deleted' AND locator_version=?`), stamp, tenant, diskID, d.LocatorVersion)); err != nil {
			return Cleanup{}, err
		}
	} else if err := changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_disks SET state='delete_pending',updated_at=? WHERE tenant_id=? AND id=? AND state='available' AND attached_instance_id IS NULL AND locator_version=?`), stamp, tenant, diskID, d.LocatorVersion)); err != nil {
		return Cleanup{}, err
	}
	if _, err := tx.ExecContext(ctx, s.query(`INSERT INTO workspace_cleanup_tombstones(id,tenant_id,space_id,request_id,disk_id,node_id,node_incarnation,snapshot_json,delete_disk,phase,pending,next_attempt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,TRUE,?,?,?,?,?)`), cleanupID, tenant, space, requestID, diskID, d.NodeID, d.NodeIncarnation, string(raw), phase, pending, now.UnixMilli(), stamp, now.UnixMilli()); err != nil {
		return Cleanup{}, err
	}
	c, err := scanCleanup(tx.QueryRowContext(ctx, s.query(`SELECT `+cleanupColumns+` FROM workspace_cleanup_tombstones WHERE id=?`), cleanupID))
	if err != nil {
		return c, err
	}
	return c, tx.Commit()
}

func (s Store) CompleteDiskDeletion(ctx context.Context, c Cleanup, deleted protocol.Disk, now time.Time) error {
	expected := c.Snapshot.Disk.Wire()
	expected.Locator = c.Snapshot.Locator
	if c.Token == "" || !c.DeleteDisk || c.Phase != "deleting_disk" || expected != deleted {
		return ErrConflict
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_cleanup_tombstones SET phase='completed',pending=FALSE,token='',last_error=NULL,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND token=? AND pending=TRUE AND delete_disk=TRUE AND phase='deleting_disk' AND next_attempt>?`), now.UnixMilli(), c.ID, c.TenantID, c.SpaceID, c.Token, now.UnixMilli())); err != nil {
		return err
	}
	if err := changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_disks SET state='deleted',used_bytes=0,sampled_at=?,last_error=NULL,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND node_id=? AND node_incarnation=? AND locator_version=? AND locator_key=? AND state='delete_pending' AND attached_instance_id IS NULL`), now.UTC().Format(time.RFC3339Nano), now.UTC().Format(time.RFC3339Nano), deleted.DiskID, deleted.TenantID, deleted.SpaceID, c.Snapshot.Disk.NodeID, deleted.NodeIncarnation, deleted.LocatorVersion, deleted.Locator.RelativePath)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s Store) Cleanups(ctx context.Context, tenant, space string) ([]Cleanup, error) {
	rows, err := s.DB.QueryContext(ctx, s.query(`SELECT `+cleanupColumns+` FROM workspace_cleanup_tombstones WHERE tenant_id=? AND space_id=? AND pending=TRUE ORDER BY created_at,id`), tenant, space)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Cleanup{}
	for rows.Next() {
		c, err := scanCleanup(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

// DiskCleanups lists pending obligations across all of the tenant's disks.
func (s Store) DiskCleanups(ctx context.Context, tenant string) ([]Cleanup, error) {
	rows, err := s.DB.QueryContext(ctx, s.query(`SELECT `+cleanupColumns+` FROM workspace_cleanup_tombstones WHERE tenant_id=? AND pending=TRUE ORDER BY created_at,id`), tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Cleanup{}
	for rows.Next() {
		c, err := scanCleanup(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

func (s Store) DueCleanups(ctx context.Context, now time.Time, limit int) ([]Cleanup, error) {
	return s.dueCleanups(ctx, now, limit, "", nil)
}

// DueNodeCleanups excludes offline nodes before the limit is applied so they
// cannot starve cleanup on connected nodes.
func (s Store) DueNodeCleanups(ctx context.Context, now time.Time, limit int, nodes []string) ([]Cleanup, error) {
	if len(nodes) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(nodes))
	args := make([]any, len(nodes))
	for i, node := range nodes {
		placeholders[i] = "?"
		args[i] = node
	}
	return s.dueCleanups(ctx, now, limit, " AND node_id IN ("+strings.Join(placeholders, ",")+")", args)
}

func (s Store) dueCleanups(ctx context.Context, now time.Time, limit int, filter string, nodes []any) ([]Cleanup, error) {
	if limit < 1 || limit > 100 {
		return nil, errors.New("invalid cleanup batch size")
	}
	args := append([]any{now.UnixMilli()}, nodes...)
	args = append(args, limit)
	rows, err := s.DB.QueryContext(ctx, s.query(`SELECT `+cleanupColumns+` FROM workspace_cleanup_tombstones WHERE pending=TRUE AND next_attempt<=?`+filter+` ORDER BY next_attempt,id LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Cleanup
	for rows.Next() {
		c, err := scanCleanup(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}
