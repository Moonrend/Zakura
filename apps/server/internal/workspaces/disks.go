package workspaces

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Config struct {
	Kind           string `json:"workspaceKind"`
	Image          string `json:"workspaceImage"`
	EnableComputer bool   `json:"enableComputer"`
}

// RegisterDisk persists an allocation intent. It is not available until the
// node has created/verified the directory with its matching ownership marker.
func (s Store) RegisterDisk(ctx context.Context, tenant, space, id, name, node, incarnation string, now time.Time) (Disk, error) {
	for _, value := range []string{tenant, space, id, node, incarnation} {
		if !identityPattern.MatchString(value) {
			return Disk{}, errors.New("invalid disk identity")
		}
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 200 {
		return Disk{}, errors.New("disk name is required and must not exceed 200 bytes")
	}
	l := Locator{Kind: "directory", RelativePath: "disks/" + id + "/workspace"}
	if err := l.Validate(); err != nil {
		return Disk{}, err
	}
	raw, _ := json.Marshal(l)
	stamp := now.UTC().Format(time.RFC3339Nano)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Disk{}, err
	}
	defer tx.Rollback()
	// Lock the Space then node, matching node removal and attachment.
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE spaces SET workspace_generation=workspace_generation WHERE tenant_id=? AND id=? AND deletion_pending=FALSE`), tenant, space)); err != nil {
		return Disk{}, err
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE runtime_nodes SET incarnation=incarnation WHERE id=? AND (tenant_id=? OR is_shared=TRUE) AND incarnation=? AND kind IN ('server','computer')`), node, tenant, incarnation)); err != nil {
		return Disk{}, err
	}
	err = changed(tx.ExecContext(ctx, s.query(`INSERT INTO workspace_disks(id,tenant_id,space_id,name,node_id,node_incarnation,locator_json,locator_key,state,created_at,updated_at)
 SELECT ?,s.tenant_id,s.id,?,n.id,n.incarnation,?,?,'pending',?,?
 FROM spaces s JOIN runtime_nodes n ON n.id=? AND (n.tenant_id=s.tenant_id OR n.is_shared=TRUE)
 WHERE s.tenant_id=? AND s.id=? AND s.deletion_pending=FALSE AND n.incarnation=? AND n.kind IN ('server','computer')`), id, name, string(raw), l.RelativePath, stamp, stamp, node, tenant, space, incarnation))
	if err != nil {
		return Disk{}, err
	}
	d, err := s.disk(ctx, tx, tenant, space, id)
	if err != nil {
		return Disk{}, err
	}
	return d, tx.Commit()
}

// VerifyDisk commits an exact node observation; a delayed allocation reply must
// not make a deleting, replaced or already attached disk available again.
func (s Store) VerifyDisk(ctx context.Context, d Disk, usedBytes int64, now time.Time) error {
	if usedBytes < 0 {
		return errors.New("invalid disk usage")
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	return changed(s.DB.ExecContext(ctx, s.query(`UPDATE workspace_disks SET state='available',verified_at=?,used_bytes=?,sampled_at=?,last_error=NULL,updated_at=?
 WHERE id=? AND tenant_id=? AND space_id=? AND node_id=? AND node_incarnation=? AND locator_version=? AND locator_key=? AND state='pending' AND attached_instance_id IS NULL AND node_removed_at IS NULL`), stamp, usedBytes, stamp, stamp, d.ID, d.TenantID, d.SpaceID, d.NodeID, d.NodeIncarnation, d.LocatorVersion, d.Locator.RelativePath))
}

// Attach reserves a verified disk under the caller's existing lifecycle lease.
// The disk remains attached through revocation until remote release is proven.
func (s Store) Attach(ctx context.Context, tenant, space, id, diskID, leaseToken string, config Config, now time.Time) (Instance, error) {
	if !identityPattern.MatchString(id) || leaseToken == "" || config.Kind != "container" && config.Kind != "host" || config.Kind == "container" && strings.TrimSpace(config.Image) == "" {
		return Instance{}, errors.New("invalid workspace instance configuration")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Instance{}, err
	}
	defer tx.Rollback()
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE spaces SET workspace_generation=workspace_generation WHERE tenant_id=? AND id=? AND deletion_pending=FALSE AND current_workspace_instance_id IS NULL`), tenant, space)); err != nil {
		return Instance{}, err
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE computer_workspace_leases SET updated_at=? WHERE tenant_id=? AND space_id=? AND token=? AND expires_at>? AND operation='configuring'`), now.UnixMilli(), tenant, space, leaseToken, now.UnixMilli())); err != nil {
		return Instance{}, err
	}
	d, err := s.disk(ctx, tx, tenant, space, diskID)
	if err != nil {
		return Instance{}, err
	}
	if d.State != "available" || d.VerifiedAt == nil || d.AttachedInstanceID != nil || d.NodeRemovedAt != nil {
		return Instance{}, ErrConflict
	}
	var incarnation, computer string
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE runtime_nodes SET incarnation=incarnation WHERE id=? AND (tenant_id=? OR is_shared=TRUE) AND incarnation=?`), d.NodeID, tenant, d.NodeIncarnation)); err != nil {
		return Instance{}, err
	}
	if err = tx.QueryRowContext(ctx, s.query(`SELECT incarnation FROM runtime_nodes WHERE id=? AND (tenant_id=? OR is_shared=TRUE)`), d.NodeID, tenant).Scan(&incarnation); err != nil {
		return Instance{}, err
	}
	if incarnation != d.NodeIncarnation {
		return Instance{}, ErrConflict
	}
	if err = tx.QueryRowContext(ctx, s.query(`SELECT id FROM computers WHERE tenant_id=? AND space_id=? AND role='server' AND deletion_pending=FALSE`), tenant, space).Scan(&computer); err != nil {
		return Instance{}, err
	}
	var generation int64
	if err = tx.QueryRowContext(ctx, s.query(`SELECT workspace_generation FROM spaces WHERE tenant_id=? AND id=?`), tenant, space).Scan(&generation); err != nil {
		return Instance{}, err
	}
	generation++
	stamp := now.UTC().Format(time.RFC3339Nano)
	raw, _ := json.Marshal(config)
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_disks SET attached_instance_id=?,state='attached',updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND state='available' AND attached_instance_id IS NULL AND locator_version=?`), id, stamp, diskID, tenant, space, d.LocatorVersion)); err != nil {
		return Instance{}, err
	}
	if _, err = tx.ExecContext(ctx, s.query(`INSERT INTO workspace_instances(id,tenant_id,space_id,computer_id,generation,node_id,node_incarnation,disk_id,locator_version,config_json,identity_version,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,2,'pending',?,?)`), id, tenant, space, computer, generation, d.NodeID, d.NodeIncarnation, diskID, d.LocatorVersion, string(raw), stamp, stamp); err != nil {
		return Instance{}, err
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE spaces SET current_workspace_instance_id=?,workspace_generation=?,runtime_node_id=?,workspace_kind=?,workspace_image=?,enable_computer=?,last_error=NULL,updated_at=? WHERE tenant_id=? AND id=? AND current_workspace_instance_id IS NULL AND workspace_generation=?`), id, generation, d.NodeID, config.Kind, config.Image, config.EnableComputer, stamp, tenant, space, generation-1)); err != nil {
		return Instance{}, err
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE computer_workspace_leases SET workspace_instance_id=?,workspace_generation=? WHERE tenant_id=? AND space_id=? AND token=? AND expires_at>?`), id, generation, tenant, space, leaseToken, now.UnixMilli())); err != nil {
		return Instance{}, err
	}
	i, err := s.instance(ctx, tx, tenant, space, id)
	if err != nil {
		return i, err
	}
	return i, tx.Commit()
}

// ConfirmLegacy checks the identity recorded by adoption after observing both
// the directory and original receipt/container. Absence of a container is only
// accepted when no durable creation effect or exact Docker ID was recorded.
func (s Store) ConfirmLegacy(ctx context.Context, target Target, dockerID, status string, now time.Time) error {
	if status != "running" && status != "stopped" {
		return errors.New("invalid observed workspace state")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	i, err := s.instance(ctx, tx, target.TenantID, target.SpaceID, target.InstanceID)
	if err != nil {
		return err
	}
	if i.Target != target || i.IdentityVersion != 1 || i.State != "unknown" || i.RevokedAt != nil {
		return ErrConflict
	}
	if i.DockerID != nil && *i.DockerID != dockerID || (i.CreateOperationID != nil || status == "running") && dockerID == "" {
		return ErrConflict
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_instances SET state=?,docker_id=?,last_error=NULL,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND state='unknown' AND revoked_at IS NULL`), status, nullString(dockerID), stamp, target.InstanceID, target.TenantID, target.SpaceID)); err != nil {
		return err
	}
	if err = changed(tx.ExecContext(ctx, s.query(`UPDATE workspace_disks SET state='attached',verified_at=?,last_error=NULL,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND attached_instance_id=? AND node_id=? AND node_incarnation=? AND locator_version=? AND state='unknown'`), stamp, stamp, target.DiskID, target.TenantID, target.SpaceID, target.InstanceID, target.NodeID, target.NodeIncarnation, target.LocatorVersion)); err != nil {
		return err
	}
	return tx.Commit()
}

func nullString(v string) sql.NullString { return sql.NullString{String: v, Valid: v != ""} }
