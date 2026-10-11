// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectcampaign"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
	"github.com/Moonrend/Zakura/packages/projectkit/campaign"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/requirements"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
	"github.com/go-chi/chi/v5"
)

// This fixture uses the actual migrations and control-plane stores. The common
// snapshot is an opaque test identity; these tests exercise reservations and
// HTTP guards, not runner snapshot construction or external effects.
func workbenchCampaignFixture(t *testing.T, h *handler, tenant string) (campaign.Campaign, mission.Project) {
	t.Helper()
	ctx := context.Background()
	space, err := h.store.CreateSpace(ctx, tenant, Space{Name: "Campaign regression workspace"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(ctx, tenant, Agent{Name: "Campaign regression agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	source, err := h.projects.CreateProject(ctx, mission.Project{TenantID: tenant, SpaceID: space.ID, Name: "Campaign source", Goal: "Compare bounded variants", Config: mission.Config{MaxTasks: 10}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "work", Title: "Work", Prompt: "Produce the result", AgentID: agent.ID, MaxAttempts: 1, Writes: []string{"result.txt"}, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "result.txt", Required: true}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	definition, err := campaign.Freeze(campaign.FrozenRequest{Name: "Fixed experiment", SourceProjectID: source.ID, TemplateID: "regression-template", TemplateVersion: 1, BaselineID: "baseline", Budget: mission.Budget{MaxTokens: 2000, MaxModelCalls: 20, MaxToolCalls: 20, MaxWallSeconds: 3600, MaxConcurrent: 1}, Blueprint: blueprint.Definition{Name: "Bounded experiment", ProjectName: "Variant", Goal: source.Goal, Parameters: []blueprint.Parameter{}, Config: mission.Config{MaxTasks: 10, ExternalEffects: "deny"}, Tasks: []blueprint.Task{{Key: "work", Title: "Work", Prompt: "Produce the result", AgentRole: "author", MaxAttempts: 1, Writes: []string{"result.txt"}, Checks: source.Plan.Tasks[0].Checks}}}, Inputs: blueprint.Inputs{SpaceID: space.ID}, Variants: []campaign.VariantSpec{{ID: "baseline", Name: "Baseline", AgentMapping: map[string]string{"author": agent.ID}}, {ID: "candidate", Name: "Candidate", AgentMapping: map[string]string{"author": agent.ID}}}})
	if err != nil {
		t.Fatal(err)
	}
	store := h.campaignStore()
	c, err := store.Create(ctx, tenant, space.ID, "regression-reviewer", definition)
	if err != nil {
		t.Fatal(err)
	}
	c, err = store.BeginProvision(ctx, tenant, c.ID, "regression-reviewer", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	for _, variant := range c.Definition.Variants {
		child, e := h.projects.CreateProject(ctx, variant.Project)
		if e != nil {
			t.Fatal(e)
		}
		c, e = store.Provisioned(ctx, tenant, c.ID, variant.ID, child)
		if e != nil {
			t.Fatal(e)
		}
	}
	c, err = store.FinishProvision(ctx, tenant, c.ID, "regression-reviewer", []campaignControlResult{})
	if err != nil {
		t.Fatal(err)
	}
	c, err = store.Capture(ctx, tenant, c.ID, "regression-reviewer", "Freeze one common input", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	c, err = store.CaptureResult(ctx, tenant, c.ID, c.CaptureOperationID, strings.Repeat("a", 64), "ready", "", "regression-reviewer", "Observed common input")
	if err != nil {
		t.Fatal(err)
	}
	for _, variant := range c.Definition.Variants {
		c, err = store.Copy(ctx, tenant, c.ID, variant.ID, "regression-reviewer", c.Revision)
		if err != nil {
			t.Fatal(err)
		}
		for _, current := range c.Definition.Variants {
			if current.ID == variant.ID {
				c, err = store.CopyResult(ctx, tenant, c.ID, variant.ID, current.CopyOperationID, c.BaseSnapshot, "ready", "", "regression-reviewer", "Observed scoped snapshot copy")
				break
			}
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	return c, source
}

type workbenchEvidenceFiles map[string]string

func (f workbenchEvidenceFiles) Stat(_ context.Context, path string) (acceptance.FileInfo, error) {
	content, found := f[path]
	if !found {
		return acceptance.FileInfo{}, acceptance.ErrNotFound
	}
	return acceptance.FileInfo{Size: int64(len(content))}, nil
}
func (f workbenchEvidenceFiles) ReadFile(_ context.Context, path string, limit int64) ([]byte, error) {
	content, found := f[path]
	if !found {
		return nil, acceptance.ErrNotFound
	}
	if int64(len(content)) > limit {
		return nil, errors.New("fixture read exceeds bound")
	}
	return []byte(content), nil
}

func workbenchVerification(t *testing.T, task mission.Task, snapshot string, checks []mission.CheckSpec) mission.Verification {
	t.Helper()
	report, err := acceptance.Evaluate(context.Background(), checks, acceptance.Environment{SnapshotID: snapshot, Files: workbenchEvidenceFiles{"result.txt": "required implementation", "other.txt": "unrelated implementation"}}, acceptance.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return report.Verification("proof_"+task.ID, task.ID, "fixture_branch", time.Now().UTC())
}

// Acceptance evidence is generated by the real verifier and recorded through
// the fenced store. The snapshots and merge previews are fixtures; any attempt
// to publish these denied selections must stop before a runner RPC or intent.
func TestProjectWorkbenchRequirementPublicationGateAcrossReviewApplyAndDelivery(t *testing.T) {
	d := testDeps(t)
	key := seedTenant(t, d, "tenant-workbench-gate")
	human := projectTestHumanToken(t, d, "tenant-workbench-gate", "publication-reviewer")
	h, server, _ := projectTestServer(t, d)
	ctx := context.Background()
	space, err := h.store.CreateSpace(ctx, "tenant-workbench-gate", Space{Name: "Publication gate regression"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(ctx, "tenant-workbench-gate", Agent{Name: "Gate author", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	p, err := h.projects.CreateProject(ctx, mission.Project{TenantID: "tenant-workbench-gate", SpaceID: space.ID, Name: "Required artifact", Goal: "Publish the required implementation", Config: mission.Config{MaxTasks: 10}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "required", Title: "Required implementation", Prompt: "Implement the requirement", AgentID: agent.ID, Writes: []string{"result.txt"}, MaxAttempts: 1, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "result.txt", Required: true}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := h.projects.CreateRun(ctx, p.TenantID, p.ID, strings.Repeat("a", 64), p.Revision)
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := h.projects.ClaimTask(ctx, "gate-worker", time.Minute)
	if err != nil || assignment == nil {
		t.Fatalf("claim required task: %+v %v", assignment, err)
	}
	ref := projectexec.FenceRequest{Scope: assignment.Scope, RunID: run.ID, TaskID: assignment.Task.ID, Owner: assignment.Task.LeaseOwner, Fence: assignment.Task.Fence}
	if err = h.projects.InitializeTaskBranch(ctx, ref, "fixture_branch", run.BaseSnapshot); err != nil {
		t.Fatal(err)
	}
	taskSnapshot := strings.Repeat("b", 64)
	if _, err = h.projects.RecordVerification(ctx, ref, workbenchVerification(t, assignment.Task, taskSnapshot, assignment.Task.Spec.Checks)); err != nil {
		t.Fatal(err)
	}
	if err = h.projects.CompleteTask(ctx, ref, "Required output passed its check", taskSnapshot); err != nil {
		t.Fatal(err)
	}
	run, err = h.projects.GetRun(ctx, p.TenantID, p.ID, run.ID)
	if err != nil || run.Status != "completed" {
		t.Fatalf("completed run fixture: %+v %v", run, err)
	}
	task, err := h.projects.GetTask(ctx, p.TenantID, p.ID, run.ID, assignment.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := h.projectRequirements.Create(ctx, projectScope(p), requirements.Draft{Title: "Release requirements", RequiredBeforePublication: true, Clauses: []requirements.Clause{{ID: "REQ-1", Kind: "functional", Title: "Include the required implementation", Required: true, Bindings: []requirements.Binding{{TaskSpecID: task.Spec.ID, CheckID: "exists"}}}}}, "publication-reviewer")
	if err != nil {
		t.Fatal(err)
	}
	baseline, err = h.projectRequirements.Review(ctx, projectScope(p), baseline.ID, baseline.Revision, p.Revision, "approved", "Check the exact task and acceptance mapping", "publication-reviewer", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.projectRequirements.Bind(ctx, projectScope(p), baseline.ID, run.ID, baseline.Revision, "publication-reviewer"); err != nil {
		t.Fatal(err)
	}
	coverage, err := h.projectRequirements.Coverage(ctx, projectScope(p), run.ID)
	if err != nil || !coverage.PublicationAllowed {
		t.Fatalf("task-level required coverage should pass: %+v %v", coverage, err)
	}
	finalSnapshot := strings.Repeat("c", 64)
	finalProof := workbenchVerification(t, task, finalSnapshot, task.Spec.Checks)
	wrongChecks := append([]mission.CheckSpec(nil), task.Spec.Checks...)
	wrongChecks[0].Path = "other.txt"
	for _, sample := range []struct {
		Name     string
		Selected map[string]string
		Proof    mission.Verification
	}{
		{"required task omitted from subset", map[string]string{}, finalProof},
		{"proof belongs to a different snapshot", map[string]string{task.ID: task.SnapshotID}, workbenchVerification(t, task, strings.Repeat("d", 64), task.Spec.Checks)},
		{"proof uses different frozen check semantics", map[string]string{task.ID: task.SnapshotID}, workbenchVerification(t, task, finalSnapshot, wrongChecks)},
	} {
		t.Run(sample.Name, func(t *testing.T) {
			preview := projectMergePreview{ID: h.store.id(), ProjectID: p.ID, RunID: run.ID, RunRevision: run.Revision, Status: "ready", PlanID: strings.Repeat("e", 64), Plan: workspace.MergePlan{ID: strings.Repeat("e", 64), Result: workspace.Snapshot{ID: finalSnapshot}}, ExpectedBase: run.BaseSnapshot, TaskSnapshots: sample.Selected, Verifications: []mission.Verification{sample.Proof}}
			if err := h.saveMerge(ctx, p, preview); err != nil {
				t.Fatal(err)
			}
			runURL := server.URL + "/api/project-executions/" + p.ID + "/runs/" + run.ID
			code, out := doJSON(t, server.Client(), "POST", runURL+"/merges/"+preview.ID+"/review", human, map[string]any{"expectedRevision": 1, "snapshotId": finalSnapshot, "decision": "approved", "comment": "Check publication includes requirements"})
			projectTestStatus(t, code, 409, out)
			unchanged, err := h.loadMerge(ctx, p.TenantID, p.ID, run.ID, preview.ID)
			if err != nil || unchanged.Revision != 1 || unchanged.Status != "ready" {
				t.Fatalf("rejected review committed approval: %+v %v", unchanged, err)
			}
			// Seed an earlier approval to ensure both consuming entry points
			// independently revalidate their selection in the mutation transaction.
			preview.ID = h.store.id()
			preview.Status = "approved"
			preview.ReviewID = h.store.id()
			preview.ReviewedBy = "publication-reviewer"
			preview.ReviewComment = "Earlier approval must not bypass current proof validation"
			if err = h.saveMerge(ctx, p, preview); err != nil {
				t.Fatal(err)
			}
			code, out = doJSON(t, server.Client(), "POST", runURL+"/merges/"+preview.ID+"/apply", human, map[string]any{"expectedRevision": 1, "confirmation": "merge"})
			if code != 400 && code != 409 {
				t.Fatalf("invalid publication reached runner apply: HTTP %d %#v", code, out)
			}
			unchanged, err = h.loadMerge(ctx, p.TenantID, p.ID, run.ID, preview.ID)
			if err != nil || unchanged.Status != "approved" || unchanged.Revision != 1 || unchanged.OperationID != "" {
				t.Fatalf("denied publication left an outbound intent: %+v %v", unchanged, err)
			}
			code, out = doJSON(t, server.Client(), "POST", server.URL+"/api/project-executions/"+p.ID+"/deliveries", human, map[string]any{"runId": run.ID, "previewId": preview.ID, "expectedPreviewRevision": 1, "name": "Required artifact", "version": "candidate-" + preview.ID, "comment": "Package all required implementation"})
			if code != 400 && code != 409 {
				t.Fatalf("invalid publication reached delivery prepare: HTTP %d %#v", code, out)
			}
			var count int
			if err = d.DB.QueryRow(`SELECT COUNT(*) FROM execution_deliveries WHERE tenant_id=? AND project_id=?`, p.TenantID, p.ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("rejected package left a delivery intent: %d %v", count, err)
			}
		})
	}
	valid := projectMergePreview{ID: h.store.id(), ProjectID: p.ID, RunID: run.ID, RunRevision: run.Revision, Status: "ready", PlanID: strings.Repeat("e", 64), Plan: workspace.MergePlan{ID: strings.Repeat("e", 64), Result: workspace.Snapshot{ID: finalSnapshot}}, ExpectedBase: run.BaseSnapshot, TaskSnapshots: map[string]string{task.ID: task.SnapshotID}, Verifications: []mission.Verification{finalProof}}
	if err = h.saveMerge(ctx, p, valid); err != nil {
		t.Fatal(err)
	}
	reviewURL := server.URL + "/api/project-executions/" + p.ID + "/runs/" + run.ID + "/merges/" + valid.ID + "/review"
	body := map[string]any{"expectedRevision": 1, "snapshotId": finalSnapshot, "decision": "approved", "comment": "Exact required artifact and frozen checks are present"}
	code, out := doJSON(t, server.Client(), "POST", reviewURL, key, body)
	projectTestStatus(t, code, 403, out)
	code, out = doJSON(t, server.Client(), "POST", reviewURL, human, body)
	projectTestStatus(t, code, 200, out)
	if out["status"] != "approved" {
		t.Fatalf("valid exact proof was not approved: %#v", out)
	}
	if err = h.projectEngine.CancelTenant(ctx, p.TenantID); err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB.Exec(`DELETE FROM tenants WHERE id=?`, p.TenantID); err != nil {
		t.Fatalf("frozen baseline binding blocked whole-tenant cascade: %v", err)
	}
	for _, table := range []string{"execution_requirement_baselines", "execution_requirement_revisions", "execution_requirement_bindings", "execution_merge_previews"} {
		var count int
		if err = d.DB.QueryRow(`SELECT COUNT(*) FROM `+table+` WHERE tenant_id=?`, p.TenantID).Scan(&count); err != nil || count != 0 {
			t.Errorf("requirements tenant cascade left %s: %d %v", table, count, err)
		}
	}
}

func workbenchHTTPServer(t *testing.T, h *handler) *httptest.Server {
	t.Helper()
	router := chi.NewRouter()
	router.Route("/api", func(api chi.Router) {
		api.Use(httpx.Auth(h.deps))
		api.Use(RequireAPIScope)
		h.registerProjectExecutions(api)
		h.registerProjectPortfolio(api)
		h.registerProjectCampaigns(api)
	})
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return server
}

func TestProjectWorkbenchCampaignGuardsEveryAlternateHTTPRunEntry(t *testing.T) {
	d := testDeps(t)
	key := seedTenant(t, d, "tenant-workbench-guards")
	human := projectTestHumanToken(t, d, "tenant-workbench-guards", "regression-reviewer", "owner")
	h, _, _ := projectTestServer(t, d)
	c, source := workbenchCampaignFixture(t, h, "tenant-workbench-guards")
	server := workbenchHTTPServer(t, h)
	p := c.Definition.Variants[0].Project
	base := server.URL + "/api/project-executions/" + p.ID
	for _, request := range []struct {
		Name, Method, Path string
		Body               any
	}{
		{"ordinary start", "POST", base + "/runs", map[string]any{"expectedRevision": p.Revision}},
		{"ordinary fork", "POST", base + "/runs/not-created/fork", map[string]any{"expectedProjectRevision": p.Revision}},
		{"ordinary resume", "POST", base + "/runs/not-created/resume", map[string]any{"expectedRevision": 1}},
		{"ordinary retry", "POST", base + "/runs/not-created/tasks/not-created/retry", map[string]any{"expectedRevision": 1}},
		{"definition update", "PATCH", base, map[string]any{"expectedRevision": p.Revision}},
		{"definition delete", "DELETE", base, map[string]any{"expectedRevision": p.Revision}},
		{"imported artifact run", "POST", base + "/imports/not-created/runs", map[string]any{"expectedRevision": p.Revision}},
		{"refactor artifact run", "POST", base + "/refactors/not-created/runs", map[string]any{"expectedRevision": p.Revision}},
		{"portfolio scheduling", "PATCH", server.URL + "/api/project-portfolio/projects/" + p.ID + "/scheduling", map[string]any{"expectedRevision": p.Revision, "priority": 5, "weight": 2}},
		{"source deletion", "DELETE", server.URL + "/api/project-executions/" + source.ID, map[string]any{"expectedRevision": source.Revision}},
	} {
		t.Run(request.Name, func(t *testing.T) {
			code, out := doJSON(t, server.Client(), request.Method, request.Path, human, request.Body)
			projectTestStatus(t, code, 409, out)
		})
	}
	unchanged, err := h.projects.GetProject(context.Background(), p.TenantID, p.ID)
	if err != nil || unchanged.Revision != p.Revision || campaign.ProjectHash(unchanged) != c.Definition.Variants[0].DefinitionHash {
		t.Fatalf("blocked request changed frozen campaign child: %+v %v", unchanged, err)
	}
	code, out := doJSON(t, server.Client(), "GET", base, key, nil)
	projectTestStatus(t, code, 200, out)

	c, err = h.campaignStore().Start(context.Background(), c.TenantID, c.ID, "baseline", "regression-reviewer", "Explicit bounded start", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	variant := c.Definition.Variants[0]
	run, err := h.projects.CreateRunOnce(context.Background(), c.TenantID, variant.Project.ID, c.BaseSnapshot, variant.Project.Revision, variant.RunID)
	if err != nil {
		t.Fatal(err)
	}
	run, err = h.projectEngine.Pause(context.Background(), c.TenantID, variant.Project.ID, run.ID, run.Revision)
	if err != nil {
		t.Fatal(err)
	}
	code, out = doJSON(t, server.Client(), "POST", server.URL+"/api/project-portfolio/runs/actions", human, map[string]any{"action": "resume", "items": []projectexec.PortfolioRunAction{{ProjectID: p.ID, RunID: run.ID, ExpectedRevision: run.Revision}}})
	projectTestStatus(t, code, 200, out)
	result := projectTestDecode[struct {
		Items []projectexec.PortfolioActionResult `json:"items"`
	}](t, out)
	if len(result.Items) != 1 || result.Items[0].Status != "invalid_state" {
		t.Fatalf("portfolio resumed managed campaign run: %+v", result)
	}
	run, err = h.projects.GetRun(context.Background(), c.TenantID, p.ID, run.ID)
	if err != nil || run.Status != "paused" {
		t.Fatalf("managed run changed through portfolio: %+v %v", run, err)
	}
}

func TestProjectWorkbenchCampaignReservationsControlFenceAndTenantCascade(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant-workbench-cascade")
	h, _, _ := projectTestServer(t, d)
	c, source := workbenchCampaignFixture(t, h, "tenant-workbench-cascade")
	ctx := context.Background()
	store := h.campaignStore()
	var tokens int64
	var models, tools, wall int
	for _, variant := range c.Definition.Variants {
		caps := variant.Project.Config.Budget
		tokens += caps.MaxTokens
		models += caps.MaxModelCalls
		tools += caps.MaxToolCalls
		wall += caps.MaxWallSeconds
		if caps.MaxConcurrent != 1 {
			t.Fatalf("variant has unreserved task concurrency: %+v", caps)
		}
	}
	if tokens > c.Definition.Budget.MaxTokens || models > c.Definition.Budget.MaxModelCalls || tools > c.Definition.Budget.MaxToolCalls || wall > c.Definition.Budget.MaxWallSeconds {
		t.Fatal("frozen variant caps exceed fixed total experiment budget")
	}
	var err error
	c, err = store.Start(ctx, c.TenantID, c.ID, "baseline", "reviewer", "Reserve once", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	variant := c.Definition.Variants[0]
	if _, err = store.Start(ctx, c.TenantID, c.ID, "candidate", "reviewer", "No second unresolved reservation", c.Revision); err == nil {
		t.Fatal("unresolved start released its concurrency slot")
	}
	run, err := h.projects.CreateRunOnce(ctx, c.TenantID, variant.Project.ID, c.BaseSnapshot, variant.Project.Revision, variant.RunID)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := h.projects.CreateRunOnce(ctx, c.TenantID, variant.Project.ID, c.BaseSnapshot, variant.Project.Revision, variant.RunID)
	if err != nil || replayed.ID != run.ID {
		t.Fatalf("lost start replay created a new identity: %+v %v", replayed, err)
	}
	c, err = store.StartResult(ctx, c.TenantID, c.ID, variant.ID, variant.RunID, "started", "", "reviewer", "Observed one reserved run")
	if err != nil {
		t.Fatal(err)
	}
	run, err = h.projectEngine.Pause(ctx, c.TenantID, variant.Project.ID, run.ID, run.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Start(ctx, c.TenantID, c.ID, "candidate", "reviewer", "Paused variants still hold grants", c.Revision); err == nil {
		t.Fatal("paused run released its experiment concurrency slot")
	}
	if _, err = h.projectEngine.Cancel(ctx, c.TenantID, variant.Project.ID, run.ID, run.Revision); err != nil {
		t.Fatal(err)
	}
	c, err = store.Start(ctx, c.TenantID, c.ID, "candidate", "reviewer", "Reserve remaining fixed grant", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	second := c.Definition.Variants[1]
	c, err = store.BeginControl(ctx, c.TenantID, c.ID, "reviewer", "Cancel before reserved child is created", "cancel", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.projects.CreateRunOnce(ctx, c.TenantID, second.Project.ID, c.BaseSnapshot, second.Project.Revision, second.RunID); !errors.Is(err, projectexec.ErrConflict) {
		t.Fatalf("in-flight start crossed campaign control fence: %v", err)
	}
	c, err = store.FinishControl(ctx, c.TenantID, c.ID, "reviewer", "No second run was created", []campaignControlResult{})
	if err != nil || c.Status != "cancelled" {
		t.Fatalf("cancel outcome: %+v %v", c, err)
	}
	if _, err = h.projects.CreateRunOnce(ctx, c.TenantID, second.Project.ID, c.BaseSnapshot, second.Project.Revision, second.RunID); !errors.Is(err, projectexec.ErrConflict) {
		t.Fatalf("cancelled campaign created its reserved child: %v", err)
	}

	// The default policy and absence of a requirements binding preserve ordinary
	// project execution after all workbench migrations have been applied.
	ordinary, err := h.projects.CreateRun(ctx, source.TenantID, source.ID, "ordinary-base", source.Revision)
	if err != nil {
		t.Fatalf("campaign schema blocked an unrelated ordinary project: %v", err)
	}
	if err = h.requireProjectRequirements(ctx, projectScope(source), ordinary.ID); err != nil {
		t.Fatalf("unbound requirements blocked legacy publication: %v", err)
	}
	policy, err := h.projects.GetPortfolioPolicy(ctx, c.TenantID)
	if err != nil || policy.Enabled {
		t.Fatalf("default scheduling unexpectedly enabled: %+v %v", policy, err)
	}
	if err = h.projectEngine.CancelTenant(ctx, c.TenantID); err != nil {
		t.Fatal(err)
	}
	if _, err = store.BeginControl(ctx, c.TenantID, c.ID, "reviewer", "No new intent after drain", "resume", c.Revision); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatalf("drain accepted a campaign mutation: %v", err)
	}
	if _, err = h.projects.CreateRun(ctx, source.TenantID, source.ID, "late-base", source.Revision); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatalf("drain accepted an ordinary start: %v", err)
	}
	if _, err = d.DB.Exec(`DELETE FROM tenants WHERE id=?`, c.TenantID); err != nil {
		t.Fatalf("campaign source foreign key blocked whole-tenant cascade: %v", err)
	}
	for _, table := range []string{"project_campaigns", "project_campaign_variants", "project_campaign_audit", "execution_projects", "execution_runs", "execution_tenant_controls"} {
		var remaining int
		if err = d.DB.QueryRow(`SELECT COUNT(*) FROM `+table+` WHERE tenant_id=?`, c.TenantID).Scan(&remaining); err != nil || remaining != 0 {
			t.Errorf("tenant cascade left %s rows: %d %v", table, remaining, err)
		}
	}
	if _, err = store.Get(ctx, c.TenantID, c.ID); !errors.Is(err, projectcampaign.ErrNotFound) {
		t.Fatalf("deleted tenant retained campaign: %v", err)
	}
}

func TestProjectWorkbenchCampaignCancelBeforeReservedRunCreationHasDefiniteOutcome(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant-workbench-cancel")
	human := projectTestHumanToken(t, d, "tenant-workbench-cancel", "cancel-reviewer")
	h, _, _ := projectTestServer(t, d)
	c, _ := workbenchCampaignFixture(t, h, "tenant-workbench-cancel")
	ctx := context.Background()
	var err error
	c, err = h.campaignStore().Start(ctx, c.TenantID, c.ID, "baseline", "cancel-reviewer", "Reserve an explicit start", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	variant := c.Definition.Variants[0]
	server := workbenchHTTPServer(t, h)
	code, out := doJSON(t, server.Client(), "POST", server.URL+"/api/project-campaigns/"+c.ID+"/control", human, map[string]any{"expectedRevision": c.Revision, "action": "cancel", "comment": "Cancel the experiment before its reserved run is created"})
	projectTestStatus(t, code, 200, out)
	result := projectTestDecode[struct {
		Campaign campaign.Campaign       `json:"campaign"`
		Results  []campaignControlResult `json:"results"`
	}](t, out)
	if result.Campaign.Status != "cancelled" {
		t.Fatalf("definitely absent reserved run left an unrecoverable partial cancellation: status=%s results=%+v", result.Campaign.Status, result.Results)
	}
	if len(result.Results) != 1 || result.Results[0].Error != "" || result.Results[0].RunID != variant.RunID {
		t.Fatalf("unstarted variant lost its definite cancellation outcome or reserved audit identity: %+v", result)
	}
	if result.Campaign.Definition.Variants[0].RunID != variant.RunID {
		t.Fatal("cancellation discarded the reserved identity")
	}
	if _, err = h.projects.CreateRunOnce(ctx, c.TenantID, variant.Project.ID, c.BaseSnapshot, variant.Project.Revision, variant.RunID); !errors.Is(err, projectexec.ErrConflict) {
		t.Fatalf("late start crossed the observed cancellation: %v", err)
	}
	runs, err := h.projects.ListRuns(ctx, c.TenantID, variant.Project.ID, 10)
	if err != nil || len(runs) != 0 {
		t.Fatalf("cancelling an absent reserved run manufactured execution: %+v %v", runs, err)
	}
}

func TestProjectWorkbenchDrainStillPermitsReceiptSettlementAndScopedSourceRecovery(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant-workbench-recovery")
	h, _, _ := projectTestServer(t, d)
	ctx := context.Background()
	space, err := h.store.CreateSpace(ctx, "tenant-workbench-recovery", Space{Name: "Shutdown recovery"})
	if err != nil {
		t.Fatal(err)
	}
	p, err := h.projects.CreateProject(ctx, mission.Project{TenantID: "tenant-workbench-recovery", SpaceID: space.ID, Name: "Recover prior receipts", Goal: "Close known intent metadata during shutdown", Config: mission.Config{MaxTasks: 10}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "work", Title: "Work", Prompt: "Work", AgentID: "fixture-agent", MaxAttempts: 1, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "result.txt", Required: true}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	transfer, err := h.insertDelivery(ctx, p, projectDelivery{ID: "pending_transfer", ProjectID: p.ID, Kind: "import", Name: "Pending scoped import", Status: "unknown", CreatedBy: "fixture-operator"})
	if err != nil {
		t.Fatal(err)
	}
	now := runtimeTimeString(h.store.now())
	if err = h.recordSourceAttestation(ctx, p, "pending_source", "fixture-operator", `["old_writer"]`, "Previously requested source confirmation", now); err != nil {
		t.Fatal(err)
	}
	run, err := h.projects.CreateRun(ctx, p.TenantID, p.ID, "fixture-base", p.Revision)
	if err != nil {
		t.Fatal(err)
	}
	preview := projectMergePreview{ID: "pending_merge", ProjectID: p.ID, RunID: run.ID, Status: "unknown", OperationID: "earlier_apply"}
	if err = h.saveMerge(ctx, p, preview); err != nil {
		t.Fatal(err)
	}
	if err = h.projectEngine.CancelTenant(ctx, p.TenantID); err != nil {
		t.Fatal(err)
	}
	if _, err = h.insertDelivery(ctx, p, projectDelivery{ID: "late_transfer", ProjectID: p.ID, Kind: "import", Name: "Forbidden late import", Status: "preparing"}); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatalf("shutdown allowed new transfer intent: %v", err)
	}
	workbenchAssertDrainReceiptRecovery(t, ctx, h, p, transfer, run, preview, now)
}
