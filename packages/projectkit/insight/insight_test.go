// SPDX-License-Identifier: AGPL-3.0-or-later
package insight

import (
	"encoding/json"
	"math"
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
)

func fixture(ids ...string) Evidence {
	e := Evidence{Project: mission.Project{ID: "project", TenantID: "tenant", SpaceID: "space", Goal: "deliver useful feature", Plan: mission.Plan{Version: 1}, Config: mission.Config{Budget: mission.Budget{MaxConcurrent: 2}}}, Run: mission.Run{ID: "run", ProjectID: "project", PlanVersion: 1, Status: "running", CreatedAt: time.Unix(1000, 0)}}
	for _, id := range ids {
		spec := mission.TaskSpec{ID: id, Title: "Task " + id, Prompt: "Implement " + id, AgentID: "agent", Writes: []string{id + ".txt"}, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: id + ".txt", Required: true}}}
		e.Project.Plan.Tasks = append(e.Project.Plan.Tasks, spec)
		e.Tasks = append(e.Tasks, mission.Task{ID: "task-" + id, RunID: e.Run.ID, Spec: spec, Status: "pending", CreatedAt: e.Run.CreatedAt, UpdatedAt: e.Run.CreatedAt})
	}
	return e
}

func event(e *Evidence, spec, kind string, second int64, payload map[string]any) {
	tid := ""
	if spec != "" {
		tid = "task-" + spec
	}
	raw, _ := json.Marshal(payload)
	e.Events = append(e.Events, mission.Event{ID: kind, ProjectID: e.Project.ID, RunID: e.Run.ID, TaskID: tid, Sequence: int64(len(e.Events) + 1), Kind: kind, Payload: raw, CreatedAt: time.Unix(1000+second, 0)})
}

func finish(e *Evidence, index int, start, end int64) {
	id := e.Tasks[index].Spec.ID
	event(e, id, "task.claimed", start, nil)
	event(e, id, "task.finished", end, map[string]any{"status": "completed"})
	e.Tasks[index].Status = "completed"
}

func taskBySpec(t *testing.T, run RunInsight, id string) TaskInsight {
	t.Helper()
	for _, task := range run.Tasks {
		if task.SpecID == id {
			return task
		}
	}
	t.Fatalf("task %s missing", id)
	return TaskInsight{}
}

func TestTraceUsesDurableBoundariesAndDoesNotDoubleCountRecovery(t *testing.T) {
	e := fixture("a", "b")
	e.Project.Plan.Tasks[1].DependsOn = []string{"a"}
	e.Tasks[1].Spec = e.Project.Plan.Tasks[1]
	event(&e, "a", "task.claimed", 1, nil)
	event(&e, "a", "model.decision", 2, map[string]any{"tokens": 7})
	event(&e, "a", "task.claimed", 8, map[string]any{"recovered": true})
	event(&e, "a", "task.finished", 11, map[string]any{"status": "waiting_review"})
	event(&e, "a", "task.reviewed", 31, map[string]any{"decision": "approved"})
	e.Tasks[0].Status = "completed"
	e.Tasks[0].UpdatedAt = time.Unix(990000, 0)
	e.Run.Tokens = 8199
	e.Run.ModelCalls = 2
	e.Run.ToolCalls = 1
	e.Operations = []mission.Operation{{ID: "write", Scope: mission.Scope{TenantID: "tenant", SpaceID: "space", ProjectID: "project"}, RunID: "run", TaskID: "task-a", Status: "completed"}}
	value, err := Analyze(e)
	if err != nil {
		t.Fatal(err)
	}
	a := taskBySpec(t, value, "a")
	if a.ObservedSeconds == nil || *a.ObservedSeconds != 10 || len(a.Intervals) != 1 || a.Recoveries != 1 || !a.DurationComplete {
		t.Fatalf("incorrect recovery span: %+v", a)
	}
	if a.ReviewSeconds == nil || *a.ReviewSeconds != 20 {
		t.Fatalf("review wait included in execution: %+v", a)
	}
	if a.Usage.Tokens != 7 || a.Usage.ToolCalls != 1 || value.UnattributedUsage.Tokens != 8192 || value.UnattributedUsage.ModelCalls != 1 {
		t.Fatalf("lost model reservation was attributed by guess: %+v", value)
	}
	b := taskBySpec(t, value, "b")
	if b.ObservedSeconds != nil || b.Blockers[0].Code != "dispatch_pending" {
		t.Fatalf("pending duration or invented blocker: %+v", b)
	}
	if value.CriticalPath.Seconds != nil || value.CriticalPath.KnownLowerBoundSeconds != 10 {
		t.Fatalf("unknown task converted to unit duration: %+v", value.CriticalPath)
	}
}

func TestPauseApprovalRetryAndClockReversalRemainExplicit(t *testing.T) {
	e := fixture("a")
	event(&e, "a", "task.claimed", 0, nil)
	event(&e, "", "run.pause", 5, nil)
	event(&e, "", "run.resume", 105, nil)
	event(&e, "a", "task.claimed", 110, map[string]any{"recovered": true})
	event(&e, "a", "operation.prepared", 114, map[string]any{"status": "pending_approval"})
	event(&e, "a", "task.claimed", 214, nil)
	event(&e, "a", "task.failed", 219, nil)
	event(&e, "a", "task.retry_requested", 300, nil)
	event(&e, "a", "task.claimed", 310, nil)
	event(&e, "a", "task.finished", 320, map[string]any{"status": "completed"})
	e.Tasks[0].Status = "completed"
	value, err := Analyze(e)
	if err != nil {
		t.Fatal(err)
	}
	a := value.Tasks[0]
	if a.ObservedSeconds == nil || *a.ObservedSeconds != 24 || a.RetryRequests != 1 || len(a.Intervals) != 4 {
		t.Fatalf("control waiting was charged as execution: %+v", a)
	}
	e.Events[len(e.Events)-1].CreatedAt = time.Unix(1001, 0)
	value, err = Analyze(e)
	if err != nil {
		t.Fatal(err)
	}
	if value.Tasks[0].DurationComplete || value.Tasks[0].Intervals[3].Seconds != nil {
		t.Fatalf("negative clock duration accepted: %+v", value.Tasks[0])
	}
}

func TestBlockerCauseChainUsesAcceptedDependencies(t *testing.T) {
	e := fixture("a", "b", "c")
	for i := 1; i < 3; i++ {
		e.Project.Plan.Tasks[i].DependsOn = []string{e.Tasks[i-1].Spec.ID}
		e.Tasks[i].Spec = e.Project.Plan.Tasks[i]
	}
	e.Tasks[0].Status = "waiting_review"
	e.Tasks[1].Status = "blocked"
	value, err := Analyze(e)
	if err != nil {
		t.Fatal(err)
	}
	c := taskBySpec(t, value, "c")
	if len(c.Blockers) != 1 || !reflect.DeepEqual(c.Blockers[0].Chain, []string{"c", "b", "a"}) {
		t.Fatalf("lost transitive review cause: %+v", c.Blockers)
	}
	if taskBySpec(t, value, "a").Blockers[0].Code != "artifact_review" {
		t.Fatal("review is not a durable blocker")
	}
}

func TestEstimatorRejectsChangedAncestorsReuseAndIncompleteEvidence(t *testing.T) {
	target := fixture("a", "b")
	target.Project.Plan.Tasks[1].DependsOn = []string{"a"}
	target.Tasks[1].Spec = target.Project.Plan.Tasks[1]
	history := []Evidence{}
	for i, seconds := range []int64{2, 4, 8, 16, 32} {
		e := fixture("a", "b")
		e.Run.ID = string(rune('A' + i))
		e.Run.Status = "completed"
		e.Project.Plan.Tasks[1].DependsOn = []string{"a"}
		for j := range e.Tasks {
			e.Tasks[j].RunID = e.Run.ID
			e.Tasks[j].Spec = e.Project.Plan.Tasks[j]
		}
		finish(&e, 0, 0, seconds)
		finish(&e, 1, seconds, seconds*2)
		history = append(history, e)
	}
	estimates, err := EstimateDurations(target.Project, history)
	if err != nil {
		t.Fatal(err)
	}
	b := estimates[1]
	if b.Samples != 5 || b.P50Seconds == nil || *b.P50Seconds != 8 || b.MedianInterval == nil || b.MedianInterval.Low > b.MedianInterval.High {
		t.Fatalf("invalid observed distribution: %+v", b)
	}
	again, _ := EstimateDurations(target.Project, history)
	if !reflect.DeepEqual(again, estimates) {
		t.Fatal("bootstrap result is nondeterministic")
	}
	target.Project.Plan.Tasks[0].Prompt = "changed upstream artifact"
	changed, err := EstimateDurations(target.Project, history)
	if err != nil {
		t.Fatal(err)
	}
	if changed[1].Samples != 0 || changed[1].P50Seconds != nil {
		t.Fatal("consumer history survived changed dependency")
	}
	target.Project = history[0].Project
	history[0].Tasks[1].ReusedFromTaskID = "old"
	history[1].EventsTruncated = true
	filtered, err := EstimateDurations(target.Project, history)
	if err != nil {
		t.Fatal(err)
	}
	if filtered[1].Samples != 3 {
		t.Fatalf("reused/truncated samples counted: %+v", filtered[1])
	}
}

func TestComparisonNeverClaimsChangedInputsAreFaster(t *testing.T) {
	left := fixture("a", "b")
	right := fixture("a", "b")
	left.Project.Plan.Tasks[1].DependsOn = []string{"a"}
	left.Tasks[1].Spec = left.Project.Plan.Tasks[1]
	right.Project.Plan.Tasks[1].DependsOn = []string{"a"}
	right.Tasks[1].Spec = right.Project.Plan.Tasks[1]
	finish(&left, 0, 0, 10)
	finish(&left, 1, 10, 20)
	finish(&right, 0, 0, 5)
	finish(&right, 1, 5, 10)
	right.Project.Plan.Tasks[0].Prompt = "different algorithm"
	right.Tasks[0].Spec = right.Project.Plan.Tasks[0]
	value, err := Compare(left, right)
	if err != nil {
		t.Fatal(err)
	}
	if value.Tasks[1].Comparable || value.Tasks[1].DurationDeltaSeconds != nil {
		t.Fatal("changed ancestor compared as speedup")
	}
	left.Project.TenantID = "other"
	if _, err := Compare(left, right); err == nil {
		t.Fatal("cross tenant comparison accepted")
	}
}

func TestSimulatorRespectsDAGWriteScopeAndCapacity(t *testing.T) {
	e := fixture("a", "b", "c", "d")
	e.Project.Plan.Tasks[0].Writes = []string{"src/api/**"}
	e.Project.Plan.Tasks[1].Writes = []string{"src/apix/file.go"}
	e.Project.Plan.Tasks[2].Writes = []string{"src/api/handler.go"}
	e.Project.Plan.Tasks[3].DependsOn = []string{"a", "b", "c"}
	for i := range e.Tasks {
		e.Tasks[i].Spec = e.Project.Plan.Tasks[i]
	}
	s := Scenario{ID: "two", Label: "two slots", MaxConcurrent: 2, Durations: map[string]float64{"a": 10, "b": 10, "c": 10, "d": 10}, Capacities: map[string]int{"gpu": 1}, Resources: map[string]map[string]int{"a": {"gpu": 1}, "b": {"gpu": 1}}}
	result, err := Simulate(e, nil, SimulationRequest{Scenarios: []Scenario{s}})
	if err != nil {
		t.Fatal(err)
	}
	value := result.Scenarios[0]
	if value.Status != "complete" || value.MakespanSeconds == nil || *value.MakespanSeconds != 30 || value.Budget.Status != "unknown" {
		t.Fatalf("unexpected scheduling result: %+v", value)
	}
	entries := map[string]TimelineEntry{}
	for _, entry := range value.Timeline {
		entries[entry.SpecID] = entry
	}
	if entries["c"].StartSeconds < entries["a"].EndSeconds || entries["b"].StartSeconds < entries["a"].EndSeconds || entries["d"].StartSeconds < entries["b"].EndSeconds {
		t.Fatalf("reservation or dependency violated: %+v", entries)
	}
	delete(s.Resources, "b")
	result, err = Simulate(e, nil, SimulationRequest{Scenarios: []Scenario{s}})
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range result.Scenarios[0].Timeline {
		entries[entry.SpecID] = entry
	}
	if entries["b"].StartSeconds != 0 {
		t.Fatal("lexical src/api neighbour incorrectly conflicts")
	}
	s.Resources["a"]["gpu"] = 2
	result, err = Simulate(e, nil, SimulationRequest{Scenarios: []Scenario{s}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Scenarios[0].Status != "blocked" || result.Scenarios[0].MakespanSeconds != nil {
		t.Fatal("impossible resource capacity claimed completion")
	}
}

func TestSimulatorUnknownBudgetAndLimitsFailClosed(t *testing.T) {
	e := fixture("a", "b")
	e.Project.Config.Budget.MaxTokens = 5
	s := Scenario{ID: "one", MaxConcurrent: 1, Durations: map[string]float64{"a": 4}, Costs: map[string]CostEstimate{"a": {Tokens: 6}}}
	result, err := Simulate(e, nil, SimulationRequest{Scenarios: []Scenario{s}})
	if err != nil {
		t.Fatal(err)
	}
	value := result.Scenarios[0]
	if value.Status != "unknown" || value.MakespanSeconds != nil || value.Budget.Status != "exceeded" || len(value.UnknownTaskIDs) != 1 {
		t.Fatalf("missing assumptions guessed: %+v", value)
	}
	s.Durations["b"] = math.Inf(1)
	if _, err := Simulate(e, nil, SimulationRequest{Scenarios: []Scenario{s}}); err == nil {
		t.Fatal("infinite duration accepted")
	}
	s.Durations["b"] = 1
	if _, err := Simulate(e, nil, SimulationRequest{Scenarios: []Scenario{s, s}}); err == nil {
		t.Fatal("duplicate scenario IDs accepted")
	}
	e.Events = make([]mission.Event, MaxEvents+1)
	if _, err := Analyze(e); err == nil {
		t.Fatal("unbounded event input accepted")
	}
}

// Random DAGs check scheduling invariants independently of selection order:
// every edge, resource and simultaneous write reservation must remain feasible.
func TestSimulationRandomDAGInvariants(t *testing.T) {
	random := rand.New(rand.NewSource(42071))
	for sample := 0; sample < 120; sample++ {
		count := 3 + random.Intn(20)
		ids := []string{}
		for i := 0; i < count; i++ {
			ids = append(ids, string(rune('A'+i)))
		}
		e := fixture(ids...)
		s := Scenario{ID: "sample", MaxConcurrent: 1 + random.Intn(5), Durations: map[string]float64{}, Capacities: map[string]int{"cpu": 4}, Resources: map[string]map[string]int{}}
		for i := range e.Tasks {
			for j := 0; j < i; j++ {
				if random.Intn(8) == 0 {
					e.Project.Plan.Tasks[i].DependsOn = append(e.Project.Plan.Tasks[i].DependsOn, ids[j])
				}
			}
			e.Project.Plan.Tasks[i].Writes = []string{"area/" + string(rune('a'+random.Intn(4)))}
			e.Tasks[i].Spec = e.Project.Plan.Tasks[i]
			s.Durations[ids[i]] = float64(1 + random.Intn(9))
			s.Resources[ids[i]] = map[string]int{"cpu": 1 + random.Intn(3)}
		}
		result, err := Simulate(e, nil, SimulationRequest{Scenarios: []Scenario{s}})
		if err != nil {
			t.Fatal(err)
		}
		timeline := result.Scenarios[0].Timeline
		byID := map[string]TimelineEntry{}
		for _, entry := range timeline {
			byID[entry.SpecID] = entry
		}
		if len(timeline) != count || result.Scenarios[0].Status != "complete" {
			t.Fatalf("feasible DAG deadlocked at sample %d", sample)
		}
		for _, spec := range e.Project.Plan.Tasks {
			for _, dep := range spec.DependsOn {
				if byID[dep].EndSeconds > byID[spec.ID].StartSeconds {
					t.Fatal("dependency starts early")
				}
			}
		}
		for _, point := range timeline {
			concurrent, resource := 0, 0
			for _, entry := range timeline {
				if entry.StartSeconds <= point.StartSeconds && entry.EndSeconds > point.StartSeconds {
					concurrent++
					resource += entry.Resources["cpu"]
				}
			}
			if concurrent > s.MaxConcurrent || resource > 4 {
				t.Fatal("capacity exceeded")
			}
		}
		for i, a := range timeline {
			for _, b := range timeline[i+1:] {
				if a.StartSeconds < b.EndSeconds && b.StartSeconds < a.EndSeconds {
					var as, bs mission.TaskSpec
					for _, spec := range e.Project.Plan.Tasks {
						if spec.ID == a.SpecID {
							as = spec
						}
						if spec.ID == b.SpecID {
							bs = spec
						}
					}
					if conflict, _ := plan.PathsOverlap(as.Writes[0], bs.Writes[0]); conflict {
						t.Fatal("simultaneous write reservation overlaps")
					}
				}
			}
		}
	}
}

func TestReportEscapesTitlesAndExportsNoExecutionSecrets(t *testing.T) {
	e := fixture("a")
	e.Project.Plan.Tasks[0].Title = "<script>alert(1)</script>|x\ny"
	e.Tasks[0].Spec = e.Project.Plan.Tasks[0]
	finish(&e, 0, 0, 5)
	value, err := Analyze(e)
	if err != nil {
		t.Fatal(err)
	}
	report := Markdown(value)
	if strings.Contains(report, "<script>") || strings.Contains(report, "Implement a") || !strings.Contains(report, "&lt;script&gt;") {
		t.Fatalf("unsafe or excessive report: %s", report)
	}
}
