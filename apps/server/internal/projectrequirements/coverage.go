// SPDX-License-Identifier: AGPL-3.0-or-later
package projectrequirements

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/requirements"
)

type GateError struct{ Coverage requirements.Coverage }

func (e *GateError) Error() string {
	return fmt.Sprintf("%v: required requirement coverage is incomplete (%d/%d passed)", ErrInvalid, e.Coverage.RequiredPassed, e.Coverage.RequiredTotal)
}
func (e *GateError) Unwrap() error { return ErrInvalid }
func (s *Store) input(ctx context.Context, q reader, scope mission.Scope, runID string) (requirements.Input, error) {
	var input requirements.Input
	var err error
	if _, err = s.project(ctx, q, scope); err != nil {
		return input, err
	}
	input.Run, input.FrozenProject, err = s.run(ctx, q, scope, runID)
	if err != nil {
		return input, err
	}
	input.Binding, _, err = s.binding(ctx, q, scope, runID)
	if err != nil {
		return input, err
	}
	input.Tasks = []mission.Task{}
	input.Verifications = map[string]mission.Verification{}
	input.Reviews = map[string]mission.Review{}
	if input.Binding.RunID == "" {
		return input, nil
	}
	rows, err := q.QueryContext(ctx, s.rebind(`SELECT task_json FROM execution_tasks WHERE tenant_id=? AND project_id=? AND run_id=? ORDER BY id`), scope.TenantID, scope.ProjectID, runID)
	if err != nil {
		return input, err
	}
	for rows.Next() {
		var raw string
		var task mission.Task
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return input, err
		}
		if err = json.Unmarshal([]byte(raw), &task); err != nil {
			rows.Close()
			return input, err
		}
		input.Tasks = append(input.Tasks, task)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return input, err
	}
	rows, err = q.QueryContext(ctx, s.rebind(`SELECT task_id,verification_json FROM execution_verifications WHERE tenant_id=? AND project_id=? AND run_id=? ORDER BY revision DESC,id DESC`), scope.TenantID, scope.ProjectID, runID)
	if err != nil {
		return input, err
	}
	for rows.Next() {
		var id, raw string
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return input, err
		}
		if _, exists := input.Verifications[id]; exists {
			continue
		}
		var verification mission.Verification
		if err = json.Unmarshal([]byte(raw), &verification); err != nil {
			rows.Close()
			return input, err
		}
		input.Verifications[id] = verification
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return input, err
	}
	// Review ordering comes from transactionally monotonic project audit
	// sequence. Imported manifests and wall-clock sort order cannot manufacture
	// a local task approval or revive a superseded review.
	latestReviewIDs := map[string]string{}
	rows, err = q.QueryContext(ctx, s.rebind(`SELECT task_id,event_json FROM execution_events WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id<>'' ORDER BY sequence DESC`), scope.TenantID, scope.ProjectID, runID)
	if err != nil {
		return input, err
	}
	for rows.Next() {
		var taskID, raw string
		if err = rows.Scan(&taskID, &raw); err != nil {
			rows.Close()
			return input, err
		}
		if _, exists := latestReviewIDs[taskID]; exists {
			continue
		}
		var event mission.Event
		if err = json.Unmarshal([]byte(raw), &event); err != nil {
			rows.Close()
			return input, err
		}
		if event.Kind != "task.reviewed" {
			continue
		}
		var payload struct {
			ReviewID string `json:"reviewId"`
		}
		if err = json.Unmarshal(event.Payload, &payload); err != nil {
			rows.Close()
			return input, err
		}
		if payload.ReviewID != "" {
			latestReviewIDs[taskID] = payload.ReviewID
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return input, err
	}
	for taskID, reviewID := range latestReviewIDs {
		var raw string
		err = q.QueryRowContext(ctx, s.rebind(`SELECT review_json FROM execution_reviews WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? AND id=?`), scope.TenantID, scope.ProjectID, runID, taskID, reviewID).Scan(&raw)
		if err != nil {
			return input, notFound(err)
		}
		var review mission.Review
		if err = json.Unmarshal([]byte(raw), &review); err != nil {
			return input, err
		}
		input.Reviews[taskID] = review
	}
	return input, nil
}
func (s *Store) Coverage(ctx context.Context, scope mission.Scope, runID string) (requirements.Coverage, error) {
	_, _, coverage, err := s.RunCoverage(ctx, scope, runID)
	return coverage, err
}
func (s *Store) RunCoverage(ctx context.Context, scope mission.Scope, runID string) (requirements.RunBinding, bool, requirements.Coverage, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return requirements.RunBinding{}, false, requirements.Coverage{}, err
	}
	defer tx.Rollback()
	input, err := s.input(ctx, tx, scope, runID)
	if err != nil {
		return requirements.RunBinding{}, false, requirements.Coverage{}, err
	}
	result := requirements.Evaluate(input)
	return input.Binding, input.Binding.RunID != "", result, tx.Commit()
}

// GateTx requires the caller to hold the same project's mutation lock. Binding
// and all proof reads are part of the publication transaction, closing the
// race between a standalone coverage GET and a concurrent binding or retry.
func (s *Store) GateTx(ctx context.Context, tx *sql.Tx, scope mission.Scope, runID string) error {
	input, err := s.input(ctx, tx, scope, runID)
	if err != nil {
		return err
	}
	coverage := requirements.Evaluate(input)
	if coverage.Bound && coverage.RequiredBeforePublication && !coverage.PublicationAllowed {
		return &GateError{Coverage: coverage}
	}
	return nil
}
func (s *Store) Gate(ctx context.Context, scope mission.Scope, runID string) error {
	coverage, err := s.Coverage(ctx, scope, runID)
	if err != nil {
		return err
	}
	if coverage.Bound && coverage.RequiredBeforePublication && !coverage.PublicationAllowed {
		return &GateError{Coverage: coverage}
	}
	return nil
}

// ArtifactGateTx additionally validates the publication selection and the
// final composed snapshot's acceptance proofs. Passing task-level checks alone
// does not prove that a subset merge contains the required implementation.
func (s *Store) ArtifactGateTx(ctx context.Context, tx *sql.Tx, scope mission.Scope, runID string, selected map[string]string, verifications []mission.Verification, finalSnapshotID string) error {
	input, err := s.input(ctx, tx, scope, runID)
	if err != nil {
		return err
	}
	coverage := requirements.Evaluate(input)
	if !coverage.Bound || !coverage.RequiredBeforePublication {
		return nil
	}
	if !coverage.PublicationAllowed {
		return &GateError{Coverage: coverage}
	}
	tasks := map[string]mission.Task{}
	for _, task := range input.Tasks {
		tasks[task.Spec.ID] = task
	}
	proofs := map[string]*mission.Verification{}
	for i := range verifications {
		candidate := &verifications[i]
		if candidate.SnapshotID != finalSnapshotID {
			continue
		}
		if _, exists := proofs[candidate.TaskID]; exists {
			return invalid("publication repeats requirement acceptance proof")
		}
		proofs[candidate.TaskID] = candidate
	}
	verified := map[string]bool{}
	for _, clause := range input.Binding.Baseline.Clauses {
		if !clause.Required {
			continue
		}
		for _, binding := range clause.Bindings {
			task, exists := tasks[binding.TaskSpecID]
			if !exists || selected[task.ID] == "" || selected[task.ID] != task.SnapshotID {
				return invalid("publication does not include required requirement " + clause.ID + " task " + binding.TaskSpecID)
			}
			proof := proofs[task.ID]
			if finalSnapshotID == "" || proof == nil {
				return invalid("publication lacks final-snapshot requirement acceptance proof for " + clause.ID)
			}
			if !verified[task.ID] {
				if err = acceptance.ValidateVerification(task.Spec.Checks, *proof); err != nil {
					return invalid("publication requirement proof differs from frozen checks: " + err.Error())
				}
				verified[task.ID] = true
			}
			passed := false
			for _, check := range proof.Checks {
				if check.ID == binding.CheckID && check.Status == "passed" {
					passed = true
				}
			}
			if !passed {
				return invalid("required requirement " + clause.ID + " failed on the publication snapshot")
			}
		}
	}
	return nil
}
