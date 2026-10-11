// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func (e *Engine) process(ctx context.Context, ref FenceRequest, a mission.Assignment) error {
	if a.Project.Config.Budget.MaxWallSeconds > 0 {
		deadline := a.Run.CreatedAt.Add(time.Duration(a.Project.Config.Budget.MaxWallSeconds) * time.Second)
		bounded, cancel := context.WithDeadline(ctx, deadline)
		defer cancel()
		ctx = bounded
	}
	if err := e.initializeBranch(ctx, ref, &a); err != nil {
		return fmt.Errorf("initialize dependency workspace: %w", err)
	}
	cp := a.Checkpoint
	if cp.ID == "" {
		cp = mission.Checkpoint{TaskID: a.Task.ID, Sequence: cp.Sequence, Messages: []mission.Message{{"role": "user", "content": a.Task.Spec.Prompt}}}
		var err error
		cp, err = e.store.SaveCheckpoint(ctx, ref, cp)
		if err != nil {
			return fmt.Errorf("initialize task checkpoint: %w", err)
		}
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := e.store.RenewLease(ctx, ref, e.config.Lease); err != nil {
			return err
		}
		a.Checkpoint = cp
		if cp.Decision == nil {
			if modelDecisionCount(cp) >= e.config.MaxTurns {
				return errors.New("task model decision limit reached")
			}
			allowance, err := e.store.ReserveDecisionBudget(ctx, ref, e.config.MaxDecisionTokens)
			if err != nil {
				return fmt.Errorf("reserve model decision budget: %w", err)
			}
			a.TokenAllowance = allowance
			decision, err := e.executor.Advance(ctx, a)
			if err != nil {
				return fmt.Errorf("model decision: %w", err)
			}
			decision, err = normalizeDecision(decision)
			if err != nil {
				return fmt.Errorf("invalid model decision: %w", err)
			}
			cp, err = e.store.RecordModelDecision(ctx, ref, cp.Sequence, decision)
			if err != nil {
				return fmt.Errorf("persist model decision: %w", err)
			}
			a.Checkpoint = cp
		}
		if cp.Decision == nil {
			return errors.New("persisted model decision is absent")
		}
		if cp.Decision.Done {
			return e.verifyAndFinish(ctx, ref, a, cp.Decision.Result)
		}
		if cp.NextTool < 0 || cp.NextTool > len(cp.Decision.Tools) {
			return errors.New("persisted tool cursor is outside decision")
		}
		for cp.NextTool < len(cp.Decision.Tools) {
			if err := ctx.Err(); err != nil {
				return err
			}
			call := cp.Decision.Tools[cp.NextTool]
			operation, _, err := e.store.BeginOperation(ctx, ref, cp.ID, call)
			if err != nil {
				return fmt.Errorf("prepare tool operation: %w", err)
			}
			a.Checkpoint = cp
			operation, err = e.executeOperation(ctx, ref, a, operation)
			if err != nil {
				return err
			}
			cp.Messages = append(cp.Messages, operationResultMessage(operation))
			cp.NextTool++
			cp, err = e.store.SaveCheckpoint(ctx, ref, cp)
			if err != nil {
				return fmt.Errorf("advance tool checkpoint: %w", err)
			}
		}
		cp.Decision = nil
		cp.NextTool = 0
		var err error
		cp, err = e.store.SaveCheckpoint(ctx, ref, cp)
		if err != nil {
			return fmt.Errorf("close model decision checkpoint: %w", err)
		}
	}
}

func (e *Engine) initializeBranch(ctx context.Context, ref FenceRequest, a *mission.Assignment) error {
	if a.Task.BranchID != "" {
		return nil
	}
	tasks, err := e.store.ListTasks(ctx, a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID)
	if err != nil {
		return err
	}
	bySpec := make(map[string]mission.Task, len(tasks))
	for _, task := range tasks {
		bySpec[task.Spec.ID] = task
	}
	a.DependencyResults = make(map[string]string, len(a.Task.Spec.DependsOn))
	for _, id := range a.Task.Spec.DependsOn {
		task, ok := bySpec[id]
		if !ok || task.Status != "completed" {
			return fmt.Errorf("dependency %s is not complete", id)
		}
		if task.SnapshotID == "" {
			return fmt.Errorf("dependency %s has no immutable output snapshot", id)
		}
		a.DependencyResults[id] = task.Result
	}
	base, err := composeDependencies(ctx, e.workspaces, a.Scope, a.Run.BaseSnapshot, tasks, a.Task.Spec.DependsOn)
	if err != nil {
		return fmt.Errorf("compose dependency artifacts: %w", err)
	}
	if a.Task.ForkSnapshotID != "" {
		// A reused immutable artifact that is rejected by its new reviewer is
		// revised on this run's new branch. Never open its source run's mutable
		// worktree, even though the source artifact itself remains reusable.
		base = a.Task.ForkSnapshotID
	}
	if base == "" {
		return errors.New("workspace provider returned an empty composed snapshot")
	}
	if err := e.store.RenewLease(ctx, ref, e.config.Lease); err != nil {
		return err
	}
	branch, err := e.workspaces.Fork(ctx, a.Scope, base, a.Task.ID)
	if err != nil {
		return fmt.Errorf("fork isolated task branch: %w", err)
	}
	if branch == "" {
		return errors.New("workspace provider returned an empty task branch")
	}
	if err := e.store.InitializeTaskBranch(ctx, ref, branch, base); err != nil {
		return err
	}
	a.Task.BranchID = branch
	a.Task.BaseSnapshot = base
	return nil
}

func (e *Engine) executeOperation(ctx context.Context, ref FenceRequest, a mission.Assignment, operation mission.Operation) (mission.Operation, error) {
	switch operation.Status {
	case "completed", "failed":
		return operation, nil
	case "pending_approval", "unknown":
		return operation, errAwaitingDecision
	case "prepared", "approved":
		if err := e.store.RenewLease(ctx, ref, e.config.Lease); err != nil {
			return operation, err
		}
		started, err := e.store.StartOperation(ctx, ref, operation.ID, operation.Revision)
		if err != nil {
			return operation, fmt.Errorf("persist tool dispatch: %w", err)
		}
		operation = started
		result, performErr := e.executor.Perform(ctx, a, operation)
		if ctx.Err() != nil {
			return operation, ctx.Err()
		}
		if performErr != nil {
			if operation.Call.Effect == "read" {
				result = mission.ToolResult{Error: performErr.Error()}
			} else {
				return e.recoverOperation(ctx, ref, a, operation, performErr)
			}
		}
		if err := e.store.CompleteOperation(ctx, ref, operation.ID, result); err != nil {
			return operation, fmt.Errorf("persist tool result: %w", err)
		}
		return e.store.GetOperation(ctx, a.Scope, a.Run.ID, operation.ID)
	case "running":
		return e.recoverOperation(ctx, ref, a, operation, nil)
	default:
		return operation, fmt.Errorf("operation %s has unsupported state %s", operation.ID, operation.Status)
	}
}

func (e *Engine) recoverOperation(ctx context.Context, ref FenceRequest, a mission.Assignment, operation mission.Operation, dispatchErr error) (mission.Operation, error) {
	if err := e.store.RenewLease(ctx, ref, e.config.Lease); err != nil {
		return operation, err
	}
	inspection, inspectErr := e.executor.Inspect(ctx, a, operation)
	if ctx.Err() != nil {
		return operation, ctx.Err()
	}
	if inspectErr == nil && inspection.Known {
		if err := e.store.CompleteOperation(ctx, ref, operation.ID, inspection.Result); err != nil {
			return operation, fmt.Errorf("persist inspected tool result: %w", err)
		}
		return e.store.GetOperation(ctx, a.Scope, a.Run.ID, operation.ID)
	}
	if operation.Call.Effect == "read" {
		// Reads have no external mutation. Reissuing uses the same operation ID;
		// the result is still persisted before the next model decision.
		if err := e.store.RenewLease(ctx, ref, e.config.Lease); err != nil {
			return operation, err
		}
		result, err := e.executor.Perform(ctx, a, operation)
		if ctx.Err() != nil {
			return operation, ctx.Err()
		}
		if err != nil {
			result = mission.ToolResult{Error: err.Error()}
		}
		if err := e.store.CompleteOperation(ctx, ref, operation.ID, result); err != nil {
			return operation, fmt.Errorf("persist repeated read result: %w", err)
		}
		return e.store.GetOperation(ctx, a.Scope, a.Run.ID, operation.ID)
	}
	// A workspace mutation is replayable only when its runner explicitly
	// confirms a known result. Unknown is never translated into not-performed.
	reason := "tool outcome is unknown; inspect the target system before resolving"
	if dispatchErr != nil {
		reason += "; dispatch: " + dispatchErr.Error()
	}
	if inspectErr != nil {
		reason += "; inspection: " + inspectErr.Error()
	}
	if err := e.store.MarkOperationUnknown(ctx, ref, operation.ID, reason); err != nil {
		return operation, fmt.Errorf("persist unknown tool outcome: %w", err)
	}
	return operation, errAwaitingDecision
}

func (e *Engine) verifyAndFinish(ctx context.Context, ref FenceRequest, a mission.Assignment, result string) error {
	if err := e.store.RenewLease(ctx, ref, e.config.Lease); err != nil {
		return err
	}
	before, err := e.workspaces.Snapshot(ctx, a.Scope, a.Task.BranchID)
	if err != nil {
		return fmt.Errorf("snapshot task output: %w", err)
	}
	if before == "" {
		return errors.New("task output snapshot is empty")
	}
	if a.Task.BaseSnapshot == "" {
		return errors.New("task has no persisted dependency workspace baseline")
	}
	if err := e.workspaces.ValidateWrites(ctx, a.Scope, a.Task.BaseSnapshot, a.Task.BranchID, a.Task.Spec.Writes); err != nil {
		return fmt.Errorf("task changed files outside its write claims: %w", err)
	}
	verification, err := e.workspaces.Verify(ctx, a.Scope, a.Task.BranchID, a.Task.Spec.Checks)
	if err != nil {
		return fmt.Errorf("verify task output: %w", err)
	}
	verification.TaskID = a.Task.ID
	if verification.BranchID == "" {
		verification.BranchID = a.Task.BranchID
	}
	if verification.BranchID != a.Task.BranchID || verification.SnapshotID != before {
		return errors.New("verification is not bound to the task output snapshot")
	}
	if err := acceptance.ValidateVerification(a.Task.Spec.Checks, verification); err != nil {
		return fmt.Errorf("invalid verification evidence: %w", err)
	}
	after, err := e.workspaces.Snapshot(ctx, a.Scope, a.Task.BranchID)
	if err != nil {
		return fmt.Errorf("confirm verified output snapshot: %w", err)
	}
	if after != before {
		return errors.New("task workspace changed during verification")
	}
	verification, err = e.store.RecordVerification(ctx, ref, verification)
	if err != nil {
		return fmt.Errorf("persist task verification: %w", err)
	}
	passed, err := acceptance.VerificationPassed(a.Task.Spec.Checks, verification)
	if err != nil {
		return err
	}
	if !passed {
		return fmt.Errorf("task acceptance checks did not pass (%s)", verification.Status)
	}
	if err := e.store.CompleteTask(ctx, ref, result, before); err != nil {
		return fmt.Errorf("complete verified task: %w", err)
	}
	return nil
}
