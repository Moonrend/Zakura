// SPDX-License-Identifier: AGPL-3.0-or-later
package projectcampaign

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/campaign"
)

var ErrNotFound = errors.New("project campaign not found")
var ErrConflict = errors.New("project campaign revision or state conflict")
var ErrActiveLimit = errors.New("campaign active variant limit is reached; paused and unresolved starts retain their slot")

type Audit struct {
	ID        string          `json:"id"`
	AuthorID  string          `json:"authorId"`
	Action    string          `json:"action"`
	VariantID string          `json:"variantId,omitempty"`
	Comment   string          `json:"comment"`
	Details   json.RawMessage `json:"details"`
	CreatedAt time.Time       `json:"createdAt"`
}

type Store struct {
	db     *sql.DB
	rebind func(string) string
	fence  *projectexec.Store
	now    func() time.Time
}

func NewStore(db *sql.DB, dialect string, rebind func(string) string) *Store {
	if rebind == nil {
		rebind = func(v string) string { return v }
	}
	return &Store{db: db, rebind: rebind, fence: projectexec.NewStore(db, dialect, rebind), now: func() time.Time { return time.Now().UTC() }}
}

func id() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}
func stamp(t time.Time) string            { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }
func decode(raw string, target any) error { return json.Unmarshal([]byte(raw), target) }

type reader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (s *Store) get(ctx context.Context, q reader, tenant, cid string) (campaign.Campaign, error) {
	var raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT campaign_json FROM project_campaigns WHERE tenant_id=? AND id=?`), tenant, cid).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return campaign.Campaign{}, ErrNotFound
	}
	if err != nil {
		return campaign.Campaign{}, err
	}
	var c campaign.Campaign
	err = json.Unmarshal([]byte(raw), &c)
	return c, err
}
func (s *Store) Get(ctx context.Context, tenant, cid string) (campaign.Campaign, error) {
	return s.get(ctx, s.db, tenant, cid)
}

func (s *Store) Create(ctx context.Context, tenant, space, author string, d campaign.Definition) (campaign.Campaign, error) {
	if len(d.Variants) < 2 || len(d.Variants) > campaign.MaxVariants {
		return campaign.Campaign{}, fmt.Errorf("invalid campaign variants")
	}
	cid, err := id()
	if err != nil {
		return campaign.Campaign{}, err
	}
	now := s.now()
	c := campaign.Campaign{ID: cid, TenantID: tenant, SpaceID: space, Revision: 1, Status: "draft", Definition: d, CaptureState: "unfrozen", CreatedBy: author, CreatedAt: now, UpdatedAt: now}
	for i := range c.Definition.Variants {
		v := &c.Definition.Variants[i]
		pid, err := id()
		if err != nil {
			return c, err
		}
		v.Project.ID = pid
		v.Project.TenantID = tenant
		v.Project.SpaceID = space
		v.Project.CreatedBy = author
		v.Project.Revision = 1
		v.State = "prepared"
		v.RunID = ""
		v.CopyOperationID = ""
		if v.DefinitionHash != campaign.ProjectHash(v.Project) {
			return campaign.Campaign{}, fmt.Errorf("frozen variant definition hash does not match")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return c, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, s.rebind(`UPDATE tenants SET id=id WHERE id=?`), tenant)
	if err != nil {
		return c, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return c, err
	}
	if n != 1 {
		return c, ErrNotFound
	}
	if err = s.fence.RequireTenantActive(ctx, tx, tenant); err != nil {
		return c, err
	}
	var sourceSpace string
	if err = tx.QueryRowContext(ctx, s.rebind(`SELECT space_id FROM execution_projects WHERE tenant_id=? AND id=?`), tenant, d.SourceProjectID).Scan(&sourceSpace); err != nil {
		return c, ErrNotFound
	}
	if sourceSpace != space {
		return c, ErrNotFound
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return c, err
	}
	if _, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO project_campaigns(id,tenant_id,space_id,source_project_id,revision,campaign_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`), cid, tenant, space, d.SourceProjectID, c.Revision, string(raw), stamp(now), stamp(now)); err != nil {
		return c, err
	}
	for _, v := range c.Definition.Variants {
		if _, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO project_campaign_variants(tenant_id,campaign_id,variant_id,project_id,state) VALUES(?,?,?,?,?)`), tenant, cid, v.ID, v.Project.ID, v.State); err != nil {
			return c, err
		}
	}
	if err = s.audit(ctx, tx, c, author, "created", "", "", map[string]any{"reservedBudget": d.ReservedBudget, "templateVersion": d.TemplateVersion}); err != nil {
		return c, err
	}
	return c, tx.Commit()
}

func (s *Store) save(ctx context.Context, tx *sql.Tx, c *campaign.Campaign) error {
	c.Revision++
	c.UpdatedAt = s.now()
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, s.rebind(`UPDATE project_campaigns SET revision=?,campaign_json=?,updated_at=? WHERE tenant_id=? AND id=?`), c.Revision, string(raw), stamp(c.UpdatedAt), c.TenantID, c.ID); err != nil {
		return err
	}
	for _, v := range c.Definition.Variants {
		var runID any
		if v.RunID != "" {
			runID = v.RunID
		}
		if _, err = tx.ExecContext(ctx, s.rebind(`UPDATE project_campaign_variants SET state=?,run_id=? WHERE tenant_id=? AND campaign_id=? AND variant_id=?`), v.State, runID, c.TenantID, c.ID, v.ID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) mutate(ctx context.Context, tenant, cid string, expected int64, fn func(*sql.Tx, *campaign.Campaign) error) (campaign.Campaign, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return campaign.Campaign{}, err
	}
	defer tx.Rollback()
	// Serialize the active check with tenant shutdown before locking campaign
	// state. Otherwise PostgreSQL could commit a new intent after draining.
	tenantLock, err := tx.ExecContext(ctx, s.rebind(`UPDATE tenants SET id=id WHERE id=?`), tenant)
	if err != nil {
		return campaign.Campaign{}, err
	}
	tenantRows, err := tenantLock.RowsAffected()
	if err != nil {
		return campaign.Campaign{}, err
	}
	if tenantRows != 1 {
		return campaign.Campaign{}, ErrNotFound
	}
	result, err := tx.ExecContext(ctx, s.rebind(`UPDATE project_campaigns SET revision=revision WHERE tenant_id=? AND id=?`), tenant, cid)
	if err != nil {
		return campaign.Campaign{}, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return campaign.Campaign{}, err
	}
	if n != 1 {
		return campaign.Campaign{}, ErrNotFound
	}
	c, err := s.get(ctx, tx, tenant, cid)
	if err != nil {
		return c, err
	}
	if expected > 0 && c.Revision != expected {
		return c, ErrConflict
	}
	if err = s.fence.RequireTenantActive(ctx, tx, tenant); err != nil {
		return c, err
	}
	if err = fn(tx, &c); err != nil {
		return c, err
	}
	if err = s.save(ctx, tx, &c); err != nil {
		return c, err
	}
	return c, tx.Commit()
}

func (s *Store) audit(ctx context.Context, tx *sql.Tx, c campaign.Campaign, author, action, variant, comment string, details any) error {
	aid, err := id()
	if err != nil {
		return err
	}
	raw, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO project_campaign_audit(id,tenant_id,campaign_id,author_id,action,variant_id,comment,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`), aid, c.TenantID, c.ID, author, action, variant, comment, string(raw), stamp(s.now()))
	return err
}

func variant(c *campaign.Campaign, vid string) (*campaign.Variant, error) {
	for i := range c.Definition.Variants {
		if c.Definition.Variants[i].ID == vid {
			return &c.Definition.Variants[i], nil
		}
	}
	return nil, ErrNotFound
}

func (s *Store) List(ctx context.Context, tenant, source string, limit int) ([]campaign.Campaign, error) {
	if limit < 1 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	query := `SELECT campaign_json FROM project_campaigns WHERE tenant_id=?`
	args := []any{tenant}
	if source != "" {
		query += ` AND source_project_id=?`
		args = append(args, source)
	}
	query += ` ORDER BY created_at DESC,id LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.rebind(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []campaign.Campaign{}
	for rows.Next() {
		var raw string
		var c campaign.Campaign
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &c); err != nil {
			return nil, err
		}
		items = append(items, c)
	}
	return items, rows.Err()
}

func (s *Store) Managed(ctx context.Context, tenant, pid string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM project_campaign_variants WHERE tenant_id=? AND project_id=?`), tenant, pid).Scan(&n)
	return n != 0, err
}

func (s *Store) Audit(ctx context.Context, tenant, cid string, limit int) ([]Audit, error) {
	if _, err := s.Get(ctx, tenant, cid); err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, s.rebind(`SELECT id,author_id,action,variant_id,comment,details_json,created_at FROM project_campaign_audit WHERE tenant_id=? AND campaign_id=? ORDER BY created_at DESC,id LIMIT ?`), tenant, cid, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Audit{}
	for rows.Next() {
		var a Audit
		var created, raw string
		if err = rows.Scan(&a.ID, &a.AuthorID, &a.Action, &a.VariantID, &a.Comment, &raw, &created); err != nil {
			return nil, err
		}
		a.Details = json.RawMessage(raw)
		if a.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, rows.Err()
}
