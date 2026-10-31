package workspaces

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// Store changes durable ownership only. It never creates directories or invokes
// a runtime node; callers must prove remote effects before completing a claim.
type Store struct {
	DB     *sql.DB
	Rebind func(string) string
}

func (s Store) query(q string) string {
	if s.Rebind != nil {
		return s.Rebind(q)
	}
	return q
}

type scanner interface{ Scan(...any) error }
type querier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

const diskColumns = `id,tenant_id,space_id,name,node_id,node_incarnation,locator_json,locator_version,state,attached_instance_id,used_bytes,sampled_at,verified_at,last_error,created_at,updated_at,node_removed_at`
const instanceColumns = `id,tenant_id,space_id,computer_id,generation,node_id,node_incarnation,disk_id,locator_version,config_json,identity_version,state,docker_id,create_operation_id,revoked_at,released_at,last_error,created_at,updated_at`

func scanDisk(row scanner) (Disk, error) {
	var d Disk
	var raw string
	err := row.Scan(&d.ID, &d.TenantID, &d.SpaceID, &d.Name, &d.NodeID, &d.NodeIncarnation, &raw, &d.LocatorVersion, &d.State, &d.AttachedInstanceID, &d.UsedBytes, &d.SampledAt, &d.VerifiedAt, &d.LastError, &d.CreatedAt, &d.UpdatedAt, &d.NodeRemovedAt)
	if err != nil {
		return d, err
	}
	if err = json.Unmarshal([]byte(raw), &d.Locator); err != nil {
		return d, err
	}
	return d, d.Locator.Validate()
}

func scanInstance(row scanner) (Instance, error) {
	var i Instance
	var raw string
	err := row.Scan(&i.InstanceID, &i.TenantID, &i.SpaceID, &i.ComputerID, &i.Generation, &i.NodeID, &i.NodeIncarnation, &i.DiskID, &i.LocatorVersion, &raw, &i.IdentityVersion, &i.State, &i.DockerID, &i.CreateOperationID, &i.RevokedAt, &i.ReleasedAt, &i.LastError, &i.CreatedAt, &i.UpdatedAt)
	if err != nil {
		return i, err
	}
	i.Config = json.RawMessage(raw)
	if !json.Valid(i.Config) {
		return i, errors.New("invalid workspace configuration snapshot")
	}
	return i, i.Target.Validate()
}

func (s Store) disk(ctx context.Context, q querier, tenant, id string) (Disk, error) {
	return scanDisk(q.QueryRowContext(ctx, s.query(`SELECT `+diskColumns+` FROM workspace_disks WHERE tenant_id=? AND id=?`), tenant, id))
}
func (s Store) instance(ctx context.Context, q querier, tenant, space, id string) (Instance, error) {
	return scanInstance(q.QueryRowContext(ctx, s.query(`SELECT `+instanceColumns+` FROM workspace_instances WHERE tenant_id=? AND space_id=? AND id=?`), tenant, space, id))
}
func (s Store) Disk(ctx context.Context, tenant, id string) (Disk, error) {
	return s.disk(ctx, s.DB, tenant, id)
}
func (s Store) Instance(ctx context.Context, tenant, space, id string) (Instance, error) {
	return s.instance(ctx, s.DB, tenant, space, id)
}
func (s Store) Current(ctx context.Context, tenant, space string) (Instance, error) {
	var id sql.NullString
	if err := s.DB.QueryRowContext(ctx, s.query(`SELECT current_workspace_instance_id FROM spaces WHERE tenant_id=? AND id=? AND deletion_pending=FALSE`), tenant, space).Scan(&id); err != nil {
		return Instance{}, err
	}
	if !id.Valid || id.String == "" {
		return Instance{}, sql.ErrNoRows
	}
	return s.Instance(ctx, tenant, space, id.String)
}

// Disks are tenant storage. SpaceID is set only on legacy-bind disks, whose
// directory is named after the Space that created it; managed disks leave it
// empty and can be attached by any Space of the tenant.
func (s Store) Disks(ctx context.Context, tenant string) ([]Disk, error) {
	rows, err := s.DB.QueryContext(ctx, s.query(`SELECT `+diskColumns+` FROM workspace_disks WHERE tenant_id=? AND state<>'deleted' ORDER BY created_at,id`), tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Disk{}
	for rows.Next() {
		d, err := scanDisk(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// Resolve never looks up the current binding as a replacement for a pinned one.
// A detached/revoked instance must fail even if its Space has a new workspace.
func (s Store) Resolve(ctx context.Context, target Target) (Instance, Disk, error) {
	if err := target.Validate(); err != nil {
		return Instance{}, Disk{}, err
	}
	i, err := s.Instance(ctx, target.TenantID, target.SpaceID, target.InstanceID)
	if err != nil {
		return i, Disk{}, err
	}
	if i.Target != target || !i.Usable() {
		return i, Disk{}, ErrTargetRevoked
	}
	d, err := s.Disk(ctx, target.TenantID, target.DiskID)
	if err != nil {
		return i, d, err
	}
	if d.NodeRemovedAt != nil || d.NodeID != target.NodeID || d.NodeIncarnation != target.NodeIncarnation || d.LocatorVersion != target.LocatorVersion || d.AttachedInstanceID == nil || *d.AttachedInstanceID != target.InstanceID || d.State != "attached" {
		return i, d, ErrTargetRevoked
	}
	if d.VerifiedAt == nil {
		return i, d, ErrUnverified
	}
	return i, d, nil
}

func changed(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConflict
	}
	return nil
}
