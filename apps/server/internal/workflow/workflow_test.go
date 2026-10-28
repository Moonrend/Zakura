// SPDX-License-Identifier: AGPL-3.0-or-later
package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

func example() Request {
	return Request{Definition: Definition{Version: 1, Name: "test", Nodes: []Node{
		{ID: "a", DurationMS: 10},
		{ID: "b", DependsOn: []string{"a"}, DurationMS: 30},
		{ID: "c", DependsOn: []string{"a"}, DurationMS: 20},
		{ID: "d", DependsOn: []string{"b", "c"}, DurationMS: 5},
	}}, Options: Options{MaxParallel: 2}}
}

func mustPlan(t *testing.T, req Request) Result {
	t.Helper()
	result, err := Plan(context.Background(), req)
	if err != nil || !result.Validation.Valid {
		t.Fatalf("plan: %v %#v", err, result.Validation)
	}
	return result
}

func TestCriticalPathAndResourceWait(t *testing.T) {
	req := example()
	result := mustPlan(t, req)
	if result.Analysis.CriticalPathMS != 45 || !reflect.DeepEqual(result.Analysis.CriticalPath, []string{"a", "b", "d"}) {
		t.Fatalf("critical path: %#v", result.Analysis)
	}
	if result.Schedule.MakespanMS != 45 || !result.Schedule.Optimal {
		t.Fatalf("schedule: %#v", result.Schedule)
	}
	for _, n := range result.Analysis.Nodes {
		if n.ID == "c" && n.SlackMS != 10 {
			t.Fatalf("slack: %#v", n)
		}
	}
	req.Options.Resources = map[string]int{"gpu": 1}
	req.Definition.Nodes[1].Resources = map[string]int{"gpu": 1}
	req.Definition.Nodes[2].Resources = map[string]int{"gpu": 1}
	result = mustPlan(t, req)
	if result.Schedule.MakespanMS != 65 || result.Schedule.PeakResources["gpu"] != 1 {
		t.Fatalf("resource schedule: %#v", result.Schedule)
	}
	for _, s := range result.Schedule.Slots {
		if s.NodeID == "c" && s.WaitMS != 30 {
			t.Fatalf("wait: %#v", s)
		}
	}
}

func TestInvalidDefinitions(t *testing.T) {
	cases := []struct {
		name, code string
		edit       func(*Request)
	}{
		{"version", "unsupported_version", func(r *Request) { r.Definition.Version = 2 }},
		{"name", "invalid_name", func(r *Request) { r.Definition.Name = " " }},
		{"empty", "node_limit", func(r *Request) { r.Definition.Nodes = nil }},
		{"parallel", "invalid_parallelism", func(r *Request) { r.Options.MaxParallel = -1 }},
		{"mode", "invalid_mode", func(r *Request) { r.Options.Mode = "unknown" }},
		{"priority", "invalid_priority", func(r *Request) { r.Options.Priority = "unknown" }},
		{"budget", "invalid_budget", func(r *Request) { r.Options.BudgetMicros = -1 }},
		{"deadline", "invalid_deadline", func(r *Request) { r.Options.DeadlineMS = MaxLimit + 1 }},
		{"id", "invalid_id", func(r *Request) { r.Definition.Nodes[0].ID = "../a" }},
		{"duplicate", "duplicate_id", func(r *Request) { r.Definition.Nodes[1].ID = "a" }},
		{"kind", "invalid_kind", func(r *Request) { r.Definition.Nodes[0].Kind = "shell" }},
		{"duration", "invalid_duration", func(r *Request) { r.Definition.Nodes[0].DurationMS = 0 }},
		{"timeout", "invalid_timeout", func(r *Request) { r.Definition.Nodes[0].TimeoutMS = -1 }},
		{"short_timeout", "duration_exceeds_timeout", func(r *Request) { r.Definition.Nodes[0].TimeoutMS = 2 }},
		{"attempts", "invalid_attempts", func(r *Request) { r.Definition.Nodes[0].MaxAttempts = 11 }},
		{"backoff", "invalid_backoff", func(r *Request) { r.Definition.Nodes[0].BackoffMS = -1 }},
		{"cap", "invalid_backoff_cap", func(r *Request) { r.Definition.Nodes[0].MaxBackoffMS = -1 }},
		{"multiplier", "invalid_multiplier", func(r *Request) { r.Definition.Nodes[0].BackoffMultiplier = 5 }},
		{"cost", "invalid_cost", func(r *Request) { r.Definition.Nodes[0].CostMicros = MaxCostMicros + 1 }},
		{"capacity", "invalid_capacity", func(r *Request) { r.Options.Resources = map[string]int{"gpu": 0} }},
		{"resource_key", "invalid_resource_key", func(r *Request) { r.Options.Resources = map[string]int{"gpu!": 1} }},
		{"units", "invalid_units", func(r *Request) {
			r.Definition.Nodes[0].Resources = map[string]int{"gpu": 0}
			r.Options.Resources = map[string]int{"gpu": 1}
		}},
		{"missing_capacity", "missing_capacity", func(r *Request) { r.Definition.Nodes[0].Resources = map[string]int{"gpu": 1} }},
		{"impossible", "unschedulable_resource", func(r *Request) {
			r.Definition.Nodes[0].Resources = map[string]int{"gpu": 2}
			r.Options.Resources = map[string]int{"gpu": 1}
		}},
		{"concurrency", "missing_concurrency_limit", func(r *Request) { r.Definition.Nodes[0].ConcurrencyKey = "exclusive" }},
		{"self", "self_dependency", func(r *Request) { r.Definition.Nodes[0].DependsOn = []string{"a"} }},
		{"missing", "unknown_dependency", func(r *Request) { r.Definition.Nodes[0].DependsOn = []string{"missing"} }},
		{"duplicate_edge", "duplicate_dependency", func(r *Request) { r.Definition.Nodes[1].DependsOn = []string{"a", "a"} }},
		{"cycle", "cycle", func(r *Request) { r.Definition.Nodes[0].DependsOn = []string{"b"} }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := example()
			c.edit(&r)
			result, err := Plan(context.Background(), r)
			if err != nil || result.Validation.Valid || result.Analysis != nil || result.Schedule != nil {
				t.Fatalf("invalid input planned: %v %#v", err, result)
			}
			found := false
			for _, d := range result.Validation.Diagnostics {
				if d.Code == c.code {
					found = true
				}
			}
			if !found {
				t.Fatalf("missing %s: %#v", c.code, result.Validation)
			}
		})
	}
}

func TestCollectionLimitsBoundDiagnostics(t *testing.T) {
	for _, location := range []string{"resources", "concurrency", "nodeResources"} {
		r := example()
		values := map[string]int{}
		for i := 0; i < 10000; i++ {
			values[fmt.Sprintf("r%d", i)] = -1
		}
		switch location {
		case "resources":
			r.Options.Resources = values
		case "concurrency":
			r.Options.ConcurrencyLimits = values
		case "nodeResources":
			r.Definition.Nodes[0].Resources = values
		}
		v := Validate(r.Definition, r.Options)
		if v.Valid || len(v.Diagnostics) != 1 || v.Diagnostics[0].Code != "resource_limit" {
			t.Fatalf("unbounded diagnostics for %s: %d", location, len(v.Diagnostics))
		}
	}
	r := example()
	for len(r.Definition.Nodes) <= MaxNodes {
		r.Definition.Nodes = append(r.Definition.Nodes, Node{ID: "repeated", DurationMS: 1})
	}
	if v := Validate(r.Definition, r.Options); v.Valid || len(v.Diagnostics) != 1 || v.Diagnostics[0].Code != "node_limit" {
		t.Fatal("node limit not checked before traversal")
	}
	r = example()
	r.Definition.Nodes[0].DependsOn = make([]string, MaxNodes+1)
	if v := Validate(r.Definition, r.Options); v.Valid || v.Diagnostics[0].Code != "dependency_limit" {
		t.Fatal("dependency limit not checked before traversal")
	}
}

func TestCycleDoesNotMislabelDownstream(t *testing.T) {
	r := example()
	r.Definition.Nodes[0].DependsOn = []string{"b"}
	v := Validate(r.Definition, r.Options)
	if len(v.Diagnostics) != 1 || !reflect.DeepEqual(v.Diagnostics[0].NodeIDs, []string{"a", "b"}) {
		t.Fatalf("cycle members: %#v", v)
	}
}

func TestRetryCapTimeoutCostAndWarnings(t *testing.T) {
	r := Request{Definition: Definition{Version: 1, Name: "retry", Nodes: []Node{{ID: "a", DurationMS: 10, TimeoutMS: 20, MaxAttempts: 4, BackoffMS: 5, BackoffMultiplier: 2, MaxBackoffMS: 8, CostMicros: 7}}}, Options: Options{Mode: "retryBound", BudgetMicros: 27, DeadlineMS: 90}}
	result := mustPlan(t, r)
	if result.Schedule.MakespanMS != 91 || result.Analysis.TotalCostMicros != 28 || result.Schedule.WithinBudget || result.Schedule.WithinDeadline {
		t.Fatalf("retry calculation: %#v", result)
	}
	if len(result.Validation.Diagnostics) != 2 {
		t.Fatalf("warnings: %#v", result.Validation.Diagnostics)
	}
	r.Options.Mode = "nominal"
	result = mustPlan(t, r)
	if result.Schedule.MakespanMS != 10 || result.Analysis.TotalCostMicros != 7 || result.Validation.Diagnostics[0].Code != "retries_excluded" {
		t.Fatalf("nominal: %#v", result)
	}
}

func TestFingerprintPermutationAndNoMutation(t *testing.T) {
	r := example()
	before, _ := json.Marshal(r)
	first := mustPlan(t, r)
	after, _ := json.Marshal(r)
	if string(before) != string(after) {
		t.Fatal("planning mutated input")
	}
	for i, j := 0, len(r.Definition.Nodes)-1; i < j; i, j = i+1, j-1 {
		r.Definition.Nodes[i], r.Definition.Nodes[j] = r.Definition.Nodes[j], r.Definition.Nodes[i]
	}
	r.Definition.Nodes[0].DependsOn = []string{"c", "b"}
	second := mustPlan(t, r)
	if !reflect.DeepEqual(first, second) {
		t.Fatal("input permutation changed canonical result")
	}
	r.Options.Mode = "nominal"
	r.Options.Priority = "criticalPath"
	if mustPlan(t, r).Fingerprint != first.Fingerprint {
		t.Fatal("explicit defaults changed fingerprint")
	}
	r.Definition.Nodes[0].DurationMS++
	if mustPlan(t, r).Fingerprint == first.Fingerprint {
		t.Fatal("changed definition retained fingerprint")
	}
}

func TestCancellationAndConcurrentDeterminism(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Plan(ctx, example()); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	req := example()
	expected := mustPlan(t, req)
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := Plan(context.Background(), req)
			if err != nil || !reflect.DeepEqual(result, expected) {
				t.Error("concurrent plan mismatch")
			}
		}()
	}
	wg.Wait()
}

func TestMaximumBoundsRemainExact(t *testing.T) {
	r := Request{Definition: Definition{Version: 1, Name: "limits"}, Options: Options{MaxParallel: 1, Mode: "retryBound", Resources: map[string]int{"cpu": 1_000_000}}}
	for i := 0; i < MaxNodes; i++ {
		id := strings.Repeat("x", i/26+1) + string(rune('a'+i%26))
		r.Definition.Nodes = append(r.Definition.Nodes, Node{ID: id, DurationMS: MaxDurationMS, TimeoutMS: MaxDurationMS, MaxAttempts: 10, BackoffMS: MaxDurationMS, BackoffMultiplier: 4, CostMicros: MaxCostMicros, Resources: map[string]int{"cpu": 1_000_000}})
	}
	result := mustPlan(t, r)
	want := int64(19) * MaxDurationMS * MaxNodes
	if result.Schedule.MakespanMS != want || result.Analysis.ResourceLowerBoundsMS["cpu"] != want || result.Analysis.TotalCostMicros != int64(MaxNodes)*10*MaxCostMicros {
		t.Fatalf("overflow or bound error: %#v", result.Analysis)
	}
}

// verifySchedule reconstructs half-open occupancy intervals independently of
// the planner and checks precedence, uniqueness, resource and group capacities.
func verifySchedule(t *testing.T, r Request, result Result) {
	t.Helper()
	byID := map[string]Slot{}
	for _, slot := range result.Schedule.Slots {
		if _, exists := byID[slot.NodeID]; exists {
			t.Fatal("duplicate slot")
		}
		byID[slot.NodeID] = slot
	}
	if len(byID) != len(r.Definition.Nodes) {
		t.Fatal("lost nodes")
	}
	o := normalizeOptions(r.Options)
	for _, n := range r.Definition.Nodes {
		s := byID[n.ID]
		if s.StartMS < 0 || s.EndMS <= s.StartMS {
			t.Fatal("invalid slot interval")
		}
		for _, p := range n.DependsOn {
			if byID[p].EndMS > s.StartMS {
				t.Fatalf("dependency violation: %s -> %s", p, n.ID)
			}
		}
		used, groups := map[string]int{}, map[string]int{}
		running := 0
		for _, other := range r.Definition.Nodes {
			v := byID[other.ID]
			if v.StartMS <= s.StartMS && s.StartMS < v.EndMS {
				running++
				for k, units := range other.Resources {
					used[k] += units
				}
				if other.ConcurrencyKey != "" {
					groups[other.ConcurrencyKey]++
				}
			}
		}
		if running > o.MaxParallel {
			t.Fatal("parallelism violation")
		}
		for k, units := range used {
			if units > o.Resources[k] {
				t.Fatal("resource violation")
			}
		}
		for k, units := range groups {
			if units > o.ConcurrencyLimits[k] {
				t.Fatal("group violation")
			}
		}
	}
	if result.Schedule.MakespanMS < result.Analysis.CriticalPathMS || result.Schedule.Utilization > 1 || result.Schedule.Utilization <= 0 {
		t.Fatal("invalid aggregate metrics")
	}
}

func TestRandomizedScheduleInvariants(t *testing.T) {
	rng := rand.New(rand.NewSource(20261011))
	for iteration := 0; iteration < 1000; iteration++ {
		r := Request{Definition: Definition{Version: 1, Name: "random"}, Options: Options{MaxParallel: 1 + rng.Intn(8), Resources: map[string]int{"cpu": 4, "model": 3}, ConcurrencyLimits: map[string]int{"group": 2}}}
		if iteration%2 == 1 {
			r.Options.Mode = "retryBound"
		}
		if iteration%3 == 1 {
			r.Options.Priority = "id"
		}
		nodeCount := 1 + rng.Intn(24)
		for i := 0; i < nodeCount; i++ {
			n := Node{ID: string(rune('a' + i)), DurationMS: int64(1 + rng.Intn(100)), MaxAttempts: 1 + rng.Intn(4), BackoffMS: int64(rng.Intn(10)), CostMicros: int64(rng.Intn(1000)), Resources: map[string]int{}}
			if rng.Intn(2) == 0 {
				n.Resources["cpu"] = 1 + rng.Intn(4)
			}
			if rng.Intn(2) == 0 {
				n.Resources["model"] = 1 + rng.Intn(3)
			}
			if rng.Intn(2) == 0 {
				n.ConcurrencyKey = "group"
			}
			for j := 0; j < i; j++ {
				if rng.Intn(5) == 0 {
					n.DependsOn = append(n.DependsOn, string(rune('a'+j)))
				}
			}
			r.Definition.Nodes = append(r.Definition.Nodes, n)
		}
		verifySchedule(t, r, mustPlan(t, r))
	}
}

func TestTemplatesAndFreshAllocation(t *testing.T) {
	for _, template := range Templates() {
		verifySchedule(t, template.Request, mustPlan(t, template.Request))
	}
	a, b := Templates(), Templates()
	a[0].Request.Definition.Nodes[0].ID = "changed"
	if b[0].Request.Definition.Nodes[0].ID == "changed" {
		t.Fatal("templates share mutable state")
	}
}

type goldenExpected struct {
	Order          []string       `json:"order"`
	Layers         [][]string     `json:"layers"`
	Analysis       Analysis       `json:"analysis"`
	Slots          []Slot         `json:"slots"`
	MakespanMS     int64          `json:"makespanMs"`
	PeakParallel   int            `json:"peakParallel"`
	PeakResources  map[string]int `json:"peakResources"`
	WithinBudget   bool           `json:"withinBudget"`
	WithinDeadline bool           `json:"withinDeadline"`
	Optimal        bool           `json:"optimal"`
}

type goldenCase struct {
	Name     string         `json:"name"`
	Request  Request        `json:"request"`
	Expected goldenExpected `json:"expected"`
}

func TestIndependentReferenceCorpus(t *testing.T) {
	files, err := os.ReadDir("testdata")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile("testdata/" + file.Name())
		if err != nil {
			t.Fatal(err)
		}
		var cases []goldenCase
		if err := json.Unmarshal(raw, &cases); err != nil {
			t.Fatal(err)
		}
		for _, c := range cases {
			count++
			t.Run(c.Name, func(t *testing.T) {
				result := mustPlan(t, c.Request)
				expected := c.Expected
				if !reflect.DeepEqual(result.Validation.TopologicalOrder, expected.Order) || !reflect.DeepEqual(result.Validation.Layers, expected.Layers) {
					t.Fatal("topology differs from independent oracle")
				}
				if !reflect.DeepEqual(*result.Analysis, expected.Analysis) {
					got, _ := json.MarshalIndent(result.Analysis, "", "  ")
					want, _ := json.MarshalIndent(expected.Analysis, "", "  ")
					t.Fatalf("analysis differs\ngot %s\nwant %s", got, want)
				}
				if !reflect.DeepEqual(result.Schedule.Slots, expected.Slots) || result.Schedule.MakespanMS != expected.MakespanMS || result.Schedule.PeakParallel != expected.PeakParallel || !reflect.DeepEqual(result.Schedule.PeakResources, expected.PeakResources) || result.Schedule.WithinBudget != expected.WithinBudget || result.Schedule.WithinDeadline != expected.WithinDeadline || result.Schedule.Optimal != expected.Optimal {
					t.Fatalf("schedule differs: %#v\nexpected %#v", result.Schedule, expected)
				}
				verifySchedule(t, c.Request, result)
			})
		}
	}
	if count != 128 {
		t.Fatalf("reference corpus coverage changed: %d", count)
	}
}

func FuzzWorkflowPlan(f *testing.F) {
	for _, template := range Templates() {
		raw, _ := json.Marshal(template.Request)
		f.Add(raw)
	}
	f.Add([]byte(`{"definition":{"version":1,"name":"cycle","nodes":[{"id":"a","durationMs":1,"dependsOn":["a"]}]},"options":{}}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 1<<20 {
			t.Skip()
		}
		var request Request
		if json.Unmarshal(raw, &request) != nil {
			return
		}
		result, err := Plan(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		if result.Validation.Valid {
			verifySchedule(t, request, result)
		} else if result.Schedule != nil {
			t.Fatal("invalid definition produced schedule")
		}
	})
}

func BenchmarkPlan128(b *testing.B) {
	r := example()
	r.Definition.Nodes = nil
	for i := 0; i < 128; i++ {
		id := strings.Repeat("n", i/26+1) + string(rune('a'+i%26))
		r.Definition.Nodes = append(r.Definition.Nodes, Node{ID: id, DurationMS: 10})
	}
	sort.Slice(r.Definition.Nodes, func(i, j int) bool { return r.Definition.Nodes[i].ID < r.Definition.Nodes[j].ID })
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := Plan(context.Background(), r); err != nil {
			b.Fatal(err)
		}
	}
}
