// SPDX-License-Identifier: AGPL-3.0-or-later
package projectrequirements

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/requirements"
)

type ListResult struct {
	Items      []requirements.Baseline `json:"items"`
	NextCursor string                  `json:"nextCursor,omitempty"`
}

func (s *Store) List(ctx context.Context, scope mission.Scope, cursor string, limit int, retired bool) (ListResult, error) {
	result := ListResult{Items: []requirements.Baseline{}}
	if _, err := s.project(ctx, s.db, scope); err != nil {
		return result, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	query := `SELECT baseline_json FROM execution_requirement_baselines WHERE tenant_id=? AND project_id=? AND id>?`
	args := []any{scope.TenantID, scope.ProjectID, cursor}
	if !retired {
		query += ` AND status NOT IN ('deleted','archived')`
	}
	query += ` ORDER BY id LIMIT ?`
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, s.rebind(query), args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		var b requirements.Baseline
		if err = rows.Scan(&raw); err != nil {
			return result, err
		}
		if err = json.Unmarshal([]byte(raw), &b); err != nil {
			return result, err
		}
		result.Items = append(result.Items, b)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.NextCursor = result.Items[len(result.Items)-1].ID
	}
	return result, nil
}
func (s *Store) History(ctx context.Context, scope mission.Scope, id string, before int64, limit int) ([]requirements.Revision, error) {
	if _, err := s.project(ctx, s.db, scope); err != nil {
		return nil, err
	}
	if _, err := s.baseline(ctx, s.db, scope, id, 0); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	query := `SELECT revision_json FROM execution_requirement_revisions WHERE tenant_id=? AND project_id=? AND baseline_id=?`
	args := []any{scope.TenantID, scope.ProjectID, id}
	if before > 0 {
		query += ` AND revision<?`
		args = append(args, before)
	}
	query += ` ORDER BY revision DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.rebind(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []requirements.Revision{}
	for rows.Next() {
		var raw string
		var revision requirements.Revision
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &revision); err != nil {
			return nil, err
		}
		items = append(items, revision)
	}
	return items, rows.Err()
}
func (s *Store) Review(ctx context.Context, scope mission.Scope, id string, expected, expectedProjectRevision int64, decision, comment, author string, human bool) (requirements.Baseline, error) {
	var out requirements.Baseline
	if !human || author == "" {
		return out, invalid("requirements review requires an authenticated human member")
	}
	if !validComment(comment) {
		return out, invalid("review requires an explanatory comment of at most 4096 bytes")
	}
	if decision != "approved" && decision != "rejected" {
		return out, invalid("review decision must be approved or rejected")
	}
	err := s.tx(ctx, scope, func(tx *sql.Tx) error {
		baseline, e := s.baseline(ctx, tx, scope, id, 0)
		if e != nil {
			return e
		}
		if baseline.Revision != expected {
			return ErrConflict
		}
		if baseline.Status != "draft" {
			return invalid("only draft requirement baselines can be reviewed")
		}
		project, e := s.project(ctx, tx, scope)
		if e != nil {
			return e
		}
		if project.Revision != expectedProjectRevision {
			return ErrConflict
		}
		analysis := requirements.Analyze(baseline.Clauses, project.Plan)
		if decision == "approved" && !analysis.Valid {
			return invalid("required requirements have orphaned or removed task/check mappings")
		}
		if decision == "approved" && baseline.RequiredBeforePublication && analysis.Required == 0 {
			return invalid("publication gates require at least one required requirement")
		}
		baseline.Revision++
		baseline.UpdatedBy = author
		baseline.UpdatedAt = s.now()
		if decision == "approved" {
			baseline.Status = "approved"
			baseline.ApprovedBy = author
			approvedAt := baseline.UpdatedAt
			baseline.ApprovedAt = &approvedAt
			baseline.ApprovedPlan = project.Plan
			baseline.ApprovedPlanHash = analysis.PlanHash
		}
		out = baseline
		return s.persist(ctx, tx, scope, baseline, decision, comment, author)
	})
	return out, err
}
func (s *Store) Retire(ctx context.Context, scope mission.Scope, id string, expected int64, action, comment, author string) (requirements.Baseline, error) {
	var out requirements.Baseline
	if action != "archive" && action != "delete" {
		return out, ErrInvalid
	}
	if !validComment(comment) {
		return out, invalid("retirement requires an explanatory comment")
	}
	err := s.tx(ctx, scope, func(tx *sql.Tx) error {
		baseline, e := s.baseline(ctx, tx, scope, id, 0)
		if e != nil {
			return e
		}
		if baseline.Revision != expected {
			return ErrConflict
		}
		if baseline.Status == "deleted" || baseline.Status == "archived" {
			return invalid("baseline is already retired")
		}
		baseline.Status = "archived"
		if action == "delete" {
			baseline.Status = "deleted"
			baseline.Clauses = []requirements.Clause{}
		}
		baseline.Revision++
		baseline.UpdatedBy = author
		baseline.UpdatedAt = s.now()
		out = baseline
		return s.persist(ctx, tx, scope, baseline, action, comment, author)
	})
	return out, err
}
func (s *Store) run(ctx context.Context, q reader, scope mission.Scope, id string) (mission.Run, mission.Project, error) {
	var runRaw, projectRaw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT run_json,project_json FROM execution_runs WHERE tenant_id=? AND project_id=? AND id=?`), scope.TenantID, scope.ProjectID, id).Scan(&runRaw, &projectRaw)
	if err != nil {
		return mission.Run{}, mission.Project{}, notFound(err)
	}
	var run mission.Run
	var project mission.Project
	if err = json.Unmarshal([]byte(runRaw), &run); err != nil {
		return run, project, err
	}
	err = json.Unmarshal([]byte(projectRaw), &project)
	return run, project, err
}
func (s *Store) binding(ctx context.Context, q reader, scope mission.Scope, runID string) (requirements.RunBinding, bool, error) {
	var raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT binding_json FROM execution_requirement_bindings WHERE tenant_id=? AND project_id=? AND run_id=?`), scope.TenantID, scope.ProjectID, runID).Scan(&raw)
	if err == sql.ErrNoRows {
		return requirements.RunBinding{}, false, nil
	}
	if err != nil {
		return requirements.RunBinding{}, false, err
	}
	var binding requirements.RunBinding
	err = json.Unmarshal([]byte(raw), &binding)
	return binding, true, err
}
func (s *Store) Bind(ctx context.Context, scope mission.Scope, id, runID string, expected int64, author string) (requirements.RunBinding, error) {
	var out requirements.RunBinding
	err := s.tx(ctx, scope, func(tx *sql.Tx) error {
		baseline, e := s.baseline(ctx, tx, scope, id, 0)
		if e != nil {
			return e
		}
		if baseline.Revision != expected {
			return ErrConflict
		}
		if baseline.Status != "approved" || baseline.ApprovedBy == "" || baseline.ApprovedAt == nil {
			return invalid("only a current human-approved baseline can be bound")
		}
		_, frozen, e := s.run(ctx, tx, scope, runID)
		if e != nil {
			return e
		}
		planHash := requirements.PlanHash(frozen.Plan)
		if planHash != baseline.ApprovedPlanHash {
			return invalid("run frozen plan differs from the approved requirements plan")
		}
		existing, found, e := s.binding(ctx, tx, scope, runID)
		if e != nil {
			return e
		}
		if found {
			if existing.BaselineID == id && existing.BaselineRevision == expected {
				out = existing
				return nil
			}
			return invalid("run requirements are already frozen and cannot be replaced")
		}
		if e = s.requireUnpublishedRun(ctx, tx, scope, runID); e != nil {
			return e
		}
		out = requirements.RunBinding{RunID: runID, BaselineID: id, BaselineRevision: baseline.Revision, BaselineHash: requirements.BaselineHash(baseline), Baseline: baseline, FrozenPlanHash: planHash, BoundBy: author, BoundAt: s.now()}
		raw, e := encode(out)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_requirement_bindings(tenant_id,project_id,run_id,baseline_id,baseline_revision,baseline_hash,binding_json,created_at) VALUES(?,?,?,?,?,?,?,?)`), scope.TenantID, scope.ProjectID, runID, id, baseline.Revision, out.BaselineHash, raw, stamp(out.BoundAt)); e != nil {
			return e
		}
		return s.event(ctx, tx, scope, runID, "requirements.bound", map[string]any{"baselineId": id, "baselineRevision": baseline.Revision, "baselineHash": out.BaselineHash, "authorId": author})
	})
	return out, err
}

// First binding must precede publication intent. The project lock serializes
// this check with merge/apply and delivery creation, whose remote effects can
// continue after their transaction commits. Existing bindings remain readable
// and idempotent after publication.
func (s *Store) requireUnpublishedRun(ctx context.Context, tx *sql.Tx, scope mission.Scope, runID string) error {
	var count int
	if err := tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND run_id=? AND status IN ('applying','unknown','applied')`), scope.TenantID, scope.ProjectID, runID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return invalid("requirements must be bound before merge publication intent")
	}
	// Delivery records use an immutable manifest rather than a run_id column.
	// Narrow candidates with the JSON-encoded ID, then inspect the exact manifest
	// field so an unrelated nested reference cannot fence this run.
	idJSON, err := json.Marshal(runID)
	if err != nil {
		return err
	}
	pattern := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(`"runId":` + string(idJSON))
	rows, err := tx.QueryContext(ctx, s.rebind(`SELECT record_json FROM execution_deliveries WHERE tenant_id=? AND project_id=? AND kind='delivery' AND status IN ('preparing','unknown','ready','revoked') AND record_json LIKE ? ESCAPE '!'`), scope.TenantID, scope.ProjectID, "%"+pattern+"%")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		var record struct {
			Manifest *struct {
				RunID string `json:"runId"`
			} `json:"manifest"`
		}
		if err = rows.Scan(&raw); err != nil {
			return err
		}
		if err = json.Unmarshal([]byte(raw), &record); err != nil {
			return err
		}
		if record.Manifest != nil && record.Manifest.RunID == runID {
			return invalid("requirements must be bound before delivery publication intent")
		}
	}
	return rows.Err()
}
func (s *Store) Binding(ctx context.Context, scope mission.Scope, runID string) (requirements.RunBinding, bool, error) {
	if _, err := s.project(ctx, s.db, scope); err != nil {
		return requirements.RunBinding{}, false, err
	}
	if _, _, err := s.run(ctx, s.db, scope, runID); err != nil {
		return requirements.RunBinding{}, false, err
	}
	return s.binding(ctx, s.db, scope, runID)
}
