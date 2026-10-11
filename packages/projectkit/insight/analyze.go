// SPDX-License-Identifier: AGPL-3.0-or-later
package insight

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
)

type taskTrace struct {
	value         TaskInsight
	open          int
	reviewStart   *time.Time
	reviewSeconds float64
	reviewKnown   bool
	invalid       bool
}

func validateEvidence(e Evidence) (*plan.Graph, error) {
	if e.Project.ID == "" || e.Run.ID == "" || e.Run.ProjectID != e.Project.ID {
		return nil, fmt.Errorf("run evidence must belong to its frozen project")
	}
	if e.Run.Tokens < 0 || e.Run.ModelCalls < 0 || e.Run.ToolCalls < 0 {
		return nil, fmt.Errorf("negative persisted run usage")
	}
	if len(e.Project.Plan.Tasks) > MaxTasks || len(e.Tasks) > MaxTasks || len(e.Events) > MaxEvents || len(e.Operations) > MaxOperations || len(e.Verifications) > MaxOperations || len(e.Reviews) > MaxOperations {
		return nil, fmt.Errorf("execution evidence exceeds bounded analysis limits")
	}
	g, err := plan.Compile(e.Project.Plan, e.Project.Config)
	if err != nil {
		return nil, err
	}
	if len(g.Order()) > MaxTasks {
		return nil, fmt.Errorf("at most %d tasks can be analyzed", MaxTasks)
	}
	seen := map[string]bool{}
	seenSpec := map[string]bool{}
	for _, t := range e.Tasks {
		if t.ID == "" || t.RunID != e.Run.ID || t.Attempt < 0 || seen[t.ID] || seenSpec[t.Spec.ID] {
			return nil, fmt.Errorf("duplicate or foreign execution task")
		}
		spec, ok := g.Task(t.Spec.ID)
		if !ok || !plan.ExecutionEquivalent(spec, t.Spec) || !plan.AcceptanceEquivalent(spec.Checks, t.Spec.Checks) {
			return nil, fmt.Errorf("execution task %s does not match frozen plan", t.Spec.ID)
		}
		seen[t.ID], seenSpec[t.Spec.ID] = true, true
	}
	if len(seen) != len(g.Order()) {
		return nil, fmt.Errorf("frozen plan task evidence is incomplete")
	}
	for _, ev := range e.Events {
		if ev.RunID != e.Run.ID || ev.ProjectID != e.Project.ID || (ev.TaskID != "" && !seen[ev.TaskID]) {
			return nil, fmt.Errorf("foreign execution event")
		}
	}
	for _, op := range e.Operations {
		if op.RunID != e.Run.ID || op.Scope.ProjectID != e.Project.ID || op.Scope.TenantID != e.Project.TenantID || op.Scope.SpaceID != e.Project.SpaceID || !seen[op.TaskID] {
			return nil, fmt.Errorf("foreign execution operation")
		}
	}
	for _, v := range e.Verifications {
		if !seen[v.TaskID] {
			return nil, fmt.Errorf("foreign execution verification")
		}
	}
	for _, v := range e.Reviews {
		if v.ProjectID != e.Project.ID || v.RunID != e.Run.ID || !seen[v.TaskID] {
			return nil, fmt.Errorf("foreign execution review")
		}
	}
	return g, nil
}

func Analyze(e Evidence) (RunInsight, error) {
	g, err := validateEvidence(e)
	if err != nil {
		return RunInsight{}, err
	}
	out := RunInsight{RunID: e.Run.ID, ProjectID: e.Project.ID, PlanVersion: e.Run.PlanVersion, Status: e.Run.Status, CreatedAt: e.Run.CreatedAt, Usage: Usage{e.Run.Tokens, e.Run.ModelCalls, e.Run.ToolCalls}, Tasks: []TaskInsight{}, StatusCounts: map[string]int{}, Warnings: []Notice{}, EvidenceComplete: !e.EventsTruncated}
	traces := map[string]*taskTrace{}
	bySpec := map[string]mission.Task{}
	for _, t := range e.Tasks {
		traces[t.ID] = &taskTrace{open: -1, value: TaskInsight{TaskID: t.ID, SpecID: t.Spec.ID, Title: t.Spec.Title, Status: t.Status, Attempt: t.Attempt, Reused: t.ReusedFromTaskID != "", Intervals: []Interval{}, Checkpoints: []Checkpoint{}, OperationStatuses: map[string]int{}, VerificationStatuses: map[string]int{}, Blockers: []Blocker{}, Warnings: []Notice{}}}
		bySpec[t.Spec.ID] = t
		out.StatusCounts[t.Status]++
	}
	events := append([]mission.Event(nil), e.Events...)
	sort.SliceStable(events, func(i, j int) bool { return events[i].Sequence < events[j].Sequence })
	seenSequence := map[int64]bool{}
	for _, ev := range events {
		if seenSequence[ev.Sequence] {
			out.Warnings = append(out.Warnings, Notice{Code: "duplicate_event", Message: "Repeated event sequence was ignored; trace completeness cannot be certified."})
			out.EvidenceComplete = false
			continue
		}
		seenSequence[ev.Sequence] = true
		out.EventCount++
		payload := decodePayload(ev.Payload)
		tr := traces[ev.TaskID]
		if ev.Kind == "run.pause" || ev.Kind == "run.cancel" || ev.Kind == "run.tenant_cancelled" || ev.Kind == "run.budget_exhausted" {
			for _, current := range traces {
				closeInterval(current, ev, ev.Kind)
			}
		}
		if isRunTerminalEvent(ev, payload) && terminal(e.Run.Status) {
			ended := ev.CreatedAt
			out.FinishedAt = &ended
		}
		if tr == nil {
			continue
		}
		switch ev.Kind {
		case "task.claimed":
			if payloadBool(payload, "recovered") {
				tr.value.Recoveries++
			}
			if tr.open >= 0 {
				tr.value.Intervals[tr.open].Recoveries++
				continue
			}
			tr.value.Intervals = append(tr.value.Intervals, Interval{Start: ev.CreatedAt, StartSequence: ev.Sequence, Outcome: "open"})
			tr.open = len(tr.value.Intervals) - 1
			if tr.value.FirstStartedAt == nil {
				t := ev.CreatedAt
				tr.value.FirstStartedAt = &t
			}
		case "task.finished":
			closeInterval(tr, ev, "finished")
			if payloadString(payload, "status") == "waiting_review" {
				t := ev.CreatedAt
				tr.reviewStart = &t
			}
			if payloadString(payload, "status") == "completed" {
				t := ev.CreatedAt
				tr.value.FinishedAt = &t
			}
		case "task.failed":
			closeInterval(tr, ev, "failed")
		case "operation.unknown":
			closeInterval(tr, ev, "unknown_effect")
		case "operation.prepared":
			if payloadString(payload, "status") == "pending_approval" {
				closeInterval(tr, ev, "approval_required")
			}
		case "task.reviewed":
			if tr.reviewStart != nil {
				seconds := ev.CreatedAt.Sub(*tr.reviewStart).Seconds()
				if seconds >= 0 {
					tr.reviewSeconds += seconds
					tr.reviewKnown = true
				} else {
					traceWarning(tr, "clock_reversal", "Review timestamp precedes its artifact; review duration is unknown.")
				}
				tr.reviewStart = nil
			}
			if payloadString(payload, "decision") == "approved" {
				t := ev.CreatedAt
				tr.value.FinishedAt = &t
			}
		case "task.retry_requested":
			tr.value.RetryRequests++
		case "task.output_reused":
			if payloadString(payload, "status") == "waiting_review" {
				t := ev.CreatedAt
				tr.reviewStart = &t
			}
		case "task.checkpoint":
			tr.value.Checkpoints = append(tr.value.Checkpoints, Checkpoint{ID: payloadString(payload, "checkpointId"), Sequence: payloadInt(payload, "sequence"), NextTool: int(payloadInt(payload, "nextTool")), EventSequence: ev.Sequence, CreatedAt: ev.CreatedAt})
		case "model.decision":
			tokens := payloadInt(payload, "tokens")
			if tokens < 0 || tr.value.Usage.Tokens > math.MaxInt64-tokens {
				traceWarning(tr, "invalid_usage", "Model usage cannot be safely summed.")
			} else {
				tr.value.Usage.Tokens += tokens
				tr.value.Usage.ModelCalls++
			}
		}
	}
	seenOperations := map[string]bool{}
	for _, op := range e.Operations {
		if seenOperations[op.ID] {
			return RunInsight{}, fmt.Errorf("duplicate operation evidence")
		}
		seenOperations[op.ID] = true
		tr := traces[op.TaskID]
		tr.value.OperationStatuses[op.Status]++
		tr.value.Usage.ToolCalls++
		if op.Status == "unknown" || op.Status == "pending_approval" {
			code, message := "unknown_effect", "An already dispatched effect needs inspection or human attestation before retry."
			if op.Status == "pending_approval" {
				code, message = "effect_approval", "A never-started external effect needs human approval."
			}
			tr.value.Blockers = append(tr.value.Blockers, Blocker{Code: code, TaskID: tr.value.SpecID, OperationID: op.ID, Message: message, Evidence: "persisted_operation", Chain: []string{tr.value.SpecID}})
		}
	}
	for _, v := range e.Verifications {
		traces[v.TaskID].value.VerificationStatuses[v.Status]++
	}
	durations := map[string]*float64{}
	active := 0
	for _, t := range e.Tasks {
		if t.Status == "running" || t.Status == "verifying" {
			active++
		}
	}
	for _, id := range g.Order() {
		t := bySpec[id]
		tr := traces[t.ID]
		sum := 0.0
		known := 0
		for _, interval := range tr.value.Intervals {
			if interval.Seconds != nil {
				sum += *interval.Seconds
				known++
			}
		}
		if known > 0 {
			tr.value.ObservedSeconds = &sum
		}
		tr.value.DurationComplete = t.Status == "completed" && !tr.value.Reused && len(tr.value.Intervals) > 0 && known == len(tr.value.Intervals) && !tr.invalid && out.EvidenceComplete
		if tr.reviewKnown && tr.reviewStart == nil {
			tr.value.ReviewSeconds = &tr.reviewSeconds
		}
		if tr.value.Reused {
			zero := 0.0
			durations[id] = &zero
			traceWarning(tr, "reused_output", "This run reused an immutable artifact; no execution duration sample is attributed to it.")
		} else if tr.value.DurationComplete {
			durations[id] = tr.value.ObservedSeconds
		} else {
			durations[id] = nil
		}
		if tr.value.ObservedSeconds != nil && *tr.value.ObservedSeconds > 0 {
			ratio := float64(tr.value.Usage.Tokens) / *tr.value.ObservedSeconds
			tr.value.TokensPerObservedSecond = &ratio
		}
		if t.Status != "completed" {
			tr.value.Blockers = append(tr.value.Blockers, explainBlockers(g, bySpec, t, e.Run, active, e.Project.Config.Budget.MaxConcurrent)...)
		}
		out.AttributedUsage.Tokens = safeAddTokens(out.AttributedUsage.Tokens, tr.value.Usage.Tokens)
		out.AttributedUsage.ModelCalls += tr.value.Usage.ModelCalls
		out.AttributedUsage.ToolCalls += tr.value.Usage.ToolCalls
		out.Tasks = append(out.Tasks, tr.value)
	}
	out.UnattributedUsage = Usage{max(int64(0), out.Usage.Tokens-out.AttributedUsage.Tokens), max(0, out.Usage.ModelCalls-out.AttributedUsage.ModelCalls), max(0, out.Usage.ToolCalls-out.AttributedUsage.ToolCalls)}
	if out.UnattributedUsage.Tokens > 0 || out.UnattributedUsage.ModelCalls > 0 || out.UnattributedUsage.ToolCalls > 0 {
		out.Warnings = append(out.Warnings, Notice{Code: "unattributed_usage", Message: "Run counters include reservations or records without settled task evidence; these costs are not assigned by guess."})
	}
	if out.AttributedUsage.Tokens > out.Usage.Tokens || out.AttributedUsage.ModelCalls > out.Usage.ModelCalls || out.AttributedUsage.ToolCalls > out.Usage.ToolCalls {
		out.Warnings = append(out.Warnings, Notice{Code: "concurrent_read", Message: "Task evidence is newer than the run counter snapshot; reload before comparing totals."})
		out.EvidenceComplete = false
	}
	if !out.EvidenceComplete {
		for i := range out.Tasks {
			out.Tasks[i].DurationComplete = false
			if !out.Tasks[i].Reused {
				durations[out.Tasks[i].SpecID] = nil
			}
		}
	}
	if e.EventsTruncated {
		out.Warnings = append(out.Warnings, Notice{Code: "events_truncated", Message: "The bounded event history is incomplete; durations are observations, not certified completion samples."})
	}
	if out.FinishedAt != nil {
		seconds := out.FinishedAt.Sub(e.Run.CreatedAt).Seconds()
		if seconds >= 0 {
			out.ElapsedSeconds = &seconds
		} else {
			out.Warnings = append(out.Warnings, Notice{Code: "clock_reversal", Message: "Run completion timestamp precedes creation; elapsed duration is unknown."})
		}
	}
	out.CriticalPath = criticalPath(g, durations)
	return out, nil
}

func traceWarning(tr *taskTrace, code, message string) {
	tr.value.Warnings = append(tr.value.Warnings, Notice{Code: code, TaskID: tr.value.SpecID, Message: message})
	if code == "clock_reversal" || code == "missing_start" {
		tr.invalid = true
	}
}

func closeInterval(tr *taskTrace, ev mission.Event, outcome string) {
	if tr.open < 0 {
		if ev.Kind == "task.finished" || ev.Kind == "task.failed" {
			traceWarning(tr, "missing_start", "A terminal task event has no earlier claimed event; its duration remains unknown.")
		}
		return
	}
	interval := &tr.value.Intervals[tr.open]
	end := ev.CreatedAt
	interval.End = &end
	interval.EndSequence = ev.Sequence
	interval.Outcome = outcome
	seconds := end.Sub(interval.Start).Seconds()
	if seconds >= 0 {
		interval.Seconds = &seconds
	} else {
		traceWarning(tr, "clock_reversal", "An event timestamp moved backwards; this interval has no trusted duration.")
	}
	tr.open = -1
}

func decodePayload(raw json.RawMessage) map[string]any {
	var value map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&value) != nil {
		return map[string]any{}
	}
	return value
}
func payloadString(p map[string]any, key string) string { value, _ := p[key].(string); return value }
func payloadBool(p map[string]any, key string) bool     { value, _ := p[key].(bool); return value }
func payloadInt(p map[string]any, key string) int64 {
	value, _ := p[key].(json.Number)
	n, _ := value.Int64()
	return n
}
func terminal(status string) bool {
	return status == "completed" || status == "cancelled" || status == "failed"
}
func isRunTerminalEvent(ev mission.Event, p map[string]any) bool {
	return ev.Kind == "run.cancel" || ev.Kind == "run.tenant_cancelled" || ev.Kind == "run.budget_exhausted" || (ev.Kind == "run.status" && terminal(payloadString(p, "status")))
}
func safeAddTokens(a, b int64) int64 {
	if b > 0 && a > math.MaxInt64-b {
		return math.MaxInt64
	}
	return a + b
}

func explainBlockers(g *plan.Graph, tasks map[string]mission.Task, t mission.Task, r mission.Run, active, limit int) []Blocker {
	result := []Blocker{}
	if r.Status == "paused" || r.Status == "cancelled" || r.Status == "failed" {
		result = append(result, Blocker{Code: "run_" + r.Status, TaskID: t.Spec.ID, Message: "The durable run state prevents new dispatch: " + r.Status, Evidence: "run_state", Chain: []string{t.Spec.ID}})
	}
	switch t.Status {
	case "waiting_review":
		result = append(result, Blocker{Code: "artifact_review", TaskID: t.Spec.ID, Message: "Passed artifact requires a fresh human review before dependants can execute.", Evidence: "task_state", Chain: []string{t.Spec.ID}})
	case "unknown":
		result = append(result, Blocker{Code: "unknown_effect", TaskID: t.Spec.ID, Message: "Task is fenced until the dispatched effect is reconciled.", Evidence: "task_state", Chain: []string{t.Spec.ID}})
	case "failed":
		result = append(result, Blocker{Code: "task_failed", TaskID: t.Spec.ID, Message: "Task failed and needs an explicit retry or replan.", Evidence: "task_state", Chain: []string{t.Spec.ID}})
	case "running", "verifying":
		result = append(result, Blocker{Code: "in_progress", TaskID: t.Spec.ID, Message: "Execution or acceptance is still in progress; no completed duration is available.", Evidence: "task_state", Chain: []string{t.Spec.ID}})
	}
	if t.Status == "waiting_approval" {
		result = append(result, Blocker{Code: "effect_approval", TaskID: t.Spec.ID, Message: "An external effect is awaiting approval before dispatch.", Evidence: "task_state", Chain: []string{t.Spec.ID}})
	}
	if t.Status == "pending" || t.Status == "blocked" {
		for _, dep := range g.Dependencies(t.Spec.ID) {
			if tasks[dep].Status == "completed" {
				continue
			}
			chain := []string{t.Spec.ID, dep}
			current := dep
			for len(chain) <= MaxTasks {
				next := ""
				for _, ancestor := range g.Dependencies(current) {
					if tasks[ancestor].Status != "completed" {
						next = ancestor
						break
					}
				}
				if next == "" {
					break
				}
				chain = append(chain, next)
				current = next
			}
			result = append(result, Blocker{Code: "dependency", TaskID: dep, Message: "Dependency has not produced an accepted output: " + tasks[dep].Status, Evidence: "dependency_state", Chain: chain})
		}
		if len(result) == 0 && limit > 0 && active >= limit {
			result = append(result, Blocker{Code: "capacity", TaskID: t.Spec.ID, Message: "Concurrency appears occupied according to task states; expired leases or worker availability may change the actual dispatch cause.", Evidence: "capacity_inference", Chain: []string{t.Spec.ID}})
		}
		if len(result) == 0 {
			result = append(result, Blocker{Code: "dispatch_pending", TaskID: t.Spec.ID, Message: "Dependencies are accepted; no durable event proves a further waiting cause.", Evidence: "unknown", Chain: []string{t.Spec.ID}})
		}
	}
	return result
}

func criticalPath(g *plan.Graph, durations map[string]*float64) CriticalPath {
	result := CriticalPath{TaskIDs: []string{}, UnknownTaskIDs: []string{}}
	finishes := map[string]float64{}
	previous := map[string]string{}
	last := ""
	for _, id := range g.Order() {
		start := 0.0
		for _, dep := range g.Dependencies(id) {
			if finishes[dep] > start || (finishes[dep] == start && (previous[id] == "" || dep < previous[id])) {
				start = finishes[dep]
				previous[id] = dep
			}
		}
		duration := 0.0
		if value := durations[id]; value != nil {
			duration = *value
		} else {
			result.UnknownTaskIDs = append(result.UnknownTaskIDs, id)
		}
		finishes[id] = start + duration
		if last == "" || finishes[id] > finishes[last] || (finishes[id] == finishes[last] && id < last) {
			last = id
		}
	}
	for current := last; current != ""; current = previous[current] {
		result.TaskIDs = append(result.TaskIDs, current)
	}
	for i, j := 0, len(result.TaskIDs)-1; i < j; i, j = i+1, j-1 {
		result.TaskIDs[i], result.TaskIDs[j] = result.TaskIDs[j], result.TaskIDs[i]
	}
	result.KnownLowerBoundSeconds = finishes[last]
	if len(result.UnknownTaskIDs) == 0 {
		seconds := result.KnownLowerBoundSeconds
		result.Seconds = &seconds
	}
	return result
}
