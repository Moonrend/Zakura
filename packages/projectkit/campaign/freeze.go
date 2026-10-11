// SPDX-License-Identifier: AGPL-3.0-or-later
package campaign

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
)

func Freeze(r FrozenRequest) (Definition, error) {
	if strings.TrimSpace(r.Name) == "" || len(r.Name) > 200 || r.SourceProjectID == "" || r.TemplateID == "" || r.TemplateVersion < 1 {
		return Definition{}, fmt.Errorf("campaign name, source project and template version are required")
	}
	if len(r.Variants) < 2 || len(r.Variants) > MaxVariants {
		return Definition{}, fmt.Errorf("campaign requires 2 to 16 variants")
	}
	budget, err := allocate(r.Budget, len(r.Variants))
	if err != nil {
		return Definition{}, err
	}
	d := Definition{Name: r.Name, SourceProjectID: r.SourceProjectID, TemplateID: r.TemplateID, TemplateVersion: r.TemplateVersion, BaselineID: r.BaselineID, Budget: r.Budget, ReservedBudget: mission.Budget{MaxTokens: budget.MaxTokens * int64(len(r.Variants)), MaxModelCalls: budget.MaxModelCalls * len(r.Variants), MaxToolCalls: budget.MaxToolCalls * len(r.Variants), MaxWallSeconds: budget.MaxWallSeconds * len(r.Variants), MaxConcurrent: r.Budget.MaxConcurrent}, Variants: []Variant{}}
	seen := map[string]bool{}
	roles := map[string]bool{}
	for _, role := range blueprint.Roles(r.Blueprint) {
		roles[role] = true
	}
	keyRoles := map[string]string{}
	for _, task := range r.Blueprint.Tasks {
		keyRoles[task.Key] = task.AgentRole
	}
	totalBytes := 0
	for _, spec := range r.Variants {
		if !variantID(spec.ID) || seen[spec.ID] || strings.TrimSpace(spec.Name) == "" || len(spec.Name) > 200 {
			return Definition{}, fmt.Errorf("variant IDs must be unique ASCII identifiers and names require 1 to 200 bytes")
		}
		seen[spec.ID] = true
		for role, model := range spec.Models {
			if !roles[role] || len(model) > 256 || strings.ContainsAny(model, "\x00\r\n") {
				return Definition{}, fmt.Errorf("invalid model mapping for role %s", role)
			}
		}
		inputs := r.Inputs
		inputs.AgentMapping = spec.AgentMapping
		expanded, err := blueprint.Expand(r.Blueprint, inputs)
		if err != nil {
			return Definition{}, err
		}
		p := expanded.Project
		p.Name = r.Name + " / " + spec.Name
		p.Config.Budget = budget
		for i, instance := range expanded.Instances {
			role := keyRoles[instance.Key]
			if model, ok := spec.Models[role]; ok {
				p.Plan.Tasks[i].Model = model
			}
		}
		if err = plan.ValidatePlan(p.Plan, p.Config); err != nil {
			return Definition{}, err
		}
		variant := Variant{ID: spec.ID, Name: spec.Name, Project: p, DefinitionHash: ProjectHash(p), State: "prepared"}
		raw, _ := json.Marshal(variant)
		totalBytes += len(raw)
		if totalBytes > MaxDefinitionBytes {
			return Definition{}, fmt.Errorf("campaign frozen variants exceed 16 MiB")
		}
		d.Variants = append(d.Variants, variant)
	}
	if !seen[r.BaselineID] {
		return Definition{}, fmt.Errorf("baseline must name one of the variants")
	}
	return d, nil
}

func variantID(value string) bool {
	if len(value) < 1 || len(value) > 64 {
		return false
	}
	for i, c := range []byte(value) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_' || i > 0 && (c >= '0' && c <= '9' || c == '-') {
			continue
		}
		return false
	}
	return true
}

func allocate(total mission.Budget, count int) (mission.Budget, error) {
	if total.MaxTokens < int64(count) || total.MaxTokens > 1_000_000_000_000 || total.MaxModelCalls < count || total.MaxModelCalls > 1_000_000 || total.MaxToolCalls < count || total.MaxToolCalls > 1_000_000 || total.MaxWallSeconds < count || total.MaxWallSeconds > 30*24*3600 || total.MaxConcurrent < 1 || total.MaxConcurrent > MaxVariants {
		return mission.Budget{}, fmt.Errorf("campaign requires positive bounded token/model/tool/wall caps large enough for every variant and concurrency 1 to 16")
	}
	return mission.Budget{MaxTokens: total.MaxTokens / int64(count), MaxModelCalls: total.MaxModelCalls / count, MaxToolCalls: total.MaxToolCalls / count, MaxWallSeconds: total.MaxWallSeconds / count, MaxConcurrent: 1}, nil
}

// ProjectHash ignores persistence identity, status and timestamps, and binds the
// exact writable definition and fixed caps that the campaign granted.
func ProjectHash(p mission.Project) string {
	value := struct {
		SpaceID string
		Name    string
		Goal    string
		Plan    mission.Plan
		Config  mission.Config
	}{p.SpaceID, p.Name, p.Goal, p.Plan, p.Config}
	raw, _ := json.Marshal(value)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func Terminal(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}
