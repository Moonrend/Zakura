package projectexec

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
)

// ForkRun starts a new immutable plan incarnation and reuses only verified
// output whose entire dependency history still describes the same work.
func (s *Store) ForkRun(ctx context.Context, tenant, pid, sourceRunID string, expectedProjectRevision int64) (mission.Run, error) {
	var out mission.Run
	err := s.tx(ctx, tenant, pid, func(tx *sql.Tx) error {
		p, e := s.project(ctx, tx, tenant, pid)
		if e != nil {
			return e
		}
		if p.Revision != expectedProjectRevision {
			return ErrConflict
		}
		source, e := s.run(ctx, tx, tenant, pid, sourceRunID)
		if e != nil {
			return e
		}
		switch source.Status {
		case "paused", "failed", "completed", "cancelled":
		default:
			return fmt.Errorf("%w: source must be paused or stopped before forking", ErrInvalidState)
		}
		var unresolved int
		if e = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_operations WHERE tenant_id=? AND project_id=? AND run_id=? AND status IN ('prepared','approved','running','unknown','pending_approval')`), tenant, pid, sourceRunID).Scan(&unresolved); e != nil {
			return e
		}
		if unresolved > 0 {
			return fmt.Errorf("%w: reconcile source operations before forking", ErrInvalidState)
		}
		frozen, e := s.frozenProject(ctx, tx, tenant, pid, sourceRunID)
		if e != nil {
			return e
		}
		oldTasks, e := s.listTasks(ctx, tx, tenant, pid, sourceRunID)
		if e != nil {
			return e
		}
		oldBySpec := map[string]mission.Task{}
		for _, t := range oldTasks {
			oldBySpec[t.Spec.ID] = t
		}
		newBySpec := map[string]mission.TaskSpec{}
		for _, spec := range p.Plan.Tasks {
			newBySpec[spec.ID] = spec
		}
		eligible := map[string]bool{}
		visited := map[string]bool{}
		var retain func(string) bool
		retain = func(id string) bool {
			if visited[id] {
				return eligible[id]
			}
			visited[id] = true
			t, old := oldBySpec[id]
			spec, current := newBySpec[id]
			ok := old && current && frozen.Goal == p.Goal && t.Status == "completed" && t.SnapshotID != "" && plan.ExecutionEquivalent(t.Spec, spec) && plan.AcceptanceEquivalent(t.Spec.Checks, spec.Checks)
			if ok {
				for _, dep := range spec.DependsOn {
					if !retain(dep) {
						ok = false
						break
					}
				}
			}
			eligible[id] = ok
			return ok
		}
		r, e := s.createRunTx(ctx, tx, p, source.BaseSnapshot)
		if e != nil {
			return e
		}
		scope := scopeOf(p)
		newTasks, e := s.listTasks(ctx, tx, tenant, pid, r.ID)
		if e != nil {
			return e
		}
		reused := 0
		for _, t := range newTasks {
			if !retain(t.Spec.ID) {
				continue
			}
			previous := oldBySpec[t.Spec.ID]
			proof, e := s.verification(ctx, tx, scope, sourceRunID, previous.ID)
			if e != nil {
				return e
			}
			if proof.Status != "passed" || proof.SnapshotID != previous.SnapshotID {
				return fmt.Errorf("%w: reusable task has no matching passed verification", ErrInvalidState)
			}
			if e = acceptance.ValidateVerification(t.Spec.Checks, proof); e != nil {
				return fmt.Errorf("%w: retained verification: %v", ErrInvalidState, e)
			}
			t.Status = "completed"
			if p.Config.RequireReview {
				t.Status = "waiting_review"
			}
			t.BranchID = ""
			t.BaseSnapshot = previous.BaseSnapshot
			t.SnapshotID = previous.SnapshotID
			t.Result = previous.Result
			t.ReusedFromRunID = sourceRunID
			t.ReusedFromTaskID = previous.ID
			t.Revision++
			t.UpdatedAt = s.now()
			if e = s.putTask(ctx, tx, scope, t); e != nil {
				return e
			}
			id, e := newID()
			if e != nil {
				return e
			}
			proof.ID = id
			proof.TaskID = t.ID
			proof.BranchID = ""
			proof.CreatedAt = s.now()
			raw, e := encode(proof)
			if e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_verifications(id,tenant_id,project_id,run_id,task_id,revision,verification_json,created_at) VALUES(?,?,?,?,?,?,?,?)`), id, tenant, pid, r.ID, t.ID, t.Revision, raw, stamp(proof.CreatedAt)); e != nil {
				return e
			}
			if e = s.event(ctx, tx, scope, r.ID, t.ID, "task.output_reused", map[string]any{"sourceRunId": sourceRunID, "sourceTaskId": previous.ID, "snapshotId": previous.SnapshotID, "status": t.Status}); e != nil {
				return e
			}
			reused++
		}
		if e = s.refreshRun(ctx, tx, scope, r); e != nil {
			return e
		}
		out, e = s.run(ctx, tx, tenant, pid, r.ID)
		if e != nil {
			return e
		}
		return s.event(ctx, tx, scope, r.ID, "", "run.forked", map[string]any{"sourceRunId": sourceRunID, "retainedTasks": reused, "planVersion": p.Plan.Version})
	})
	return out, err
}
