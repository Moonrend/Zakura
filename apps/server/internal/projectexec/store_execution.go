package projectexec

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func (s *Store) fenced(ctx context.Context, tx *sql.Tx, ref FenceRequest) (mission.Task, mission.Run, mission.Project, error) {
	t, e := s.task(ctx, tx, ref.Scope, ref.RunID, ref.TaskID)
	if e != nil {
		return t, mission.Run{}, mission.Project{}, e
	}
	r, e := s.run(ctx, tx, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID)
	if e != nil {
		return t, r, mission.Project{}, e
	}
	if ref.Owner == "" || ref.Fence <= 0 || t.Fence != ref.Fence || t.LeaseOwner != ref.Owner || t.LeaseUntil == nil || !t.LeaseUntil.After(s.now()) {
		return t, r, mission.Project{}, ErrLeaseLost
	}
	if e = s.RequireTenantActive(ctx, tx, ref.Scope.TenantID); e != nil {
		return t, r, mission.Project{}, e
	}
	if (t.Status != "running" && t.Status != "verifying") || r.Status != "running" {
		return t, r, mission.Project{}, ErrInvalidState
	}
	p, e := s.frozenProject(ctx, tx, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID)
	return t, r, p, e
}
func (s *Store) checkpoint(ctx context.Context, q sqlReader, scope mission.Scope, rid, tid string) (mission.Checkpoint, error) {
	t, e := s.task(ctx, q, scope, rid, tid)
	if e != nil {
		return mission.Checkpoint{}, e
	}
	if t.CheckpointID == "" {
		var sequence int64
		if e = q.QueryRowContext(ctx, s.rebind(`SELECT COALESCE(MAX(sequence),0) FROM execution_checkpoints WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=?`), scope.TenantID, scope.ProjectID, rid, tid).Scan(&sequence); e != nil {
			return mission.Checkpoint{}, e
		}
		return mission.Checkpoint{TaskID: tid, Sequence: sequence, Messages: []mission.Message{}}, nil
	}
	var raw string
	e = q.QueryRowContext(ctx, s.rebind(`SELECT checkpoint_json FROM execution_checkpoints WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? AND id=?`), scope.TenantID, scope.ProjectID, rid, tid, t.CheckpointID).Scan(&raw)
	if e != nil {
		return mission.Checkpoint{}, notFound(e)
	}
	var cp mission.Checkpoint
	e = json.Unmarshal([]byte(raw), &cp)
	return cp, e
}

func (s *Store) GetCheckpoint(ctx context.Context, scope mission.Scope, rid, tid string) (mission.Checkpoint, error) {
	if _, e := s.task(ctx, s.db, scope, rid, tid); e != nil {
		return mission.Checkpoint{}, e
	}
	return s.checkpoint(ctx, s.db, scope, rid, tid)
}
func (s *Store) ClaimTask(ctx context.Context, owner string, lease time.Duration) (*mission.Assignment, error) {
	if owner == "" || lease <= 0 || lease > 24*time.Hour {
		return nil, ErrInvalidState
	}
	type candidate struct {
		scope     mission.Scope
		rid, tid  string
		priority  int
		createdAt string
	}
	var cursor *candidate
	saturatedRuns := map[string]bool{}
	fairDeferredProjects := map[string]bool{}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		query := `SELECT t.tenant_id,p.space_id,t.project_id,t.run_id,t.id,t.priority,t.created_at FROM execution_tasks t JOIN execution_projects p ON p.id=t.project_id AND p.tenant_id=t.tenant_id JOIN execution_runs r ON r.id=t.run_id AND r.tenant_id=t.tenant_id AND r.project_id=t.project_id WHERE r.status IN ('pending','running') AND NOT EXISTS (SELECT 1 FROM execution_tenant_controls control WHERE control.tenant_id=t.tenant_id AND control.draining!=0) AND ((t.status='pending' AND NOT EXISTS (SELECT 1 FROM execution_task_dependencies d JOIN execution_tasks dependency ON dependency.run_id=d.run_id AND dependency.id=d.dependency_id AND dependency.tenant_id=d.tenant_id AND dependency.project_id=d.project_id WHERE d.tenant_id=t.tenant_id AND d.project_id=t.project_id AND d.run_id=t.run_id AND d.task_id=t.id AND dependency.status!='completed')) OR (t.status IN ('running','verifying') AND (t.lease_until IS NULL OR t.lease_until<=?)))`
		args := []any{stamp(s.now())}
		if cursor != nil {
			query += ` AND (t.priority<? OR (t.priority=? AND (t.created_at>? OR (t.created_at=? AND t.id>?))))`
			args = append(args, cursor.priority, cursor.priority, cursor.createdAt, cursor.createdAt, cursor.tid)
		}
		query += ` ORDER BY t.priority DESC,t.created_at,t.id LIMIT 256`
		rows, e := s.db.QueryContext(ctx, s.rebind(query), args...)
		if e != nil {
			return nil, e
		}

		candidates := []candidate{}
		for rows.Next() {
			var c candidate
			if e = rows.Scan(&c.scope.TenantID, &c.scope.SpaceID, &c.scope.ProjectID, &c.rid, &c.tid, &c.priority, &c.createdAt); e != nil {
				rows.Close()
				return nil, e
			}
			candidates = append(candidates, c)
		}
		e = rows.Err()
		if ce := rows.Close(); e == nil {
			e = ce
		}
		if e != nil {
			return nil, e
		}
		for _, c := range candidates {
			if saturatedRuns[c.rid] || fairDeferredProjects[c.scope.TenantID+"\x00"+c.scope.ProjectID] {
				continue
			}
			saturated := false
			fairDeferred := false
			var assignment *mission.Assignment
			e = s.tx(ctx, c.scope.TenantID, c.scope.ProjectID, func(tx *sql.Tx) error {
				if err := s.RequireTenantActive(ctx, tx, c.scope.TenantID); err != nil {
					return err
				}
				r, err := s.run(ctx, tx, c.scope.TenantID, c.scope.ProjectID, c.rid)
				if err != nil {
					return err
				}
				if r.Status != "pending" && r.Status != "running" {
					return nil
				}
				p, err := s.frozenProject(ctx, tx, c.scope.TenantID, c.scope.ProjectID, c.rid)
				if err != nil {
					return err
				}
				tasks, err := s.listTasks(ctx, tx, c.scope.TenantID, c.scope.ProjectID, c.rid)
				if err != nil {
					return err
				}
				var chosen *mission.Task
				byID := map[string]mission.Task{}
				active := 0
				now := s.now()
				for i := range tasks {
					t := tasks[i]
					byID[t.Spec.ID] = t
					if t.ID == c.tid {
						chosen = &tasks[i]
					}
					if (t.Status == "running" || t.Status == "verifying") && t.LeaseUntil != nil && t.LeaseUntil.After(now) {
						active++
					}
				}
				if chosen == nil {
					return nil
				}
				t := *chosen
				expired := (t.Status == "running" || t.Status == "verifying") && (t.LeaseUntil == nil || !t.LeaseUntil.After(now))
				if t.Status != "pending" && !expired {
					return nil
				}
				if p.Config.Budget.MaxConcurrent > 0 && active >= p.Config.Budget.MaxConcurrent {
					saturated = true
					return nil
				}
				depResults := map[string]string{}
				for _, dep := range t.Spec.DependsOn {
					dt, ok := byID[dep]
					if !ok {
						return fmt.Errorf("%w: dependency absent", ErrInvalidState)
					}
					if dt.Status != "completed" {
						return nil
					}
					depResults[dep] = dt.Result
				}
				if p.Config.Budget.MaxWallSeconds > 0 && now.Sub(r.CreatedAt) >= time.Duration(p.Config.Budget.MaxWallSeconds)*time.Second {
					r.Status = "failed"
					r.Error = "wall-time budget exhausted"
					r.Revision++
					r.UpdatedAt = now
					if err = s.stopTasks(ctx, tx, c.scope, r.ID, r.Error); err != nil {
						return err
					}
					if err = s.putRun(ctx, tx, c.scope.TenantID, r); err != nil {
						return err
					}
					return s.event(ctx, tx, c.scope, r.ID, t.ID, "run.budget_exhausted", map[string]any{"kind": "wall"})
				}
				allowed, err := s.portfolioClaimAllowed(ctx, tx, c.scope.TenantID, c.scope.ProjectID)
				if err != nil {
					return err
				}
				if !allowed {
					fairDeferred = true
					return nil
				}
				if !expired && t.Attempt == 0 {
					max := t.Spec.MaxAttempts
					if max <= 0 {
						max = 3
					}
					if t.Attempt >= max {
						t.Status = "failed"
						t.Error = "task attempt limit exhausted"
						t.Revision++
						t.UpdatedAt = now
						if err = s.putTask(ctx, tx, c.scope, t); err != nil {
							return err
						}
						return s.refreshRun(ctx, tx, c.scope, r)
					}
					t.Attempt++
				}
				t.Status = "running"
				t.LeaseOwner = owner
				until := now.Add(lease)
				t.LeaseUntil = &until
				t.Fence++
				t.Revision++
				t.UpdatedAt = now
				if err = s.putTask(ctx, tx, c.scope, t); err != nil {
					return err
				}
				// An unanswered previous model call remains charged. Its reservation is
				// abandoned when a different incarnation resumes, never refunded by guess.
				if _, err = tx.ExecContext(ctx, s.rebind(`UPDATE execution_tasks SET model_allowance=0,model_reserved=0 WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), c.scope.TenantID, c.scope.ProjectID, c.rid, t.ID); err != nil {
					return err
				}
				r.Status = "running"
				r.Revision++
				r.UpdatedAt = now
				if err = s.putRun(ctx, tx, c.scope.TenantID, r); err != nil {
					return err
				}
				cp, err := s.checkpoint(ctx, tx, c.scope, c.rid, t.ID)
				if err != nil {
					return err
				}
				if err = s.recordPortfolioClaim(ctx, tx, c.scope.TenantID, c.scope.ProjectID); err != nil {
					return err
				}
				assignment = &mission.Assignment{Scope: c.scope, Run: r, Task: t, Project: p, Checkpoint: cp, DependencyResults: depResults}
				return s.event(ctx, tx, c.scope, r.ID, t.ID, "task.claimed", map[string]any{"owner": owner, "fence": t.Fence, "recovered": expired})
			})
			if e != nil {
				if errors.Is(e, ErrNotFound) || errors.Is(e, ErrTenantDraining) {
					continue
				}
				return nil, e
			}
			if fairDeferred {
				fairDeferredProjects[c.scope.TenantID+"\x00"+c.scope.ProjectID] = true
			}
			if saturated {
				saturatedRuns[c.rid] = true
			}
			if assignment != nil {
				return assignment, nil
			}
		}
		if len(candidates) < 256 {
			return nil, nil
		}
		last := candidates[len(candidates)-1]
		cursor = &last
	}
}
func (s *Store) RenewLease(ctx context.Context, ref FenceRequest, lease time.Duration) error {
	if lease <= 0 || lease > 24*time.Hour {
		return ErrInvalidState
	}
	return s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		t, _, _, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		until := s.now().Add(lease)
		t.LeaseUntil = &until
		t.UpdatedAt = s.now()
		t.Revision++
		return s.putTask(ctx, tx, ref.Scope, t)
	})
}
func (s *Store) InitializeTaskBranch(ctx context.Context, ref FenceRequest, branch string, baseSnapshots ...string) error {
	base := ""
	if len(baseSnapshots) > 0 {
		base = baseSnapshots[0]
	}
	if branch == "" {
		return ErrInvalidState
	}
	return s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		t, r, _, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		if base == "" {
			if len(t.Spec.DependsOn) > 0 {
				return ErrInvalidState
			}
			base = r.BaseSnapshot
		}
		if t.BranchID != "" {
			if t.BranchID == branch && (base == "" || base == t.BaseSnapshot) {
				return nil
			}
			return ErrConflict
		}
		t.BranchID = branch
		t.BaseSnapshot = base
		t.Revision++
		t.UpdatedAt = s.now()
		if e = s.putTask(ctx, tx, ref.Scope, t); e != nil {
			return e
		}
		return s.event(ctx, tx, ref.Scope, ref.RunID, ref.TaskID, "task.branch_initialized", map[string]any{"branchId": branch})
	})
}
func (s *Store) saveCheckpoint(ctx context.Context, tx *sql.Tx, ref FenceRequest, t *mission.Task, cp mission.Checkpoint) (mission.Checkpoint, error) {
	old, e := s.checkpoint(ctx, tx, ref.Scope, ref.RunID, ref.TaskID)
	if e != nil {
		return mission.Checkpoint{}, e
	}
	if old.Sequence != cp.Sequence {
		return mission.Checkpoint{}, ErrConflict
	}
	if cp.NextTool < 0 || (cp.Decision != nil && cp.NextTool > len(cp.Decision.Tools)) {
		return mission.Checkpoint{}, ErrInvalidState
	}
	id, e := newID()
	if e != nil {
		return mission.Checkpoint{}, e
	}
	cp.ID = id
	cp.TaskID = ref.TaskID
	cp.Sequence = old.Sequence + 1
	cp.CreatedAt = s.now()
	raw, e := encode(cp)
	if e != nil {
		return mission.Checkpoint{}, e
	}
	if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_checkpoints(id,tenant_id,project_id,run_id,task_id,sequence,checkpoint_json,created_at) VALUES(?,?,?,?,?,?,?,?)`), id, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID, cp.Sequence, raw, stamp(cp.CreatedAt)); e != nil {
		return mission.Checkpoint{}, e
	}
	t.CheckpointID = id
	t.Revision++
	t.UpdatedAt = s.now()
	if e = s.putTask(ctx, tx, ref.Scope, *t); e != nil {
		return mission.Checkpoint{}, e
	}
	return cp, s.event(ctx, tx, ref.Scope, ref.RunID, ref.TaskID, "task.checkpoint", map[string]any{"checkpointId": id, "sequence": cp.Sequence, "nextTool": cp.NextTool})
}
func (s *Store) SaveCheckpoint(ctx context.Context, ref FenceRequest, cp mission.Checkpoint) (mission.Checkpoint, error) {
	var out mission.Checkpoint
	e := s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		t, _, _, err := s.fenced(ctx, tx, ref)
		if err != nil {
			return err
		}
		old, err := s.checkpoint(ctx, tx, ref.Scope, ref.RunID, ref.TaskID)
		if err != nil {
			return err
		}
		if old.Sequence != cp.Sequence {
			return ErrConflict
		}
		if old.Decision == nil {
			if cp.Decision != nil || cp.NextTool != 0 {
				return ErrInvalidState
			}
		} else {
			if cp.Decision == nil {
				if old.Decision.Done || old.NextTool != len(old.Decision.Tools) || cp.NextTool != 0 {
					return ErrInvalidState
				}
			} else {
				if !sameJSON(old.Decision, cp.Decision) || cp.NextTool < old.NextTool || cp.NextTool > old.NextTool+1 || cp.NextTool > len(old.Decision.Tools) {
					return ErrInvalidState
				}
				if cp.NextTool == old.NextTool+1 {
					var operationJSON string
					if err = tx.QueryRowContext(ctx, s.rebind(`SELECT operation_json FROM execution_operations WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? AND checkpoint_id=? AND call_id=?`), ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID, old.ID, old.Decision.Tools[old.NextTool].ID).Scan(&operationJSON); err != nil {
						return notFound(err)
					}
					var op mission.Operation
					if err = json.Unmarshal([]byte(operationJSON), &op); err != nil {
						return err
					}
					if op.Status != "completed" && op.Status != "failed" {
						return ErrInvalidState
					}
					expectedMessages := append(append([]mission.Message{}, old.Messages...), operationResultMessage(op))
					if !sameJSON(cp.Messages, expectedMessages) {
						return ErrInvalidState
					}
				}
			}
		}
		advanced := old.Decision != nil && cp.Decision != nil && cp.NextTool == old.NextTool+1
		if old.ID != "" && !advanced && !sameJSON(old.Messages, cp.Messages) {
			return ErrInvalidState
		}
		out, err = s.saveCheckpoint(ctx, tx, ref, &t, cp)
		return err
	})
	return out, e
}
func budgetFits(p mission.Project, r mission.Run, b BudgetReservation) bool {
	if b.ModelCalls < 0 || b.ToolCalls < 0 || b.Tokens < 0 {
		return false
	}
	if r.Tokens > math.MaxInt64-b.Tokens || r.ModelCalls > math.MaxInt-b.ModelCalls || r.ToolCalls > math.MaxInt-b.ToolCalls {
		return false
	}
	limits := p.Config.Budget
	return (limits.MaxTokens == 0 || r.Tokens+b.Tokens <= limits.MaxTokens) && (limits.MaxModelCalls == 0 || r.ModelCalls+b.ModelCalls <= limits.MaxModelCalls) && (limits.MaxToolCalls == 0 || r.ToolCalls+b.ToolCalls <= limits.MaxToolCalls)
}
func (s *Store) reserve(ctx context.Context, tx *sql.Tx, scope mission.Scope, r *mission.Run, p mission.Project, b BudgetReservation) error {
	if b.ModelCalls < 0 || b.ToolCalls < 0 || b.Tokens < 0 {
		return ErrInvalidState
	}
	if p.Config.Budget.MaxWallSeconds > 0 && s.now().Sub(r.CreatedAt) >= time.Duration(p.Config.Budget.MaxWallSeconds)*time.Second {
		return ErrBudgetExceeded
	}
	if !budgetFits(p, *r, b) {
		return ErrBudgetExceeded
	}
	r.ModelCalls += b.ModelCalls
	r.ToolCalls += b.ToolCalls
	r.Tokens += b.Tokens
	r.Revision++
	r.UpdatedAt = s.now()
	return s.putRun(ctx, tx, scope.TenantID, *r)
}
func (s *Store) ReserveBudget(ctx context.Context, ref FenceRequest, b BudgetReservation) error {
	return s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		_, r, p, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		return s.reserve(ctx, tx, ref.Scope, &r, p, b)
	})
}
func (s *Store) ReserveDecisionBudget(ctx context.Context, ref FenceRequest, maxTokens int64) (int64, error) {
	if maxTokens <= 0 {
		return 0, ErrInvalidState
	}
	var allowance int64
	e := s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		task, r, p, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		cp, e := s.checkpoint(ctx, tx, ref.Scope, ref.RunID, ref.TaskID)
		if e != nil {
			return e
		}
		if cp.Decision != nil {
			return ErrInvalidState
		}
		var reserved int
		if e = tx.QueryRowContext(ctx, s.rebind(`SELECT model_reserved FROM execution_tasks WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID).Scan(&reserved); e != nil {
			return e
		}
		if reserved != 0 {
			return ErrConflict
		}
		if e = s.acquireResource(ctx, tx, ref, task, "model"); e != nil {
			return e
		}
		allowance = maxTokens
		if p.Config.Budget.MaxTokens > 0 && allowance > p.Config.Budget.MaxTokens-r.Tokens {
			allowance = p.Config.Budget.MaxTokens - r.Tokens
		}
		if allowance <= 0 {
			return ErrBudgetExceeded
		}
		if e = s.reserve(ctx, tx, ref.Scope, &r, p, BudgetReservation{ModelCalls: 1, Tokens: allowance}); e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, s.rebind(`UPDATE execution_tasks SET model_allowance=?,model_reserved=1 WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), allowance, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID)
		return e
	})
	return allowance, e
}
func (s *Store) RecordModelDecision(ctx context.Context, ref FenceRequest, sequence int64, decision mission.Decision) (mission.Checkpoint, error) {
	normalized, validationErr := normalizeDecision(decision)
	if validationErr != nil {
		return mission.Checkpoint{}, fmt.Errorf("%w: %v", ErrInvalidState, validationErr)
	}
	decision = normalized
	var out mission.Checkpoint
	overBudget := false
	e := s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		t, r, p, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		if decision.Tokens < 0 {
			return ErrInvalidState
		}
		var allowance int64
		var reserved int
		if e = tx.QueryRowContext(ctx, s.rebind(`SELECT model_allowance,model_reserved FROM execution_tasks WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID).Scan(&allowance, &reserved); e != nil {
			return e
		}
		if reserved == 0 {
			return fmt.Errorf("%w: decision must reserve model budget first", ErrInvalidState)
		}
		cp, e := s.checkpoint(ctx, tx, ref.Scope, ref.RunID, ref.TaskID)
		if e != nil {
			return e
		}
		if cp.Sequence != sequence {
			return ErrConflict
		}
		cp.Decision = &decision
		cp.NextTool = 0
		if decision.Message != nil {
			cp.Messages = append(cp.Messages, decision.Message)
		}
		out, e = s.saveCheckpoint(ctx, tx, ref, &t, cp)
		if e != nil {
			return e
		}
		if r.Tokens < allowance || r.Tokens-allowance > math.MaxInt64-decision.Tokens {
			return ErrInvalidState
		}
		r.Tokens = r.Tokens - allowance + decision.Tokens
		overBudget = decision.Tokens > allowance || (p.Config.Budget.MaxTokens > 0 && r.Tokens > p.Config.Budget.MaxTokens)
		r.Revision++
		r.UpdatedAt = s.now()
		if overBudget {
			r.Status = "failed"
			r.Error = "model exceeded reserved token allowance"
			t.Status = "failed"
			t.Error = r.Error
			t.LeaseOwner = ""
			t.LeaseUntil = nil
			t.Fence++
			t.Revision++
			if e = s.putTask(ctx, tx, ref.Scope, t); e != nil {
				return e
			}
		}
		if overBudget {
			if e = s.stopTasks(ctx, tx, ref.Scope, ref.RunID, "run stopped after model exceeded token allowance"); e != nil {
				return e
			}
		}
		if e = s.putRun(ctx, tx, ref.Scope.TenantID, r); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, s.rebind(`UPDATE execution_tasks SET model_allowance=0,model_reserved=0 WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID); e != nil {
			return e
		}
		if e = s.releaseResource(ctx, tx, ref, "model"); e != nil {
			return e
		}
		return s.event(ctx, tx, ref.Scope, ref.RunID, ref.TaskID, "model.decision", map[string]any{"tokens": decision.Tokens, "allowance": allowance, "budgetExceeded": overBudget})
	})
	if e == nil && overBudget {
		e = ErrBudgetExceeded
	}
	return out, e
}
func (s *Store) refreshRun(ctx context.Context, tx *sql.Tx, scope mission.Scope, r mission.Run) error {
	if r.Status == "paused" || r.Status == "cancelled" {
		return nil
	}
	tasks, e := s.listTasks(ctx, tx, scope.TenantID, scope.ProjectID, r.ID)
	if e != nil {
		return e
	}
	bySpec := map[string]int{}
	for i, t := range tasks {
		bySpec[t.Spec.ID] = i
	}
	// Propagate terminal dependency failures. Independent tasks may still run,
	// while a later explicit retry can unblock descendants without losing state.
	for changed := true; changed; {
		changed = false
		for i := range tasks {
			t := &tasks[i]
			if t.Status != "pending" && t.Status != "blocked" {
				continue
			}
			failed := false
			for _, dep := range t.Spec.DependsOn {
				index, ok := bySpec[dep]
				if !ok {
					return ErrInvalidState
				}
				status := tasks[index].Status
				if status == "failed" || status == "cancelled" || status == "blocked" {
					failed = true
				}
			}
			next := t.Status
			if failed {
				next = "blocked"
			} else if t.Status == "blocked" {
				next = "pending"
			}
			if next != t.Status {
				t.Status = next
				t.Error = ""
				if failed {
					t.Error = "dependency failed"
				}
				t.Revision++
				t.UpdatedAt = s.now()
				if e = s.putTask(ctx, tx, scope, *t); e != nil {
					return e
				}
				if e = s.event(ctx, tx, scope, r.ID, t.ID, "task.dependency_status", map[string]any{"status": next}); e != nil {
					return e
				}
				changed = true
			}
		}
	}
	hasRunning, hasReady, hasUnknown, hasReview, hasFailed := false, false, false, false, false
	done := 0
	for _, t := range tasks {
		switch t.Status {
		case "running", "verifying":
			hasRunning = true
		case "pending":
			ready := true
			for _, dep := range t.Spec.DependsOn {
				if tasks[bySpec[dep]].Status != "completed" {
					ready = false
				}
			}
			hasReady = hasReady || ready
		case "unknown":
			hasUnknown = true
		case "waiting_review", "waiting_approval":
			hasReview = true
		case "failed", "blocked":
			hasFailed = true
		case "completed":
			done++
		}
	}
	next := "running"
	switch {
	case hasUnknown:
		next = "unknown"
	case hasRunning || hasReady:
		next = "running"
	case hasReview:
		next = "waiting_review"
	case done == len(tasks):
		next = "completed"
	case hasFailed:
		next = "failed"
	default:
		next = "cancelled"
	}
	if next == r.Status {
		return nil
	}
	r.Status = next
	r.Revision++
	r.UpdatedAt = s.now()
	if e = s.putRun(ctx, tx, scope.TenantID, r); e != nil {
		return e
	}
	return s.event(ctx, tx, scope, r.ID, "", "run.status", map[string]any{"status": next})
}

// Comparing JSON values also canonicalizes RawMessage spacing while keeping
// the original tool argument bytes inside the assistant conversation intact.
func sameJSON(a, b any) bool {
	left, e := json.Marshal(a)
	if e != nil {
		return false
	}
	right, e := json.Marshal(b)
	return e == nil && bytes.Equal(left, right)
}
