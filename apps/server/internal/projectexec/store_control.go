package projectexec

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func (s *Store) RecordVerification(ctx context.Context, ref FenceRequest, v mission.Verification) (mission.Verification, error) {
	var out mission.Verification
	e := s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		t, _, _, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		if t.BranchID == "" || v.BranchID != t.BranchID || v.SnapshotID == "" || (v.TaskID != "" && v.TaskID != t.ID) {
			return ErrInvalidState
		}
		if err := acceptance.ValidateVerification(t.Spec.Checks, v); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidState, err)
		}
		if v.Status != "passed" && v.Status != "failed" && v.Status != "unverified" {
			return ErrInvalidState
		}
		seen := map[string]bool{}
		for _, check := range v.Checks {
			if check.ID == "" || seen[check.ID] {
				return ErrInvalidState
			}
			seen[check.ID] = true
			if check.Required && check.Status != "passed" && v.Status == "passed" {
				return ErrInvalidState
			}
		}
		id, e := newID()
		if e != nil {
			return e
		}
		v.ID = id
		v.TaskID = t.ID
		v.CreatedAt = s.now()
		raw, e := encode(v)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_verifications(id,tenant_id,project_id,run_id,task_id,revision,verification_json,created_at) VALUES(?,?,?,?,?,?,?,?)`), id, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID, t.Revision+1, raw, stamp(v.CreatedAt)); e != nil {
			return e
		}
		t.Status = "verifying"
		t.SnapshotID = v.SnapshotID
		t.Revision++
		t.UpdatedAt = s.now()
		if e = s.putTask(ctx, tx, ref.Scope, t); e != nil {
			return e
		}
		out = v
		return s.event(ctx, tx, ref.Scope, ref.RunID, ref.TaskID, "task.verified", map[string]any{"verificationId": id, "snapshotId": v.SnapshotID, "status": v.Status})
	})
	return out, e
}
func (s *Store) verification(ctx context.Context, q sqlReader, scope mission.Scope, rid, tid string) (mission.Verification, error) {
	var raw string
	e := q.QueryRowContext(ctx, s.rebind(`SELECT verification_json FROM execution_verifications WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? ORDER BY revision DESC LIMIT 1`), scope.TenantID, scope.ProjectID, rid, tid).Scan(&raw)
	if e != nil {
		return mission.Verification{}, notFound(e)
	}
	var v mission.Verification
	e = json.Unmarshal([]byte(raw), &v)
	return v, e
}
func (s *Store) CompleteTask(ctx context.Context, ref FenceRequest, result, snapshotID string) error {
	return s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		t, r, p, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		if snapshotID == "" || snapshotID != t.SnapshotID {
			return ErrConflict
		}
		v, e := s.verification(ctx, tx, ref.Scope, ref.RunID, t.ID)
		if e != nil {
			return e
		}
		if v.Status != "passed" || v.SnapshotID != snapshotID || v.BranchID != t.BranchID {
			return ErrInvalidState
		}
		checked := map[string]bool{}
		for _, c := range v.Checks {
			checked[c.ID] = c.Status == "passed"
		}
		required := 0
		for _, spec := range t.Spec.Checks {
			if spec.Required {
				required++
				if !checked[spec.ID] {
					return fmt.Errorf("%w: required verification missing", ErrInvalidState)
				}
			}
		}
		if required == 0 {
			return fmt.Errorf("%w: at least one required acceptance check is necessary", ErrInvalidState)
		}
		var unresolved int
		if e = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_operations WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? AND status IN ('prepared','approved','running','unknown','pending_approval')`), ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, t.ID).Scan(&unresolved); e != nil {
			return e
		}
		if unresolved > 0 {
			return ErrInvalidState
		}
		t.Status = "completed"
		if p.Config.RequireReview {
			t.Status = "waiting_review"
		}
		t.Result = result
		t.Error = ""
		t.LeaseOwner = ""
		t.LeaseUntil = nil
		t.Fence++
		t.Revision++
		t.UpdatedAt = s.now()
		if e = s.putTask(ctx, tx, ref.Scope, t); e != nil {
			return e
		}
		if e = s.refreshRun(ctx, tx, ref.Scope, r); e != nil {
			return e
		}
		return s.event(ctx, tx, ref.Scope, ref.RunID, t.ID, "task.finished", map[string]any{"status": t.Status, "snapshotId": snapshotID})
	})
}
func (s *Store) FailTask(ctx context.Context, ref FenceRequest, reason string) error {
	return s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		t, r, _, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		// Dispatch may have happened before cancellation or a failed DB write.
		rows, e := tx.QueryContext(ctx, s.rebind(`SELECT operation_json FROM execution_operations WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? AND status IN ('running','prepared','approved')`), ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, t.ID)
		if e != nil {
			return e
		}
		operations, e := decodeRows[mission.Operation](rows)
		if e != nil {
			return e
		}
		ambiguous := false
		for _, o := range operations {
			if o.Status != "running" || o.Call.Effect == "read" {
				o.Status = "failed"
				o.Error = reason
			} else {
				o.Status = "unknown"
				o.Error = "task stopped after effect dispatch: " + reason
				ambiguous = true
			}
			o.Revision++
			o.UpdatedAt = s.now()
			if e = s.putOperation(ctx, tx, o); e != nil {
				return e
			}
			if e = s.event(ctx, tx, ref.Scope, ref.RunID, t.ID, "operation.interrupted", map[string]any{"operationId": o.ID, "status": o.Status}); e != nil {
				return e
			}
		}
		t.Status = "failed"
		if ambiguous {
			t.Status = "unknown"
		}
		t.Error = reason
		t.LeaseOwner = ""
		t.LeaseUntil = nil
		t.Fence++
		t.Revision++
		t.UpdatedAt = s.now()
		if e = s.putTask(ctx, tx, ref.Scope, t); e != nil {
			return e
		}
		if e = s.refreshRun(ctx, tx, ref.Scope, r); e != nil {
			return e
		}
		return s.event(ctx, tx, ref.Scope, ref.RunID, t.ID, "task.failed", map[string]any{"reason": reason})
	})
}
func (s *Store) RecordReview(ctx context.Context, tenant, pid, rid string, review mission.Review) (mission.Review, error) {
	var out mission.Review
	if review.AuthorID == "" {
		return out, ErrInvalidState
	}
	switch review.Decision {
	case "approve":
		review.Decision = "approved"
	case "reject":
		review.Decision = "rejected"
	case "approved", "rejected":
	default:
		return out, ErrInvalidState
	}
	e := s.tx(ctx, tenant, pid, func(tx *sql.Tx) error {
		p, e := s.project(ctx, tx, tenant, pid)
		if e != nil {
			return e
		}
		scope := scopeOf(p)
		r, e := s.run(ctx, tx, tenant, pid, rid)
		if e != nil {
			return e
		}
		if r.Status == "cancelled" || r.Status == "completed" {
			return ErrInvalidState
		}
		t, e := s.task(ctx, tx, scope, rid, review.TaskID)
		if e != nil {
			return e
		}
		if t.Status != "waiting_review" {
			return ErrInvalidState
		}
		if review.Decision == "approved" {
			all, e := s.listTasks(ctx, tx, tenant, pid, rid)
			if e != nil {
				return e
			}
			bySpec := map[string]mission.Task{}
			for _, depTask := range all {
				bySpec[depTask.Spec.ID] = depTask
			}
			for _, dep := range t.Spec.DependsOn {
				dependency, exists := bySpec[dep]
				if !exists || dependency.Status != "completed" {
					return fmt.Errorf("%w: approve dependencies before their consumer", ErrInvalidState)
				}
			}
		}
		if review.SnapshotID == "" || review.SnapshotID != t.SnapshotID {
			return ErrConflict
		}
		v, e := s.verification(ctx, tx, scope, rid, t.ID)
		if e != nil {
			return e
		}
		if v.Status != "passed" || v.SnapshotID != t.SnapshotID {
			return ErrInvalidState
		}
		id, e := newID()
		if e != nil {
			return e
		}
		review.ID = id
		review.ProjectID = pid
		review.RunID = rid
		review.CreatedAt = s.now()
		raw, e := encode(review)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_reviews(id,tenant_id,project_id,run_id,task_id,review_json,created_at) VALUES(?,?,?,?,?,?,?)`), id, tenant, pid, rid, t.ID, raw, stamp(review.CreatedAt)); e != nil {
			return e
		}
		t.Status = "completed"
		if review.Decision == "rejected" {
			t.Status = "failed"
			t.Error = "acceptance review rejected: " + review.Comment
		}
		t.Revision++
		t.UpdatedAt = s.now()
		if e = s.putTask(ctx, tx, scope, t); e != nil {
			return e
		}
		if review.Decision == "rejected" {
			if e = s.invalidateRetainedDescendants(ctx, tx, scope, rid, t); e != nil {
				return e
			}
		}
		if e = s.refreshRun(ctx, tx, scope, r); e != nil {
			return e
		}
		out = review
		return s.event(ctx, tx, scope, rid, t.ID, "task.reviewed", map[string]any{"reviewId": id, "decision": review.Decision, "snapshotId": review.SnapshotID, "authorId": review.AuthorID})
	})
	return out, e
}
func (s *Store) controlRun(ctx context.Context, tenant, pid, rid string, revision int64, action string) (mission.Run, error) {
	var out mission.Run
	e := s.tx(ctx, tenant, pid, func(tx *sql.Tx) error {
		if action == "resume" {
			if e := s.RequireTenantActive(ctx, tx, tenant); e != nil {
				return e
			}
		}
		p, e := s.project(ctx, tx, tenant, pid)
		if e != nil {
			return e
		}
		scope := scopeOf(p)
		r, e := s.run(ctx, tx, tenant, pid, rid)
		if e != nil {
			return e
		}
		if r.Revision != revision {
			return ErrConflict
		}
		switch action {
		case "pause":
			if r.Status == "completed" || r.Status == "cancelled" || r.Status == "failed" || r.Status == "paused" {
				return ErrInvalidState
			}
			r.Status = "paused"
		case "resume":
			if r.Status != "paused" {
				return ErrInvalidState
			}
			r.Status = "running"
		case "cancel":
			if r.Status == "completed" || r.Status == "cancelled" {
				return ErrInvalidState
			}
			r.Status = "cancelled"
		default:
			return ErrInvalidState
		}
		r.Revision++
		r.UpdatedAt = s.now()
		if e = s.putRun(ctx, tx, tenant, r); e != nil {
			return e
		}
		if action == "cancel" {
			if e = s.cancelOperations(ctx, tx, scope, rid); e != nil {
				return e
			}
		}
		if action != "resume" {
			tasks, e := s.listTasks(ctx, tx, tenant, pid, rid)
			if e != nil {
				return e
			}
			for _, t := range tasks {
				if t.Status == "completed" || t.Status == "failed" || t.Status == "cancelled" {
					continue
				}
				if action == "cancel" {
					t.Status = "cancelled"
					t.LeaseUntil = nil
				} else if t.Status == "running" || t.Status == "verifying" {
					now := s.now()
					t.LeaseUntil = &now
				}
				t.LeaseOwner = ""
				t.Fence++
				t.Revision++
				t.UpdatedAt = s.now()
				if e = s.putTask(ctx, tx, scope, t); e != nil {
					return e
				}
			}
		}
		if action == "resume" {
			if e = s.refreshRun(ctx, tx, scope, r); e != nil {
				return e
			}
			r, e = s.run(ctx, tx, tenant, pid, rid)
			if e != nil {
				return e
			}
		}
		out = r
		return s.event(ctx, tx, scope, rid, "", "run."+action, map[string]any{"revision": r.Revision})
	})
	return out, e
}
func (s *Store) PauseRun(ctx context.Context, tenant, pid, rid string, revision int64) (mission.Run, error) {
	return s.controlRun(ctx, tenant, pid, rid, revision, "pause")
}
func (s *Store) ResumeRun(ctx context.Context, tenant, pid, rid string, revision int64) (mission.Run, error) {
	return s.controlRun(ctx, tenant, pid, rid, revision, "resume")
}
func (s *Store) CancelRun(ctx context.Context, tenant, pid, rid string, revision int64) (mission.Run, error) {
	return s.controlRun(ctx, tenant, pid, rid, revision, "cancel")
}
func (s *Store) RetryTask(ctx context.Context, tenant, pid, rid, tid string, revision int64) (mission.Task, error) {
	var out mission.Task
	e := s.tx(ctx, tenant, pid, func(tx *sql.Tx) error {
		if e := s.RequireTenantActive(ctx, tx, tenant); e != nil {
			return e
		}
		p, e := s.project(ctx, tx, tenant, pid)
		if e != nil {
			return e
		}
		scope := scopeOf(p)
		r, e := s.run(ctx, tx, tenant, pid, rid)
		if e != nil {
			return e
		}
		if r.Status == "completed" || r.Status == "cancelled" {
			return ErrInvalidState
		}
		t, e := s.task(ctx, tx, scope, rid, tid)
		if e != nil {
			return e
		}
		if t.Revision != revision {
			return ErrConflict
		}
		if t.Status != "failed" && t.Status != "blocked" {
			return ErrInvalidState
		}
		var unresolved int
		if e = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_operations WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? AND status IN ('running','unknown','pending_approval','approved','prepared')`), tenant, pid, rid, tid).Scan(&unresolved); e != nil {
			return e
		}
		if unresolved > 0 {
			return ErrInvalidState
		}
		limit := t.Spec.MaxAttempts
		if limit <= 0 {
			limit = 3
		}
		if t.Attempt >= limit {
			return ErrBudgetExceeded
		}
		cp, e := s.checkpoint(ctx, tx, scope, rid, tid)
		if e != nil {
			return e
		}
		if t.ReusedFromRunID != "" && cp.ID == "" {
			if t.SnapshotID == "" {
				return ErrInvalidState
			}
			t.ForkSnapshotID = t.SnapshotID
			t.BranchID = ""
			t.BaseSnapshot = ""
		}
		if cp.ID == "" {
			cp = mission.Checkpoint{TaskID: t.ID, Messages: []mission.Message{{"role": "user", "content": t.Spec.Prompt}}}
		}
		{
			if cp.Decision != nil {
				if cp.NextTool < 0 || cp.NextTool > len(cp.Decision.Tools) {
					return ErrInvalidState
				}
				for _, call := range cp.Decision.Tools[cp.NextTool:] {
					var raw string
					err := tx.QueryRowContext(ctx, s.rebind(`SELECT operation_json FROM execution_operations WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? AND checkpoint_id=? AND call_id=?`), tenant, pid, rid, tid, cp.ID, call.ID).Scan(&raw)
					var op mission.Operation
					if errors.Is(err, sql.ErrNoRows) {
						op = mission.Operation{Call: call, Status: "failed", Error: "Previous attempt stopped before this tool was dispatched"}
					} else if err != nil {
						return err
					} else {
						if err = json.Unmarshal([]byte(raw), &op); err != nil {
							return err
						}
						if op.Status != "completed" && op.Status != "failed" {
							return ErrInvalidState
						}
					}
					cp.Messages = append(cp.Messages, operationResultMessage(op))
				}
			}
			cp.Decision = nil
			cp.NextTool = 0
			cp.Messages = append(cp.Messages, mission.Message{"role": "user", "content": "Previous attempt failed: " + t.Error + ". Revise the result and satisfy the acceptance checks."})
			ref := FenceRequest{Scope: scope, RunID: rid, TaskID: tid}
			if _, e = s.saveCheckpoint(ctx, tx, ref, &t, cp); e != nil {
				return e
			}
		}
		t.Status = "pending"
		t.Attempt++
		t.Error = ""
		t.Result = ""
		t.SnapshotID = ""
		t.LeaseOwner = ""
		t.LeaseUntil = nil
		t.Fence++
		t.Revision++
		t.UpdatedAt = s.now()
		if e = s.putTask(ctx, tx, scope, t); e != nil {
			return e
		}
		if e = s.refreshRun(ctx, tx, scope, r); e != nil {
			return e
		}
		out = t
		return s.event(ctx, tx, scope, rid, tid, "task.retry_requested", map[string]any{"revision": t.Revision})
	})
	return out, e
}

// cancelOperations retains ambiguous mutations for explicit reconciliation.
// A persisted prepared operation has never been dispatched and is safe to stop.
func (s *Store) cancelOperations(ctx context.Context, tx *sql.Tx, scope mission.Scope, rid string) error {
	rows, e := tx.QueryContext(ctx, s.rebind(`SELECT operation_json FROM execution_operations WHERE tenant_id=? AND project_id=? AND run_id=? AND status IN ('running','prepared','approved','pending_approval') ORDER BY id`), scope.TenantID, scope.ProjectID, rid)
	if e != nil {
		return e
	}
	operations, e := decodeRows[mission.Operation](rows)
	if e != nil {
		return e
	}
	for _, o := range operations {
		if o.Status == "running" && o.Call.Effect != "read" {
			o.Status = "unknown"
			o.Error = "execution cancelled after dispatch; mutation outcome requires inspection"
		} else {
			o.Status = "failed"
			o.Error = "operation stopped by execution cancellation"
		}
		o.Revision++
		o.UpdatedAt = s.now()
		if e = s.putOperation(ctx, tx, o); e != nil {
			return e
		}
		if e = s.event(ctx, tx, scope, rid, o.TaskID, "operation.cancelled", map[string]any{"operationId": o.ID, "status": o.Status}); e != nil {
			return e
		}
	}
	return nil
}

// CancelTenant revokes all task incarnations in one transaction. The tenant row
// serializes this shutdown with project creation, and project locks serialize it
// with budget reservation and effect dispatch. The durable fence remains set
// even if later container cleanup or physical tenant deletion fails.
func (s *Store) CancelTenant(ctx context.Context, tenant string) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	result, e := tx.ExecContext(ctx, s.rebind(`UPDATE tenants SET id=id WHERE id=?`), tenant)
	if e != nil {
		return e
	}
	n, e := result.RowsAffected()
	if e != nil {
		return e
	}
	if n != 1 {
		return ErrNotFound
	}
	if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES(?,1,?) ON CONFLICT(tenant_id) DO UPDATE SET draining=1,updated_at=excluded.updated_at`), tenant, stamp(s.now())); e != nil {
		return e
	}
	rows, e := tx.QueryContext(ctx, s.rebind(`SELECT project_json FROM execution_projects WHERE tenant_id=? ORDER BY id`), tenant)
	if e != nil {
		return e
	}
	projects, e := decodeRows[mission.Project](rows)
	if e != nil {
		return e
	}
	for _, p := range projects {
		scope := scopeOf(p)
		if _, e = tx.ExecContext(ctx, s.rebind(`UPDATE execution_projects SET event_sequence=event_sequence WHERE tenant_id=? AND id=?`), tenant, p.ID); e != nil {
			return e
		}
		rows, e = tx.QueryContext(ctx, s.rebind(`SELECT run_json FROM execution_runs WHERE tenant_id=? AND project_id=? AND status NOT IN ('completed','cancelled') ORDER BY id`), tenant, p.ID)
		if e != nil {
			return e
		}
		runs, e := decodeRows[mission.Run](rows)
		if e != nil {
			return e
		}
		for _, r := range runs {
			if e = s.cancelOperations(ctx, tx, scope, r.ID); e != nil {
				return e
			}
			tasks, e := s.listTasks(ctx, tx, tenant, p.ID, r.ID)
			if e != nil {
				return e
			}
			for _, t := range tasks {
				if t.Status == "completed" {
					continue
				}
				t.Status = "cancelled"
				t.LeaseOwner = ""
				t.LeaseUntil = nil
				t.Fence++
				t.Revision++
				t.UpdatedAt = s.now()
				if e = s.putTask(ctx, tx, scope, t); e != nil {
					return e
				}
			}
			r.Status = "cancelled"
			r.Revision++
			r.UpdatedAt = s.now()
			if e = s.putRun(ctx, tx, tenant, r); e != nil {
				return e
			}
			if e = s.event(ctx, tx, scope, r.ID, "", "run.tenant_cancelled", map[string]any{"tenantId": tenant}); e != nil {
				return e
			}
		}
	}
	return tx.Commit()
}

func (s *Store) stopTasks(ctx context.Context, tx *sql.Tx, scope mission.Scope, rid, reason string) error {
	if e := s.cancelOperations(ctx, tx, scope, rid); e != nil {
		return e
	}
	tasks, e := s.listTasks(ctx, tx, scope.TenantID, scope.ProjectID, rid)
	if e != nil {
		return e
	}
	for _, t := range tasks {
		if t.Status == "completed" || t.Status == "failed" || t.Status == "cancelled" {
			continue
		}
		t.Status = "failed"
		t.Error = reason
		t.LeaseOwner = ""
		t.LeaseUntil = nil
		t.Fence++
		t.Revision++
		t.UpdatedAt = s.now()
		if e = s.putTask(ctx, tx, scope, t); e != nil {
			return e
		}
	}
	return nil
}

// Rejecting an ancestor changes the causal meaning of every retained consumer.
// Historical proofs remain readable, but cannot authorize the new task head.
func (s *Store) invalidateRetainedDescendants(ctx context.Context, tx *sql.Tx, scope mission.Scope, rid string, ancestor mission.Task) error {
	tasks, e := s.listTasks(ctx, tx, scope.TenantID, scope.ProjectID, rid)
	if e != nil {
		return e
	}
	children := map[string][]int{}
	for i, t := range tasks {
		for _, dep := range t.Spec.DependsOn {
			children[dep] = append(children[dep], i)
		}
	}
	visited := map[string]bool{}
	queue := []string{ancestor.Spec.ID}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, index := range children[id] {
			t := &tasks[index]
			if visited[t.Spec.ID] {
				continue
			}
			visited[t.Spec.ID] = true
			queue = append(queue, t.Spec.ID)
			if t.ReusedFromRunID == "" || t.Status == "completed" {
				continue
			}
			oldSnapshot, sourceRun, sourceTask := t.SnapshotID, t.ReusedFromRunID, t.ReusedFromTaskID
			t.Status = "pending"
			t.Result = ""
			t.Error = ""
			t.BranchID = ""
			t.BaseSnapshot = ""
			t.ForkSnapshotID = ""
			t.SnapshotID = ""
			t.CheckpointID = ""
			t.ReusedFromRunID = ""
			t.ReusedFromTaskID = ""
			t.LeaseOwner = ""
			t.LeaseUntil = nil
			t.Fence++
			t.Revision++
			t.UpdatedAt = s.now()
			if e = s.putTask(ctx, tx, scope, *t); e != nil {
				return e
			}
			if e = s.event(ctx, tx, scope, rid, t.ID, "task.reuse_invalidated", map[string]any{"snapshotId": oldSnapshot, "sourceRunId": sourceRun, "sourceTaskId": sourceTask, "causeTaskId": ancestor.ID}); e != nil {
				return e
			}
		}
	}
	return nil
}
