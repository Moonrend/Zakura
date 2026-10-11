// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
	"github.com/go-chi/chi/v5"
)

type projectMergePreview struct {
	ID                string                 `json:"id"`
	ProjectID         string                 `json:"projectId"`
	RunID             string                 `json:"runId"`
	Revision          int64                  `json:"revision"`
	RunRevision       int64                  `json:"runRevision"`
	Status            string                 `json:"status"`
	PlanID            string                 `json:"planId"`
	Plan              workspace.MergePlan    `json:"plan"`
	ExpectedBase      string                 `json:"expectedBase"`
	TaskSnapshots     map[string]string      `json:"taskSnapshots"`
	Verifications     []mission.Verification `json:"verifications"`
	ReviewID          string                 `json:"reviewId,omitempty"`
	ReviewedBy        string                 `json:"reviewedBy,omitempty"`
	ReviewComment     string                 `json:"reviewComment,omitempty"`
	ReviewEvidence    json.RawMessage        `json:"reviewEvidence,omitempty"`
	OperationID       string                 `json:"operationId,omitempty"`
	Result            json.RawMessage        `json:"result,omitempty"`
	Error             string                 `json:"error,omitempty"`
	OriginalPreviewID string                 `json:"originalPreviewId,omitempty"`
	CreatedAt         time.Time              `json:"createdAt"`
	UpdatedAt         time.Time              `json:"updatedAt"`
}

func (h *handler) registerProjectMerges(r chi.Router) {
	r.Get("/merges", h.projectMergeList)
	r.Post("/merges/preview", h.projectMergeCreate)
	r.Get("/merges/{mid}", h.projectMergeGet)
	r.Post("/merges/{mid}/resolve", h.projectMergeResolve)
	r.Post("/merges/{mid}/review", h.projectMergeReview)
	r.Post("/merges/{mid}/apply", h.projectMergeApply)
	r.Post("/merges/{mid}/reconcile", h.projectMergeReconcile)
}

func (h *handler) loadMerge(ctx context.Context, tenant, pid, rid, id string) (projectMergePreview, error) {
	var raw string
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT preview_json FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), tenant, pid, rid, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return projectMergePreview{}, projectexec.ErrNotFound
	}
	if err != nil {
		return projectMergePreview{}, err
	}
	var out projectMergePreview
	err = json.Unmarshal([]byte(raw), &out)
	return out, err
}

func (h *handler) saveMerge(ctx context.Context, p mission.Project, preview projectMergePreview) error {
	preview.Revision = 1
	preview.CreatedAt = h.store.now()
	preview.UpdatedAt = preview.CreatedAt
	raw, err := json.Marshal(preview)
	if err != nil {
		return err
	}
	tx, err := h.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := h.lockProjectMutation(ctx, tx, p); err != nil {
		return err
	}
	if err := h.projects.RequireTenantActive(ctx, tx, p.TenantID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, h.deps.Rebind(`INSERT INTO execution_merge_previews(id,tenant_id,project_id,run_id,revision,status,preview_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`), preview.ID, p.TenantID, p.ID, preview.RunID, preview.Revision, preview.Status, string(raw), runtimeTimeString(preview.CreatedAt), runtimeTimeString(preview.UpdatedAt))
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (h *handler) lockProjectMutation(ctx context.Context, tx *sql.Tx, p mission.Project) error {
	// Match the durable executor's tenant-before-project order. Activity checks
	// remain with callers so receipt settlement and recovery can finish during
	// tenant shutdown.
	result, err := tx.ExecContext(ctx, h.deps.Rebind(`UPDATE tenants SET id=id WHERE id=?`), p.TenantID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return projectexec.ErrNotFound
	}
	result, err = tx.ExecContext(ctx, h.deps.Rebind(`UPDATE execution_projects SET event_sequence=event_sequence WHERE tenant_id=? AND id=?`), p.TenantID, p.ID)
	if err != nil {
		return err
	}
	n, err = result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return projectexec.ErrNotFound
	}
	return nil
}

func (h *handler) mutateMerge(ctx context.Context, p mission.Project, rid, id string, revision int64, author, action, comment string, fn func(*sql.Tx, *projectMergePreview) error) (projectMergePreview, error) {
	tx, err := h.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return projectMergePreview{}, err
	}
	defer tx.Rollback()
	if err := h.lockProjectMutation(ctx, tx, p); err != nil {
		return projectMergePreview{}, err
	}
	var raw string
	if err := tx.QueryRowContext(ctx, h.deps.Rebind(`SELECT preview_json FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), p.TenantID, p.ID, rid, id).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = projectexec.ErrNotFound
		}
		return projectMergePreview{}, err
	}
	var preview projectMergePreview
	if err := json.Unmarshal([]byte(raw), &preview); err != nil {
		return preview, err
	}
	if preview.Revision != revision {
		return preview, projectexec.ErrConflict
	}
	if err := fn(tx, &preview); err != nil {
		return preview, err
	}
	preview.Revision++
	preview.UpdatedAt = h.store.now()
	encoded, err := json.Marshal(preview)
	if err != nil {
		return preview, err
	}
	_, err = tx.ExecContext(ctx, h.deps.Rebind(`UPDATE execution_merge_previews SET revision=?,status=?,preview_json=?,updated_at=? WHERE tenant_id=? AND id=? AND revision=?`), preview.Revision, preview.Status, string(encoded), runtimeTimeString(preview.UpdatedAt), p.TenantID, id, revision)
	if err != nil {
		return preview, err
	}
	if action != "" {
		_, err = tx.ExecContext(ctx, h.deps.Rebind(`INSERT INTO execution_merge_audit(id,tenant_id,project_id,run_id,preview_id,author_id,action,snapshot_id,comment,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`), h.store.id(), p.TenantID, p.ID, rid, id, author, action, preview.Plan.Result.ID, comment, runtimeTimeString(preview.UpdatedAt))
		if err != nil {
			return preview, err
		}
	}
	if err := tx.Commit(); err != nil {
		return preview, err
	}
	return preview, nil
}

func (h *handler) verifyMergedArtifact(ctx context.Context, p mission.Project, preview *projectMergePreview, tasks []mission.Task) error {
	if len(preview.Plan.Conflicts) > 0 {
		preview.Status = "conflicted"
		return nil
	}
	branch, err := h.projectBridge.Fork(ctx, projectScope(p), preview.Plan.Result.ID, "merge_"+preview.ID)
	if err != nil {
		return err
	}
	preview.Verifications = []mission.Verification{}
	passed := true
	for _, task := range tasks {
		verification, err := h.projectBridge.Verify(ctx, projectScope(p), branch, task.Spec.Checks)
		if err != nil {
			return err
		}
		if verification.SnapshotID != preview.Plan.Result.ID {
			return errors.New("merge verification is bound to a different snapshot")
		}
		if err := acceptance.ValidateVerification(task.Spec.Checks, verification); err != nil {
			return err
		}
		verification.TaskID = task.ID
		preview.Verifications = append(preview.Verifications, verification)
		ok, err := acceptance.VerificationPassed(task.Spec.Checks, verification)
		if err != nil {
			return err
		}
		if !ok {
			passed = false
		}
	}
	head, err := h.projectBridge.Snapshot(ctx, projectScope(p), branch)
	if err != nil {
		return err
	}
	if head != preview.Plan.Result.ID {
		return errors.New("merge acceptance modified the reviewed artifact")
	}
	if passed {
		preview.Status = "ready"
	} else {
		preview.Status = "verification_failed"
	}
	return nil
}

func (h *handler) selectedMergeTasks(ctx context.Context, p mission.Project, rid string, ids []string) (mission.Run, []mission.Task, error) {
	run, err := h.projects.GetRun(ctx, p.TenantID, p.ID, rid)
	if err != nil {
		return run, nil, err
	}
	if run.Status != "completed" {
		return run, nil, fmt.Errorf("%w: merge requires a completed run", projectexec.ErrInvalidState)
	}
	maxTasks := p.Config.MaxTasks
	if maxTasks <= 0 {
		maxTasks = 1000
	}
	if len(ids) == 0 || len(ids) > maxTasks {
		return run, nil, errors.New("select at least one bounded completed task")
	}
	seen := map[string]bool{}
	tasks := make([]mission.Task, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			return run, nil, errors.New("duplicate task selection")
		}
		seen[id] = true
		task, err := h.projects.GetTask(ctx, p.TenantID, p.ID, rid, id)
		if err != nil {
			return run, nil, err
		}
		if task.Status != "completed" || task.SnapshotID == "" {
			return run, nil, fmt.Errorf("%w: task %s is not accepted", projectexec.ErrInvalidState, task.Spec.ID)
		}
		tasks = append(tasks, task)
	}
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].ID < tasks[j].ID })
	return run, tasks, nil
}

func (h *handler) projectMergeCreate(w http.ResponseWriter, r *http.Request) {
	p, err := h.projects.GetRunProject(r.Context(), principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		TaskIDs             []string `json:"taskIds"`
		ExpectedRunRevision int64    `json:"expectedRunRevision"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid merge selection")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	run, tasks, err := h.selectedMergeTasks(ctx, p, chi.URLParam(r, "rid"), body.TaskIDs)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if run.Revision != body.ExpectedRunRevision {
		projectHTTPError(w, projectexec.ErrConflict)
		return
	}
	bindings := map[string]string{}
	for _, task := range tasks {
		bindings[task.ID] = task.SnapshotID
	}
	target, err := h.projectEngine.ComposeTaskOutputs(ctx, p.TenantID, p.ID, run.ID, body.TaskIDs)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var planned struct {
		PlanID       string              `json:"planId"`
		ExpectedBase string              `json:"expectedBase"`
		Plan         workspace.MergePlan `json:"plan"`
	}
	if err := h.projectBridge.rpc(ctx, projectScope(p), "project.merge.plan", map[string]any{"operationId": h.store.id(), "baseSnapshot": run.BaseSnapshot, "snapshotId": target}, &planned); err != nil {
		projectHTTPError(w, err)
		return
	}
	preview := projectMergePreview{ID: h.store.id(), ProjectID: p.ID, RunID: run.ID, RunRevision: run.Revision, PlanID: planned.PlanID, ExpectedBase: planned.ExpectedBase, Plan: planned.Plan, TaskSnapshots: bindings}
	if err := h.verifyMergedArtifact(ctx, p, &preview, tasks); err != nil {
		projectHTTPError(w, err)
		return
	}
	if err := h.saveMerge(ctx, p, preview); err != nil {
		projectHTTPError(w, err)
		return
	}
	preview, err = h.loadMerge(ctx, p.TenantID, p.ID, run.ID, preview.ID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, preview)
}

func (h *handler) projectMergeList(w http.ResponseWriter, r *http.Request) {
	rows, err := h.deps.DB.QueryContext(r.Context(), h.deps.Rebind(`SELECT preview_json FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND run_id=? ORDER BY created_at DESC LIMIT ?`), principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"), projectQueryInt(r, "limit", 100, 500))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer rows.Close()
	items := []projectMergePreview{}
	for rows.Next() {
		var raw string
		var preview projectMergePreview
		if err := rows.Scan(&raw); err != nil {
			projectHTTPError(w, err)
			return
		}
		if err := json.Unmarshal([]byte(raw), &preview); err != nil {
			projectHTTPError(w, err)
			return
		}
		items = append(items, preview)
	}
	if err := rows.Err(); err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}
func (h *handler) projectMergeGet(w http.ResponseWriter, r *http.Request) {
	preview, err := h.loadMerge(r.Context(), principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"), chi.URLParam(r, "mid"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	rows, err := h.deps.DB.QueryContext(r.Context(), h.deps.Rebind(`SELECT id,author_id,action,snapshot_id,comment,created_at FROM execution_merge_audit WHERE tenant_id=? AND project_id=? AND run_id=? AND preview_id=? ORDER BY created_at,id`), principal(r).TenantID, preview.ProjectID, preview.RunID, preview.ID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer rows.Close()
	audit := []map[string]any{}
	for rows.Next() {
		var id, author, action, snapshot, comment, created string
		if err := rows.Scan(&id, &author, &action, &snapshot, &comment, &created); err != nil {
			projectHTTPError(w, err)
			return
		}
		audit = append(audit, map[string]any{"id": id, "authorId": author, "action": action, "snapshotId": snapshot, "comment": comment, "createdAt": created})
	}
	if err := rows.Err(); err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"preview": preview, "audit": audit})
}

func (h *handler) projectMergeResolve(w http.ResponseWriter, r *http.Request) {
	p, err := h.projects.GetRunProject(r.Context(), principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	previous, err := h.loadMerge(r.Context(), p.TenantID, p.ID, chi.URLParam(r, "rid"), chi.URLParam(r, "mid"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64                  `json:"expectedRevision"`
		Resolutions      []workspace.Resolution `json:"resolutions"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid merge resolution")
		return
	}
	if previous.Revision != body.ExpectedRevision || previous.Status != "conflicted" {
		projectHTTPError(w, projectexec.ErrConflict)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	var resolved struct {
		PlanID       string              `json:"planId"`
		ExpectedBase string              `json:"expectedBase"`
		Plan         workspace.MergePlan `json:"plan"`
	}
	if err := h.projectBridge.rpc(ctx, projectScope(p), "project.merge.resolve", map[string]any{"operationId": h.store.id(), "planId": previous.PlanID, "resolutions": body.Resolutions}, &resolved); err != nil {
		projectHTTPError(w, err)
		return
	}
	ids := make([]string, 0, len(previous.TaskSnapshots))
	for id := range previous.TaskSnapshots {
		ids = append(ids, id)
	}
	run, tasks, err := h.selectedMergeTasks(ctx, p, previous.RunID, ids)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if run.Revision != previous.RunRevision {
		projectHTTPError(w, projectexec.ErrConflict)
		return
	}
	preview := projectMergePreview{ID: h.store.id(), ProjectID: p.ID, RunID: previous.RunID, RunRevision: run.Revision, PlanID: resolved.PlanID, ExpectedBase: resolved.ExpectedBase, Plan: resolved.Plan, TaskSnapshots: previous.TaskSnapshots, OriginalPreviewID: previous.ID}
	if err := h.verifyMergedArtifact(ctx, p, &preview, tasks); err != nil {
		projectHTTPError(w, err)
		return
	}
	if err := h.saveMerge(ctx, p, preview); err != nil {
		projectHTTPError(w, err)
		return
	}
	preview, err = h.loadMerge(ctx, p.TenantID, p.ID, preview.RunID, preview.ID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, preview)
}

func projectHumanReviewer(w http.ResponseWriter, r *http.Request) bool {
	p := principal(r)
	if p.UserID == "" || p.APIKey || p.OAuth || p.SessionID == "" {
		httpx.Error(w, 403, "Merge review requires an authenticated human member session")
		return false
	}
	return true
}

func (h *handler) projectMergeReview(w http.ResponseWriter, r *http.Request) {
	if !projectHumanReviewer(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		SnapshotID       string `json:"snapshotId"`
		Decision         string `json:"decision"`
		Comment          string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid merge review")
		return
	}
	if strings.TrimSpace(body.Comment) == "" || len(body.Comment) > 16000 || (body.Decision != "approved" && body.Decision != "rejected") {
		httpx.Error(w, 400, "Review decision and explanatory comment are required")
		return
	}
	preview, err := h.mutateMerge(r.Context(), p, chi.URLParam(r, "rid"), chi.URLParam(r, "mid"), body.ExpectedRevision, principal(r).UserID, "review."+body.Decision, body.Comment, func(tx *sql.Tx, preview *projectMergePreview) error {
		if (preview.Status != "ready" && preview.Status != "approved") || preview.Plan.Result.ID != body.SnapshotID || len(preview.Plan.Conflicts) > 0 {
			return projectexec.ErrConflict
		}
		if body.Decision == "approved" {
			if err := h.requireProjectRequirementsArtifactTx(r.Context(), tx, projectScope(p), preview.RunID, preview.TaskSnapshots, preview.Verifications, preview.Plan.Result.ID); err != nil {
				return err
			}
		}
		return h.recordProjectMergeSignoffTx(r.Context(), tx, p, preview, principal(r).UserID, principal(r).Role, body.Decision, body.Comment)
	})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, preview)
}

func (h *handler) validateMergeFrozenState(ctx context.Context, tx *sql.Tx, p mission.Project, preview *projectMergePreview) error {
	var runJSON string
	if err := tx.QueryRowContext(ctx, h.deps.Rebind(`SELECT run_json FROM execution_runs WHERE tenant_id=? AND project_id=? AND id=?`), p.TenantID, p.ID, preview.RunID).Scan(&runJSON); err != nil {
		return err
	}
	var run mission.Run
	if err := json.Unmarshal([]byte(runJSON), &run); err != nil {
		return err
	}
	if run.Status != "completed" || run.Revision != preview.RunRevision {
		return projectexec.ErrConflict
	}
	for id, snapshot := range preview.TaskSnapshots {
		var raw string
		if err := tx.QueryRowContext(ctx, h.deps.Rebind(`SELECT task_json FROM execution_tasks WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), p.TenantID, p.ID, preview.RunID, id).Scan(&raw); err != nil {
			return err
		}
		var task mission.Task
		if err := json.Unmarshal([]byte(raw), &task); err != nil {
			return err
		}
		if task.Status != "completed" || task.SnapshotID != snapshot {
			return projectexec.ErrConflict
		}
		found := false
		for _, v := range preview.Verifications {
			if v.TaskID != task.ID || v.SnapshotID != preview.Plan.Result.ID {
				continue
			}
			passed, err := acceptance.VerificationPassed(task.Spec.Checks, v)
			if err != nil {
				return err
			}
			if v.TaskID == task.ID && v.SnapshotID == preview.Plan.Result.ID && passed {
				found = true
				break
			}
		}
		if !found {
			return errors.New("merged artifact acceptance is missing or failed")
		}
	}
	return nil
}

func (h *handler) projectMergeApply(w http.ResponseWriter, r *http.Request) {
	if !projectHumanReviewer(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		Confirmation     string `json:"confirmation"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.Confirmation != "merge" {
		httpx.Error(w, 400, "Explicit merge confirmation required")
		return
	}
	preview, err := h.mutateMerge(r.Context(), p, chi.URLParam(r, "rid"), chi.URLParam(r, "mid"), body.ExpectedRevision, principal(r).UserID, "apply.started", "Apply approved immutable artifact", func(tx *sql.Tx, preview *projectMergePreview) error {
		if err := h.projects.RequireTenantActive(r.Context(), tx, p.TenantID); err != nil {
			return err
		}
		if preview.Status != "approved" || preview.ReviewID == "" || len(preview.Plan.Conflicts) > 0 {
			return projectexec.ErrInvalidState
		}
		if err := h.validateMergeFrozenState(r.Context(), tx, p, preview); err != nil {
			return err
		}
		if err := h.requireProjectRequirementsArtifactTx(r.Context(), tx, projectScope(p), preview.RunID, preview.TaskSnapshots, preview.Verifications, preview.Plan.Result.ID); err != nil {
			return err
		}
		if err := h.requireProjectSignoffTx(r.Context(), tx, p, preview); err != nil {
			return err
		}
		var active int
		if err := tx.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT COUNT(*) FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND status IN ('applying','unknown') AND id<>?`), p.TenantID, p.ID, preview.ID).Scan(&active); err != nil {
			return err
		}
		if active > 0 {
			return fmt.Errorf("%w: reconcile earlier merge before applying another", projectexec.ErrConflict)
		}
		preview.Status = "applying"
		preview.OperationID = projectOperationKey("merge", preview.ID, preview.ReviewID)
		return nil
	})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	var result json.RawMessage
	applyErr := h.projectBridge.rpc(ctx, projectScope(p), "project.merge.apply", map[string]any{"operationId": preview.OperationID, "planId": preview.PlanID, "expectedBase": preview.ExpectedBase, "reviewId": preview.ReviewID, "reviewSnapshot": preview.Plan.Result.ID, "approved": true}, &result)
	// A failed/abandoned RPC cannot prove that the filesystem mutation did not
	// occur. Preserve intent and require reconciliation rather than reissuing.
	finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer finishCancel()
	preview, err = h.mutateMerge(finishCtx, p, preview.RunID, preview.ID, preview.Revision, principal(r).UserID, "apply.finished", "Runner merge result recorded", func(_ *sql.Tx, preview *projectMergePreview) error {
		if applyErr != nil {
			preview.Status = "unknown"
			preview.Error = applyErr.Error()
		} else {
			preview.Status = "applied"
			preview.Result = result
		}
		return nil
	})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if applyErr != nil {
		httpx.JSON(w, 202, preview)
		return
	}
	httpx.JSON(w, 200, preview)
}

func (h *handler) projectMergeReconcile(w http.ResponseWriter, r *http.Request) {
	if !projectHumanReviewer(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	preview, err := h.loadMerge(r.Context(), p.TenantID, p.ID, chi.URLParam(r, "rid"), chi.URLParam(r, "mid"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		Decision         string `json:"decision"`
		Comment          string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid merge reconciliation")
		return
	}
	if body.ExpectedRevision != preview.Revision || (preview.Status != "applying" && preview.Status != "unknown") {
		projectHTTPError(w, projectexec.ErrConflict)
		return
	}
	if strings.TrimSpace(body.Comment) == "" || len(body.Comment) > 16000 || (body.Decision != "inspect" && body.Decision != "not_performed") {
		httpx.Error(w, 400, "Inspection or explicit not-performed attestation and comment required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	var inspected struct {
		Known       bool            `json:"known"`
		Status      string          `json:"status"`
		Result      json.RawMessage `json:"result"`
		Error       string          `json:"error"`
		EffectState string          `json:"effectState"`
	}
	if err := h.projectBridge.rpc(ctx, projectScope(p), "project.operation.inspect", map[string]any{"operationId": preview.OperationID}, &inspected); err != nil {
		projectHTTPError(w, err)
		return
	}
	if body.Decision == "not_performed" && inspected.Known && inspected.Status == "completed" {
		projectHTTPError(w, projectexec.ErrConflict)
		return
	}
	if body.Decision == "not_performed" {
		current, err := h.projectBridge.Base(ctx, projectScope(p))
		if err != nil {
			projectHTTPError(w, err)
			return
		}
		if current != preview.ExpectedBase {
			httpx.Error(w, 409, "Original workspace differs from merge baseline; not-performed attestation rejected")
			return
		}
	}
	preview, err = h.mutateMerge(ctx, p, preview.RunID, preview.ID, preview.Revision, principal(r).UserID, "reconcile."+body.Decision, body.Comment, func(_ *sql.Tx, preview *projectMergePreview) error {
		if inspected.Known && inspected.Status == "completed" {
			preview.Status = "applied"
			preview.Result = inspected.Result
			preview.Error = ""
		} else if inspected.Known && inspected.Status == "failed" && inspected.EffectState == "not_performed" {
			preview.Status = "abandoned"
			preview.Error = "Runner proved merge rejection before workspace mutation: " + inspected.Error
		} else if body.Decision == "not_performed" {
			preview.Status = "abandoned"
			preview.Error = "Human attested operation not performed; create and review a fresh preview before trying another merge"
		} else {
			preview.Status = "unknown"
			preview.Error = inspected.Error
		}
		return nil
	})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, preview)
}
