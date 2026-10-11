// SPDX-License-Identifier: AGPL-3.0-or-later
package plan

import (
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"math"
	"sort"
)

func Compare(base, candidate mission.Plan, config mission.Config, options CompareOptions) (Comparison, error) {
	oldGraph, err := Compile(base, config)
	if err != nil {
		return Comparison{}, fmt.Errorf("base plan: %w", err)
	}
	newGraph, err := Compile(candidate, config)
	if err != nil {
		return Comparison{}, fmt.Errorf("candidate plan: %w", err)
	}
	if err := validateEstimates(options.BaseEstimates, oldGraph); err != nil {
		return Comparison{}, err
	}
	if err := validateEstimates(options.CandidateEstimates, newGraph); err != nil {
		return Comparison{}, err
	}
	if options.CostWeight == 0 && options.VerificationWeight == 0 && options.ArtifactWeight == 0 && options.RiskWeight == 0 {
		options.CostWeight = 1
		options.VerificationWeight = 2
		options.ArtifactWeight = 1
		options.RiskWeight = 2
	}
	for _, weight := range []float64{options.CostWeight, options.VerificationWeight, options.ArtifactWeight, options.RiskWeight} {
		if math.IsNaN(weight) || math.IsInf(weight, 0) || weight < 0 || weight > 1000000 {
			return Comparison{}, fmt.Errorf("comparison weights must be finite and nonnegative")
		}
	}
	before := scoreAlternative(oldGraph, options.BaseEstimates, config, options)
	after := scoreAlternative(newGraph, options.CandidateEstimates, config, options)
	result := Comparison{Base: before, Candidate: after, Changes: planChanges(oldGraph, newGraph), Comparable: true, Metrics: []Metric{}, Uncertainty: []string{}}
	add := func(name string, a, b, weight float64, explanation string) {
		result.Metrics = append(result.Metrics, Metric{Name: name, Base: a, Candidate: b, Delta: b - a, Weight: weight, Explanation: explanation})
	}
	add("cost", before.Cost, after.Cost, options.CostWeight, "budget-normalized explicit cost reservations; unknown cost is reported separately")
	add("verification", before.Verification, after.Verification, options.VerificationWeight, "required acceptance checks cover every task; distinct rule kinds add evidence diversity, not proof of correctness")
	add("artifacts", before.Artifacts, after.Artifacts, options.ArtifactWeight, "write scopes with content acceptance improve observable delivery; declaring more files alone earns no extra score")
	add("risk", before.Risk, after.Risk, options.RiskWeight, "unordered writes, command execution and missing cost estimates are explicit execution risks")
	add("criticalSeconds", float64(before.CriticalSeconds), float64(after.CriticalSeconds), 0, "longest estimated dependency chain; meaningful only with complete duration estimates")
	if before.EstimateCoverage < 1 || after.EstimateCoverage < 1 {
		result.Comparable = false
		result.Uncertainty = append(result.Uncertainty, "cost or duration estimates are incomplete; overall scores are descriptive and cannot justify a cheaper or faster plan")
	}
	beforeWrites, afterWrites := deliveryPaths(oldGraph), deliveryPaths(newGraph)
	if !sameStrings(beforeWrites, afterWrites) {
		result.Comparable = false
		result.Uncertainty = append(result.Uncertainty, "alternatives declare different artifact scopes; verify equivalent user outcomes before choosing by score")
	}
	if len(options.BaseEstimates) == 0 && len(options.CandidateEstimates) == 0 {
		result.Uncertainty = append(result.Uncertainty, "no model or tool cost was inferred from prompt length")
	}
	if !result.Comparable {
		result.Recommendation = "review_assumptions"
	} else if after.Total > before.Total+0.000001 {
		result.Recommendation = "candidate"
	} else if before.Total > after.Total+0.000001 {
		result.Recommendation = "base"
	} else {
		result.Recommendation = "equivalent_under_assumptions"
	}
	return result, nil
}
func scoreAlternative(graph *Graph, estimates map[string]Estimate, config mission.Config, options CompareOptions) AlternativeScore {
	score := AlternativeScore{}
	covered := 0
	verified, artifactTasks, commandTasks := 0, 0, 0
	diversity := 0.0
	for _, id := range graph.order {
		task := graph.byID[id]
		if estimate, known := estimates[id]; known {
			covered++
			score.KnownCost = addUsage(score.KnownCost, estimate)
		}
		kinds := map[string]bool{}
		content := false
		hasRequired := false
		command := false
		for _, check := range task.Checks {
			if !check.Required {
				continue
			}
			hasRequired = true
			kinds[check.Kind] = true
			if check.Kind == "command" {
				command = true
			}
			switch check.Kind {
			case "text_contains", "text_excludes", "regex", "json_valid", "json_pointer", "command":
				content = true
			}
		}
		if hasRequired {
			verified++
		}
		if len(task.Writes) > 0 && content {
			artifactTasks++
		}
		if command {
			commandTasks++
		}
		diversity += math.Min(float64(len(kinds))/3, 1)
	}
	n := float64(len(graph.order))
	score.EstimateCoverage = float64(covered) / n
	score.Verification = 0.75*float64(verified)/n + 0.25*diversity/n
	score.Artifacts = float64(artifactTasks) / n
	costParts := []float64{}
	if config.Budget.MaxTokens > 0 {
		costParts = append(costParts, float64(score.KnownCost.Tokens)/float64(config.Budget.MaxTokens))
	}
	if config.Budget.MaxModelCalls > 0 {
		costParts = append(costParts, float64(score.KnownCost.ModelCalls)/float64(config.Budget.MaxModelCalls))
	}
	if config.Budget.MaxToolCalls > 0 {
		costParts = append(costParts, float64(score.KnownCost.ToolCalls)/float64(config.Budget.MaxToolCalls))
	}
	if config.Budget.MaxWallSeconds > 0 {
		costParts = append(costParts, float64(score.KnownCost.WallSeconds)/float64(config.Budget.MaxWallSeconds))
	}
	if len(costParts) > 0 {
		for _, part := range costParts {
			score.Cost += part
		}
		score.Cost /= float64(len(costParts))
	}
	conflicts, truncated := graph.writeConflicts(20000)
	unordered := 0
	for _, conflict := range conflicts {
		if !conflict.Ordered {
			unordered++
		}
	}
	possible := n * (n - 1) / 2
	if possible > 0 {
		score.Risk = float64(unordered) / possible
	}
	if truncated {
		score.Risk = 1
	}
	score.Risk += 0.2*float64(commandTasks)/n + 0.5*(1-score.EstimateCoverage)
	score.Total = options.VerificationWeight*score.Verification + options.ArtifactWeight*score.Artifacts - options.CostWeight*score.Cost - options.RiskWeight*score.Risk
	if score.EstimateCoverage == 1 {
		analysis := graph.analyze(estimates)
		score.CriticalSeconds = analysis.CriticalLength
	}
	return score
}
func deliveryPaths(graph *Graph) []string {
	seen := map[string]bool{}
	for _, task := range graph.byID {
		for _, raw := range task.Writes {
			claim, _ := normalizeClaim(raw)
			seen[claim] = true
		}
	}
	paths := []string{}
	for claim := range seen {
		paths = append(paths, claim)
	}
	sort.Strings(paths)
	return paths
}
func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
