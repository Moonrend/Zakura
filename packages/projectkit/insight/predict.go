// SPDX-License-Identifier: AGPL-3.0-or-later
package insight

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"sort"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
)

func AnalyzeProject(target mission.Project, history []Evidence) (ProjectInsight, error) {
	if len(history) > MaxRuns {
		return ProjectInsight{}, fmt.Errorf("at most %d runs can be compared", MaxRuns)
	}
	out := ProjectInsight{ProjectID: target.ID, Runs: []RunInsight{}, Warnings: []Notice{}}
	for _, evidence := range history {
		if evidence.Project.ID != target.ID || evidence.Project.TenantID != target.TenantID {
			return ProjectInsight{}, fmt.Errorf("history belongs to another project")
		}
		value, err := Analyze(evidence)
		if err != nil {
			return ProjectInsight{}, err
		}
		out.Runs = append(out.Runs, value)
	}
	estimates, err := EstimateDurations(target, history)
	if err != nil {
		return ProjectInsight{}, err
	}
	out.Estimates = estimates
	if len(history) == MaxRuns {
		out.Warnings = append(out.Warnings, Notice{Code: "bounded_history", Message: "Only the latest bounded run history is considered; older samples may exist."})
	}
	return out, nil
}

// EstimateDurations accepts complete event-derived spans only. Changed goals,
// inputs, acceptance checks or any transitive dependency invalidate a sample.
// Reused outputs are not zero-duration samples of work that did not execute.
func EstimateDurations(target mission.Project, history []Evidence) ([]DurationEstimate, error) {
	g, err := plan.Compile(target.Plan, target.Config)
	if err != nil {
		return nil, err
	}
	if len(g.Order()) > MaxTasks || len(history) > MaxRuns {
		return nil, fmt.Errorf("duration history exceeds bounded limits")
	}
	samples := map[string][]float64{}
	runs := map[string][]string{}
	seen := map[string]bool{}
	for _, e := range history {
		if e.Project.ID != target.ID || e.Project.TenantID != target.TenantID {
			return nil, fmt.Errorf("duration history belongs to another project")
		}
		if seen[e.Run.ID] {
			return nil, fmt.Errorf("duration history repeats a run")
		}
		seen[e.Run.ID] = true
		actual, err := Analyze(e)
		if err != nil {
			return nil, err
		}
		for _, task := range actual.Tasks {
			if !task.DurationComplete || task.Reused || task.ObservedSeconds == nil || !equivalentInputs(target, e.Project, task.SpecID) {
				continue
			}
			value := *task.ObservedSeconds
			if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > MaxDurationSeconds {
				continue
			}
			samples[task.SpecID] = append(samples[task.SpecID], value)
			runs[task.SpecID] = append(runs[task.SpecID], actual.RunID)
		}
	}
	out := []DurationEstimate{}
	for _, id := range g.Order() {
		values := samples[id]
		estimate := DurationEstimate{SpecID: id, Source: "unknown", Samples: len(values), RunIDs: append([]string{}, runs[id]...), Warnings: []string{}}
		if len(values) > 0 {
			sort.Float64s(values)
			median, high := quantile(values, 0.5), quantile(values, 0.9)
			estimate.Source = "observed"
			estimate.P50Seconds = &median
			estimate.P90Seconds = &high
			if len(values) >= 2 {
				estimate.MedianInterval = bootstrapMedian(values, id)
			}
			if len(values) < 5 {
				estimate.Warnings = append(estimate.Warnings, "Few independent run samples are available; quantiles are descriptive and may not generalize.")
			}
			estimate.Warnings = append(estimate.Warnings, "Execution spans include model/tool latency and any unobserved restart gap; they are not CPU time.")
		} else {
			estimate.Warnings = append(estimate.Warnings, "No complete execution-equivalent history exists. Supply a duration assumption to simulate this task.")
		}
		out = append(out, estimate)
	}
	return out, nil
}

func equivalentInputs(left, right mission.Project, id string) bool {
	if left.Goal != right.Goal {
		return false
	}
	a, b := map[string]mission.TaskSpec{}, map[string]mission.TaskSpec{}
	for _, t := range left.Plan.Tasks {
		a[t.ID] = t
	}
	for _, t := range right.Plan.Tasks {
		b[t.ID] = t
	}
	pending := []string{id}
	seen := map[string]bool{}
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if seen[current] {
			continue
		}
		seen[current] = true
		l, lok := a[current]
		r, rok := b[current]
		if !lok || !rok || !plan.ExecutionEquivalent(l, r) || !plan.AcceptanceEquivalent(l.Checks, r.Checks) {
			return false
		}
		pending = append(pending, l.DependsOn...)
		if len(seen) > MaxTasks {
			return false
		}
	}
	return true
}

func quantile(sorted []float64, q float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	index := q * float64(len(sorted)-1)
	low := int(math.Floor(index))
	high := int(math.Ceil(index))
	return sorted[low] + (sorted[high]-sorted[low])*(index-float64(low))
}

func bootstrapMedian(values []float64, key string) *ConfidenceInterval {
	const replicates = 512
	hash := sha256.Sum256([]byte(key))
	state := binary.LittleEndian.Uint64(hash[:8]) | 1
	next := func() uint64 { state ^= state << 13; state ^= state >> 7; state ^= state << 17; return state }
	medians := make([]float64, replicates)
	resample := make([]float64, len(values))
	for i := range medians {
		for j := range resample {
			resample[j] = values[int(next()%uint64(len(values)))]
		}
		sort.Float64s(resample)
		medians[i] = quantile(resample, 0.5)
	}
	sort.Float64s(medians)
	return &ConfidenceInterval{Low: quantile(medians, 0.025), High: quantile(medians, 0.975), Confidence: 0.95, Replicates: replicates}
}

func Compare(left, right Evidence) (Comparison, error) {
	a, err := Analyze(left)
	if err != nil {
		return Comparison{}, err
	}
	b, err := Analyze(right)
	if err != nil {
		return Comparison{}, err
	}
	if left.Project.ID != right.Project.ID || left.Project.TenantID != right.Project.TenantID {
		return Comparison{}, fmt.Errorf("runs must belong to the same project")
	}
	out := Comparison{Left: a, Right: b, Tasks: []TaskComparison{}, Warnings: []Notice{}}
	byLeft, byRight := map[string]TaskInsight{}, map[string]TaskInsight{}
	ids := map[string]bool{}
	for _, t := range a.Tasks {
		byLeft[t.SpecID] = t
		ids[t.SpecID] = true
	}
	for _, t := range b.Tasks {
		byRight[t.SpecID] = t
		ids[t.SpecID] = true
	}
	order := make([]string, 0, len(ids))
	for id := range ids {
		order = append(order, id)
	}
	sort.Strings(order)
	for _, id := range order {
		l, lok := byLeft[id]
		r, rok := byRight[id]
		row := TaskComparison{SpecID: id, Change: "unchanged"}
		if lok {
			row.Left = &l
		}
		if rok {
			row.Right = &r
		}
		switch {
		case !lok:
			row.Change = "added"
			row.Reason = "Task did not exist in the earlier frozen run."
		case !rok:
			row.Change = "removed"
			row.Reason = "Task does not exist in the later frozen run."
		case !equivalentInputs(left.Project, right.Project, id):
			row.Change = "execution_changed"
			row.Reason = "Goal, task inputs, checks or transitive dependency inputs changed."
		case l.Reused || r.Reused:
			row.Change = "reused"
			row.Reason = "Reused immutable output has no new execution duration sample."
		default:
			row.Comparable = true
			tokens := r.Usage.Tokens - l.Usage.Tokens
			row.TokenDelta = &tokens
			if l.DurationComplete && r.DurationComplete && l.ObservedSeconds != nil && r.ObservedSeconds != nil {
				delta := *r.ObservedSeconds - *l.ObservedSeconds
				row.DurationDeltaSeconds = &delta
			} else {
				row.Reason = "Inputs are equivalent, but a complete duration sample is missing."
			}
		}
		out.Tasks = append(out.Tasks, row)
	}
	out.Warnings = append(out.Warnings, Notice{Code: "descriptive_comparison", Message: "Timing differences are observed across runs, not a controlled benchmark or proof of agent efficiency."})
	return out, nil
}
