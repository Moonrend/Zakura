package runtime

import (
	"context"
	"testing"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/requirements"
)

func TestProjectRequirementsHTTPHumanApprovalImmutableRunBinding(t *testing.T) {
	d := testDeps(t)
	key := seedTenant(t, d, "tenant-requirements")
	otherKey := seedTenant(t, d, "tenant-other")
	human := projectTestHumanToken(t, d, "tenant-requirements", "requirements-reviewer")
	h, server, _ := projectTestServer(t, d)
	h.initializeProjectRequirements()
	space, err := h.store.CreateSpace(context.Background(), "tenant-requirements", Space{Name: "Requirements workspace"})
	if err != nil {
		t.Fatal(err)
	}
	p, err := h.projects.CreateProject(context.Background(), mission.Project{TenantID: "tenant-requirements", SpaceID: space.ID, Name: "Requirements", Goal: "Preserve evidence", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "implement", Title: "Implement", Prompt: "Implement", AgentID: "placeholder", MaxAttempts: 3, Checks: []mission.CheckSpec{{ID: "file", Kind: "path_exists", Path: "result.txt", Required: true}}}}}, Config: mission.Config{Budget: mission.Budget{MaxConcurrent: 1}, MaxTasks: 100}})
	if err != nil {
		t.Fatal(err)
	}
	base := server.URL + "/api/project-executions/" + p.ID + "/requirements"
	draft := requirements.Draft{Title: "Release baseline", RequiredBeforePublication: true, Clauses: []requirements.Clause{{ID: "REQ-1", Kind: "functional", Title: "Implement the output", Description: "Produce the required artifact", Required: true, Bindings: []requirements.Binding{{TaskSpecID: "implement", CheckID: "file"}}}}}
	code, out := doJSON(t, server.Client(), "POST", base, key, draft)
	projectTestStatus(t, code, 201, out)
	baseline := projectTestDecode[requirements.Baseline](t, out)
	code, out = doJSON(t, server.Client(), "GET", base+"/"+baseline.ID+"/analysis", key, nil)
	projectTestStatus(t, code, 200, out)
	if out["valid"] != true {
		t.Fatalf("mapping analysis %#v", out)
	}
	reviewBody := map[string]any{"expectedRevision": 1, "expectedProjectRevision": p.Revision, "decision": "approved", "comment": "核对需求与验收映射"}
	code, out = doJSON(t, server.Client(), "POST", base+"/"+baseline.ID+"/review", key, reviewBody)
	projectTestStatus(t, code, 403, out)
	code, out = doJSON(t, server.Client(), "POST", base+"/"+baseline.ID+"/review", human, reviewBody)
	projectTestStatus(t, code, 200, out)
	approved := projectTestDecode[requirements.Baseline](t, out)
	if approved.Status != "approved" || approved.ApprovedBy != "requirements-reviewer" || approved.ApprovedPlanHash == "" {
		t.Fatalf("approval %+v", approved)
	}
	run, err := h.projects.CreateRun(context.Background(), p.TenantID, p.ID, "base-snapshot")
	if err != nil {
		t.Fatal(err)
	}
	code, out = doJSON(t, server.Client(), "POST", base+"/"+baseline.ID+"/bind", key, map[string]any{"expectedRevision": approved.Revision, "runId": run.ID})
	projectTestStatus(t, code, 201, out)
	bound := projectTestDecode[requirements.RunBinding](t, out)
	if bound.BaselineHash == "" || bound.BaselineRevision != 2 {
		t.Fatalf("binding %+v", bound)
	}
	code, out = doJSON(t, server.Client(), "GET", base+"/runs/"+run.ID, key, nil)
	projectTestStatus(t, code, 200, out)
	coverageRaw := out["coverage"].(map[string]any)
	coverage := projectTestDecode[requirements.Coverage](t, coverageRaw)
	if !coverage.Bound || coverage.PublicationAllowed || coverage.RequiredPassed != 0 || coverage.Rows[0].Status != "pending" {
		t.Fatalf("false check existence success %+v", coverage)
	}
	code, out = doJSON(t, server.Client(), "PATCH", base+"/"+baseline.ID, key, map[string]any{"expectedRevision": 2, "title": "Changed baseline", "clauses": draft.Clauses, "requiredBeforePublication": true, "comment": "必须重新签审"})
	projectTestStatus(t, code, 200, out)
	edited := projectTestDecode[requirements.Baseline](t, out)
	if edited.Status != "draft" || edited.ApprovedBy != "" {
		t.Fatalf("stale approval kept %+v", edited)
	}
	code, out = doJSON(t, server.Client(), "GET", base+"/runs/"+run.ID, key, nil)
	projectTestStatus(t, code, 200, out)
	frozen := projectTestDecode[requirements.RunBinding](t, out["binding"].(map[string]any))
	if frozen.Baseline.Title != "Release baseline" || frozen.BaselineHash != bound.BaselineHash || frozen.BaselineRevision != 2 {
		t.Fatalf("run baseline mutated %+v", frozen)
	}
	code, out = doJSON(t, server.Client(), "GET", base+"/"+baseline.ID+"?revision=2", key, nil)
	projectTestStatus(t, code, 200, out)
	if out["status"] != "approved" {
		t.Fatalf("historical review vanished %#v", out)
	}
	code, out = doJSON(t, server.Client(), "GET", base+"/runs/"+run.ID, otherKey, nil)
	projectTestStatus(t, code, 404, out)
	code, out = doJSON(t, server.Client(), "DELETE", base+"/"+baseline.ID, human, map[string]any{"expectedRevision": 3, "comment": "历史绑定必须保留"})
	projectTestStatus(t, code, 200, out)
	code, out = doJSON(t, server.Client(), "GET", base+"/runs/"+run.ID, key, nil)
	projectTestStatus(t, code, 200, out)
	frozen = projectTestDecode[requirements.RunBinding](t, out["binding"].(map[string]any))
	if frozen.BaselineHash != bound.BaselineHash {
		t.Fatal("delete erased run history")
	}
}
