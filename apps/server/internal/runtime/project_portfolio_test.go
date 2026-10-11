// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProjectPortfolioHTTPPermissionsScopeAndPartialControls(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "portfolio-a")
	seedTenant(t, d, "portfolio-b")
	h := &handler{deps: d, store: NewStore(d), projects: projectexec.NewStore(d.DB, d.Dialect, d.Rebind)}
	h.projectEngine = projectexec.NewEngine(h.projects, nil, nil, projectexec.DefaultEngineConfig())
	fixture := func(tenant string) (mission.Project, mission.Run) {
		space, err := h.store.CreateSpace(context.Background(), tenant, Space{Name: "Portfolio"})
		if err != nil {
			t.Fatal(err)
		}
		agent, err := h.store.CreateAgent(context.Background(), tenant, Agent{Name: "Portfolio agent", SpaceID: space.ID})
		if err != nil {
			t.Fatal(err)
		}
		p, err := h.projects.CreateProject(context.Background(), mission.Project{TenantID: tenant, SpaceID: space.ID, Name: "Publish docs", Goal: "Deliver a verified source artifact", Plan: mission.Plan{Tasks: []mission.TaskSpec{{ID: "deliver", Title: "Deliver", Prompt: "Write source", AgentID: agent.ID, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "feature.go", Required: true}}}}}})
		if err != nil {
			t.Fatal(err)
		}
		run, err := h.projects.CreateRun(context.Background(), tenant, p.ID, "base")
		if err != nil {
			t.Fatal(err)
		}
		return p, run
	}
	p1, r1 := fixture("portfolio-a")
	p2, r2 := fixture("portfolio-b")
	router := chi.NewRouter()
	router.Route("/api", h.registerProjectPortfolio)
	request := func(method, path string, body any, p httpx.Principal) *httptest.ResponseRecorder {
		var raw []byte
		var err error
		if body != nil {
			raw, err = json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	owner := httpx.Principal{TenantID: "portfolio-a", UserID: "owner", SessionID: "owner-session", Role: "owner"}
	member := owner
	member.Role = "member"
	policy := map[string]any{"enabled": true, "maxActiveTasks": 2, "agingSeconds": 10, "expectedRevision": 0}
	for _, p := range []httpx.Principal{member, {TenantID: "portfolio-a", UserID: "owner", SessionID: "oauth", Role: "owner", OAuth: true}, {TenantID: "portfolio-a", UserID: "key", Role: "owner", APIKey: true}} {
		w := request("PUT", "/api/project-portfolio/policy", policy, p)
		if w.Code != 403 {
			t.Fatalf("non-human/admin policy write status=%d %s", w.Code, w.Body.String())
		}
	}
	w := request("PUT", "/api/project-portfolio/policy", policy, owner)
	if w.Code != 200 {
		t.Fatalf("owner policy: %d %s", w.Code, w.Body.String())
	}
	w = request("PUT", "/api/project-portfolio/policy", policy, owner)
	if w.Code != 409 {
		t.Fatalf("stale policy: %d %s", w.Code, w.Body.String())
	}
	w = request("PATCH", "/api/project-portfolio/projects/"+p1.ID+"/scheduling", map[string]any{"expectedRevision": p1.Revision, "priority": 9, "weight": 2}, member)
	if w.Code != 200 {
		t.Fatalf("member scheduling: %d %s", w.Code, w.Body.String())
	}
	foreign := owner
	foreign.TenantID = "portfolio-b"
	w = request("PATCH", "/api/project-portfolio/projects/"+p1.ID+"/scheduling", map[string]any{"expectedRevision": p1.Revision + 1, "priority": 0, "weight": 1}, foreign)
	if w.Code != 404 {
		t.Fatalf("cross-tenant scheduling: %d %s", w.Code, w.Body.String())
	}
	w = request("GET", "/api/project-portfolio/", nil, owner)
	if w.Code != 200 || strings.Contains(w.Body.String(), p2.ID) {
		t.Fatalf("portfolio leaked cross-tenant project: %d %s", w.Code, w.Body.String())
	}
	bound := owner
	bound.AgentID = "bound-agent"
	w = request("GET", "/api/project-portfolio/", nil, bound)
	if w.Code != 403 {
		t.Fatalf("bound credential portfolio: %d %s", w.Code, w.Body.String())
	}
	w = request("POST", "/api/project-portfolio/runs/actions", map[string]any{"action": "pause", "items": []projectexec.PortfolioRunAction{{ProjectID: p1.ID, RunID: r1.ID, ExpectedRevision: r1.Revision}, {ProjectID: p2.ID, RunID: r2.ID, ExpectedRevision: r2.Revision}}}, member)
	if w.Code != 200 {
		t.Fatalf("batch HTTP: %d %s", w.Code, w.Body.String())
	}
	var result struct {
		Items []projectexec.PortfolioActionResult `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 || result.Items[0].Status != "applied" || result.Items[1].Status != "not_found" {
		t.Fatalf("batch partial outcomes: %+v", result)
	}
	untouched, err := h.projects.GetRun(context.Background(), "portfolio-b", p2.ID, r2.ID)
	if err != nil || untouched.Status != "pending" {
		t.Fatalf("foreign run changed: %+v %v", untouched, err)
	}
}

func TestProjectPortfolioCannotResumeCampaignChildren(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "portfolio-campaign")
	h := &handler{deps: d, store: NewStore(d), projects: projectexec.NewStore(d.DB, d.Dialect, d.Rebind)}
	h.projectEngine = projectexec.NewEngine(h.projects, nil, nil, projectexec.DefaultEngineConfig())
	space, err := h.store.CreateSpace(context.Background(), "portfolio-campaign", Space{Name: "Portfolio"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "portfolio-campaign", Agent{Name: "Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	create := func() (mission.Project, mission.Run) {
		p, err := h.projects.CreateProject(context.Background(), mission.Project{TenantID: "portfolio-campaign", SpaceID: space.ID, Name: "Candidate", Goal: "Deliver artifact", Plan: mission.Plan{Tasks: []mission.TaskSpec{{ID: "build", Title: "Build", Prompt: "Write", AgentID: agent.ID, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "feature.go", Required: true}}}}}})
		if err != nil {
			t.Fatal(err)
		}
		run, err := h.projects.CreateRun(context.Background(), p.TenantID, p.ID, "base")
		if err != nil {
			t.Fatal(err)
		}
		run, err = h.projectEngine.Pause(context.Background(), p.TenantID, p.ID, run.ID, run.Revision)
		if err != nil {
			t.Fatal(err)
		}
		return p, run
	}
	child, childRun := create()
	ordinary, ordinaryRun := create()
	now := runtimeTimeString(d.Clock())
	if _, err = d.DB.Exec(`INSERT INTO project_campaigns(id,tenant_id,space_id,source_project_id,revision,campaign_json,created_at,updated_at) VALUES('portfolio-campaign-test','portfolio-campaign',?,?,1,'{}',?,?)`, space.ID, ordinary.ID, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB.Exec(`INSERT INTO project_campaign_variants(tenant_id,campaign_id,variant_id,project_id,state,run_id) VALUES('portfolio-campaign','portfolio-campaign-test','child',?,'paused',?)`, child.ID, childRun.ID); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Route("/api", h.registerProjectPortfolio)
	patch, err := json.Marshal(map[string]any{"expectedRevision": child.Revision, "priority": 4, "weight": 2})
	if err != nil {
		t.Fatal(err)
	}
	patchReq := httptest.NewRequest("PATCH", "/api/project-portfolio/projects/"+child.ID+"/scheduling", bytes.NewReader(patch))
	patchReq = patchReq.WithContext(httpx.WithPrincipal(patchReq.Context(), httpx.Principal{TenantID: "portfolio-campaign", UserID: "member", SessionID: "session", Role: "member"}))
	patchResult := httptest.NewRecorder()
	router.ServeHTTP(patchResult, patchReq)
	if patchResult.Code != 409 {
		t.Fatalf("campaign scheduling bypass: %d %s", patchResult.Code, patchResult.Body.String())
	}
	unchanged, err := h.projects.GetProject(context.Background(), child.TenantID, child.ID)
	if err != nil || unchanged.Revision != child.Revision || unchanged.Config.Scheduling != child.Config.Scheduling {
		t.Fatalf("campaign definition changed: %+v %v", unchanged, err)
	}
	raw, err := json.Marshal(map[string]any{"action": "resume", "items": []projectexec.PortfolioRunAction{{ProjectID: child.ID, RunID: childRun.ID, ExpectedRevision: childRun.Revision}, {ProjectID: ordinary.ID, RunID: ordinaryRun.ID, ExpectedRevision: ordinaryRun.Revision}}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/project-portfolio/runs/actions", bytes.NewReader(raw))
	req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "portfolio-campaign", UserID: "member", SessionID: "session", Role: "member"}))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var out struct {
		Items []projectexec.PortfolioActionResult `json:"items"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || len(out.Items) != 2 || out.Items[0].Status != "invalid_state" || out.Items[1].Status != "applied" {
		t.Fatalf("campaign guard or independent control: %d %+v", w.Code, out)
	}
	got, err := h.projects.GetRun(context.Background(), child.TenantID, child.ID, childRun.ID)
	if err != nil || got.Status != "paused" {
		t.Fatalf("campaign child bypassed controller: %+v %v", got, err)
	}
}
