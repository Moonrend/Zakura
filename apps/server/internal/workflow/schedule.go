// SPDX-License-Identifier: AGPL-3.0-or-later
package workflow

import (
	"context"
	"fmt"
	"sort"
)

// Plan uses deterministic non-preemptive list scheduling. It is a heuristic
// for the resource-constrained project scheduling problem, not an optimizer.
func Plan(ctx context.Context, req Request) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	o := normalizeOptions(req.Options)
	v, g := validate(req.Definition, o)
	result := Result{Version: Version, Options: o, Validation: v}
	if !v.Valid {
		return result, nil
	}
	result.Fingerprint = fingerprint(g, req.Definition.Name, o)
	result.Analysis = analyze(g, o)
	s, err := schedule(ctx, g, o, result.Analysis)
	if err != nil {
		return Result{}, err
	}
	result.Schedule = s
	warning := func(code, message string) {
		result.Validation.Diagnostics = append(result.Validation.Diagnostics, Diagnostic{Severity: "warning", Code: code, Path: "options", Message: message})
	}
	if !s.WithinBudget {
		warning("budget_exceeded", "estimated attempt cost exceeds the configured budget")
	}
	if !s.WithinDeadline {
		warning("deadline_exceeded", "simulated completion exceeds the configured deadline")
	}
	if o.Mode == "nominal" {
		for _, id := range g.ids {
			if g.nodes[id].MaxAttempts > 1 {
				warning("retries_excluded", "nominal mode excludes failed attempts and backoff; compare retryBound for a conservative scenario")
				break
			}
		}
	}
	return result, nil
}

type runningNode struct {
	id  string
	end int64
}

func schedule(ctx context.Context, g *graph, o Options, a *Analysis) (*Schedule, error) {
	s := &Schedule{Slots: []Slot{}, Usage: []Usage{}, PeakResources: map[string]int{}, WithinBudget: o.BudgetMicros == 0 || a.TotalCostMicros <= o.BudgetMicros}
	metrics := map[string]NodeAnalysis{}
	for _, n := range a.Nodes {
		metrics[n.ID] = n
	}
	remaining := map[string]int{}
	ready := []string{}
	for _, id := range g.ids {
		remaining[id] = len(g.parents[id])
		if remaining[id] == 0 {
			ready = append(ready, id)
		}
	}
	readyAt := map[string]int64{}
	used, keyUsed := map[string]int{}, map[string]int{}
	active := []runningNode{}
	var now int64
	completed := 0
	for completed < len(g.ids) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		sort.Slice(ready, func(i, j int) bool {
			if o.Priority == "criticalPath" && metrics[ready[i]].TailMS != metrics[ready[j]].TailMS {
				return metrics[ready[i]].TailMS > metrics[ready[j]].TailMS
			}
			return ready[i] < ready[j]
		})
		pending := []string{}
		for _, id := range ready {
			n := g.nodes[id]
			fits := len(active) < o.MaxParallel
			if n.ConcurrencyKey != "" && keyUsed[n.ConcurrencyKey] >= o.ConcurrencyLimits[n.ConcurrencyKey] {
				fits = false
			}
			for k, units := range n.Resources {
				if used[k]+units > o.Resources[k] {
					fits = false
				}
			}
			if !fits {
				pending = append(pending, id)
				continue
			}
			end := now + metrics[id].DurationMS
			active = append(active, runningNode{id: id, end: end})
			for k, units := range n.Resources {
				used[k] += units
				if used[k] > s.PeakResources[k] {
					s.PeakResources[k] = used[k]
				}
			}
			if n.ConcurrencyKey != "" {
				keyUsed[n.ConcurrencyKey]++
			}
			s.Slots = append(s.Slots, Slot{NodeID: id, StartMS: now, EndMS: end, WaitMS: now - readyAt[id], Resources: cloneMap(n.Resources), ConcurrencyKey: n.ConcurrencyKey})
			if len(active) > s.PeakParallel {
				s.PeakParallel = len(active)
			}
		}
		ready = pending
		if len(active) == 0 {
			return nil, fmt.Errorf("workflow scheduler invariant: no runnable nodes after validation")
		}
		s.Usage = append(s.Usage, Usage{AtMS: now, Running: len(active), Resources: cloneMap(used)})
		next := active[0].end
		for _, n := range active {
			if n.end < next {
				next = n.end
			}
		}
		now = next
		still := []runningNode{}
		// Release all nodes at the same instant before considering new starts.
		for _, run := range active {
			if run.end != now {
				still = append(still, run)
				continue
			}
			n := g.nodes[run.id]
			for k, units := range n.Resources {
				used[k] -= units
			}
			if n.ConcurrencyKey != "" {
				keyUsed[n.ConcurrencyKey]--
			}
			completed++
			for _, child := range g.children[run.id] {
				if now > readyAt[child] {
					readyAt[child] = now
				}
				remaining[child]--
				if remaining[child] == 0 {
					ready = append(ready, child)
				}
			}
		}
		active = still
	}
	s.MakespanMS = now
	s.WithinDeadline = o.DeadlineMS == 0 || now <= o.DeadlineMS
	s.Usage = append(s.Usage, Usage{AtMS: now, Running: 0, Resources: cloneMap(used)})
	s.Utilization = float64(a.TotalWorkMS) / float64(now*int64(o.MaxParallel))
	lower := a.CriticalPathMS
	if a.ParallelLowerBoundMS > lower {
		lower = a.ParallelLowerBoundMS
	}
	for _, bound := range a.ResourceLowerBoundsMS {
		if bound > lower {
			lower = bound
		}
	}
	// Equality with a valid lower bound is a certificate of optimal makespan.
	// Other schedules may also be optimal, but are deliberately not certified.
	s.Optimal = now == lower
	return s, nil
}

func cloneMap(m map[string]int) map[string]int {
	out := map[string]int{}
	for k, v := range m {
		out[k] = v
	}
	return out
}
