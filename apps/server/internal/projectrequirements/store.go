// SPDX-License-Identifier: AGPL-3.0-or-later
package projectrequirements

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
	"unicode/utf8"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/requirements"
)

var ErrNotFound = projectexec.ErrNotFound
var ErrConflict = projectexec.ErrConflict
var ErrInvalid = projectexec.ErrInvalidState

type Store struct {
	db      *sql.DB
	dialect string
	rebind  func(string) string
	now     func() time.Time
}
type reader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func NewStore(db *sql.DB, dialect string, rebind func(string) string) *Store {
	if rebind == nil {
		rebind = func(q string) string { return q }
	}
	return &Store{db: db, dialect: dialect, rebind: rebind, now: func() time.Time { return time.Now().UTC() }}
}
func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func stamp(t time.Time) string     { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }
func encode(v any) (string, error) { raw, err := json.Marshal(v); return string(raw), err }
func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
func invalid(message string) error { return fmt.Errorf("%w: %s", ErrInvalid, message) }
func validComment(comment string) bool {
	return strings.TrimSpace(comment) != "" && len(comment) <= 4096 && utf8.ValidString(comment)
}
func (s *Store) project(ctx context.Context, q reader, scope mission.Scope) (mission.Project, error) {
	var raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT project_json FROM execution_projects WHERE tenant_id=? AND space_id=? AND id=?`), scope.TenantID, scope.SpaceID, scope.ProjectID).Scan(&raw)
	if err != nil {
		return mission.Project{}, notFound(err)
	}
	var p mission.Project
	err = json.Unmarshal([]byte(raw), &p)
	return p, err
}
func (s *Store) tx(ctx context.Context, scope mission.Scope, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, s.rebind(`UPDATE execution_projects SET event_sequence=event_sequence WHERE tenant_id=? AND space_id=? AND id=?`), scope.TenantID, scope.SpaceID, scope.ProjectID)
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
	if err = projectexec.NewStore(s.db, s.dialect, s.rebind).RequireTenantActive(ctx, tx, scope.TenantID); err != nil {
		return err
	}
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) baseline(ctx context.Context, q reader, scope mission.Scope, id string, revision int64) (requirements.Baseline, error) {
	var raw string
	var err error
	if revision > 0 {
		err = q.QueryRowContext(ctx, s.rebind(`SELECT revision_json FROM execution_requirement_revisions WHERE tenant_id=? AND project_id=? AND baseline_id=? AND revision=?`), scope.TenantID, scope.ProjectID, id, revision).Scan(&raw)
		if err != nil {
			return requirements.Baseline{}, notFound(err)
		}
		var rev requirements.Revision
		err = json.Unmarshal([]byte(raw), &rev)
		return rev.Baseline, err
	}
	err = q.QueryRowContext(ctx, s.rebind(`SELECT baseline_json FROM execution_requirement_baselines WHERE tenant_id=? AND project_id=? AND id=?`), scope.TenantID, scope.ProjectID, id).Scan(&raw)
	if err != nil {
		return requirements.Baseline{}, notFound(err)
	}
	var baseline requirements.Baseline
	err = json.Unmarshal([]byte(raw), &baseline)
	return baseline, err
}
func (s *Store) Get(ctx context.Context, scope mission.Scope, id string, revision int64) (requirements.Baseline, error) {
	if _, err := s.project(ctx, s.db, scope); err != nil {
		return requirements.Baseline{}, err
	}
	if revision < 0 {
		return requirements.Baseline{}, ErrInvalid
	}
	return s.baseline(ctx, s.db, scope, id, revision)
}
func (s *Store) Create(ctx context.Context, scope mission.Scope, draft requirements.Draft, author string) (requirements.Baseline, error) {
	var out requirements.Baseline
	normalized, err := requirements.Normalize(draft)
	if err != nil {
		return out, invalid(err.Error())
	}
	err = s.tx(ctx, scope, func(tx *sql.Tx) error {
		var count int
		if e := tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_requirement_baselines WHERE tenant_id=? AND project_id=?`), scope.TenantID, scope.ProjectID).Scan(&count); e != nil {
			return e
		}
		if count >= 500 {
			return invalid("at most 500 retained requirement baselines per project")
		}
		id, e := newID()
		if e != nil {
			return e
		}
		now := s.now()
		out = requirements.Baseline{ID: id, ProjectID: scope.ProjectID, Title: normalized.Title, Clauses: normalized.Clauses, RequiredBeforePublication: normalized.RequiredBeforePublication, Revision: 1, Status: "draft", CreatedBy: author, UpdatedBy: author, CreatedAt: now, UpdatedAt: now}
		raw, e := encode(out)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_requirement_baselines(id,tenant_id,project_id,revision,status,baseline_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`), id, scope.TenantID, scope.ProjectID, out.Revision, out.Status, raw, stamp(now), stamp(now)); e != nil {
			return e
		}
		return s.persist(ctx, tx, scope, out, "created", "", author)
	})
	return out, err
}
func (s *Store) persist(ctx context.Context, tx *sql.Tx, scope mission.Scope, baseline requirements.Baseline, action, comment, author string) error {
	raw, err := encode(baseline)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, s.rebind(`UPDATE execution_requirement_baselines SET revision=?,status=?,baseline_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND id=?`), baseline.Revision, baseline.Status, raw, stamp(baseline.UpdatedAt), scope.TenantID, scope.ProjectID, baseline.ID); err != nil {
		return err
	}
	rev := requirements.Revision{Baseline: baseline, Action: action, AuthorID: author, Comment: comment, CreatedAt: baseline.UpdatedAt}
	revRaw, err := encode(rev)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_requirement_revisions(tenant_id,project_id,baseline_id,revision,revision_json) VALUES(?,?,?,?,?)`), scope.TenantID, scope.ProjectID, baseline.ID, baseline.Revision, revRaw); err != nil {
		return err
	}
	return s.event(ctx, tx, scope, "", "requirements."+action, map[string]any{"baselineId": baseline.ID, "revision": baseline.Revision, "status": baseline.Status, "authorId": author, "comment": comment})
}
func (s *Store) Update(ctx context.Context, scope mission.Scope, id string, expected int64, draft requirements.Draft, comment, author string) (requirements.Baseline, error) {
	var out requirements.Baseline
	normalized, err := requirements.Normalize(draft)
	if err != nil {
		return out, invalid(err.Error())
	}
	if len(comment) > 4096 || !utf8.ValidString(comment) {
		return out, ErrInvalid
	}
	err = s.tx(ctx, scope, func(tx *sql.Tx) error {
		old, e := s.baseline(ctx, tx, scope, id, 0)
		if e != nil {
			return e
		}
		if old.Revision != expected {
			return ErrConflict
		}
		if old.Status == "deleted" || old.Status == "archived" {
			return invalid("retired baselines cannot be edited")
		}
		out = old
		out.Title = normalized.Title
		out.Clauses = normalized.Clauses
		out.RequiredBeforePublication = normalized.RequiredBeforePublication
		out.Status = "draft"
		out.ApprovedBy = ""
		out.ApprovedAt = nil
		out.ApprovedPlan = mission.Plan{}
		out.ApprovedPlanHash = ""
		out.Revision++
		out.UpdatedBy = author
		out.UpdatedAt = s.now()
		return s.persist(ctx, tx, scope, out, "edited", comment, author)
	})
	return out, err
}
func (s *Store) event(ctx context.Context, tx *sql.Tx, scope mission.Scope, runID, kind string, payload any) error {
	if _, err := tx.ExecContext(ctx, s.rebind(`UPDATE execution_projects SET event_sequence=event_sequence+1 WHERE tenant_id=? AND id=?`), scope.TenantID, scope.ProjectID); err != nil {
		return err
	}
	var sequence int64
	if err := tx.QueryRowContext(ctx, s.rebind(`SELECT event_sequence FROM execution_projects WHERE tenant_id=? AND id=?`), scope.TenantID, scope.ProjectID).Scan(&sequence); err != nil {
		return err
	}
	id, err := newID()
	if err != nil {
		return err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	event := mission.Event{ID: id, ProjectID: scope.ProjectID, RunID: runID, Sequence: sequence, Kind: kind, Payload: data, CreatedAt: s.now()}
	raw, err := encode(event)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_events(id,tenant_id,project_id,run_id,task_id,sequence,event_json,created_at) VALUES(?,?,?,?,'',?,?,?)`), id, scope.TenantID, scope.ProjectID, runID, sequence, raw, stamp(event.CreatedAt))
	return err
}
