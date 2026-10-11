// SPDX-License-Identifier: AGPL-3.0-or-later
package plan

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"math/rand"
	"reflect"
	"sort"
	"testing"
	"time"
)

func task(id string, deps ...string) mission.TaskSpec {
	return mission.TaskSpec{ID: id, Title: id, Prompt: "implement " + id, AgentID: "agent", DependsOn: deps, Writes: []string{"src/" + id}, Checks: []mission.CheckSpec{{ID: "check", Kind: "path_exists", Path: "src/" + id, Required: true}}, MaxAttempts: 3}
}
func planOf(tasks ...mission.TaskSpec) mission.Plan { return mission.Plan{Version: 1, Tasks: tasks} }
func assertStrings(t *testing.T, a, b []string) {
	t.Helper()
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("got %v, expected %v", a, b)
	}
}
func TestValidationReportsAllLocationsAndCycleWitness(t *testing.T) {
	a := task("a", "missing")
	a.Writes = []string{"../escape"}
	a.Checks[0].Kind = "unknown"
	a.Priority = 1001
	err := ValidatePlan(planOf(a), mission.Config{})
	var invalid *ValidationError
	if !errors.As(err, &invalid) || len(invalid.Issues) < 4 {
		t.Fatalf("missing structured issues: %v", err)
	}
	seen := map[string]bool{}
	for _, issue := range invalid.Issues {
		seen[issue.Code] = true
	}
	for _, code := range []string{"missing_dependency", "invalid_write", "unsupported_kind", "range"} {
		if !seen[code] {
			t.Fatalf("missing %s", code)
		}
	}
	_, err = Compile(planOf(task("a", "b"), task("b", "c"), task("c", "a")), mission.Config{})
	if !errors.As(err, &invalid) || invalid.Issues[0].Code != "dependency_cycle" {
		t.Fatalf("cycle: %v", err)
	}
	assertStrings(t, invalid.Issues[0].Related, []string{"a", "b", "c", "a"})
	empty := task("empty")
	empty.Checks = nil
	if ValidatePlan(planOf(empty), mission.Config{}) == nil {
		t.Fatal("unverifiable task accepted")
	}
}
func TestCriticalPathAndSlackWithExplicitDurations(t *testing.T) {
	p := planOf(task("finish", "left", "right"), task("right", "root"), task("root"), task("left", "root"))
	a, err := AnalyzeWithEstimates(p, mission.Config{}, map[string]Estimate{"root": {Seconds: 2}, "left": {Seconds: 7}, "right": {Seconds: 3}, "finish": {Seconds: 4}})
	if err != nil {
		t.Fatal(err)
	}
	assertStrings(t, a.Topological, []string{"root", "left", "right", "finish"})
	assertStrings(t, a.CriticalPath, []string{"root", "left", "finish"})
	if a.CriticalLength != 13 {
		t.Fatalf("critical: %d", a.CriticalLength)
	}
	nodes := map[string]Node{}
	for _, n := range a.Nodes {
		nodes[n.ID] = n
	}
	if nodes["right"].Slack != 4 || nodes["right"].Critical || nodes["finish"].Ancestors != 3 || nodes["root"].Descendants != 3 {
		t.Fatalf("bad nodes: %+v", nodes)
	}
	a2, err := AnalyzeWithEstimates(p, mission.Config{}, map[string]Estimate{"root": {Seconds: 2}, "left": {Seconds: 7}, "right": {Seconds: 3}, "finish": {Seconds: 4}})
	if err != nil {
		t.Fatal(err)
	}
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(a2)
	if string(x) != string(y) {
		t.Fatal("analysis is nondeterministic")
	}
	p.Tasks[2].Prompt = "changed after compile"
	g, err := Compile(planOf(task("a")), mission.Config{})
	if err != nil {
		t.Fatal(err)
	}
	copy, _ := g.Task("a")
	copy.Writes[0] = "mutated"
	again, _ := g.Task("a")
	if again.Writes[0] == "mutated" {
		t.Fatal("graph accessor leaked mutation")
	}
}
func TestBitsetReachabilityMatchesIndependentDFS(t *testing.T) {
	rng := rand.New(rand.NewSource(4632))
	for size := 2; size <= 130; size += 16 {
		tasks := make([]mission.TaskSpec, size)
		for i := range tasks {
			tasks[i] = task(fmt.Sprintf("t%03d", i))
			for j := 0; j < i; j++ {
				if rng.Intn(10) == 0 {
					tasks[i].DependsOn = append(tasks[i].DependsOn, fmt.Sprintf("t%03d", j))
				}
			}
		}
		g, err := Compile(planOf(tasks...), mission.Config{})
		if err != nil {
			t.Fatal(err)
		}
		for _, node := range tasks {
			reachable := map[string]bool{}
			var walk func(string)
			walk = func(id string) {
				for _, dep := range g.dependencies[id] {
					if !reachable[dep] {
						reachable[dep] = true
						walk(dep)
					}
				}
			}
			walk(node.ID)
			for _, candidate := range tasks {
				if g.IsAncestor(candidate.ID, node.ID) != reachable[candidate.ID] {
					t.Fatalf("reachability %s -> %s", candidate.ID, node.ID)
				}
			}
		}
	}
}
func TestWriteScopeConflictWitnessAndLexicalNeighbors(t *testing.T) {
	a, b, c := task("a"), task("b"), task("c")
	a.Writes = []string{"src/a"}
	b.Writes = []string{"src/a-b"}
	c.Writes = []string{"src/a/file.go"}
	analysis, err := Analyze(planOf(a, b, c), mission.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if len(analysis.Conflicts) != 1 || analysis.Conflicts[0].LeftTask != "a" || analysis.Conflicts[0].RightTask != "c" || analysis.Conflicts[0].Witness != "src/a/file.go" {
		t.Fatalf("conflicts %+v", analysis.Conflicts)
	}
	c.DependsOn = []string{"a"}
	analysis, err = Analyze(planOf(a, b, c), mission.Config{})
	if err != nil || !analysis.Conflicts[0].Ordered {
		t.Fatalf("ordered conflict %+v %v", analysis, err)
	}
	for _, sample := range []struct {
		A, B     string
		Expected bool
	}{{"src/**", "src/a", true}, {"src/a", "src/abc", false}, {".", "anything", true}, {"a/./b", "a/b/c", true}} {
		yes, err := PathsOverlap(sample.A, sample.B)
		if err != nil || yes != sample.Expected {
			t.Fatalf("overlap %+v %v %v", sample, yes, err)
		}
	}
	for _, bad := range []string{"/root", "../x", "a/../x", "C:/foo", ".git/HEAD", "a/*/b", "a\\b", "x\x00y"} {
		if _, err := PathsOverlap(bad, "src"); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}
func TestSchedulingBudgetsDependenciesAndWriteReservations(t *testing.T) {
	a, b, c, d := task("a"), task("b"), task("c", "a"), task("d")
	a.Writes = []string{"shared"}
	b.Writes = []string{"shared/file"}
	p := planOf(a, b, c, d)
	cfg := mission.Config{Budget: mission.Budget{MaxConcurrent: 3, MaxTokens: 15}}
	estimates := map[string]Estimate{"a": {Tokens: 10}, "b": {Tokens: 10}, "c": {Tokens: 1}, "d": {Tokens: 5}}
	result, err := ScheduleCandidates(p, nil, cfg, ScheduleOptions{Estimates: estimates, Now: time.Unix(0, 0)})
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, c := range result.Selected {
		ids = append(ids, c.TaskID)
	}
	assertStrings(t, ids, []string{"a", "d"})
	if result.Reserved.Tokens != 15 {
		t.Fatalf("reservation %+v", result)
	}
	codes := map[string]string{}
	for _, d := range result.Deferred {
		codes[d.TaskID] = d.Codes[0]
	}
	if codes["b"] != "batch_write_conflict" || codes["c"] != "dependency_pending" {
		t.Fatalf("deferred %+v", result.Deferred)
	}
	completed := mission.Task{Spec: a, Status: "completed"}
	result, err = ScheduleCandidates(p, []mission.Task{completed}, cfg, ScheduleOptions{Estimates: estimates, Now: time.Unix(0, 0)})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range result.Ranked {
		found = found || c.TaskID == "c"
	}
	if !found {
		t.Fatal("completed dependency did not release child")
	}
	_, err = ScheduleCandidates(p, []mission.Task{{Spec: a, Status: "succeeded"}}, cfg, ScheduleOptions{})
	if err == nil {
		t.Fatal("ambiguous success status accepted")
	}
	active := mission.Task{Spec: a, Status: "running"}
	result, err = ScheduleCandidates(p, []mission.Task{active}, cfg, ScheduleOptions{Estimates: map[string]Estimate{"d": {Tokens: 1}}, Now: time.Unix(0, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Selected) != 0 {
		t.Fatal("unknown active reservation breached hard budget")
	}
}
func TestSchedulerFairnessAgingAndCapacity(t *testing.T) {
	a, b, c := task("a"), task("b"), task("c")
	c.AgentID = "another"
	cfg := mission.Config{Budget: mission.Budget{MaxConcurrent: 2}}
	result, err := ScheduleCandidates(planOf(a, b, c), nil, cfg, ScheduleOptions{Now: time.Unix(3600, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if result.Selected[0].TaskID != "a" || result.Selected[1].TaskID != "c" {
		t.Fatalf("fair scheduling %+v", result.Selected)
	}
	b.Priority = -10
	result, err = ScheduleCandidates(planOf(a, b, c), nil, cfg, ScheduleOptions{Now: time.Unix(100000, 0), WaitingSince: map[string]time.Time{"b": time.Unix(0, 0)}})
	if err != nil || result.Selected[0].TaskID != "b" {
		t.Fatalf("aging did not prevent starvation: %+v %v", result, err)
	}
	estimates := map[string]Estimate{"a": {Resources: map[string]int{"gpu": 1}}, "b": {Resources: map[string]int{"gpu": 1}}, "c": {Resources: map[string]int{"gpu": 1}}}
	result, err = ScheduleCandidates(planOf(a, b, c), nil, cfg, ScheduleOptions{Estimates: estimates, ResourceLimits: map[string]int{"gpu": 1}, Now: time.Unix(0, 0)})
	if err != nil || len(result.Selected) != 1 {
		t.Fatalf("resource capacity: %+v %v", result, err)
	}
}
func TestReplanInvalidationAndAcceptanceOnlyReverification(t *testing.T) {
	original := planOf(task("a"), task("b", "a"), task("c"))
	updated := clonePlan(original)
	updated.Version = 2
	updated.Tasks[0].Prompt = "new behavior"
	states := []mission.Task{{Spec: original.Tasks[0], Status: "completed"}, {Spec: original.Tasks[1], Status: "running"}, {Spec: original.Tasks[2], Status: "completed"}}
	result, err := Replan(original, updated, states, mission.Config{})
	if err != nil {
		t.Fatal(err)
	}
	assertStrings(t, result.Invalidated, []string{"a", "b"})
	assertStrings(t, result.Retained, []string{"c"})
	assertStrings(t, result.ReplayRequired, []string{"a"})
	if result.SafeToApply || len(result.Interrupted) != 1 {
		t.Fatalf("active effects ignored: %+v", result)
	}
	updated = clonePlan(original)
	updated.Version = 2
	updated.Tasks[0].Checks[0].Path = "different"
	result, err = Replan(original, updated, states, mission.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.ReplayRequired) != 0 || !result.Changes[0].AcceptanceChanged || result.Changes[0].ExecutionChanged {
		t.Fatalf("acceptance change invented execution change: %+v", result)
	}
	updated = clonePlan(original)
	updated.Version = 2
	updated.Tasks[0].Priority = 50
	result, err = Replan(original, updated, states, mission.Config{})
	if err != nil || len(result.Invalidated) != 0 {
		t.Fatalf("priority edit invalidated artifact: %+v %v", result, err)
	}
}
func TestArtifactReuseEquivalenceSeparatesExecutionAndFrozenChecks(t *testing.T) {
	left := task("build", "base", "schema")
	left.Writes = []string{"src/./api", "docs/**"}
	left.Checks = append(left.Checks, mission.CheckSpec{ID: "second", Kind: "json_valid", Path: "schema.json", Required: true})
	right := cloneTask(left)
	right.Title = "A clearer task name"
	right.Priority = 50
	right.MaxAttempts = 8
	right.DependsOn = []string{"schema", "base"}
	right.Writes = []string{"docs", "src/api"}
	right.Checks[0], right.Checks[1] = right.Checks[1], right.Checks[0]
	if !ExecutionEquivalent(left, right) || !AcceptanceEquivalent(left.Checks, right.Checks) {
		t.Fatal("cosmetic metadata and set ordering should preserve accepted artifacts")
	}
	if left.Writes[0] != "src/./api" || left.DependsOn[0] != "base" || left.Checks[0].ID == "second" {
		t.Fatal("equivalence mutated the frozen plan")
	}
	changed := cloneTask(right)
	changed.Checks[0].Title = "Describe the same predicate more clearly"
	if !ExecutionEquivalent(left, changed) || AcceptanceEquivalent(left.Checks, changed.Checks) {
		t.Fatal("every full check is evidence-bound even when its title alone changes")
	}
	for _, mutate := range []func(*mission.TaskSpec){
		func(s *mission.TaskSpec) { s.Prompt += " revised behavior" },
		func(s *mission.TaskSpec) { s.AgentID = "other-agent" },
		func(s *mission.TaskSpec) { s.Model = "other-model" },
		func(s *mission.TaskSpec) { s.DependsOn = []string{"base"} },
		func(s *mission.TaskSpec) { s.Writes = []string{"src/other"} },
	} {
		changed = cloneTask(right)
		mutate(&changed)
		if ExecutionEquivalent(left, changed) {
			t.Fatal("execution input change retained an artifact")
		}
	}
}
func TestComparisonReportsUncertaintyAndExplainsKnownCosts(t *testing.T) {
	base := planOf(task("a"))
	candidate := clonePlan(base)
	candidate.Version = 2
	result, err := Compare(base, candidate, mission.Config{Budget: mission.Budget{MaxTokens: 100}}, CompareOptions{})
	if err != nil || result.Comparable || result.Recommendation != "review_assumptions" {
		t.Fatalf("unknown costs made recommendation: %+v %v", result, err)
	}
	options := CompareOptions{BaseEstimates: map[string]Estimate{"a": {Tokens: 80, Seconds: 20}}, CandidateEstimates: map[string]Estimate{"a": {Tokens: 30, Seconds: 10}}}
	result, err = Compare(base, candidate, mission.Config{Budget: mission.Budget{MaxTokens: 100}}, options)
	if err != nil || !result.Comparable || result.Recommendation != "candidate" || result.Candidate.CriticalSeconds != 10 {
		t.Fatalf("known comparison %+v %v", result, err)
	}
	candidate.Tasks[0].Writes = []string{"other"}
	result, err = Compare(base, candidate, mission.Config{}, options)
	if err != nil || result.Comparable {
		t.Fatalf("different deliverables called comparable: %+v %v", result, err)
	}
}
func TestConflictEnumerationMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	paths := []string{".", "a", "a/b", "a-b", "a-b/z", "b", "b/x", "b/xy", "x/y/z"}
	for trial := 0; trial < 20; trial++ {
		tasks := []mission.TaskSpec{}
		for i := 0; i < 20; i++ {
			spec := task(fmt.Sprintf("t%02d", i))
			spec.Writes = []string{paths[rng.Intn(len(paths))]}
			tasks = append(tasks, spec)
		}
		g, err := Compile(planOf(tasks...), mission.Config{})
		if err != nil {
			t.Fatal(err)
		}
		actual, truncated := g.writeConflicts(1000)
		if truncated {
			t.Fatal("unexpected truncation")
		}
		keys := []string{}
		for _, c := range actual {
			keys = append(keys, c.LeftTask+":"+c.RightTask)
		}
		expected := []string{}
		for i, a := range tasks {
			for _, b := range tasks[i+1:] {
				if overlap, _ := PathsOverlap(a.Writes[0], b.Writes[0]); overlap {
					expected = append(expected, a.ID+":"+b.ID)
				}
			}
		}
		sort.Strings(keys)
		sort.Strings(expected)
		assertStrings(t, keys, expected)
	}
}
