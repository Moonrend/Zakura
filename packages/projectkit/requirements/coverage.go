// SPDX-License-Identifier: AGPL-3.0-or-later
package requirements

import (
	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func Evaluate(input Input) Coverage {
	bound := input.Binding.Baseline
	result := Coverage{RunID: input.Run.ID, BaselineID: bound.ID, BaselineRevision: bound.Revision, BaselineHash: input.Binding.BaselineHash, FrozenPlanHash: PlanHash(input.FrozenProject.Plan), ApprovedPlanHash: bound.ApprovedPlanHash, Bound: input.Binding.RunID != "", RequiredBeforePublication: bound.RequiredBeforePublication, PublicationAllowed: true, Rows: []CoverageRow{}, Issues: Analyze(bound.Clauses, input.FrozenProject.Plan).Issues}
	if !result.Bound {
		return result
	}
	planChanged := result.FrozenPlanHash != bound.ApprovedPlanHash || result.FrozenPlanHash != input.Binding.FrozenPlanHash || BaselineHash(bound) != input.Binding.BaselineHash || bound.Status != "approved" || bound.ApprovedBy == "" || bound.ApprovedAt == nil
	tasks := map[string]mission.Task{}
	cached := map[Binding]Evidence{}
	for _, task := range input.Tasks {
		if task.RunID == input.Run.ID {
			tasks[task.Spec.ID] = task
		}
	}
	for _, clause := range bound.Clauses {
		row := CoverageRow{Clause: clause, Status: "passed", Evidence: []Evidence{}}
		if clause.Required {
			result.RequiredTotal++
		}
		if planChanged {
			row.Status = "changed_plan"
		}
		if len(clause.Bindings) == 0 {
			row.Status = "missing"
		}
		for _, binding := range clause.Bindings {
			evidence := Evidence{TaskSpecID: binding.TaskSpecID, CheckID: binding.CheckID, Status: "missing", Reason: "Mapped task or acceptance check is missing"}
			task, exists := tasks[binding.TaskSpecID]
			if saved, known := cached[binding]; known {
				evidence = saved
			} else if exists {
				evidence.TaskID = task.ID
				evidence.SnapshotID = task.SnapshotID
				evidence = checkEvidence(input, task, binding, evidence)
				cached[binding] = evidence
			}
			if planChanged {
				evidence.Status = "changed_plan"
				evidence.Reason = "Frozen run execution/check semantics differ from the human-approved baseline"
			}
			row.Evidence = append(row.Evidence, evidence)
			row.Status = combine(row.Status, evidence.Status)
		}
		if clause.Required && row.Status == "passed" {
			result.RequiredPassed++
		}
		result.Rows = append(result.Rows, row)
	}
	if result.RequiredBeforePublication {
		result.PublicationAllowed = result.RequiredPassed == result.RequiredTotal && !planChanged
	}
	return result
}
func combine(left, right string) string {
	weight := map[string]int{"passed": 0, "pending": 1, "review_unapproved": 2, "missing": 3, "failed": 4, "changed_plan": 5}
	if weight[right] > weight[left] {
		return right
	}
	return left
}
func checkEvidence(input Input, task mission.Task, binding Binding, out Evidence) Evidence {
	var frozen *mission.TaskSpec
	for i := range input.FrozenProject.Plan.Tasks {
		if input.FrozenProject.Plan.Tasks[i].ID == binding.TaskSpecID {
			frozen = &input.FrozenProject.Plan.Tasks[i]
			break
		}
	}
	if frozen == nil {
		return out
	}
	if PlanHash(mission.Plan{Tasks: []mission.TaskSpec{*frozen}}) != PlanHash(mission.Plan{Tasks: []mission.TaskSpec{task.Spec}}) {
		out.Status = "changed_plan"
		out.Reason = "Task execution/check semantics differ from its frozen run definition"
		return out
	}
	found := false
	for _, spec := range task.Spec.Checks {
		if spec.ID == binding.CheckID {
			found = true
			break
		}
	}
	if !found {
		return out
	}
	if task.Status == "failed" || task.Status == "cancelled" {
		out.Status = "failed"
		out.Reason = "Mapped task failed or was cancelled"
		return out
	}
	verification, exists := input.Verifications[task.ID]
	if !exists {
		out.Status = "pending"
		out.Reason = "No immutable acceptance evidence has been recorded"
		return out
	}
	out.VerificationID = verification.ID
	if verification.TaskID != task.ID || verification.SnapshotID == "" || verification.SnapshotID != task.SnapshotID {
		out.Status = "missing"
		out.Reason = "Acceptance evidence does not bind the task's current immutable snapshot"
		return out
	}
	if err := acceptance.ValidateVerification(task.Spec.Checks, verification); err != nil {
		out.Status = "failed"
		out.Reason = "Acceptance proof does not match the frozen check semantics: " + err.Error()
		return out
	}
	for _, check := range verification.Checks {
		if check.ID == binding.CheckID {
			out.Summary = check.Summary
			if check.Status != "passed" {
				out.Status = "failed"
				out.Reason = "The exact mapped acceptance check did not pass"
				return out
			}
			break
		}
	}
	if task.Status == "waiting_review" {
		out.Status = "review_unapproved"
		out.Reason = "Human task approval is still outstanding"
		return out
	}
	if task.Status != "completed" {
		out.Status = "pending"
		out.Reason = "Mapped task has not completed"
		return out
	}
	if input.FrozenProject.Config.RequireReview {
		latest, exists := input.Reviews[task.ID]
		if !exists || latest.RunID != input.Run.ID || latest.TaskID != task.ID || latest.SnapshotID != task.SnapshotID || latest.Decision != "approved" || latest.AuthorID == "" {
			out.Status = "review_unapproved"
			out.Reason = "No current local human approval covers this exact task snapshot"
			return out
		}
		out.ReviewID = latest.ID
	}
	out.Status = "passed"
	out.Reason = "Mapped check passed on the task snapshot and all required local reviews are approved"
	return out
}
