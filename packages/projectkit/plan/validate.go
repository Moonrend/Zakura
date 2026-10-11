// SPDX-License-Identifier: AGPL-3.0-or-later
package plan

import (
	"container/heap"
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

func ValidatePlan(value mission.Plan, config mission.Config) error {
	_, err := Compile(value, config)
	return err
}
func Compile(value mission.Plan, config mission.Config) (*Graph, error) {
	issues := []Issue{}
	add := func(task, field, code, message string, related ...string) {
		issues = append(issues, Issue{TaskID: task, Field: field, Code: code, Message: message, Related: related})
	}
	max := config.MaxTasks
	if max == 0 {
		max = 1000
	}
	if max < 1 || max > 10000 {
		add("", "config.maxTasks", "range", "max tasks must be between 1 and 10000")
	}
	if len(value.Tasks) == 0 {
		add("", "tasks", "empty_plan", "project plan requires at least one task")
	}
	if len(value.Tasks) > max || len(value.Tasks) > 10000 {
		add("", "tasks", "task_limit", "project plan exceeds the task limit")
		return nil, &ValidationError{Issues: issues}
	}
	if value.Version < 1 {
		add("", "version", "range", "plan version must be positive")
	}
	if config.Budget.MaxTokens < 0 || config.Budget.MaxModelCalls < 0 || config.Budget.MaxToolCalls < 0 || config.Budget.MaxWallSeconds < 0 || config.Budget.MaxConcurrent < 0 || config.Budget.MaxConcurrent > 1000 {
		add("", "config.budget", "range", "budget limits must be nonnegative and concurrency at most 1000")
	}
	if config.ExternalEffects != "" && config.ExternalEffects != "deny" && config.ExternalEffects != "review" && config.ExternalEffects != "allow" {
		add("", "config.externalEffects", "unsupported_policy", "external effects must be deny, review or allow")
	}
	graph := &Graph{plan: value, byID: map[string]mission.TaskSpec{}, dependencies: map[string][]string{}, dependents: map[string][]string{}, ancestors: map[string][]uint64{}, descendants: map[string][]uint64{}, index: map[string]int{}}
	totalWrites, totalChecks, totalEdges, totalText := 0, 0, 0, 0
	for index, task := range value.Tasks {
		totalWrites += len(task.Writes)
		totalChecks += len(task.Checks)
		totalEdges += len(task.DependsOn)
		totalText += len(task.Prompt) + len(task.Title)
		if totalWrites > 100000 || totalChecks > 10000 || totalEdges > 100000 || totalText > 16<<20 {
			add(task.ID, "tasks", "aggregate_limit", "plan metadata exceeds bounded analysis limits")
			return nil, &ValidationError{Issues: issues}
		}
		id := task.ID
		if !validID(id) {
			add(id, fmt.Sprintf("tasks[%d].id", index), "invalid_id", "task ID must contain 1 to 128 UTF-8 bytes without whitespace/control characters")
		}
		if _, exists := graph.byID[id]; exists {
			add(id, "id", "duplicate_id", "task IDs must be unique")
		} else {
			graph.byID[id] = cloneTask(task)
		}
		if strings.TrimSpace(task.Title) == "" || len(task.Title) > 500 {
			add(id, "title", "invalid_title", "task title must contain 1 to 500 bytes")
		}
		if strings.TrimSpace(task.Prompt) == "" || len(task.Prompt) > 1<<20 || !utf8.ValidString(task.Prompt) {
			add(id, "prompt", "invalid_prompt", "task prompt must be nonempty UTF-8 and at most 1 MiB")
		}
		if task.AgentID != "" && !validID(task.AgentID) {
			add(id, "agentId", "invalid_id", "agent ID is invalid")
		}
		if len(task.Model) > 256 {
			add(id, "model", "limit", "model selector exceeds 256 bytes")
		}
		if task.Priority < -1000 || task.Priority > 1000 {
			add(id, "priority", "range", "priority must be between -1000 and 1000")
		}
		if task.MaxAttempts < 0 || task.MaxAttempts > 100 {
			add(id, "maxAttempts", "range", "max attempts must be between 0 and 100")
		}
		if len(task.DependsOn) > 10000 {
			add(id, "dependsOn", "limit", "too many dependency edges")
		}
		seen := map[string]bool{}
		for depIndex, dependency := range task.DependsOn {
			if dependency == id {
				add(id, fmt.Sprintf("dependsOn[%d]", depIndex), "self_dependency", "task cannot depend on itself", id)
			}
			if seen[dependency] {
				add(id, "dependsOn", "duplicate_dependency", "dependency is repeated", dependency)
			}
			seen[dependency] = true
		}
		if len(task.Writes) > 1000 {
			add(id, "writes", "limit", "at most 1000 write claims per task")
		}
		paths := map[string]bool{}
		for pathIndex, write := range task.Writes {
			claim, err := normalizeClaim(write)
			if err != nil {
				add(id, fmt.Sprintf("writes[%d]", pathIndex), "invalid_write", err.Error())
				continue
			}
			if paths[claim] {
				add(id, "writes", "duplicate_write", "write path is repeated after normalization", claim)
			}
			paths[claim] = true
		}
		required := false
		for _, check := range task.Checks {
			required = required || check.Required
		}
		if !required {
			add(id, "checks", "missing_required_check", "every task requires at least one required acceptance check")
		}
		if err := acceptance.ValidateChecks(task.Checks); err != nil {
			var validation *acceptance.ValidationError
			if errors.As(err, &validation) {
				for _, issue := range validation.Issues {
					issues = append(issues, Issue{TaskID: id, CheckID: issue.CheckID, Field: "checks." + issue.Field, Code: issue.Code, Message: issue.Message})
				}
			} else {
				add(id, "checks", "invalid_checks", err.Error())
			}
		}
	}
	for _, task := range value.Tasks {
		for _, dependency := range task.DependsOn {
			if _, exists := graph.byID[dependency]; !exists {
				add(task.ID, "dependsOn", "missing_dependency", "task dependency does not exist", dependency)
			}
		}
	}
	if len(issues) > 0 {
		return nil, &ValidationError{Issues: issues}
	}
	indegree := map[string]int{}
	ready := &stringHeap{}
	for id, task := range graph.byID {
		deps := append([]string(nil), task.DependsOn...)
		sort.Strings(deps)
		graph.dependencies[id] = deps
		indegree[id] = len(deps)
		for _, dep := range deps {
			graph.dependents[dep] = append(graph.dependents[dep], id)
		}
		if len(deps) == 0 {
			heap.Push(ready, id)
		}
	}
	for id := range graph.byID {
		sort.Strings(graph.dependents[id])
	}
	for ready.Len() > 0 {
		id := heap.Pop(ready).(string)
		graph.order = append(graph.order, id)
		for _, child := range graph.dependents[id] {
			indegree[child]--
			if indegree[child] == 0 {
				heap.Push(ready, child)
			}
		}
	}
	if len(graph.order) != len(graph.byID) {
		cycle := findCycle(graph.dependencies)
		return nil, &ValidationError{Issues: []Issue{{Code: "dependency_cycle", Field: "dependsOn", Message: "dependency cycle: " + strings.Join(cycle, " -> "), Related: cycle}}}
	}
	words := (len(graph.order) + 63) / 64
	for index, id := range graph.order {
		graph.index[id] = index
		graph.ancestors[id] = make([]uint64, words)
		graph.descendants[id] = make([]uint64, words)
	}
	for _, id := range graph.order {
		for _, dep := range graph.dependencies[id] {
			setBit(graph.ancestors[id], graph.index[dep])
			orBits(graph.ancestors[id], graph.ancestors[dep])
		}
	}
	for index := len(graph.order) - 1; index >= 0; index-- {
		id := graph.order[index]
		for _, child := range graph.dependents[id] {
			setBit(graph.descendants[id], graph.index[child])
			orBits(graph.descendants[id], graph.descendants[child])
		}
	}
	graph.plan = clonePlan(value)
	return graph, nil
}
func validID(id string) bool {
	if id == "" || len(id) > 128 || !utf8.ValidString(id) {
		return false
	}
	for _, r := range id {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func normalizeClaim(raw string) (string, error) {
	if strings.HasSuffix(raw, "/**") {
		raw = strings.TrimSuffix(raw, "/**")
		if raw == "" {
			raw = "."
		}
	}
	if strings.ContainsAny(raw, "*?[]{}") {
		return "", fmt.Errorf("write claims must be exact paths or directory/** scopes")
	}
	return acceptance.NormalizePath(raw)
}
func PathsOverlap(left, right string) (bool, error) {
	a, err := normalizeClaim(left)
	if err != nil {
		return false, err
	}
	b, err := normalizeClaim(right)
	if err != nil {
		return false, err
	}
	return pathOverlap(a, b), nil
}
func pathOverlap(a, b string) bool {
	return a == "." || b == "." || a == b || strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/")
}
func findCycle(dependencies map[string][]string) []string {
	colors := map[string]int{}
	positions := map[string]int{}
	stack := []string{}
	var found []string
	var visit func(string) bool
	visit = func(id string) bool {
		colors[id] = 1
		positions[id] = len(stack)
		stack = append(stack, id)
		for _, dep := range dependencies[id] {
			if colors[dep] == 1 {
				found = append(append([]string(nil), stack[positions[dep]:]...), dep)
				return true
			}
			if colors[dep] == 0 && visit(dep) {
				return true
			}
		}
		stack = stack[:len(stack)-1]
		colors[id] = 2
		return false
	}
	ids := make([]string, 0, len(dependencies))
	for id := range dependencies {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if colors[id] == 0 && visit(id) {
			break
		}
	}
	return found
}

type stringHeap []string

func (h stringHeap) Len() int           { return len(h) }
func (h stringHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h stringHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *stringHeap) Push(v any)        { *h = append(*h, v.(string)) }
func (h *stringHeap) Pop() any {
	old := *h
	last := old[len(old)-1]
	*h = old[:len(old)-1]
	return last
}
func cloneTask(t mission.TaskSpec) mission.TaskSpec {
	t.DependsOn = append([]string(nil), t.DependsOn...)
	t.Writes = append([]string(nil), t.Writes...)
	t.Checks = append([]mission.CheckSpec(nil), t.Checks...)
	for i := range t.Checks {
		t.Checks[i].Command = append([]string(nil), t.Checks[i].Command...)
	}
	return t
}
func clonePlan(p mission.Plan) mission.Plan {
	p.Tasks = append([]mission.TaskSpec(nil), p.Tasks...)
	for i := range p.Tasks {
		p.Tasks[i] = cloneTask(p.Tasks[i])
	}
	return p
}
