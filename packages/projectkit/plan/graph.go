// SPDX-License-Identifier: AGPL-3.0-or-later
package plan

import (
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"math/bits"
	"sort"
)

func setBit(words []uint64, index int) { words[index/64] |= uint64(1) << uint(index%64) }
func hasBit(words []uint64, index int) bool {
	return index >= 0 && index/64 < len(words) && words[index/64]&(uint64(1)<<uint(index%64)) != 0
}
func orBits(target, source []uint64) {
	for i := range target {
		target[i] |= source[i]
	}
}
func countBits(words []uint64) int {
	count := 0
	for _, word := range words {
		count += bits.OnesCount64(word)
	}
	return count
}
func (g *Graph) IsAncestor(ancestor, task string) bool {
	index, exists := g.index[ancestor]
	return exists && hasBit(g.ancestors[task], index)
}
func (g *Graph) Ancestors(task string) []string   { return g.members(g.ancestors[task]) }
func (g *Graph) Descendants(task string) []string { return g.members(g.descendants[task]) }
func (g *Graph) members(words []uint64) []string {
	result := []string{}
	for _, id := range g.order {
		if hasBit(words, g.index[id]) {
			result = append(result, id)
		}
	}
	return result
}
func (g *Graph) Order() []string { return append([]string(nil), g.order...) }
func (g *Graph) Task(id string) (mission.TaskSpec, bool) {
	task, ok := g.byID[id]
	return cloneTask(task), ok
}
func (g *Graph) Dependencies(id string) []string { return append([]string(nil), g.dependencies[id]...) }
func (g *Graph) Dependents(id string) []string   { return append([]string(nil), g.dependents[id]...) }
func Analyze(value mission.Plan, config mission.Config) (Analysis, error) {
	return AnalyzeWithEstimates(value, config, nil)
}
func AnalyzeWithEstimates(value mission.Plan, config mission.Config, estimates map[string]Estimate) (Analysis, error) {
	graph, err := Compile(value, config)
	if err != nil {
		return Analysis{}, err
	}
	if err := validateEstimates(estimates, graph); err != nil {
		return Analysis{}, err
	}
	return graph.analyze(estimates), nil
}
func (g *Graph) analyze(estimates map[string]Estimate) Analysis {
	analysis := Analysis{PlanVersion: g.plan.Version, Topological: g.Order(), Roots: []string{}, Leaves: []string{}, Nodes: []Node{}, Edges: []Edge{}, CriticalPath: []string{}, Layers: [][]string{}, Conflicts: []WriteConflict{}, Warnings: []Issue{}, TasksWithoutRequiredChecks: []string{}}
	starts, finishes, layers, durations := map[string]int{}, map[string]int{}, map[string]int{}, map[string]int{}
	predecessor := map[string]string{}
	maxFinish := 0
	terminal := ""
	for _, id := range g.order {
		duration := 1
		if estimate, exists := estimates[id]; exists {
			duration = estimate.Seconds
		}
		durations[id] = duration
		for _, dep := range g.dependencies[id] {
			if finishes[dep] > starts[id] || (finishes[dep] == starts[id] && (predecessor[id] == "" || dep < predecessor[id])) {
				starts[id] = finishes[dep]
				predecessor[id] = dep
			}
			if layers[dep]+1 > layers[id] {
				layers[id] = layers[dep] + 1
			}
		}
		finishes[id] = starts[id] + duration
		if finishes[id] > maxFinish || (finishes[id] == maxFinish && (terminal == "" || id < terminal)) {
			maxFinish = finishes[id]
			terminal = id
		}
		for len(analysis.Layers) <= layers[id] {
			analysis.Layers = append(analysis.Layers, []string{})
		}
		analysis.Layers[layers[id]] = append(analysis.Layers[layers[id]], id)
		if len(g.dependencies[id]) == 0 {
			analysis.Roots = append(analysis.Roots, id)
		}
		if len(g.dependents[id]) == 0 {
			analysis.Leaves = append(analysis.Leaves, id)
		}
	}
	analysis.CriticalLength = maxFinish
	for cursor := terminal; cursor != ""; cursor = predecessor[cursor] {
		analysis.CriticalPath = append(analysis.CriticalPath, cursor)
	}
	for left, right := 0, len(analysis.CriticalPath)-1; left < right; left, right = left+1, right-1 {
		analysis.CriticalPath[left], analysis.CriticalPath[right] = analysis.CriticalPath[right], analysis.CriticalPath[left]
	}
	latest := map[string]int{}
	for index := len(g.order) - 1; index >= 0; index-- {
		id := g.order[index]
		finish := maxFinish
		for _, child := range g.dependents[id] {
			if latest[child] < finish {
				finish = latest[child]
			}
		}
		latest[id] = finish - durations[id]
	}
	positions := layoutLayers(analysis.Layers, g.dependencies, g.dependents)
	for index, id := range g.order {
		task := g.byID[id]
		required := 0
		for _, check := range task.Checks {
			if check.Required {
				required++
				analysis.RequiredChecks++
			}
		}
		if required == 0 {
			analysis.TasksWithoutRequiredChecks = append(analysis.TasksWithoutRequiredChecks, id)
		}
		position := positions[id]
		slack := latest[id] - starts[id]
		analysis.Nodes = append(analysis.Nodes, Node{ID: id, Title: task.Title, AgentID: task.AgentID, Layer: layers[id], Order: index, EarliestStart: starts[id], EarliestFinish: finishes[id], LatestStart: latest[id], LatestFinish: latest[id] + durations[id], Slack: slack, Critical: slack == 0, Ancestors: countBits(g.ancestors[id]), Descendants: countBits(g.descendants[id]), X: float64(layers[id]) * 320, Y: position * 140})
		for _, dep := range g.dependencies[id] {
			analysis.Edges = append(analysis.Edges, Edge{From: dep, To: id, Critical: slack == 0 && latest[dep] == starts[dep] && finishes[dep] == starts[id]})
		}
	}
	for _, layer := range analysis.Layers {
		if len(layer) > analysis.MaxLayerWidth {
			analysis.MaxLayerWidth = len(layer)
		}
	}
	conflicts, truncated := g.writeConflicts(20000)
	analysis.Conflicts = conflicts
	if truncated {
		analysis.Warnings = append(analysis.Warnings, Issue{Code: "conflict_report_truncated", Field: "writes", Message: "more than 20000 task write-conflict pairs exist; execution conflict checks remain exact"})
	}
	unordered := 0
	for _, conflict := range conflicts {
		if !conflict.Ordered {
			unordered++
		}
	}
	if unordered > 0 {
		analysis.Warnings = append(analysis.Warnings, Issue{Code: "unordered_write_conflicts", Field: "writes", Message: "independent tasks have overlapping writes and must be serialized or merged explicitly"})
	}
	return analysis
}

// Six deterministic barycentric sweeps reduce crossed dependency edges without
// pretending to solve optimal graph drawing, which is combinatorially expensive.
func layoutLayers(layers [][]string, parents, children map[string][]string) map[string]float64 {
	copies := make([][]string, len(layers))
	positions := map[string]float64{}
	for i, layer := range layers {
		copies[i] = append([]string(nil), layer...)
		sort.Strings(copies[i])
		for index, id := range copies[i] {
			positions[id] = float64(index)
		}
	}
	sweep := func(layer []string, neighbors map[string][]string) {
		averages := map[string]float64{}
		for _, id := range layer {
			links := neighbors[id]
			if len(links) == 0 {
				averages[id] = positions[id]
				continue
			}
			for _, link := range links {
				averages[id] += positions[link]
			}
			averages[id] /= float64(len(links))
		}
		sort.SliceStable(layer, func(i, j int) bool {
			if averages[layer[i]] == averages[layer[j]] {
				return layer[i] < layer[j]
			}
			return averages[layer[i]] < averages[layer[j]]
		})
		for index, id := range layer {
			positions[id] = float64(index)
		}
	}
	for pass := 0; pass < 6; pass++ {
		for layer := 1; layer < len(copies); layer++ {
			sweep(copies[layer], parents)
		}
		for layer := len(copies) - 2; layer >= 0; layer-- {
			sweep(copies[layer], children)
		}
	}
	return positions
}

type claimOwner struct{ Task, Path string }

func (g *Graph) writeConflicts(limit int) ([]WriteConflict, bool) {
	owners := map[string][]string{}
	paths := []string{}
	for _, id := range g.order {
		for _, raw := range g.byID[id].Writes {
			claim, _ := normalizeClaim(raw)
			if _, exists := owners[claim]; !exists {
				paths = append(paths, claim)
			}
			owners[claim] = append(owners[claim], id)
		}
	}
	sort.Strings(paths)
	for claim := range owners {
		sort.Strings(owners[claim])
	}
	pairs := map[string]bool{}
	conflicts := []WriteConflict{}
	add := func(a, b, leftPath, rightPath string) bool {
		if a == b {
			return true
		}
		if b < a {
			a, b = b, a
			leftPath, rightPath = rightPath, leftPath
		}
		key := a + "\x00" + b
		if pairs[key] {
			return true
		}
		pairs[key] = true
		if len(conflicts) == limit {
			return false
		}
		witness := leftPath
		if len(rightPath) > len(witness) {
			witness = rightPath
		}
		conflicts = append(conflicts, WriteConflict{LeftTask: a, RightTask: b, LeftPath: leftPath, RightPath: rightPath, Ordered: g.IsAncestor(a, b) || g.IsAncestor(b, a), Witness: witness})
		return true
	}
	for _, claim := range paths {
		group := owners[claim]
		for i, left := range group {
			for _, right := range group[i+1:] {
				if !add(left, right, claim, claim) {
					return conflicts, true
				}
			}
		}
		ancestors := []string{}
		if claim != "." {
			ancestors = append(ancestors, ".")
			for index, r := range claim {
				if r == '/' {
					ancestors = append(ancestors, claim[:index])
				}
			}
		}
		for _, ancestor := range ancestors {
			for _, left := range owners[ancestor] {
				for _, right := range group {
					if !add(left, right, ancestor, claim) {
						return conflicts, true
					}
				}
			}
		}
	}
	sort.Slice(conflicts, func(i, j int) bool {
		if conflicts[i].LeftTask == conflicts[j].LeftTask {
			return conflicts[i].RightTask < conflicts[j].RightTask
		}
		return conflicts[i].LeftTask < conflicts[j].LeftTask
	})
	return conflicts, false
}
