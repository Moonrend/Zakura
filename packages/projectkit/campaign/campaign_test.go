// SPDX-License-Identifier: AGPL-3.0-or-later
package campaign

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

type evidenceFiles bool

func (f evidenceFiles) Stat(context.Context, string) (acceptance.FileInfo, error) {
	if !f {
		return acceptance.FileInfo{}, acceptance.ErrNotFound
	}
	return acceptance.FileInfo{Size: 8}, nil
}
func (f evidenceFiles) ReadFile(context.Context, string, int64) ([]byte, error) {
	return []byte("artifact"), nil
}

func TestComparisonSelectsLatestSnapshotBoundEvidenceAndRejectsChangedChecks(t *testing.T) {
	d := fixture(t)
	now := time.Now().UTC()
	task := mission.TaskSpec{ID: "artifact", Title: "Artifact", Prompt: "Verify artifact", AgentID: "agent", Writes: []string{"artifact.txt"}, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "artifact.txt", Required: true}}}
	for i := range d.Variants {
		d.Variants[i].Project.Plan.Tasks = []mission.TaskSpec{task}
		d.Variants[i].DefinitionHash = ProjectHash(d.Variants[i].Project)
	}
	pass, err := acceptance.Evaluate(context.Background(), task.Checks, acceptance.Environment{SnapshotID: "snapshot", Files: evidenceFiles(true)}, acceptance.Options{})
	if err != nil {
		t.Fatal(err)
	}
	fail, err := acceptance.Evaluate(context.Background(), task.Checks, acceptance.Environment{SnapshotID: "snapshot", Files: evidenceFiles(false)}, acceptance.Options{})
	if err != nil {
		t.Fatal(err)
	}
	p := d.Variants[0].Project
	run := mission.Run{ID: "run", Status: "failed", CreatedAt: now.Add(-time.Minute), UpdatedAt: now}
	actual := mission.Task{ID: "task-id", RunID: "run", Spec: task, Status: "failed", SnapshotID: "snapshot"}
	older := pass.Verification("older", "task-id", "branch", now.Add(-time.Second))
	newer := fail.Verification("newer", "task-id", "branch", now)
	observation := Observation{VariantID: "base", Run: &run, Project: &p, Tasks: []mission.Task{actual}, Verifications: []mission.Verification{newer, older}}
	row := Compare(d, []Observation{observation}, now).Measurements[0]
	if row.AcceptanceRate == nil || *row.AcceptanceRate != 0 || row.RequiredChecksObserved != 1 {
		t.Fatalf("old passing result concealed current failure: %+v", row)
	}
	newer.Checks[0].Evidence = json.RawMessage(`{}`)
	observation.Verifications = []mission.Verification{older, newer}
	row = Compare(d, []Observation{observation}, now).Measurements[0]
	if row.AcceptanceRate != nil || row.RequiredChecksObserved != 0 {
		t.Fatalf("invalid latest proof fell back to an older passing proof: %+v", row)
	}
	older.SnapshotID = "different"
	observation.Verifications = []mission.Verification{older}
	row = Compare(d, []Observation{observation}, now).Measurements[0]
	if row.AcceptanceRate != nil {
		t.Fatal("evidence from another snapshot counted")
	}
	actual.Spec.Checks = []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "other.txt", Required: true}}
	observation.Tasks = []mission.Task{actual}
	observation.Verifications = []mission.Verification{pass.Verification("changed", "task-id", "branch", now)}
	row = Compare(d, []Observation{observation}, now).Measurements[0]
	if row.AcceptanceRate != nil {
		t.Fatal("changed check semantics counted as baseline acceptance")
	}
}

func fixture(t *testing.T) Definition {
	t.Helper()
	d, err := Freeze(FrozenRequest{Name: "Compare agents", SourceProjectID: "source", TemplateID: "template", TemplateVersion: 1, BaselineID: "base", Budget: mission.Budget{MaxTokens: 20001, MaxModelCalls: 21, MaxToolCalls: 21, MaxWallSeconds: 201, MaxConcurrent: 1}, Blueprint: blueprint.Recipes()[1].Definition, Inputs: blueprint.Inputs{SpaceID: "space", Parameters: map[string]json.RawMessage{"product": json.RawMessage(`"Zakura"`)}}, Variants: []VariantSpec{{ID: "base", Name: "Baseline", AgentMapping: map[string]string{"writer": "writer-a", "reviewer": "reviewer-a"}}, {ID: "candidate", Name: "Candidate", AgentMapping: map[string]string{"writer": "writer-b", "reviewer": "reviewer-b"}, Models: map[string]string{"writer": "alternative"}}}})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestFreezeAllocatesCapsWithoutLendingAndDisclosesVariants(t *testing.T) {
	d := fixture(t)
	if d.ReservedBudget.MaxTokens != 20000 || d.ReservedBudget.MaxModelCalls != 20 || d.ReservedBudget.MaxWallSeconds != 200 {
		t.Fatal("remainder was lent or reservation exceeds cap")
	}
	for _, v := range d.Variants {
		if v.Project.Config.Budget.MaxTokens != 10000 || v.Project.Config.Budget.MaxConcurrent != 1 {
			t.Fatal("wrong child grant")
		}
		if ProjectHash(v.Project) != v.DefinitionHash {
			t.Fatal("hash mismatch")
		}
	}
	comparison := Compare(d, nil, time.Now())
	if !comparison.Comparable || len(comparison.Differences) == 0 {
		t.Fatalf("agent/model differences not disclosed: %#v", comparison)
	}
	for _, row := range comparison.Measurements {
		if row.AcceptanceRate != nil || row.ProviderReportedTokens != nil || row.Samples != 0 {
			t.Fatal("fabricated unobserved measurements")
		}
	}
}

func TestCompareUsesCountersAndMarksMissingEvidenceUnknown(t *testing.T) {
	d := fixture(t)
	before, _ := json.Marshal(d)
	now := time.Now().UTC()
	p := d.Variants[0].Project
	run := mission.Run{ID: "run", Status: "failed", CreatedAt: now.Add(-3 * time.Second), UpdatedAt: now, Tokens: 8192, ModelCalls: 1, ToolCalls: 2}
	comparison := Compare(d, []Observation{{VariantID: "base", Run: &run, Project: &p}}, now)
	row := comparison.Measurements[0]
	if row.ChargedTokens != 8192 || row.ModelCalls != 1 || row.ToolCalls != 2 || row.ElapsedSeconds != 3 || row.AcceptanceRate != nil || row.ProviderReportedTokens != nil {
		t.Fatalf("wrong observed counters: %#v", row)
	}
	after, _ := json.Marshal(d)
	if string(before) != string(after) {
		t.Fatal("comparison mutated frozen plans")
	}
	p.Plan.Tasks[0].Prompt = "different requirement"
	comparison = Compare(d, []Observation{{VariantID: "base", Run: &run, Project: &p}}, now)
	if comparison.Comparable {
		t.Fatal("prompt differences marked comparable")
	}
}

func TestProjectHashBindsCapsButNotPersistence(t *testing.T) {
	d := fixture(t)
	p := d.Variants[0].Project
	hash := ProjectHash(p)
	p.ID = "new-id"
	p.Revision = 4
	p.Status = "completed"
	p.CreatedAt = time.Now()
	if ProjectHash(p) != hash {
		t.Fatal("persistence fields changed writable proof")
	}
	p.Config.Budget.MaxTokens++
	if ProjectHash(p) == hash {
		t.Fatal("budget not frozen")
	}
	if !reflect.DeepEqual(d.Variants[0].Project.Config.Budget, d.Variants[1].Project.Config.Budget) {
		t.Fatal("unequal allocation")
	}
}
