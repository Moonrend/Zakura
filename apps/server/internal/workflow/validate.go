// SPDX-License-Identifier: AGPL-3.0-or-later
package workflow

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

var identifier = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

type graph struct {
	nodes    map[string]Node
	ids      []string
	parents  map[string][]string
	children map[string][]string
	order    []string
	layers   [][]string
}

func normalizeOptions(o Options) Options {
	if o.MaxParallel == 0 {
		o.MaxParallel = 4
	}
	if o.Mode == "" {
		o.Mode = "nominal"
	}
	if o.Priority == "" {
		o.Priority = "criticalPath"
	}
	if o.Resources == nil {
		o.Resources = map[string]int{}
	}
	if o.ConcurrencyLimits == nil {
		o.ConcurrencyLimits = map[string]int{}
	}
	return o
}

func normalizeNode(n Node) Node {
	if n.Kind == "" {
		n.Kind = "agent"
	}
	if n.MaxAttempts == 0 {
		n.MaxAttempts = 1
	}
	if n.BackoffMultiplier == 0 {
		n.BackoffMultiplier = 2
	}
	if n.MaxBackoffMS == 0 {
		n.MaxBackoffMS = MaxDurationMS
	}
	if n.DependsOn == nil {
		n.DependsOn = []string{}
	}
	if n.Resources == nil {
		n.Resources = map[string]int{}
	}
	return n
}

// Validate reports structural and capacity errors without producing a partial
// schedule. Invalid definitions never reach timing or scheduling arithmetic.
func Validate(d Definition, o Options) Validation {
	v, _ := validate(d, normalizeOptions(o))
	return v
}

func validate(d Definition, o Options) (Validation, *graph) {
	v := Validation{Valid: true, Diagnostics: []Diagnostic{}, TopologicalOrder: []string{}, Layers: [][]string{}}
	g := &graph{nodes: map[string]Node{}, parents: map[string][]string{}, children: map[string][]string{}}
	add := func(code, path, msg string, ids ...string) {
		v.Valid = false
		v.Diagnostics = append(v.Diagnostics, Diagnostic{Severity: "error", Code: code, Path: path, Message: msg, NodeIDs: ids})
	}
	if d.Version != Version {
		add("unsupported_version", "definition.version", "version must be 1")
	}
	if !utf8.ValidString(d.Name) || strings.TrimSpace(d.Name) == "" || len(d.Name) > 256 {
		add("invalid_name", "definition.name", "name must contain 1 to 256 UTF-8 bytes")
	}
	if len(d.Nodes) < 1 || len(d.Nodes) > MaxNodes {
		add("node_limit", "definition.nodes", fmt.Sprintf("supply 1 to %d nodes", MaxNodes))
		return v, nil
	}
	if o.MaxParallel < 1 || o.MaxParallel > MaxNodes {
		add("invalid_parallelism", "options.maxParallel", "maxParallel must be between 1 and 128")
	}
	if o.Mode != "nominal" && o.Mode != "retryBound" {
		add("invalid_mode", "options.mode", "mode must be nominal or retryBound")
	}
	if o.Priority != "criticalPath" && o.Priority != "id" {
		add("invalid_priority", "options.priority", "priority must be criticalPath or id")
	}
	if o.BudgetMicros < 0 || o.BudgetMicros > MaxLimit {
		add("invalid_budget", "options.budgetMicros", "budget is outside the supported range")
	}
	if o.DeadlineMS < 0 || o.DeadlineMS > MaxLimit {
		add("invalid_deadline", "options.deadlineMs", "deadline is outside the supported range")
	}
	for _, group := range []struct {
		path   string
		values map[string]int
	}{{"options.resources", o.Resources}, {"options.concurrencyLimits", o.ConcurrencyLimits}} {
		if len(group.values) > MaxResources {
			add("resource_limit", group.path, "at most 32 capacity keys are allowed")
			continue
		}
		for _, k := range keys(group.values) {
			if !identifier.MatchString(k) {
				add("invalid_resource_key", group.path+"."+k, "capacity keys must be valid identifiers")
			}
			if group.values[k] < 1 || group.values[k] > 1_000_000 {
				add("invalid_capacity", group.path+"."+k, "capacity must be between 1 and 1000000")
			}
		}
	}
	edges := 0
	for i, raw := range d.Nodes {
		n := normalizeNode(raw)
		path := fmt.Sprintf("definition.nodes[%d]", i)
		if !identifier.MatchString(n.ID) {
			add("invalid_id", path+".id", "id must start with a letter and contain at most 64 identifier characters", n.ID)
		}
		if _, exists := g.nodes[n.ID]; exists {
			add("duplicate_id", path+".id", "node id is already defined", n.ID)
		} else {
			g.nodes[n.ID] = n
			g.ids = append(g.ids, n.ID)
		}
		if !utf8.ValidString(n.Name) || len(n.Name) > 256 {
			add("invalid_node_name", path+".name", "node name exceeds 256 UTF-8 bytes", n.ID)
		}
		if n.Kind != "agent" && n.Kind != "tool" && n.Kind != "checkpoint" {
			add("invalid_kind", path+".kind", "kind must be agent, tool or checkpoint", n.ID)
		}
		if n.DurationMS < 1 || n.DurationMS > MaxDurationMS {
			add("invalid_duration", path+".durationMs", "duration must be between 1 and 86400000 ms", n.ID)
		}
		if n.TimeoutMS < 0 || n.TimeoutMS > MaxDurationMS {
			add("invalid_timeout", path+".timeoutMs", "timeout must be between 0 and 86400000 ms", n.ID)
		}
		if n.TimeoutMS > 0 && n.DurationMS > n.TimeoutMS {
			add("duration_exceeds_timeout", path+".timeoutMs", "the estimated successful attempt cannot exceed its timeout", n.ID)
		}
		if n.MaxAttempts < 1 || n.MaxAttempts > 10 {
			add("invalid_attempts", path+".maxAttempts", "maxAttempts must be between 1 and 10", n.ID)
		}
		if n.BackoffMS < 0 || n.BackoffMS > MaxDurationMS {
			add("invalid_backoff", path+".backoffMs", "backoff must be between 0 and 86400000 ms", n.ID)
		}
		if n.MaxBackoffMS < 0 || n.MaxBackoffMS > MaxDurationMS {
			add("invalid_backoff_cap", path+".maxBackoffMs", "backoff cap must be between 0 and 86400000 ms", n.ID)
		}
		if n.BackoffMultiplier < 1 || n.BackoffMultiplier > 4 {
			add("invalid_multiplier", path+".backoffMultiplier", "multiplier must be between 1 and 4", n.ID)
		}
		if n.CostMicros < 0 || n.CostMicros > MaxCostMicros {
			add("invalid_cost", path+".costMicros", "per-attempt cost is outside the supported range", n.ID)
		}
		resourceKeys := []string{}
		if len(n.Resources) > MaxResources {
			add("resource_limit", path+".resources", "at most 32 requested resources are allowed", n.ID)
		} else {
			resourceKeys = keys(n.Resources)
		}
		for _, k := range resourceKeys {
			units := n.Resources[k]
			if !identifier.MatchString(k) {
				add("invalid_resource_key", path+".resources."+k, "resource key is invalid", n.ID)
			}
			if units < 1 || units > 1_000_000 {
				add("invalid_units", path+".resources."+k, "resource units must be between 1 and 1000000", n.ID)
			}
			cap, ok := o.Resources[k]
			if !ok {
				add("missing_capacity", path+".resources."+k, "every requested resource needs an explicit capacity", n.ID)
			} else if units > cap {
				add("unschedulable_resource", path+".resources."+k, "node requests more than the total capacity", n.ID)
			}
		}
		if n.ConcurrencyKey != "" {
			if !identifier.MatchString(n.ConcurrencyKey) {
				add("invalid_concurrency_key", path+".concurrencyKey", "concurrency key is invalid", n.ID)
			}
			if _, ok := o.ConcurrencyLimits[n.ConcurrencyKey]; !ok {
				add("missing_concurrency_limit", path+".concurrencyKey", "every concurrency key needs an explicit limit", n.ID)
			}
		}
		edges += len(n.DependsOn)
		if len(n.DependsOn) > MaxNodes {
			add("dependency_limit", path+".dependsOn", "a node cannot contain more than 128 dependencies", n.ID)
		}
	}
	if edges > MaxEdges {
		add("edge_limit", "definition.nodes", "at most 2048 dependency edges are allowed")
	}
	// Do not traverse an unbounded dependency list from hostile input.
	if !v.Valid {
		return v, nil
	}
	sort.Strings(g.ids)
	for i, n := range d.Nodes {
		seen := map[string]bool{}
		path := fmt.Sprintf("definition.nodes[%d].dependsOn", i)
		for _, parent := range n.DependsOn {
			if seen[parent] {
				add("duplicate_dependency", path, "dependency occurs more than once", n.ID, parent)
				continue
			}
			seen[parent] = true
			if parent == n.ID {
				add("self_dependency", path, "a node cannot depend on itself", n.ID)
				continue
			}
			if _, ok := g.nodes[parent]; !ok {
				add("unknown_dependency", path, "dependency references an undefined node", n.ID, parent)
				continue
			}
			g.parents[n.ID] = append(g.parents[n.ID], parent)
			g.children[parent] = append(g.children[parent], n.ID)
		}
	}
	if !v.Valid {
		return v, nil
	}
	for _, id := range g.ids {
		sort.Strings(g.parents[id])
		sort.Strings(g.children[id])
	}
	indegree := map[string]int{}
	ready := []string{}
	for _, id := range g.ids {
		indegree[id] = len(g.parents[id])
		if indegree[id] == 0 {
			ready = append(ready, id)
		}
	}
	for len(ready) > 0 {
		layer := append([]string{}, ready...)
		g.layers = append(g.layers, layer)
		next := []string{}
		for _, id := range layer {
			g.order = append(g.order, id)
			for _, child := range g.children[id] {
				indegree[child]--
				if indegree[child] == 0 {
					next = append(next, child)
				}
			}
		}
		sort.Strings(next)
		ready = next
	}
	if len(g.order) != len(g.ids) {
		// Report actual cycle members, not acyclic descendants blocked by a cycle.
		for _, component := range stronglyConnected(g) {
			if len(component) > 1 {
				add("cycle", "definition.nodes", "dependency cycle: "+strings.Join(component, ", "), component...)
			}
		}
		return v, nil
	}
	v.TopologicalOrder = append([]string{}, g.order...)
	v.Layers = g.layers
	return v, g
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func stronglyConnected(g *graph) [][]string {
	index, low := map[string]int{}, map[string]int{}
	active := map[string]bool{}
	stack := []string{}
	components := [][]string{}
	counter := 0
	var visit func(string)
	visit = func(id string) {
		counter++
		index[id] = counter
		low[id] = counter
		stack = append(stack, id)
		active[id] = true
		for _, child := range g.children[id] {
			if index[child] == 0 {
				visit(child)
				if low[child] < low[id] {
					low[id] = low[child]
				}
			} else if active[child] && index[child] < low[id] {
				low[id] = index[child]
			}
		}
		if low[id] == index[id] {
			component := []string{}
			for {
				last := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				active[last] = false
				component = append(component, last)
				if last == id {
					break
				}
			}
			sort.Strings(component)
			components = append(components, component)
		}
	}
	for _, id := range g.ids {
		if index[id] == 0 {
			visit(id)
		}
	}
	sort.Slice(components, func(i, j int) bool { return components[i][0] < components[j][0] })
	return components
}
