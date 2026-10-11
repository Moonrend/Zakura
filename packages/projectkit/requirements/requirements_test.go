package requirements

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

type files map[string]string

func (f files) Stat(ctx context.Context, path string) (acceptance.FileInfo, error) {
	raw, ok := f[path]
	if !ok {
		return acceptance.FileInfo{}, acceptance.ErrNotFound
	}
	return acceptance.FileInfo{Size: int64(len(raw))}, nil
}
func (f files) ReadFile(ctx context.Context, path string, limit int64) ([]byte, error) {
	raw, ok := f[path]
	if !ok {
		return nil, acceptance.ErrNotFound
	}
	return []byte(raw), nil
}
func fixture(t *testing.T) Input {
	t.Helper()
	check := mission.CheckSpec{ID: "file", Kind: "path_exists", Path: "result.txt", Required: true}
	taskSpec := mission.TaskSpec{ID: "implement", Title: "Implement", Prompt: "Write a tested implementation", AgentID: "agent-a", Writes: []string{"result.txt"}, Checks: []mission.CheckSpec{check}}
	project := mission.Project{ID: "p", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{taskSpec}}}
	now := time.Now().UTC()
	baseline := Baseline{ID: "baseline", ProjectID: "p", Title: "Deliver useful code", Clauses: []Clause{{ID: "REQ-1", Kind: "functional", Title: "Deliver implementation", Required: true, Bindings: []Binding{{TaskSpecID: taskSpec.ID, CheckID: check.ID}}}}, RequiredBeforePublication: true, Revision: 2, Status: "approved", ApprovedBy: "human", ApprovedAt: &now, ApprovedPlan: project.Plan, ApprovedPlanHash: PlanHash(project.Plan)}
	binding := RunBinding{RunID: "run", Baseline: baseline, BaselineID: baseline.ID, BaselineRevision: baseline.Revision, BaselineHash: BaselineHash(baseline), FrozenPlanHash: PlanHash(project.Plan)}
	task := mission.Task{ID: "task-instance", RunID: "run", Spec: taskSpec, Status: "completed", SnapshotID: "snapshot"}
	report, err := acceptance.Evaluate(context.Background(), taskSpec.Checks, acceptance.Environment{SnapshotID: task.SnapshotID, Files: files{"result.txt": "done"}}, acceptance.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return Input{Binding: binding, FrozenProject: project, Run: mission.Run{ID: "run", Status: "completed"}, Tasks: []mission.Task{task}, Verifications: map[string]mission.Verification{task.ID: report.Verification("verification", task.ID, "branch", now)}, Reviews: map[string]mission.Review{}}
}
func TestCoverageRequiresExactActualEvidence(t *testing.T) {
	for _, test := range []struct {
		name, status string
		mutate       func(*Input)
	}{
		{"passed", "passed", func(*Input) {}},
		{"check-exists-no-evidence", "pending", func(i *Input) { i.Verifications = map[string]mission.Verification{} }},
		{"unrelated-task-proof", "pending", func(i *Input) {
			v := i.Verifications["task-instance"]
			delete(i.Verifications, "task-instance")
			v.TaskID = "unrelated"
			i.Verifications[v.TaskID] = v
		}},
		{"foreign-run-task", "missing", func(i *Input) { i.Tasks[0].RunID = "foreign-run" }},
		{"old-snapshot", "missing", func(i *Input) {
			v := i.Verifications["task-instance"]
			v.SnapshotID = "stale"
			i.Verifications["task-instance"] = v
		}},
		{"tampered-proof", "failed", func(i *Input) {
			v := i.Verifications["task-instance"]
			v.Checks[0].Summary = "forged"
			i.Verifications["task-instance"] = v
		}},
		{"task-running", "pending", func(i *Input) { i.Tasks[0].Status = "running" }},
		{"task-semantics-changed", "changed_plan", func(i *Input) { i.Tasks[0].Spec.Prompt = "Different work" }},
		{"task-failed", "failed", func(i *Input) { i.Tasks[0].Status = "failed" }},
		{"review-outstanding", "review_unapproved", func(i *Input) { i.FrozenProject.Config.RequireReview = true; i.Tasks[0].Status = "waiting_review" }},
		{"require-review-no-local-record", "review_unapproved", func(i *Input) { i.FrozenProject.Config.RequireReview = true }},
		{"foreign-review", "review_unapproved", func(i *Input) {
			i.FrozenProject.Config.RequireReview = true
			i.Reviews["task-instance"] = mission.Review{ID: "imported", RunID: "foreign-run", TaskID: "task-instance", SnapshotID: "snapshot", Decision: "approved", AuthorID: "outside"}
		}},
		{"frozen-check-changed", "changed_plan", func(i *Input) { i.FrozenProject.Plan.Tasks[0].Checks[0].Path = "different.txt" }},
		{"baseline-content-changed", "changed_plan", func(i *Input) { i.Binding.Baseline.Clauses[0].Description = "Changed after approval" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := fixture(t)
			test.mutate(&input)
			coverage := Evaluate(input)
			if len(coverage.Rows) != 1 || coverage.Rows[0].Status != test.status {
				t.Fatalf("coverage %+v", coverage)
			}
			if coverage.PublicationAllowed != (test.status == "passed") {
				t.Fatalf("gate %v for %s", coverage.PublicationAllowed, test.status)
			}
		})
	}
	input := fixture(t)
	input.FrozenProject.Config.RequireReview = true
	input.Reviews["task-instance"] = mission.Review{ID: "local", RunID: "run", TaskID: "task-instance", SnapshotID: "snapshot", Decision: "approved", AuthorID: "human"}
	coverage := Evaluate(input)
	if !coverage.PublicationAllowed || coverage.Rows[0].Evidence[0].ReviewID != "local" {
		t.Fatalf("local review not accepted %+v", coverage)
	}
}
func TestPlanMappingDetectsRemovedTasksChecksAndOrphans(t *testing.T) {
	input := fixture(t)
	clauses := append([]Clause(nil), input.Binding.Baseline.Clauses...)
	clauses = append(clauses, Clause{ID: "REQ-2", Required: true}, Clause{ID: "OPTIONAL", Required: false, Bindings: []Binding{{TaskSpecID: "gone", CheckID: "gone"}}})
	analysis := Analyze(clauses, input.FrozenProject.Plan)
	if analysis.Valid || analysis.Required != 2 || analysis.Optional != 1 {
		t.Fatalf("analysis %+v", analysis)
	}
	codes := []string{}
	for _, issue := range analysis.Issues {
		codes = append(codes, issue.Code)
	}
	if !reflect.DeepEqual(codes, []string{"orphaned_requirement", "missing_task"}) {
		t.Fatalf("issues %v", codes)
	}
	input.FrozenProject.Plan.Tasks[0].Checks = nil
	analysis = Analyze(input.Binding.Baseline.Clauses, input.FrozenProject.Plan)
	if analysis.Valid || analysis.Issues[0].Code != "missing_check" {
		t.Fatalf("check removal %+v", analysis)
	}
}
func TestSemanticPlanHashIgnoresDisplayChangesButTracksExecution(t *testing.T) {
	input := fixture(t)
	original := PlanHash(input.FrozenProject.Plan)
	raw, _ := json.Marshal(input.FrozenProject.Plan)
	var changed mission.Plan
	json.Unmarshal(raw, &changed)
	changed.Version = 8
	changed.Tasks[0].Title = "Translated title"
	changed.Tasks[0].Priority = 100
	changed.Tasks[0].MaxAttempts = 20
	if PlanHash(changed) != original {
		t.Fatal("display/schedule values changed semantic signature")
	}
	changed.Tasks[0].Prompt = "A different implementation"
	if PlanHash(changed) == original {
		t.Fatal("execution prompt omitted from signature")
	}
}
