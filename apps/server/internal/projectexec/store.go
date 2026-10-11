package projectexec

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
)

// Store uses transactions and portable SQL rather than ORM hooks. Every
// mutation locks the tenant row before the project row, so shared resource
// admissions, events, budgets and lease changes
// commit together even when multiple schedulers use the same database.
type Store struct {
	db      *sql.DB
	dialect string
	rebind  func(string) string
	now     func() time.Time
}

func NewStore(db *sql.DB, dialect string, rebind func(string) string) *Store {
	if rebind == nil {
		rebind = func(s string) string { return s }
	}
	return &Store{db: db, dialect: dialect, rebind: rebind, now: func() time.Time { return time.Now().UTC() }}
}

type sqlReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func encode(v any) (string, error) { b, e := json.Marshal(v); return string(b), e }
func stamp(t time.Time) string     { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }
func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
func (s *Store) tx(ctx context.Context, tenant, pid string, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// The tenant lock precedes every project lock. Tenant shutdown uses the
	// same order; shared dispatch counters cannot race across projects.
	if err = s.lockTenant(ctx, tx, tenant); err != nil {
		return err
	}
	// UPDATE is a portable row lock: PostgreSQL locks this project, while SQLite
	// acquires its writer lock before any read-modify-write decisions.
	result, err := tx.ExecContext(ctx, s.rebind(`UPDATE execution_projects SET event_sequence=event_sequence WHERE tenant_id=? AND id=?`), tenant, pid)
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
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) project(ctx context.Context, q sqlReader, tenant, pid string) (mission.Project, error) {
	var raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT project_json FROM execution_projects WHERE tenant_id=? AND id=?`), tenant, pid).Scan(&raw)
	if err != nil {
		return mission.Project{}, notFound(err)
	}
	var p mission.Project
	err = json.Unmarshal([]byte(raw), &p)
	return p, err
}
func (s *Store) run(ctx context.Context, q sqlReader, tenant, pid, rid string) (mission.Run, error) {
	var raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT run_json FROM execution_runs WHERE tenant_id=? AND project_id=? AND id=?`), tenant, pid, rid).Scan(&raw)
	if err != nil {
		return mission.Run{}, notFound(err)
	}
	var r mission.Run
	err = json.Unmarshal([]byte(raw), &r)
	return r, err
}
func (s *Store) frozenProject(ctx context.Context, q sqlReader, tenant, pid, rid string) (mission.Project, error) {
	var raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT project_json FROM execution_runs WHERE tenant_id=? AND project_id=? AND id=?`), tenant, pid, rid).Scan(&raw)
	if err != nil {
		return mission.Project{}, notFound(err)
	}
	var p mission.Project
	err = json.Unmarshal([]byte(raw), &p)
	return p, err
}
func (s *Store) task(ctx context.Context, q sqlReader, scope mission.Scope, rid, tid string) (mission.Task, error) {
	var raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT t.task_json FROM execution_tasks t JOIN execution_projects p ON p.id=t.project_id AND p.tenant_id=t.tenant_id WHERE t.tenant_id=? AND t.project_id=? AND p.space_id=? AND t.run_id=? AND t.id=?`), scope.TenantID, scope.ProjectID, scope.SpaceID, rid, tid).Scan(&raw)
	if err != nil {
		return mission.Task{}, notFound(err)
	}
	var t mission.Task
	err = json.Unmarshal([]byte(raw), &t)
	return t, err
}
func (s *Store) putRun(ctx context.Context, tx *sql.Tx, tenant string, r mission.Run) error {
	raw, err := encode(r)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`UPDATE execution_runs SET status=?,revision=?,run_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND id=?`), r.Status, r.Revision, raw, stamp(r.UpdatedAt), tenant, r.ProjectID, r.ID)
	return err
}
func (s *Store) putTask(ctx context.Context, tx *sql.Tx, scope mission.Scope, t mission.Task) error {
	raw, err := encode(t)
	if err != nil {
		return err
	}
	var until any
	if t.LeaseUntil != nil {
		until = stamp(*t.LeaseUntil)
	}
	_, err = tx.ExecContext(ctx, s.rebind(`UPDATE execution_tasks SET status=?,revision=?,lease_owner=?,lease_until=?,fence=?,task_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), t.Status, t.Revision, t.LeaseOwner, until, t.Fence, raw, stamp(t.UpdatedAt), scope.TenantID, scope.ProjectID, t.RunID, t.ID)
	return err
}
func (s *Store) event(ctx context.Context, tx *sql.Tx, scope mission.Scope, rid, tid, kind string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	id, err := newID()
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, s.rebind(`UPDATE execution_projects SET event_sequence=event_sequence+1 WHERE tenant_id=? AND id=?`), scope.TenantID, scope.ProjectID); err != nil {
		return err
	}
	var sequence int64
	if err = tx.QueryRowContext(ctx, s.rebind(`SELECT event_sequence FROM execution_projects WHERE tenant_id=? AND id=?`), scope.TenantID, scope.ProjectID).Scan(&sequence); err != nil {
		return err
	}
	e := mission.Event{ID: id, ProjectID: scope.ProjectID, RunID: rid, TaskID: tid, Sequence: sequence, Kind: kind, Payload: raw, CreatedAt: s.now()}
	body, err := encode(e)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_events(id,tenant_id,project_id,run_id,task_id,sequence,event_json,created_at) VALUES(?,?,?,?,?,?,?,?)`), id, scope.TenantID, scope.ProjectID, rid, tid, sequence, body, stamp(e.CreatedAt))
	return err
}
func scopeOf(p mission.Project) mission.Scope {
	return mission.Scope{TenantID: p.TenantID, SpaceID: p.SpaceID, ProjectID: p.ID}
}
func validateProject(p mission.Project) error {
	if p.TenantID == "" || p.SpaceID == "" || strings.TrimSpace(p.Name) == "" || strings.TrimSpace(p.Goal) == "" {
		return fmt.Errorf("%w: project identity, name and goal are required", ErrInvalidState)
	}
	if e := p.Config.Scheduling.Validate(); e != nil {
		return errors.Join(ErrInvalidState, e)
	}
	if e := plan.ValidatePlan(p.Plan, p.Config); e != nil {
		return errors.Join(ErrInvalidState, e)
	}
	return nil
}
func executionTaskID(runID, specID string) string {
	h := sha256.Sum256([]byte(runID + "\x00" + specID))
	return hex.EncodeToString(h[:])
}

func (s *Store) CreateProject(ctx context.Context, p mission.Project) (mission.Project, error) {
	if p.Plan.Version <= 0 {
		p.Plan.Version = 1
	}
	if err := validateProject(p); err != nil {
		return mission.Project{}, err
	}
	if p.ID == "" {
		id, e := newID()
		if e != nil {
			return mission.Project{}, e
		}
		p.ID = id
	}
	p.Revision = 1
	p.Status = "draft"
	p.CreatedAt = s.now()
	p.UpdatedAt = p.CreatedAt
	if p.Plan.Version <= 0 {
		p.Plan.Version = 1
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return mission.Project{}, err
	}
	defer tx.Rollback()
	result, e := tx.ExecContext(ctx, s.rebind(`UPDATE tenants SET id=id WHERE id=?`), p.TenantID)
	if e != nil {
		return mission.Project{}, e
	}
	affected, e := result.RowsAffected()
	if e != nil {
		return mission.Project{}, e
	}
	if affected != 1 {
		return mission.Project{}, ErrNotFound
	}
	if e = s.RequireTenantActive(ctx, tx, p.TenantID); e != nil {
		return mission.Project{}, e
	}
	var n int
	if err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM spaces WHERE tenant_id=? AND id=?`), p.TenantID, p.SpaceID).Scan(&n); err != nil {
		return mission.Project{}, err
	}
	if n != 1 {
		return mission.Project{}, ErrNotFound
	}
	raw, err := encode(p)
	if err != nil {
		return mission.Project{}, err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_projects(id,tenant_id,space_id,revision,project_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`), p.ID, p.TenantID, p.SpaceID, p.Revision, raw, stamp(p.CreatedAt), stamp(p.UpdatedAt))
	if err != nil {
		return mission.Project{}, err
	}
	if err = s.event(ctx, tx, scopeOf(p), "", "", "project.created", map[string]any{"revision": p.Revision}); err != nil {
		return mission.Project{}, err
	}
	if err = tx.Commit(); err != nil {
		return mission.Project{}, err
	}
	return p, nil
}
func (s *Store) GetProject(ctx context.Context, tenant, pid string) (mission.Project, error) {
	return s.project(ctx, s.db, tenant, pid)
}
func (s *Store) UpdateProject(ctx context.Context, tenant, pid string, expectedRevision int64, p mission.Project) (mission.Project, error) {
	var out mission.Project
	err := s.tx(ctx, tenant, pid, func(tx *sql.Tx) error {
		if e := s.RequireTenantActive(ctx, tx, tenant); e != nil {
			return e
		}
		old, e := s.project(ctx, tx, tenant, pid)
		if e != nil {
			return e
		}
		if old.Revision != expectedRevision {
			return ErrConflict
		}
		p.ID = old.ID
		p.TenantID = old.TenantID
		p.SpaceID = old.SpaceID
		p.CreatedAt = old.CreatedAt
		p.CreatedBy = old.CreatedBy
		p.Status = old.Status
		p.Revision = old.Revision + 1
		p.Plan.Version = old.Plan.Version + 1
		p.UpdatedAt = s.now()
		if e = validateProject(p); e != nil {
			return e
		}
		raw, e := encode(p)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, s.rebind(`UPDATE execution_projects SET revision=?,project_json=?,updated_at=? WHERE tenant_id=? AND id=?`), p.Revision, raw, stamp(p.UpdatedAt), tenant, pid); e != nil {
			return e
		}
		out = p
		return s.event(ctx, tx, scopeOf(p), "", "", "project.updated", map[string]any{"revision": p.Revision, "planVersion": p.Plan.Version})
	})
	return out, err
}
func (s *Store) DeleteProject(ctx context.Context, tenant, pid string, revision int64, beforeDelete ...func(*sql.Tx) error) error {
	return s.tx(ctx, tenant, pid, func(tx *sql.Tx) error {
		p, e := s.project(ctx, tx, tenant, pid)
		if e != nil {
			return e
		}
		if p.Revision != revision {
			return ErrConflict
		}
		var n int
		if e = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_runs WHERE tenant_id=? AND project_id=? AND status NOT IN ('completed','failed','cancelled')`), tenant, pid).Scan(&n); e != nil {
			return e
		}
		if n != 0 {
			return ErrInvalidState
		}
		if e = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_operations WHERE tenant_id=? AND project_id=? AND status IN ('running','unknown','pending_approval')`), tenant, pid).Scan(&n); e != nil {
			return e
		}
		if n > 0 {
			return ErrInvalidState
		}
		for _, hook := range beforeDelete {
			if hook != nil {
				if e = hook(tx); e != nil {
					return e
				}
			}
		}
		_, e = tx.ExecContext(ctx, s.rebind(`DELETE FROM execution_projects WHERE tenant_id=? AND id=?`), tenant, pid)
		return e
	})
}
func (s *Store) CreateRun(ctx context.Context, tenant, pid, baseSnapshot string, expectedProjectRevision ...int64) (mission.Run, error) {
	var run mission.Run
	err := s.tx(ctx, tenant, pid, func(tx *sql.Tx) error {
		p, e := s.project(ctx, tx, tenant, pid)
		if e != nil {
			return e
		}
		if len(expectedProjectRevision) > 0 && p.Revision != expectedProjectRevision[0] {
			return ErrConflict
		}
		run, e = s.createRunTx(ctx, tx, p, baseSnapshot)
		return e
	})
	return run, err
}

// CreateRunOnce accepts a caller-reserved identity after the caller has durably
// recorded its intent. A lost response can be recovered from the same run; it
// can never create a second run or bind this identity to a different definition.
func (s *Store) CreateRunOnce(ctx context.Context, tenant, pid, baseSnapshot string, expectedProjectRevision int64, runID string) (mission.Run, error) {
	if len(runID) != 32 || expectedProjectRevision < 1 {
		return mission.Run{}, ErrInvalidState
	}
	if _, err := hex.DecodeString(runID); err != nil || strings.ToLower(runID) != runID {
		return mission.Run{}, ErrInvalidState
	}
	var result mission.Run
	err := s.tx(ctx, tenant, pid, func(tx *sql.Tx) error {
		if err := s.RequireTenantActive(ctx, tx, tenant); err != nil {
			return err
		}
		// A campaign control and its child start serialize on the campaign row.
		// Controls never acquire a project lock while holding this row lock.
		if _, err := tx.ExecContext(ctx, s.rebind(`UPDATE project_campaigns SET revision=revision WHERE tenant_id=? AND id IN (SELECT campaign_id FROM project_campaign_variants WHERE tenant_id=? AND project_id=?)`), tenant, tenant, pid); err != nil {
			return err
		}
		existing, err := s.run(ctx, tx, tenant, pid, runID)
		if err == nil {
			frozen, e := s.frozenProject(ctx, tx, tenant, pid, runID)
			if e != nil {
				return e
			}
			if existing.BaseSnapshot != baseSnapshot || frozen.Revision != expectedProjectRevision || frozen.ID != pid || frozen.TenantID != tenant {
				return ErrConflict
			}
			result = existing
			return nil
		}
		if !errors.Is(err, ErrNotFound) {
			return err
		}
		// A globally reserved identity cannot be borrowed by a different project.
		var count int
		if err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_runs WHERE id=?`), runID).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return ErrConflict
		}
		var reservationState, reservedID, campaignRaw string
		err = tx.QueryRowContext(ctx, s.rebind(`SELECT v.state,COALESCE(v.run_id,''),c.campaign_json FROM project_campaign_variants v JOIN project_campaigns c ON c.tenant_id=v.tenant_id AND c.id=v.campaign_id WHERE v.tenant_id=? AND v.project_id=?`), tenant, pid).Scan(&reservationState, &reservedID, &campaignRaw)
		if err == nil {
			var grant struct {
				Status       string `json:"status"`
				BaseSnapshot string `json:"baseSnapshot"`
			}
			if err = json.Unmarshal([]byte(campaignRaw), &grant); err != nil {
				return err
			}
			if reservedID != runID || reservationState != "starting" && reservationState != "start_unknown" || grant.Status != "active" || grant.BaseSnapshot != baseSnapshot {
				return ErrConflict
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		p, err := s.project(ctx, tx, tenant, pid)
		if err != nil {
			return err
		}
		if p.Revision != expectedProjectRevision {
			return ErrConflict
		}
		result, err = s.createRunTx(ctx, tx, p, baseSnapshot, runID)
		return err
	})
	return result, err
}

func (s *Store) createRunTx(ctx context.Context, tx *sql.Tx, p mission.Project, baseSnapshot string, reservedRunID ...string) (mission.Run, error) {
	var run mission.Run
	tenant, pid := p.TenantID, p.ID
	var e error
	if e = s.RequireTenantActive(ctx, tx, tenant); e != nil {
		return run, e
	}
	if e = validateProject(p); e != nil {
		return run, e
	}
	if baseSnapshot == "" {
		return run, fmt.Errorf("%w: base snapshot required", ErrInvalidState)
	}
	id := ""
	if len(reservedRunID) > 0 {
		id = reservedRunID[0]
	} else {
		id, e = newID()
		if e != nil {
			return run, e
		}
	}
	now := s.now()
	run = mission.Run{ID: id, ProjectID: pid, Status: "pending", Revision: 1, PlanVersion: p.Plan.Version, BaseSnapshot: baseSnapshot, CreatedAt: now, UpdatedAt: now}
	raw, e := encode(run)
	if e != nil {
		return run, e
	}
	frozen, e := encode(p)
	if e != nil {
		return run, e
	}
	if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_runs(id,tenant_id,project_id,status,revision,run_json,project_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`), id, tenant, pid, run.Status, run.Revision, raw, frozen, stamp(now), stamp(now)); e != nil {
		return run, e
	}
	for _, spec := range p.Plan.Tasks {
		taskID := executionTaskID(id, spec.ID)
		t := mission.Task{ID: taskID, SessionID: taskID, RunID: id, Spec: spec, Status: "pending", Revision: 1, CreatedAt: now, UpdatedAt: now}
		raw, e = encode(t)
		if e != nil {
			return run, e
		}
		if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_tasks(id,tenant_id,project_id,run_id,status,priority,revision,task_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`), t.ID, tenant, pid, id, t.Status, spec.Priority, t.Revision, raw, stamp(now), stamp(now)); e != nil {
			return run, e
		}
	}
	for _, spec := range p.Plan.Tasks {
		for _, dep := range spec.DependsOn {
			if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_task_dependencies(tenant_id,project_id,run_id,task_id,dependency_id) VALUES(?,?,?,?,?)`), tenant, pid, id, executionTaskID(id, spec.ID), executionTaskID(id, dep)); e != nil {
				return run, e
			}
		}
	}
	return run, s.event(ctx, tx, scopeOf(p), run.ID, "", "run.created", map[string]any{"planVersion": p.Plan.Version, "baseSnapshot": baseSnapshot})
}

func (s *Store) GetRun(ctx context.Context, tenant, pid, rid string) (mission.Run, error) {
	return s.run(ctx, s.db, tenant, pid, rid)
}
func (s *Store) GetRunProject(ctx context.Context, tenant, pid, rid string) (mission.Project, error) {
	return s.frozenProject(ctx, s.db, tenant, pid, rid)
}
func (s *Store) GetTask(ctx context.Context, tenant, pid, rid, tid string) (mission.Task, error) {
	p, e := s.GetProject(ctx, tenant, pid)
	if e != nil {
		return mission.Task{}, e
	}
	return s.task(ctx, s.db, scopeOf(p), rid, tid)
}
func boundedLimit(n int) int {
	if n <= 0 {
		return 100
	}
	if n > 1000 {
		return 1000
	}
	return n
}
func decodeRows[T any](rows *sql.Rows) ([]T, error) {
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var v T
		if err := json.Unmarshal([]byte(raw), &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) ListProjects(ctx context.Context, tenant, space string, limit int) ([]mission.Project, error) {
	rows, e := s.db.QueryContext(ctx, s.rebind(`SELECT project_json FROM execution_projects WHERE tenant_id=? AND space_id=? ORDER BY updated_at DESC,id LIMIT ?`), tenant, space, boundedLimit(limit))
	if e != nil {
		return nil, e
	}
	return decodeRows[mission.Project](rows)
}
func (s *Store) ListRuns(ctx context.Context, tenant, pid string, limit int) ([]mission.Run, error) {
	if _, e := s.GetProject(ctx, tenant, pid); e != nil {
		return nil, e
	}
	rows, e := s.db.QueryContext(ctx, s.rebind(`SELECT run_json FROM execution_runs WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC,id LIMIT ?`), tenant, pid, boundedLimit(limit))
	if e != nil {
		return nil, e
	}
	return decodeRows[mission.Run](rows)
}
func (s *Store) listTasks(ctx context.Context, q sqlReader, tenant, pid, rid string) ([]mission.Task, error) {
	rows, e := q.QueryContext(ctx, s.rebind(`SELECT task_json FROM execution_tasks WHERE tenant_id=? AND project_id=? AND run_id=? ORDER BY priority DESC,created_at,id`), tenant, pid, rid)
	if e != nil {
		return nil, e
	}
	return decodeRows[mission.Task](rows)
}
func (s *Store) ListTasks(ctx context.Context, tenant, pid, rid string) ([]mission.Task, error) {
	if _, e := s.GetRun(ctx, tenant, pid, rid); e != nil {
		return nil, e
	}
	return s.listTasks(ctx, s.db, tenant, pid, rid)
}
func (s *Store) ListEvents(ctx context.Context, tenant, pid, rid string, after int64, limit int) ([]mission.Event, error) {
	if _, e := s.GetProject(ctx, tenant, pid); e != nil {
		return nil, e
	}
	query := `SELECT event_json FROM execution_events WHERE tenant_id=? AND project_id=? AND sequence>?`
	args := []any{tenant, pid, after}
	if rid != "" {
		if _, e := s.GetRun(ctx, tenant, pid, rid); e != nil {
			return nil, e
		}
		query += ` AND run_id=?`
		args = append(args, rid)
	}
	query += ` ORDER BY sequence LIMIT ?`
	args = append(args, boundedLimit(limit))
	rows, e := s.db.QueryContext(ctx, s.rebind(query), args...)
	if e != nil {
		return nil, e
	}
	return decodeRows[mission.Event](rows)
}
func (s *Store) ListOperations(ctx context.Context, tenant, pid, rid string, taskIDs ...string) ([]mission.Operation, error) {
	tid := ""
	if len(taskIDs) > 0 {
		tid = taskIDs[0]
	}
	if _, e := s.GetRun(ctx, tenant, pid, rid); e != nil {
		return nil, e
	}
	query := `SELECT operation_json FROM execution_operations WHERE tenant_id=? AND project_id=? AND run_id=?`
	args := []any{tenant, pid, rid}
	if tid != "" {
		query += ` AND task_id=?`
		args = append(args, tid)
	}
	query += ` ORDER BY created_at,id`
	rows, e := s.db.QueryContext(ctx, s.rebind(query), args...)
	if e != nil {
		return nil, e
	}
	return decodeRows[mission.Operation](rows)
}
func (s *Store) ListVerifications(ctx context.Context, tenant, pid, rid string, taskIDs ...string) ([]mission.Verification, error) {
	tid := ""
	if len(taskIDs) > 0 {
		tid = taskIDs[0]
	}
	if _, e := s.GetRun(ctx, tenant, pid, rid); e != nil {
		return nil, e
	}
	query := `SELECT verification_json FROM execution_verifications WHERE tenant_id=? AND project_id=? AND run_id=?`
	args := []any{tenant, pid, rid}
	if tid != "" {
		query += ` AND task_id=?`
		args = append(args, tid)
	}
	query += ` ORDER BY created_at,id`
	rows, e := s.db.QueryContext(ctx, s.rebind(query), args...)
	if e != nil {
		return nil, e
	}
	return decodeRows[mission.Verification](rows)
}
func (s *Store) ListReviews(ctx context.Context, tenant, pid, rid string, taskIDs ...string) ([]mission.Review, error) {
	tid := ""
	if len(taskIDs) > 0 {
		tid = taskIDs[0]
	}
	if _, e := s.GetRun(ctx, tenant, pid, rid); e != nil {
		return nil, e
	}
	query := `SELECT review_json FROM execution_reviews WHERE tenant_id=? AND project_id=? AND run_id=?`
	args := []any{tenant, pid, rid}
	if tid != "" {
		query += ` AND task_id=?`
		args = append(args, tid)
	}
	query += ` ORDER BY created_at,id`
	rows, e := s.db.QueryContext(ctx, s.rebind(query), args...)
	if e != nil {
		return nil, e
	}
	return decodeRows[mission.Review](rows)
}
