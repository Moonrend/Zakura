// SPDX-License-Identifier: AGPL-3.0-or-later
package plan

import (
	"encoding/json"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"sort"
)

// ExecutionEquivalent compares execution inputs, dependency sets and normalized
// write claims. Cosmetic title, priority and retry policy edits do not change a
// completed artifact. Callers must separately compare acceptance and project goal.
func ExecutionEquivalent(left, right mission.TaskSpec) bool { return executionEquivalent(left, right) }

// AcceptanceEquivalent permits check display order changes, but every full
// CheckSpec (including its ID, title and argv) must remain identical. Existing
// evidence can then be checked against the new frozen ordering by check ID.
func AcceptanceEquivalent(left, right []mission.CheckSpec) bool {
	return checkBytes(left) == checkBytes(right)
}

func executionEquivalent(left, right mission.TaskSpec) bool {
	left.ID = ""
	right.ID = ""
	left.Title = ""
	right.Title = ""
	left.Priority = 0
	right.Priority = 0
	left.MaxAttempts = 0
	right.MaxAttempts = 0
	left.Checks = nil
	right.Checks = nil
	return taskBytes(left) == taskBytes(right)
}
func taskBytes(task mission.TaskSpec) string {
	task = cloneTask(task)
	sort.Strings(task.DependsOn)
	for i, raw := range task.Writes {
		if normalized, err := normalizeClaim(raw); err == nil {
			task.Writes[i] = normalized
		}
	}
	sort.Strings(task.Writes)
	sort.Slice(task.Checks, func(i, j int) bool { return task.Checks[i].ID < task.Checks[j].ID })
	raw, _ := json.Marshal(task)
	return string(raw)
}
func checkBytes(checks []mission.CheckSpec) string {
	return taskBytes(mission.TaskSpec{Checks: checks})
}
func stringSetBytes(values []string) string {
	copy := append([]string(nil), values...)
	sort.Strings(copy)
	raw, _ := json.Marshal(copy)
	return string(raw)
}
func planChanges(base, candidate *Graph) []TaskChange {
	ids := map[string]bool{}
	for id := range base.byID {
		ids[id] = true
	}
	for id := range candidate.byID {
		ids[id] = true
	}
	ordered := []string{}
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	changes := []TaskChange{}
	for _, id := range ordered {
		left, leftExists := base.byID[id]
		right, rightExists := candidate.byID[id]
		if !leftExists {
			changes = append(changes, TaskChange{TaskID: id, Kind: "added", ExecutionChanged: true, AcceptanceChanged: true})
			continue
		}
		if !rightExists {
			changes = append(changes, TaskChange{TaskID: id, Kind: "removed", ExecutionChanged: true, AcceptanceChanged: true})
			continue
		}
		change := TaskChange{TaskID: id, Kind: "modified", Fields: []string{}, ExecutionChanged: !executionEquivalent(left, right), AcceptanceChanged: checkBytes(left.Checks) != checkBytes(right.Checks)}
		if left.Title != right.Title {
			change.Fields = append(change.Fields, "title")
		}
		if left.Prompt != right.Prompt {
			change.Fields = append(change.Fields, "prompt")
		}
		if left.AgentID != right.AgentID {
			change.Fields = append(change.Fields, "agentId")
		}
		if left.Model != right.Model {
			change.Fields = append(change.Fields, "model")
		}
		if stringSetBytes(left.DependsOn) != stringSetBytes(right.DependsOn) {
			change.Fields = append(change.Fields, "dependsOn")
		}
		normalizedWrites := func(values []string) string {
			copy := append([]string(nil), values...)
			for i, raw := range copy {
				copy[i], _ = normalizeClaim(raw)
			}
			return stringSetBytes(copy)
		}
		if normalizedWrites(left.Writes) != normalizedWrites(right.Writes) {
			change.Fields = append(change.Fields, "writes")
		}
		if left.Priority != right.Priority {
			change.Fields = append(change.Fields, "priority")
		}
		if left.MaxAttempts != right.MaxAttempts {
			change.Fields = append(change.Fields, "maxAttempts")
		}
		if change.AcceptanceChanged {
			change.Fields = append(change.Fields, "checks")
		}
		if len(change.Fields) > 0 {
			changes = append(changes, change)
		}
	}
	return changes
}
func Replan(base, candidate mission.Plan, tasks []mission.Task, config mission.Config) (ReplanResult, error) {
	oldGraph, err := Compile(base, config)
	if err != nil {
		return ReplanResult{}, fmt.Errorf("base plan: %w", err)
	}
	newGraph, err := Compile(candidate, config)
	if err != nil {
		return ReplanResult{}, fmt.Errorf("candidate plan: %w", err)
	}
	if candidate.Version <= base.Version {
		return ReplanResult{}, fmt.Errorf("replanned version must exceed current version")
	}
	states := map[string]mission.Task{}
	for _, task := range tasks {
		id := task.Spec.ID
		if id == "" {
			id = task.ID
		}
		if _, old := oldGraph.byID[id]; !old {
			if _, current := newGraph.byID[id]; !current {
				return ReplanResult{}, fmt.Errorf("runtime task %s belongs to neither plan", id)
			}
		}
		if _, duplicate := states[id]; duplicate {
			return ReplanResult{}, fmt.Errorf("duplicate runtime task %s", id)
		}
		states[id] = task
	}
	result := ReplanResult{Changes: planChanges(oldGraph, newGraph), Added: []string{}, Removed: []string{}, Invalidated: []string{}, Retained: []string{}, Interrupted: []string{}, ReplayRequired: []string{}, Reasons: map[string][]string{}, SafeToApply: true, Analysis: newGraph.analyze(nil)}
	invalid, replay := map[string]bool{}, map[string]bool{}
	addReason := func(id, reason string) {
		for _, existing := range result.Reasons[id] {
			if existing == reason {
				return
			}
		}
		result.Reasons[id] = append(result.Reasons[id], reason)
	}
	for _, change := range result.Changes {
		if change.Kind == "added" {
			result.Added = append(result.Added, change.TaskID)
		}
		if change.Kind == "removed" {
			result.Removed = append(result.Removed, change.TaskID)
		}
		if !change.ExecutionChanged && !change.AcceptanceChanged {
			continue
		}
		affected := map[string]bool{change.TaskID: true}
		for _, id := range oldGraph.Descendants(change.TaskID) {
			affected[id] = true
		}
		for _, id := range newGraph.Descendants(change.TaskID) {
			affected[id] = true
		}
		for id := range affected {
			if _, exists := newGraph.byID[id]; !exists {
				continue
			}
			invalid[id] = true
			reason := "changed prerequisite " + change.TaskID
			if id == change.TaskID {
				reason = "task execution or acceptance definition changed"
			}
			addReason(id, reason)
			if change.ExecutionChanged {
				replay[id] = true
			} else if id == change.TaskID {
				addReason(id, "existing artifact can be reverified before deciding to rerun")
			}
		}
	}
	for _, id := range newGraph.order {
		state, exists := states[id]
		if invalid[id] {
			result.Invalidated = append(result.Invalidated, id)
			if exists && replay[id] && state.Status == "completed" {
				result.ReplayRequired = append(result.ReplayRequired, id)
			}
			if exists && unresolvedTask(state.Status) {
				result.Interrupted = append(result.Interrupted, id)
				result.SafeToApply = false
				addReason(id, "active or unresolved execution must reach a durable stop before replan")
			}
		} else if exists && state.Status == "completed" {
			result.Retained = append(result.Retained, id)
		}
	}
	for _, id := range result.Removed {
		if state, exists := states[id]; exists && unresolvedTask(state.Status) {
			result.Interrupted = append(result.Interrupted, id)
			result.SafeToApply = false
			addReason(id, "removed task still owns active or unresolved effects")
		}
	}
	sort.Strings(result.Added)
	sort.Strings(result.Removed)
	sort.Strings(result.Interrupted)
	for id := range result.Reasons {
		sort.Strings(result.Reasons[id])
	}
	return result, nil
}
func unresolvedTask(status string) bool {
	switch status {
	case "running", "verifying", "waiting_review", "waiting_approval", "unknown":
		return true
	}
	return false
}
