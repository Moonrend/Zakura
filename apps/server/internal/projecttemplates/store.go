// SPDX-License-Identifier: AGPL-3.0-or-later
package projecttemplates

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
)

var ErrNotFound = errors.New("project template not found")
var ErrConflict = errors.New("project template revision conflict")

type Template struct {
	ID             string               `json:"id"`
	TenantID       string               `json:"tenantId"`
	Revision       int64                `json:"revision"`
	CurrentVersion int                  `json:"currentVersion"`
	Definition     blueprint.Definition `json:"definition"`
	CreatedBy      string               `json:"createdBy"`
	CreatedAt      time.Time            `json:"createdAt"`
	UpdatedAt      time.Time            `json:"updatedAt"`
}

type TemplateVersion struct {
	TemplateID string               `json:"templateId"`
	Version    int                  `json:"version"`
	Definition blueprint.Definition `json:"definition"`
	CreatedBy  string               `json:"createdBy"`
	CreatedAt  time.Time            `json:"createdAt"`
}

type Store struct {
	db     *sql.DB
	rebind func(string) string
	fence  *projectexec.Store
	now    func() time.Time
}

func NewStore(db *sql.DB, dialect string, rebind func(string) string) *Store {
	if rebind == nil {
		rebind = func(value string) string { return value }
	}
	return &Store{db: db, rebind: rebind, fence: projectexec.NewStore(db, dialect, rebind), now: func() time.Time { return time.Now().UTC() }}
}

type reader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func found(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
func timestamp(value time.Time) string { return value.UTC().Format("2006-01-02T15:04:05.000000000Z") }

// All writes acquire the same tenant row lock as project creation. This keeps
// template edits on the same side of the durable tenant-deletion fence.
func (s *Store) mutate(ctx context.Context, tenant string, fn func(*sql.Tx) error) error {
	if strings.TrimSpace(tenant) == "" {
		return ErrNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, s.rebind(`UPDATE tenants SET id=id WHERE id=?`), tenant)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrNotFound
	}
	if err = s.fence.RequireTenantActive(ctx, tx, tenant); err != nil {
		return err
	}
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) template(ctx context.Context, q reader, tenant, id string) (Template, error) {
	var t Template
	var created, updated, raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT t.id,t.tenant_id,t.revision,t.current_version,t.created_by,t.created_at,t.updated_at,v.definition_json FROM project_templates t JOIN project_template_versions v ON v.tenant_id=t.tenant_id AND v.template_id=t.id AND v.version=t.current_version WHERE t.tenant_id=? AND t.id=? AND t.status='active'`), tenant, id).Scan(&t.ID, &t.TenantID, &t.Revision, &t.CurrentVersion, &t.CreatedBy, &created, &updated, &raw)
	if err != nil {
		return Template{}, found(err)
	}
	if err = json.Unmarshal([]byte(raw), &t.Definition); err != nil {
		return Template{}, fmt.Errorf("invalid stored blueprint: %w", err)
	}
	if t.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
		return Template{}, err
	}
	if t.UpdatedAt, err = time.Parse(time.RFC3339Nano, updated); err != nil {
		return Template{}, err
	}
	return t, nil
}

func (s *Store) Get(ctx context.Context, tenant, id string) (Template, error) {
	return s.template(ctx, s.db, tenant, id)
}

func (s *Store) Create(ctx context.Context, tenant, author string, definition blueprint.Definition) (Template, error) {
	if err := blueprint.Validate(definition); err != nil {
		return Template{}, err
	}
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return Template{}, err
	}
	t := Template{ID: hex.EncodeToString(bytes[:]), TenantID: tenant, Revision: 1, CurrentVersion: 1, Definition: definition, CreatedBy: author, CreatedAt: s.now()}
	t.UpdatedAt = t.CreatedAt
	raw, err := json.Marshal(definition)
	if err != nil {
		return Template{}, err
	}
	err = s.mutate(ctx, tenant, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.rebind(`INSERT INTO project_templates(id,tenant_id,revision,current_version,status,created_by,created_at,updated_at) VALUES(?,?,1,1,'active',?,?,?)`), t.ID, tenant, author, timestamp(t.CreatedAt), timestamp(t.UpdatedAt)); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, s.rebind(`INSERT INTO project_template_versions(tenant_id,template_id,version,definition_json,created_by,created_at) VALUES(?,?,1,?,?,?)`), tenant, t.ID, string(raw), author, timestamp(t.CreatedAt))
		return err
	})
	if err != nil {
		return Template{}, err
	}
	return t, nil
}

func (s *Store) Update(ctx context.Context, tenant, id, author string, expected int64, definition blueprint.Definition) (Template, error) {
	if expected < 1 {
		return Template{}, ErrConflict
	}
	if err := blueprint.Validate(definition); err != nil {
		return Template{}, err
	}
	raw, err := json.Marshal(definition)
	if err != nil {
		return Template{}, err
	}
	var t Template
	err = s.mutate(ctx, tenant, func(tx *sql.Tx) error {
		var err error
		t, err = s.template(ctx, tx, tenant, id)
		if err != nil {
			return err
		}
		if t.Revision != expected {
			return ErrConflict
		}
		if t.CurrentVersion >= 10000 {
			return fmt.Errorf("template has reached its 10000-version limit")
		}
		t.Revision++
		t.CurrentVersion++
		t.UpdatedAt = s.now()
		t.Definition = definition
		_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO project_template_versions(tenant_id,template_id,version,definition_json,created_by,created_at) VALUES(?,?,?,?,?,?)`), tenant, id, t.CurrentVersion, string(raw), author, timestamp(t.UpdatedAt))
		if err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, s.rebind(`UPDATE project_templates SET revision=?,current_version=?,updated_at=? WHERE tenant_id=? AND id=? AND revision=? AND status='active'`), t.Revision, t.CurrentVersion, timestamp(t.UpdatedAt), tenant, id, expected)
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
	})
	if err != nil {
		return Template{}, err
	}
	return t, nil
}

// Deletion archives the definition and immutable versions. Existing project
// plans contain their own frozen expansion and are never changed by deletion.
func (s *Store) Delete(ctx context.Context, tenant, id string, expected int64) error {
	if expected < 1 {
		return ErrConflict
	}
	return s.mutate(ctx, tenant, func(tx *sql.Tx) error {
		t, err := s.template(ctx, tx, tenant, id)
		if err != nil {
			return err
		}
		if t.Revision != expected {
			return ErrConflict
		}
		result, err := tx.ExecContext(ctx, s.rebind(`UPDATE project_templates SET status='deleted',revision=revision+1,updated_at=? WHERE tenant_id=? AND id=? AND revision=? AND status='active'`), timestamp(s.now()), tenant, id, expected)
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
	})
}

func (s *Store) List(ctx context.Context, tenant string, limit int) ([]Template, error) {
	if limit < 1 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, s.rebind(`SELECT id FROM project_templates WHERE tenant_id=? AND status='active' ORDER BY updated_at DESC,id LIMIT ?`), tenant, limit)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	items := []Template{}
	for _, id := range ids {
		item, err := s.Get(ctx, tenant, id)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Store) version(ctx context.Context, q reader, tenant, id string, version int) (TemplateVersion, error) {
	var result TemplateVersion
	var raw, created string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT v.template_id,v.version,v.definition_json,v.created_by,v.created_at FROM project_template_versions v JOIN project_templates t ON t.tenant_id=v.tenant_id AND t.id=v.template_id WHERE v.tenant_id=? AND v.template_id=? AND v.version=? AND t.status='active'`), tenant, id, version).Scan(&result.TemplateID, &result.Version, &raw, &result.CreatedBy, &created)
	if err != nil {
		return result, found(err)
	}
	if err = json.Unmarshal([]byte(raw), &result.Definition); err != nil {
		return result, err
	}
	result.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	return result, err
}

func (s *Store) Version(ctx context.Context, tenant, id string, version int) (TemplateVersion, error) {
	return s.version(ctx, s.db, tenant, id, version)
}

// Select pins a revision and version in one SQL read. The selected immutable
// definition remains valid if someone subsequently edits the template.
func (s *Store) Select(ctx context.Context, tenant, id string, expected int64, version int) (TemplateVersion, error) {
	if expected < 1 {
		return TemplateVersion{}, ErrConflict
	}
	if version < 0 {
		return TemplateVersion{}, ErrNotFound
	}
	var result TemplateVersion
	var revision int64
	var raw, created string
	err := s.db.QueryRowContext(ctx, s.rebind(`SELECT t.revision,v.template_id,v.version,v.definition_json,v.created_by,v.created_at FROM project_templates t JOIN project_template_versions v ON v.tenant_id=t.tenant_id AND v.template_id=t.id AND v.version=CASE WHEN ?=0 THEN t.current_version ELSE ? END WHERE t.tenant_id=? AND t.id=? AND t.status='active'`), version, version, tenant, id).Scan(&revision, &result.TemplateID, &result.Version, &raw, &result.CreatedBy, &created)
	if err != nil {
		return result, found(err)
	}
	if revision != expected {
		return TemplateVersion{}, ErrConflict
	}
	if err = json.Unmarshal([]byte(raw), &result.Definition); err != nil {
		return TemplateVersion{}, err
	}
	result.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	return result, err
}

func (s *Store) Versions(ctx context.Context, tenant, id string, limit int) ([]TemplateVersion, error) {
	if _, err := s.Get(ctx, tenant, id); err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, s.rebind(`SELECT version,definition_json,created_by,created_at FROM project_template_versions WHERE tenant_id=? AND template_id=? ORDER BY version DESC LIMIT ?`), tenant, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []TemplateVersion{}
	for rows.Next() {
		item := TemplateVersion{TemplateID: id}
		var raw, created string
		if err = rows.Scan(&item.Version, &raw, &item.CreatedBy, &created); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &item.Definition); err != nil {
			return nil, err
		}
		if item.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
