// SPDX-License-Identifier: AGPL-3.0-or-later
package campaign

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func Compare(d Definition, observations []Observation, now time.Time) Comparison {
	result := Comparison{BaselineID: d.BaselineID, Comparable: true, Reasons: []string{}, Differences: []Difference{}, Measurements: []Measurement{}, ReservedBudget: d.ReservedBudget, ObservedAt: now.UTC()}
	byID := map[string]Observation{}
	for _, o := range observations {
		byID[o.VariantID] = o
	}
	var baseline mission.Project
	for _, v := range d.Variants {
		if v.ID == d.BaselineID {
			baseline = v.Project
		}
	}
	for _, variant := range d.Variants {
		o := byID[variant.ID]
		if o.Run != nil && (o.Project == nil || o.Error != "") {
			result.Comparable = false
			result.Reasons = append(result.Reasons, "variant "+variant.ID+" frozen run or evidence is unavailable")
		}
		row := measure(variant, o, now)
		result.Measurements = append(result.Measurements, row)
		result.ChargedTokens += row.ChargedTokens
		result.ModelCalls += row.ModelCalls
		result.ToolCalls += row.ToolCalls
		candidate := variant.Project
		if o.Project != nil {
			candidate = *o.Project
			if ProjectHash(candidate) != variant.DefinitionHash {
				result.Comparable = false
				result.Reasons = append(result.Reasons, "variant "+variant.ID+" execution definition differs from its frozen campaign grant")
			}
		}
		diffs, comparable := compareProjects(d.BaselineID, variant.ID, baseline, candidate)
		result.Differences = append(result.Differences, diffs...)
		if !comparable {
			result.Comparable = false
			result.Reasons = append(result.Reasons, "variant "+variant.ID+" task graph, prompts, writes or acceptance differ from baseline")
		}
		if row.Samples == 0 || !row.Terminal {
			result.Reasons = append(result.Reasons, "variant "+variant.ID+" has no complete run sample")
		}
	}
	result.Reasons = append(result.Reasons, "One run per variant is insufficient to estimate statistical success probability; rates describe observed checks only.")
	result.Reasons = append(result.Reasons, "Agent configuration, available tools and gateway/provider routing are resolved during execution; their external versions are not frozen by the campaign.")
	return result
}

func measure(v Variant, o Observation, now time.Time) Measurement {
	row := Measurement{VariantID: v.ID, Name: v.Name, ProjectID: v.Project.ID, Status: v.State, TotalTasks: len(v.Project.Plan.Tasks), Unknown: []string{}, Error: o.Error}
	for _, task := range v.Project.Plan.Tasks {
		for _, check := range task.Checks {
			if check.Required {
				row.RequiredChecksTotal++
			}
		}
	}
	if o.Run == nil {
		row.Unknown = append(row.Unknown, "run_not_observed")
		return row
	}
	run := *o.Run
	row.RunID = run.ID
	row.Status = run.Status
	row.Terminal = Terminal(run.Status)
	row.Samples = 1
	row.ChargedTokens = run.Tokens
	row.ModelCalls = run.ModelCalls
	row.ToolCalls = run.ToolCalls
	row.Unknown = append(row.Unknown, "provider_reported_token_total_unavailable")
	row.Unknown = append(row.Unknown, "resolved_provider_model_identity_not_recorded")
	if o.Project == nil {
		row.Unknown = append(row.Unknown, "frozen_run_definition_unavailable")
	}
	end := now
	if row.Terminal {
		end = run.UpdatedAt
	}
	if end.After(run.CreatedAt) {
		row.ElapsedSeconds = end.Sub(run.CreatedAt).Seconds()
	}
	specs := map[string]mission.TaskSpec{}
	for _, task := range v.Project.Plan.Tasks {
		specs[task.ID] = task
	}
	seen := map[string]bool{}
	for _, task := range o.Tasks {
		if task.RunID != run.ID {
			row.Unknown = append(row.Unknown, "task_run_identity_mismatch:"+task.ID)
			continue
		}
		expected, ok := specs[task.Spec.ID]
		if !ok || seen[task.Spec.ID] {
			continue
		}
		seen[task.Spec.ID] = true
		if !reflect.DeepEqual(expected, task.Spec) {
			row.Unknown = append(row.Unknown, "task_spec_changed:"+task.Spec.ID)
			continue
		}
		if task.Status == "completed" {
			row.CompletedTasks++
		}
		if task.SnapshotID == "" {
			continue
		}
		var latest *mission.Verification
		for i := range o.Verifications {
			verification := &o.Verifications[i]
			if verification.TaskID != task.ID || verification.SnapshotID != task.SnapshotID {
				continue
			}
			if latest == nil || verification.CreatedAt.After(latest.CreatedAt) || verification.CreatedAt.Equal(latest.CreatedAt) && verification.ID > latest.ID {
				latest = verification
			}
		}
		if latest != nil {
			if acceptance.ValidateVerification(expected.Checks, *latest) != nil {
				row.Unknown = append(row.Unknown, "invalid_acceptance_evidence:"+task.Spec.ID)
				continue
			}
			for _, check := range latest.Checks {
				if check.Required {
					row.RequiredChecksObserved++
					if check.Status == "passed" {
						row.RequiredChecksPassed++
					}
				}
			}
		}
	}
	if row.Terminal && row.RequiredChecksObserved == row.RequiredChecksTotal && row.RequiredChecksTotal > 0 {
		rate := float64(row.RequiredChecksPassed) / float64(row.RequiredChecksTotal)
		row.AcceptanceRate = &rate
	} else {
		row.Unknown = append(row.Unknown, "required_acceptance_not_fully_observed")
	}
	return row
}

func compareProjects(baselineID, variantID string, baseline, candidate mission.Project) ([]Difference, bool) {
	differences := []Difference{}
	comparable := true
	left := map[string]mission.TaskSpec{}
	for _, task := range baseline.Plan.Tasks {
		left[task.ID] = task
	}
	if len(left) != len(candidate.Plan.Tasks) {
		comparable = false
		differences = append(differences, Difference{VariantID: variantID, Field: "taskCount", Baseline: fmt.Sprint(len(left)), Candidate: fmt.Sprint(len(candidate.Plan.Tasks))})
	}
	for _, task := range candidate.Plan.Tasks {
		original, ok := left[task.ID]
		if !ok {
			comparable = false
			differences = append(differences, Difference{VariantID: variantID, TaskID: task.ID, Field: "task", Baseline: "absent", Candidate: "present"})
			continue
		}
		if task.AgentID != original.AgentID {
			differences = append(differences, Difference{VariantID: variantID, TaskID: task.ID, Field: "agentId", Baseline: original.AgentID, Candidate: task.AgentID})
		}
		if task.Model != original.Model {
			differences = append(differences, Difference{VariantID: variantID, TaskID: task.ID, Field: "model", Baseline: original.Model, Candidate: task.Model})
		}
		task.AgentID = original.AgentID
		task.Model = original.Model
		task.DependsOn = append([]string{}, task.DependsOn...)
		original.DependsOn = append([]string{}, original.DependsOn...)
		sort.Strings(task.DependsOn)
		sort.Strings(original.DependsOn)
		if !reflect.DeepEqual(task, original) {
			comparable = false
			rawLeft, _ := json.Marshal(original)
			rawRight, _ := json.Marshal(task)
			differences = append(differences, Difference{VariantID: variantID, TaskID: task.ID, Field: "executionOrAcceptance", Baseline: string(rawLeft), Candidate: string(rawRight)})
		}
	}
	if baseline.Goal != candidate.Goal {
		comparable = false
		differences = append(differences, Difference{VariantID: variantID, Field: "goal", Baseline: baseline.Goal, Candidate: candidate.Goal})
	}
	return differences, comparable
}
