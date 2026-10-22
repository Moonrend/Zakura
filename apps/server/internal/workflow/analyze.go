// SPDX-License-Identifier: AGPL-3.0-or-later
package workflow

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

// retryBound assumes all earlier attempts consume their full timeout and the
// final attempt succeeds at durationMs. Resources are held through backoff.
// This is a planning scenario, not a bound on eventual execution success.
func retryBound(n Node) int64 {
	n = normalizeNode(n)
	failure := n.DurationMS
	if n.TimeoutMS > 0 {
		failure = n.TimeoutMS
	}
	duration := n.DurationMS + int64(n.MaxAttempts-1)*failure
	delay := n.BackoffMS
	for attempt := 1; attempt < n.MaxAttempts; attempt++ {
		if n.MaxBackoffMS > 0 && delay > n.MaxBackoffMS {
			delay = n.MaxBackoffMS
		}
		duration += delay
		delay *= int64(n.BackoffMultiplier)
	}
	return duration
}

func duration(n Node, o Options) int64 {
	if o.Mode == "retryBound" {
		return retryBound(n)
	}
	return n.DurationMS
}

func cost(n Node, o Options) int64 {
	if o.Mode == "retryBound" {
		return int64(n.MaxAttempts) * n.CostMicros
	}
	return n.CostMicros
}

func analyze(g *graph, o Options) *Analysis {
	a := &Analysis{Nodes: []NodeAnalysis{}, Roots: []string{}, Sinks: []string{}, CriticalPath: []string{}, ResourceLowerBoundsMS: map[string]int64{}}
	byID := map[string]*NodeAnalysis{}
	work := map[string]int64{}
	for _, id := range g.order {
		n := g.nodes[id]
		item := &NodeAnalysis{ID: id, DurationMS: duration(n, o), RetryBoundMS: retryBound(n), CostMicros: cost(n, o)}
		for _, parent := range g.parents[id] {
			p := byID[parent]
			if p.EarliestFinishMS > item.EarliestStartMS {
				item.EarliestStartMS = p.EarliestFinishMS
			}
			if p.Level+1 > item.Level {
				item.Level = p.Level + 1
			}
		}
		item.EarliestFinishMS = item.EarliestStartMS + item.DurationMS
		if item.EarliestFinishMS > a.CriticalPathMS {
			a.CriticalPathMS = item.EarliestFinishMS
		}
		a.TotalWorkMS += item.DurationMS
		a.TotalCostMicros += item.CostMicros
		for k, units := range n.Resources {
			work[k] += int64(units) * item.DurationMS
		}
		byID[id] = item
		if len(g.parents[id]) == 0 {
			a.Roots = append(a.Roots, id)
		}
		if len(g.children[id]) == 0 {
			a.Sinks = append(a.Sinks, id)
		}
	}
	for i := len(g.order) - 1; i >= 0; i-- {
		id := g.order[i]
		item := byID[id]
		finish := a.CriticalPathMS
		var tail int64
		for _, child := range g.children[id] {
			c := byID[child]
			if c.LatestStartMS < finish {
				finish = c.LatestStartMS
			}
			if c.TailMS > tail {
				tail = c.TailMS
			}
		}
		item.LatestStartMS = finish - item.DurationMS
		item.SlackMS = item.LatestStartMS - item.EarliestStartMS
		item.Critical = item.SlackMS == 0
		item.TailMS = tail + item.DurationMS
	}
	// Build one representative longest path, using lexical ties consistently.
	var current string
	for _, id := range g.ids {
		if len(g.parents[id]) == 0 && byID[id].TailMS == a.CriticalPathMS {
			current = id
			break
		}
	}
	for current != "" {
		a.CriticalPath = append(a.CriticalPath, current)
		next := ""
		for _, child := range g.children[current] {
			if byID[current].TailMS == byID[current].DurationMS+byID[child].TailMS {
				next = child
				break
			}
		}
		current = next
	}
	for _, id := range g.ids {
		a.Nodes = append(a.Nodes, *byID[id])
	}
	sort.Strings(a.Roots)
	sort.Strings(a.Sinks)
	a.ParallelLowerBoundMS = ceilDiv(a.TotalWorkMS, int64(o.MaxParallel))
	for k, units := range work {
		a.ResourceLowerBoundsMS[k] = ceilDiv(units, int64(o.Resources[k]))
	}
	return a
}

func ceilDiv(n, d int64) int64 { return n/d + boolInt(n%d != 0) }
func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func fingerprint(g *graph, name string, o Options) string {
	d := Definition{Version: Version, Name: name, Nodes: []Node{}}
	for _, id := range g.ids {
		n := g.nodes[id]
		n.DependsOn = append([]string{}, g.parents[id]...)
		d.Nodes = append(d.Nodes, n)
	}
	// encoding/json sorts map keys. Node/dependency order and omitted defaults
	// therefore do not change the fingerprint of equivalent input definitions.
	raw, _ := json.Marshal(Request{Definition: d, Options: o})
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}
