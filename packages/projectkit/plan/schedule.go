// SPDX-License-Identifier: AGPL-3.0-or-later
package plan

import (
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"math"
	"sort"
	"strings"
	"time"
)

func ScheduleCandidates(value mission.Plan, tasks []mission.Task, config mission.Config, options ScheduleOptions) (ScheduleResult, error) {
	graph, err := Compile(value, config)
	if err != nil {
		return ScheduleResult{}, err
	}
	options, err = normalizeScheduleOptions(options)
	if err != nil {
		return ScheduleResult{}, err
	}
	if err = validateEstimates(options.Estimates, graph); err != nil {
		return ScheduleResult{}, err
	}
	states, err := runtimeTasks(tasks, graph)
	if err != nil {
		return ScheduleResult{}, err
	}
	result := ScheduleResult{Selected: []Candidate{}, Ranked: []Candidate{}, Deferred: []Deferred{}, Active: []string{}, Warnings: []Issue{}}
	limit := config.Budget.MaxConcurrent
	if limit == 0 {
		limit = 1
	}
	activeAgents := map[string]int{}
	occupied := map[string]int{}
	for resource, used := range options.ActiveResources {
		occupied[resource] = used
	}
	locked := []string{}
	unknownActive := false
	hardBudget := config.Budget.MaxTokens > 0 || config.Budget.MaxModelCalls > 0 || config.Budget.MaxToolCalls > 0 || config.Budget.MaxWallSeconds > 0
	reserved := options.Used
	for _, id := range graph.order {
		task, exists := states[id]
		if !exists {
			continue
		}
		if task.Status == "running" || task.Status == "verifying" {
			result.Active = append(result.Active, id)
			activeAgents[graph.byID[id].AgentID]++
			if estimate, known := options.Estimates[id]; known {
				reserved = addUsage(reserved, estimate)
				if len(options.ActiveResources) == 0 {
					for resource, units := range estimate.Resources {
						occupied[resource] += units
					}
				}
			} else {
				unknownActive = true
				result.Warnings = append(result.Warnings, Issue{TaskID: id, Code: "unknown_active_estimate", Field: "estimates", Message: "active task reservation is unknown; hard budget safety requires measured reservations"})
			}
		}
		switch task.Status {
		case "running", "verifying", "waiting_review", "waiting_approval", "unknown":
			locked = append(locked, id)
		}
	}
	result.AvailableSlots = limit - len(result.Active)
	if result.AvailableSlots < 0 {
		result.AvailableSlots = 0
	}
	analysis := graph.analyze(nil)
	critical := map[string]int{}
	for _, node := range analysis.Nodes {
		critical[node.ID] = analysis.CriticalLength - node.EarliestStart
	}
	deferTask := func(id, code, detail string, related ...string) {
		result.Deferred = append(result.Deferred, Deferred{TaskID: id, Codes: []string{code}, Detail: detail, Related: related})
	}
	for _, id := range graph.order {
		spec := graph.byID[id]
		runtime, exists := states[id]
		if exists && runtime.Status != "" && runtime.Status != "pending" {
			continue
		}
		if exists && runtime.Spec.ID != "" && !executionEquivalent(runtime.Spec, spec) {
			deferTask(id, "plan_mismatch", "runtime task definition differs from the frozen current plan")
			continue
		}
		maxAttempts := spec.MaxAttempts
		if maxAttempts == 0 {
			maxAttempts = 1
		}
		if exists && runtime.Attempt >= maxAttempts {
			deferTask(id, "attempt_limit", "task exhausted its allowed attempts")
			continue
		}
		incomplete, failed := []string{}, []string{}
		for _, dependency := range graph.dependencies[id] {
			state, exists := states[dependency]
			if !exists || state.Status != "completed" {
				incomplete = append(incomplete, dependency)
				if exists && (state.Status == "failed" || state.Status == "cancelled" || state.Status == "blocked") {
					failed = append(failed, dependency)
				}
			}
		}
		if len(failed) > 0 {
			deferTask(id, "dependency_failed", "prerequisites failed, were cancelled or are blocked", failed...)
			continue
		}
		if len(incomplete) > 0 {
			deferTask(id, "dependency_pending", "prerequisites have not completed acceptance", incomplete...)
			continue
		}
		conflicts := conflictingTasks(spec, locked, graph)
		if len(conflicts) > 0 {
			deferTask(id, "write_lock", "write claims overlap an active or unresolved task", conflicts...)
			continue
		}
		estimate, known := options.Estimates[id]
		if unknownActive && hardBudget {
			deferTask(id, "unknown_active_reservation", "active task reservation is unknown under a hard budget")
			continue
		}
		if !known && (options.RequireKnownEstimates || hardBudget) {
			deferTask(id, "unknown_estimate", "a bounded reservation is required before scheduling under hard budgets")
			continue
		}
		age := 0.0
		if since, ok := options.WaitingSince[id]; ok && !since.After(options.Now) {
			age = options.Now.Sub(since).Seconds() / float64(options.AgingSeconds)
		}
		candidate := Candidate{TaskID: id, AgentID: spec.AgentID, PriorityScore: float64(spec.Priority) * options.PriorityWeight, CriticalScore: float64(critical[id]) * options.CriticalWeight, AgingScore: age * options.AgingWeight, FairnessPenalty: float64(activeAgents[spec.AgentID]) * options.FairnessWeight, Reasons: []string{"all prerequisite tasks completed acceptance", "write scopes are available"}}
		if known {
			copy := cloneEstimate(estimate)
			candidate.Estimate = &copy
		} else {
			candidate.Reasons = append(candidate.Reasons, "resource estimate is unknown and no hard budget is set")
		}
		candidate.Score = candidate.PriorityScore + candidate.CriticalScore + candidate.AgingScore - candidate.FairnessPenalty
		result.Ranked = append(result.Ranked, candidate)
	}
	// Greedy selection recomputes fairness as each agent receives a slot. Candidate
	// order alone would let one prolific agent consume every free worker.
	pool := append([]Candidate(nil), result.Ranked...)
	chosenAgents := map[string]int{}
	sortCandidates(result.Ranked)
	for len(pool) > 0 {
		for index := range pool {
			candidate := &pool[index]
			candidate.FairnessPenalty = float64(activeAgents[candidate.AgentID]+chosenAgents[candidate.AgentID]) * options.FairnessWeight
			candidate.Score = candidate.PriorityScore + candidate.CriticalScore + candidate.AgingScore - candidate.FairnessPenalty
		}
		sortCandidates(pool)
		candidate := pool[0]
		pool = pool[1:]
		if len(result.Selected) >= result.AvailableSlots {
			deferTask(candidate.TaskID, "concurrency_limit", "all concurrent execution slots are reserved")
			continue
		}
		selectedIDs := []string{}
		for _, selected := range result.Selected {
			selectedIDs = append(selectedIDs, selected.TaskID)
		}
		conflicts := conflictingTasks(graph.byID[candidate.TaskID], selectedIDs, graph)
		if len(conflicts) > 0 {
			deferTask(candidate.TaskID, "batch_write_conflict", "selected tasks already reserve overlapping writes", conflicts...)
			continue
		}
		estimate := Estimate{}
		if candidate.Estimate != nil {
			estimate = *candidate.Estimate
		}
		codes := budgetViolations(reserved, estimate, config.Budget)
		for resource, units := range estimate.Resources {
			capacity, exists := options.ResourceLimits[resource]
			if !exists {
				codes = append(codes, "unknown_resource:"+resource)
			} else if occupied[resource]+units > capacity {
				codes = append(codes, "resource_capacity:"+resource)
			}
		}
		sort.Strings(codes)
		if len(codes) > 0 {
			result.Deferred = append(result.Deferred, Deferred{TaskID: candidate.TaskID, Codes: codes, Detail: "candidate reservation exceeds a remaining budget or resource capacity"})
			continue
		}
		result.Selected = append(result.Selected, candidate)
		reserved = addUsage(reserved, estimate)
		chosenAgents[candidate.AgentID]++
		for resource, units := range estimate.Resources {
			occupied[resource] += units
		}
	}
	result.Reserved = reserved
	sort.Slice(result.Deferred, func(i, j int) bool { return result.Deferred[i].TaskID < result.Deferred[j].TaskID })
	return result, nil
}
func normalizeScheduleOptions(options ScheduleOptions) (ScheduleOptions, error) {
	if options.Now.IsZero() {
		options.Now = time.Now()
	}
	if options.AgingSeconds == 0 {
		options.AgingSeconds = 60
	}
	if options.AgingSeconds < 1 || options.AgingSeconds > 86400 {
		return options, fmt.Errorf("aging seconds must be between 1 and 86400")
	}
	if options.PriorityWeight == 0 && options.CriticalWeight == 0 && options.AgingWeight == 0 && options.FairnessWeight == 0 {
		options.PriorityWeight = 10
		options.CriticalWeight = 1
		options.AgingWeight = 1
		options.FairnessWeight = 20
	}
	for _, weight := range []float64{options.PriorityWeight, options.CriticalWeight, options.AgingWeight, options.FairnessWeight} {
		if math.IsNaN(weight) || math.IsInf(weight, 0) || weight < 0 || weight > 1000000 {
			return options, fmt.Errorf("scheduler weights must be finite, nonnegative and at most 1000000")
		}
	}
	if options.Used.Tokens < 0 || options.Used.Tokens > 1000000000000000 || options.Used.ModelCalls < 0 || options.Used.ModelCalls > 1000000000000 || options.Used.ToolCalls < 0 || options.Used.ToolCalls > 1000000000000 || options.Used.WallSeconds < 0 || options.Used.WallSeconds > 1000000000000 {
		return options, fmt.Errorf("measured usage cannot be negative")
	}
	for resource, limit := range options.ResourceLimits {
		if strings.TrimSpace(resource) == "" || limit < 0 || limit > 1000000 {
			return options, fmt.Errorf("invalid resource capacity")
		}
	}
	for resource, used := range options.ActiveResources {
		if strings.TrimSpace(resource) == "" || used < 0 || used > 1000000 {
			return options, fmt.Errorf("invalid active resource usage")
		}
	}
	return options, nil
}
func validateEstimates(estimates map[string]Estimate, graph *Graph) error {
	for id, estimate := range estimates {
		if _, exists := graph.byID[id]; !exists {
			return fmt.Errorf("estimate refers to unknown task %s", id)
		}
		if estimate.Tokens < 0 || estimate.Tokens > 1000000000000 || estimate.ModelCalls < 0 || estimate.ModelCalls > 1000000 || estimate.ToolCalls < 0 || estimate.ToolCalls > 1000000 || estimate.Seconds < 0 || estimate.Seconds > 31536000 {
			return fmt.Errorf("task %s estimate is outside bounded nonnegative ranges", id)
		}
		for resource, units := range estimate.Resources {
			if strings.TrimSpace(resource) == "" || len(resource) > 128 || units < 0 || units > 1000000 {
				return fmt.Errorf("task %s has invalid resource reservation", id)
			}
		}
	}
	return nil
}
func runtimeTasks(tasks []mission.Task, graph *Graph) (map[string]mission.Task, error) {
	states := map[string]mission.Task{}
	valid := map[string]bool{"": true, "pending": true, "running": true, "verifying": true, "waiting_review": true, "waiting_approval": true, "unknown": true, "completed": true, "failed": true, "cancelled": true, "blocked": true}
	for _, task := range tasks {
		id := task.Spec.ID
		if id == "" {
			id = task.ID
		}
		if _, exists := graph.byID[id]; !exists {
			return nil, fmt.Errorf("runtime task %s is outside the plan", id)
		}
		if _, exists := states[id]; exists {
			return nil, fmt.Errorf("runtime task %s is repeated", id)
		}
		if !valid[task.Status] {
			return nil, fmt.Errorf("runtime task %s has unsupported status %q", id, task.Status)
		}
		if task.Attempt < 0 {
			return nil, fmt.Errorf("runtime task %s has a negative attempt count", id)
		}
		states[id] = task
	}
	return states, nil
}
func conflictingTasks(candidate mission.TaskSpec, ids []string, graph *Graph) []string {
	conflicts := []string{}
	for _, id := range ids {
		overlap := false
		for _, left := range candidate.Writes {
			a, _ := normalizeClaim(left)
			for _, right := range graph.byID[id].Writes {
				b, _ := normalizeClaim(right)
				if pathOverlap(a, b) {
					overlap = true
					break
				}
			}
			if overlap {
				break
			}
		}
		if overlap {
			conflicts = append(conflicts, id)
		}
	}
	sort.Strings(conflicts)
	return conflicts
}
func sortCandidates(candidates []Candidate) {
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Score == candidates[j].Score {
			return candidates[i].TaskID < candidates[j].TaskID
		}
		return candidates[i].Score > candidates[j].Score
	})
}
func cloneEstimate(e Estimate) Estimate {
	resources := map[string]int{}
	for key, value := range e.Resources {
		resources[key] = value
	}
	e.Resources = resources
	return e
}
func addUsage(usage Usage, estimate Estimate) Usage {
	usage.Tokens += estimate.Tokens
	usage.ModelCalls += estimate.ModelCalls
	usage.ToolCalls += estimate.ToolCalls
	usage.WallSeconds += estimate.Seconds
	return usage
}
func budgetViolations(used Usage, estimate Estimate, budget mission.Budget) []string {
	codes := []string{}
	if budget.MaxTokens > 0 && (used.Tokens > budget.MaxTokens || estimate.Tokens > budget.MaxTokens-used.Tokens) {
		codes = append(codes, "token_budget")
	}
	if budget.MaxModelCalls > 0 && (used.ModelCalls > budget.MaxModelCalls || estimate.ModelCalls > budget.MaxModelCalls-used.ModelCalls) {
		codes = append(codes, "model_call_budget")
	}
	if budget.MaxToolCalls > 0 && (used.ToolCalls > budget.MaxToolCalls || estimate.ToolCalls > budget.MaxToolCalls-used.ToolCalls) {
		codes = append(codes, "tool_call_budget")
	}
	// This is a conservative reservation of cumulative task seconds. It does not
	// pretend parallel tasks' sum is an exact project wall-clock forecast.
	if budget.MaxWallSeconds > 0 && (used.WallSeconds > budget.MaxWallSeconds || estimate.Seconds > budget.MaxWallSeconds-used.WallSeconds) {
		codes = append(codes, "wall_time_reservation")
	}
	return codes
}
