// SPDX-License-Identifier: AGPL-3.0-or-later
package insight

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
)

const MaxDurationSeconds = 365 * 24 * 60 * 60

func Simulate(target Evidence, history []Evidence, request SimulationRequest) (Simulation, error) {
	g, err := validateEvidence(target)
	if err != nil {
		return Simulation{}, err
	}
	if len(request.Scenarios) < 1 || len(request.Scenarios) > MaxScenarios {
		return Simulation{}, fmt.Errorf("supply 1 to %d scenarios", MaxScenarios)
	}
	q := request.Quantile
	if q == 0 {
		q = 0.5
	}
	if q != 0.5 && q != 0.9 {
		return Simulation{}, fmt.Errorf("duration quantile must be 0.5 or 0.9")
	}
	estimates, err := EstimateDurations(target.Project, history)
	if err != nil {
		return Simulation{}, err
	}
	out := Simulation{RunID: target.Run.ID, PlanVersion: target.Run.PlanVersion, Quantile: q, Estimates: estimates, Scenarios: []ScenarioResult{}, Assumptions: []string{
		"Complete frozen DAG is simulated from time zero; current task progress is not estimated.",
		"Scheduling uses stable priority, remaining critical duration and task ID ordering.",
		"Historical event spans describe wall time, not CPU; changing infrastructure may invalidate them.",
		"Review latency, external approval, failures and retries require duration assumptions and are not predicted separately.",
		"Declared write serialization is an optional scenario policy; isolated runner branches do not imply such a runtime lock.",
		"Budget estimates are supplied assumptions; missing costs never certify a hard budget.",
	}}
	byEstimate := map[string]DurationEstimate{}
	for _, e := range estimates {
		byEstimate[e.SpecID] = e
	}
	seen := map[string]bool{}
	for _, scenario := range request.Scenarios {
		if seen[scenario.ID] {
			return Simulation{}, fmt.Errorf("scenario IDs must be unique")
		}
		seen[scenario.ID] = true
		if err := validateScenario(g, scenario); err != nil {
			return Simulation{}, err
		}
		out.Scenarios = append(out.Scenarios, simulateScenario(g, target.Project.Config, scenario, byEstimate, q))
	}
	return out, nil
}

func validateScenario(g *plan.Graph, s Scenario) error {
	if !validResourceName(s.ID) || len(s.Label) > 256 || !utf8.ValidString(s.Label) {
		return fmt.Errorf("scenario ID or label is invalid")
	}
	if s.MaxConcurrent < 1 || s.MaxConcurrent > MaxTasks {
		return fmt.Errorf("scenario concurrency must be between 1 and %d", MaxTasks)
	}
	if len(s.Capacities) > MaxResources || len(s.Durations) > MaxTasks || len(s.Resources) > MaxTasks || len(s.Costs) > MaxTasks {
		return fmt.Errorf("scenario configuration exceeds bounded limits")
	}
	for name, capacity := range s.Capacities {
		if !validResourceName(name) || capacity < 1 || capacity > 1000000 {
			return fmt.Errorf("resource capacities must have valid names and be between 1 and 1000000")
		}
	}
	for id, value := range s.Durations {
		if _, ok := g.Task(id); !ok {
			return fmt.Errorf("duration references unknown task %s", id)
		}
		if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 || value > MaxDurationSeconds {
			return fmt.Errorf("duration for task %s must be positive and at most one year", id)
		}
	}
	for id, demands := range s.Resources {
		if _, ok := g.Task(id); !ok {
			return fmt.Errorf("resource demand references unknown task %s", id)
		}
		if len(demands) > MaxResources {
			return fmt.Errorf("task resource demand exceeds bounded limits")
		}
		for name, demand := range demands {
			if _, ok := s.Capacities[name]; !ok {
				return fmt.Errorf("task %s demands resource %s without a capacity", id, name)
			}
			if demand < 1 || demand > 1000000 {
				return fmt.Errorf("resource demands must be between 1 and 1000000")
			}
		}
	}
	for id, cost := range s.Costs {
		if _, ok := g.Task(id); !ok {
			return fmt.Errorf("cost references unknown task %s", id)
		}
		if cost.Tokens < 0 || cost.ModelCalls < 0 || cost.ToolCalls < 0 || cost.ModelCalls > 1000000000 || cost.ToolCalls > 1000000000 {
			return fmt.Errorf("cost assumptions must be nonnegative and call counts bounded")
		}
	}
	return nil
}

func validResourceName(value string) bool {
	if value == "" || len(value) > 64 || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

type simulatedTask struct {
	id       string
	duration float64
	source   string
	start    float64
	end      float64
	priority int
	critical float64
	claims   []string
	demands  map[string]int
}

func simulateScenario(g *plan.Graph, config mission.Config, s Scenario, estimates map[string]DurationEstimate, q float64) ScenarioResult {
	out := ScenarioResult{ID: s.ID, Label: s.Label, Status: "complete", MaxConcurrent: s.MaxConcurrent, Timeline: []TimelineEntry{}, ResourceUtilization: map[string]float64{}, UnknownTaskIDs: []string{}, Blockers: []Blocker{}, Warnings: []string{}}
	tasks := map[string]*simulatedTask{}
	durations := map[string]*float64{}
	order := g.Order()
	serialize := s.SerializeWrites == nil || *s.SerializeWrites
	for _, id := range order {
		spec, _ := g.Task(id)
		task := &simulatedTask{id: id, priority: spec.Priority, demands: copyDemands(s.Resources[id])}
		for _, raw := range spec.Writes {
			scope := strings.TrimSuffix(raw, "/**")
			if scope == "" {
				scope = "."
			}
			normalized, _ := acceptance.NormalizePath(scope)
			task.claims = append(task.claims, normalized)
		}
		if override, ok := s.Durations[id]; ok {
			task.duration = override
			task.source = "override"
			durations[id] = &task.duration
		} else {
			estimate := estimates[id]
			value := estimate.P50Seconds
			if q == 0.9 {
				value = estimate.P90Seconds
			}
			if value != nil {
				task.duration = *value
				task.source = "observed"
				durations[id] = &task.duration
			} else {
				out.UnknownTaskIDs = append(out.UnknownTaskIDs, id)
				durations[id] = nil
			}
		}
		tasks[id] = task
	}
	out.CriticalPath = criticalPath(g, durations)
	for i := len(order) - 1; i >= 0; i-- {
		id := order[i]
		downstream := 0.0
		for _, child := range g.Dependents(id) {
			downstream = math.Max(downstream, tasks[child].critical)
		}
		tasks[id].critical = tasks[id].duration + downstream
	}
	sorted := append([]string(nil), order...)
	sort.Slice(sorted, func(i, j int) bool {
		a, b := tasks[sorted[i]], tasks[sorted[j]]
		if a.priority != b.priority {
			return a.priority > b.priority
		}
		if a.critical != b.critical {
			return a.critical > b.critical
		}
		return a.id < b.id
	})
	complete := map[string]bool{}
	running := map[string]*simulatedTask{}
	started := map[string]bool{}
	used := map[string]int{}
	reservations := newClaimTree()
	now := 0.0
	occupied := 0.0
	resourceTime := map[string]float64{}
	for steps := 0; steps <= 2*len(order); steps++ {
		// Release every simultaneous completion before admitting a new task.
		finishing := []string{}
		for id, t := range running {
			if t.end <= now {
				finishing = append(finishing, id)
			}
		}
		sort.Strings(finishing)
		for _, id := range finishing {
			t := running[id]
			delete(running, id)
			complete[id] = true
			for name, demand := range t.demands {
				used[name] -= demand
			}
			if serialize {
				for _, claim := range t.claims {
					reservations.adjust(claim, -1)
				}
			}
		}
		if len(complete) == len(order) {
			break
		}
		for _, id := range sorted {
			if len(running) >= s.MaxConcurrent {
				break
			}
			t := tasks[id]
			if started[id] || durations[id] == nil {
				continue
			}
			ready := true
			for _, dep := range g.Dependencies(id) {
				if !complete[dep] {
					ready = false
					break
				}
			}
			if !ready {
				continue
			}
			fits := true
			for name, demand := range t.demands {
				if demand > s.Capacities[name]-used[name] {
					fits = false
					break
				}
			}
			if !fits {
				continue
			}
			if serialize {
				for _, claim := range t.claims {
					if reservations.overlaps(claim) {
						fits = false
						break
					}
				}
				if !fits {
					continue
				}
			}
			t.start = now
			t.end = now + t.duration
			running[id] = t
			started[id] = true
			for name, demand := range t.demands {
				used[name] += demand
				resourceTime[name] += float64(demand) * t.duration
			}
			if serialize {
				for _, claim := range t.claims {
					reservations.adjust(claim, 1)
				}
			}
			occupied += t.duration
			out.Timeline = append(out.Timeline, TimelineEntry{SpecID: id, StartSeconds: t.start, EndSeconds: t.end, DurationSeconds: t.duration, DurationSource: t.source, Resources: copyDemands(t.demands)})
		}
		if len(running) == 0 {
			break
		}
		next := math.Inf(1)
		for _, t := range running {
			next = math.Min(next, t.end)
		}
		now = next
	}
	sort.Slice(out.Timeline, func(i, j int) bool {
		a, b := out.Timeline[i], out.Timeline[j]
		if a.StartSeconds == b.StartSeconds {
			return a.SpecID < b.SpecID
		}
		return a.StartSeconds < b.StartSeconds
	})
	if len(complete) == len(order) {
		out.MakespanSeconds = &now
		utilization := 0.0
		if now > 0 {
			utilization = occupied / (now * float64(s.MaxConcurrent))
		}
		out.Utilization = &utilization
		for name, capacity := range s.Capacities {
			if now > 0 {
				out.ResourceUtilization[name] = resourceTime[name] / (now * float64(capacity))
			} else {
				out.ResourceUtilization[name] = 0
			}
		}
	} else {
		out.Status = "blocked"
		if len(out.UnknownTaskIDs) > 0 {
			out.Status = "unknown"
		}
		for _, id := range order {
			if complete[id] {
				continue
			}
			if durations[id] == nil {
				out.Blockers = append(out.Blockers, Blocker{Code: "duration_unknown", TaskID: id, Message: "No complete historical duration or user assumption is available.", Evidence: "simulation_input", Chain: []string{id}})
				continue
			}
			blocked := false
			for name, demand := range tasks[id].demands {
				if demand > s.Capacities[name] {
					out.Blockers = append(out.Blockers, Blocker{Code: "resource_capacity", TaskID: id, Message: fmt.Sprintf("Demand for %s (%d) exceeds capacity (%d).", name, demand, s.Capacities[name]), Evidence: "simulation_input", Chain: []string{id}})
					blocked = true
				}
			}
			if !blocked {
				for _, dep := range g.Dependencies(id) {
					if !complete[dep] {
						out.Blockers = append(out.Blockers, Blocker{Code: "dependency", TaskID: dep, Message: "Simulation cannot complete the prerequisite task.", Evidence: "simulation_input", Chain: []string{id, dep}})
						break
					}
				}
			}
		}
	}
	out.Budget = assessBudget(g, config.Budget, s.Costs, out.MakespanSeconds)
	sort.Slice(out.Blockers, func(i, j int) bool {
		a, b := out.Blockers[i], out.Blockers[j]
		if a.TaskID != b.TaskID {
			return a.TaskID < b.TaskID
		}
		if a.Code != b.Code {
			return a.Code < b.Code
		}
		return a.Message < b.Message
	})
	if serialize {
		out.Warnings = append(out.Warnings, "Overlapping declared write scopes were serialized as an explicit scenario policy.")
	}
	out.Warnings = append(out.Warnings, "This timeline is a bounded deterministic scheduling simulation, not a runtime dispatch plan or promised completion time.")
	return out
}

func copyDemands(value map[string]int) map[string]int {
	out := map[string]int{}
	for key, n := range value {
		out[key] = n
	}
	return out
}

func assessBudget(g *plan.Graph, limits mission.Budget, costs map[string]CostEstimate, makespan *float64) BudgetAssessment {
	out := BudgetAssessment{Status: "within", MissingTaskIDs: []string{}, Exceeded: []string{}}
	for _, id := range g.Order() {
		value, ok := costs[id]
		if !ok {
			out.MissingTaskIDs = append(out.MissingTaskIDs, id)
			continue
		}
		if out.Known.Tokens > math.MaxInt64-value.Tokens {
			out.Exceeded = append(out.Exceeded, "tokens_overflow")
			out.Known.Tokens = math.MaxInt64
		} else {
			out.Known.Tokens += value.Tokens
		}
		if out.Known.ModelCalls > math.MaxInt-value.ModelCalls {
			out.Exceeded = append(out.Exceeded, "modelCalls_overflow")
			out.Known.ModelCalls = math.MaxInt
		} else {
			out.Known.ModelCalls += value.ModelCalls
		}
		if out.Known.ToolCalls > math.MaxInt-value.ToolCalls {
			out.Exceeded = append(out.Exceeded, "toolCalls_overflow")
			out.Known.ToolCalls = math.MaxInt
		} else {
			out.Known.ToolCalls += value.ToolCalls
		}
	}
	if limits.MaxTokens > 0 && out.Known.Tokens > limits.MaxTokens {
		out.Exceeded = append(out.Exceeded, "tokens")
	}
	if limits.MaxModelCalls > 0 && out.Known.ModelCalls > limits.MaxModelCalls {
		out.Exceeded = append(out.Exceeded, "modelCalls")
	}
	if limits.MaxToolCalls > 0 && out.Known.ToolCalls > limits.MaxToolCalls {
		out.Exceeded = append(out.Exceeded, "toolCalls")
	}
	if limits.MaxWallSeconds > 0 && makespan != nil && *makespan > float64(limits.MaxWallSeconds) {
		out.Exceeded = append(out.Exceeded, "wallSeconds")
	}
	switch {
	case len(out.Exceeded) > 0:
		out.Status = "exceeded"
		out.Message = "Known assumptions already exceed at least one hard budget."
	case len(out.MissingTaskIDs) > 0 || (limits.MaxWallSeconds > 0 && makespan == nil):
		out.Status = "unknown"
		out.Message = "Missing cost or wall-time assumptions prevent a hard-budget feasibility claim."
	default:
		out.Message = "Supplied assumptions fit configured limits; actual execution can differ."
	}
	return out
}

// The trie reserves exact path components. Lexical neighbours such as src/api
// and src/apix never conflict, while a directory claim reserves descendants.
type claimTree struct {
	children     map[string]*claimTree
	exact, total int
}

func newClaimTree() *claimTree { return &claimTree{children: map[string]*claimTree{}} }
func claimParts(claim string) []string {
	if claim == "." || claim == "" {
		return nil
	}
	return strings.Split(claim, "/")
}
func (t *claimTree) adjust(claim string, delta int) {
	current := t
	current.total += delta
	for _, part := range claimParts(claim) {
		child := current.children[part]
		if child == nil {
			child = newClaimTree()
			current.children[part] = child
		}
		current = child
		current.total += delta
	}
	current.exact += delta
}
func (t *claimTree) overlaps(claim string) bool {
	current := t
	for _, part := range claimParts(claim) {
		if current.exact > 0 {
			return true
		}
		current = current.children[part]
		if current == nil {
			return false
		}
	}
	return current.total > 0
}
