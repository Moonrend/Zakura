// SPDX-License-Identifier: AGPL-3.0-or-later
package requirements

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func validID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for i, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || i > 0 && (r == '_' || r == '-' || r == '.')) {
			return false
		}
	}
	return true
}
func Normalize(draft Draft) (Draft, error) {
	draft.Title = strings.TrimSpace(draft.Title)
	if draft.Title == "" || len(draft.Title) > 512 || !utf8.ValidString(draft.Title) {
		return draft, errors.New("requirements title must be valid UTF-8 and at most 512 bytes")
	}
	if len(draft.Clauses) == 0 || len(draft.Clauses) > 500 {
		return draft, errors.New("requirements need between 1 and 500 clauses")
	}
	ids := map[string]bool{}
	total := 0
	totalBindings := 0
	for i, clause := range draft.Clauses {
		if !validID(clause.ID) || ids[clause.ID] {
			return draft, fmt.Errorf("invalid or duplicate requirement identity %q", clause.ID)
		}
		ids[clause.ID] = true
		if clause.Kind != "functional" && clause.Kind != "nonfunctional" && clause.Kind != "constraint" {
			return draft, fmt.Errorf("clause %s has invalid kind", clause.ID)
		}
		clause.Title = strings.TrimSpace(clause.Title)
		if clause.Title == "" || len(clause.Title) > 512 || len(clause.Description) > 16384 || !utf8.ValidString(clause.Title) || !utf8.ValidString(clause.Description) {
			return draft, fmt.Errorf("clause %s has invalid title/description", clause.ID)
		}
		total += len(clause.Title) + len(clause.Description)
		if total > 262144 {
			return draft, errors.New("requirements text exceeds 256KiB")
		}
		if len(clause.Bindings) > 100 {
			return draft, fmt.Errorf("clause %s exceeds 100 acceptance mappings", clause.ID)
		}
		totalBindings += len(clause.Bindings)
		if totalBindings > 5000 {
			return draft, errors.New("requirements exceed 5000 acceptance mappings")
		}
		seen := map[Binding]bool{}
		if clause.Bindings == nil {
			clause.Bindings = []Binding{}
		}
		for _, binding := range clause.Bindings {
			if !validID(binding.TaskSpecID) || !validID(binding.CheckID) || seen[binding] {
				return draft, fmt.Errorf("clause %s has invalid or duplicate acceptance mapping", clause.ID)
			}
			seen[binding] = true
		}
		draft.Clauses[i] = clause
	}
	return draft, nil
}
func digest(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// PlanHash captures task execution and check semantics, ignoring task order,
// display titles, scheduler priorities, retry counts and plan version numbers.
func PlanHash(plan mission.Plan) string {
	tasks := append([]mission.TaskSpec(nil), plan.Tasks...)
	for i := range tasks {
		task := tasks[i]
		task.Title = ""
		task.Priority = 0
		task.MaxAttempts = 0
		task.DependsOn = append([]string{}, task.DependsOn...)
		task.Writes = append([]string{}, task.Writes...)
		task.Checks = append([]mission.CheckSpec{}, task.Checks...)
		sort.Strings(task.DependsOn)
		sort.Strings(task.Writes)
		sort.Slice(task.Checks, func(i, j int) bool { return task.Checks[i].ID < task.Checks[j].ID })
		tasks[i] = task
	}
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].ID < tasks[j].ID })
	hash, _ := digest(tasks)
	return hash
}
func BaselineHash(baseline Baseline) string {
	clauses := append([]Clause(nil), baseline.Clauses...)
	for i := range clauses {
		clauses[i].Bindings = append([]Binding(nil), clauses[i].Bindings...)
		sort.Slice(clauses[i].Bindings, func(a, b int) bool {
			left, right := clauses[i].Bindings[a], clauses[i].Bindings[b]
			if left.TaskSpecID != right.TaskSpecID {
				return left.TaskSpecID < right.TaskSpecID
			}
			return left.CheckID < right.CheckID
		})
	}
	sort.Slice(clauses, func(i, j int) bool { return clauses[i].ID < clauses[j].ID })
	hash, _ := digest(struct {
		ID                        string
		Revision                  int64
		Title                     string
		Clauses                   []Clause
		RequiredBeforePublication bool
		ApprovedPlanHash          string
		ApprovedBy                string
	}{baseline.ID, baseline.Revision, baseline.Title, clauses, baseline.RequiredBeforePublication, baseline.ApprovedPlanHash, baseline.ApprovedBy})
	return hash
}
func Analyze(clauses []Clause, plan mission.Plan) Analysis {
	result := Analysis{PlanHash: PlanHash(plan), Valid: true, Issues: []Issue{}}
	tasks := map[string]mission.TaskSpec{}
	for _, task := range plan.Tasks {
		tasks[task.ID] = task
	}
	for _, clause := range clauses {
		severity := "warning"
		if clause.Required {
			result.Required++
			severity = "error"
		} else {
			result.Optional++
		}
		if len(clause.Bindings) == 0 {
			result.Issues = append(result.Issues, Issue{Code: "orphaned_requirement", ClauseID: clause.ID, Severity: severity, Message: "Requirement has no mapped acceptance check"})
			if clause.Required {
				result.Valid = false
			}
			continue
		}
		for _, binding := range clause.Bindings {
			task, exists := tasks[binding.TaskSpecID]
			if !exists {
				result.Issues = append(result.Issues, Issue{Code: "missing_task", ClauseID: clause.ID, TaskSpecID: binding.TaskSpecID, CheckID: binding.CheckID, Severity: severity, Message: "Mapped task was removed from the plan"})
				if clause.Required {
					result.Valid = false
				}
				continue
			}
			found := false
			for _, check := range task.Checks {
				if check.ID == binding.CheckID {
					found = true
					if !check.Required {
						result.Issues = append(result.Issues, Issue{Code: "optional_acceptance_check", ClauseID: clause.ID, TaskSpecID: binding.TaskSpecID, CheckID: binding.CheckID, Severity: "warning", Message: "The mapped check is optional for the task; a required requirement still demands that this exact check pass"})
					}
					break
				}
			}
			if !found {
				result.Issues = append(result.Issues, Issue{Code: "missing_check", ClauseID: clause.ID, TaskSpecID: binding.TaskSpecID, CheckID: binding.CheckID, Severity: severity, Message: "Mapped acceptance check was removed from the task"})
				if clause.Required {
					result.Valid = false
				}
			}
		}
	}
	return result
}
