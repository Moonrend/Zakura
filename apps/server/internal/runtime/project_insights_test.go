// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/insight"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
)

func TestProjectInsightsReadFrozenEvidenceWithoutRunnerAndFenceTenant(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant-insights")
	other := seedTenant(t, d, "tenant-else")
	h := &handler{deps: d, store: NewStore(d)}
	h.projects = projectexec.NewStore(d.DB, d.Dialect, d.Rebind)
	// The insight HTTP surface is available with an unstarted engine and no
	// runner/model adapter; tests would fail if analysis attempted dispatch.
	h.projectEngine = projectexec.NewEngine(h.projects, nil, nil, projectexec.EngineConfig{})
	space, err := h.store.CreateSpace(context.Background(), "tenant-insights", Space{Name: "Insight space"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "tenant-insights", Agent{Name: "Author", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	project, err := h.projects.CreateProject(context.Background(), mission.Project{TenantID: "tenant-insights", SpaceID: space.ID, Name: "Measured work", Goal: "Audit actual work", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{
		{ID: "author", Title: "Write artifact", Prompt: "secret implementation instructions", AgentID: agent.ID, Writes: []string{"a.txt"}, Checks: []mission.CheckSpec{{ID: "a", Kind: "path_exists", Path: "a.txt", Required: true}}},
		{ID: "consumer", Title: "Use artifact", Prompt: "private consumer prompt", AgentID: agent.ID, DependsOn: []string{"author"}, Writes: []string{"b.txt"}, Checks: []mission.CheckSpec{{ID: "b", Kind: "path_exists", Path: "b.txt", Required: true}}},
	}}, Config: mission.Config{Budget: mission.Budget{MaxConcurrent: 2, MaxTokens: 30}}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := h.projects.CreateRun(context.Background(), project.TenantID, project.ID, "frozen-base", project.Revision)
	if err != nil {
		t.Fatal(err)
	}
	// Later edits are deliberately incompatible. The run diagnostics and CPU
	// simulator must continue interpreting the original frozen definition.
	project.Plan.Version = 2
	project.Plan.Tasks[0].Prompt = "changed implementation"
	project.Plan.Tasks[0].Title = "Renamed task"
	if _, err = h.projects.UpdateProject(context.Background(), project.TenantID, project.ID, project.Revision, project); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Route("/api", func(api chi.Router) {
		api.Use(httpx.Auth(d))
		api.Use(RequireAPIScope)
		api.Route("/project-executions/{pid}", func(p chi.Router) { p.Use(h.projectAccess); h.registerProjectInsights(p) })
	})
	server := httptest.NewServer(router)
	defer server.Close()
	base := server.URL + "/api/project-executions/" + project.ID
	runBase := base + "/runs/" + run.ID
	status, body := doJSON(t, server.Client(), http.MethodGet, runBase+"/insights", token, nil)
	if status != 200 {
		t.Fatalf("read without runner failed: %d %+v", status, body)
	}
	raw, _ := json.Marshal(body)
	var observed insight.RunInsight
	if err := json.Unmarshal(raw, &observed); err != nil {
		t.Fatal(err)
	}
	if observed.PlanVersion != 1 || len(observed.Tasks) != 2 || observed.Tasks[0].Title != "Write artifact" || observed.Tasks[0].ObservedSeconds != nil || observed.CriticalPath.Seconds != nil {
		t.Fatalf("edited or fabricated evidence: %+v", observed)
	}
	if status, body := doJSON(t, server.Client(), http.MethodGet, runBase+"/insights", other, nil); status != 404 {
		t.Fatalf("foreign tenant evidence: %d %+v", status, body)
	}
	boundToken := "zk_bound-insights"
	hash := sha256.Sum256([]byte(boundToken))
	if _, err = d.DB.Exec(`INSERT INTO api_keys(id,tenant_id,agent_id,space_id,name,key_prefix,key_hash,created_at) VALUES('bound-insight-key',?,?,?,?,?,?,?)`, project.TenantID, agent.ID, space.ID, "Bound", "zk_bound", hex.EncodeToString(hash[:]), runtimeTimeString(d.Clock())); err != nil {
		t.Fatal(err)
	}
	if status, body := doJSON(t, server.Client(), http.MethodGet, runBase+"/insights", boundToken, nil); status != 403 {
		t.Fatalf("agent bound access accepted: %d %+v", status, body)
	}
	status, body = doJSON(t, server.Client(), http.MethodPost, runBase+"/simulate", token, insight.SimulationRequest{Scenarios: []insight.Scenario{
		{ID: "serial", MaxConcurrent: 1, Durations: map[string]float64{"author": 3, "consumer": 5}},
		{ID: "parallel", MaxConcurrent: 4, Durations: map[string]float64{"author": 3, "consumer": 5}, Costs: map[string]insight.CostEstimate{"author": {Tokens: 40}}},
	}})
	if status != 200 {
		t.Fatalf("CPU simulation failed: %d %+v", status, body)
	}
	raw, _ = json.Marshal(body)
	var simulation insight.Simulation
	_ = json.Unmarshal(raw, &simulation)
	if simulation.PlanVersion != 1 || len(simulation.Scenarios) != 2 || simulation.Scenarios[0].MakespanSeconds == nil || *simulation.Scenarios[0].MakespanSeconds != 8 || simulation.Scenarios[0].Budget.Status != "unknown" || simulation.Scenarios[1].Budget.Status != "exceeded" {
		t.Fatalf("invalid simulation assumptions: %+v", simulation)
	}
	status, body = doJSON(t, server.Client(), http.MethodGet, base+"/runs/compare?left="+run.ID+"&right="+run.ID, token, nil)
	if status != 200 {
		t.Fatalf("comparison route collided: %d %+v", status, body)
	}
	status, body = doJSON(t, server.Client(), http.MethodGet, base+"/insights", token, nil)
	if status != 200 {
		t.Fatalf("history failed: %d %+v", status, body)
	}
	var count int
	if err = d.DB.QueryRow("SELECT COUNT(*) FROM execution_operations").Scan(&count); err != nil || count != 0 {
		t.Fatalf("analysis dispatched work: %d %v", count, err)
	}
	final, err := h.projects.GetRun(context.Background(), project.TenantID, project.ID, run.ID)
	if err != nil || final.Revision != run.Revision || final.Tokens != 0 || final.ToolCalls != 0 || final.Status != "pending" {
		t.Fatalf("simulation mutated execution: %+v %v", final, err)
	}
	req, _ := http.NewRequest(http.MethodGet, runBase+"/insights/report?format=markdown", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	report, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("Content-Disposition") != `attachment; filename="project-execution-insights.md"` || response.Header.Get("Cache-Control") != "private, no-store" || strings.Contains(string(report), "secret implementation") || !strings.Contains(string(report), "unknown") {
		t.Fatalf("unsafe audit report: %d %s", response.StatusCode, report)
	}
	status, _ = doJSON(t, server.Client(), http.MethodPost, runBase+"/simulate", token, insight.SimulationRequest{Scenarios: []insight.Scenario{{ID: "invalid", MaxConcurrent: 2, Durations: map[string]float64{"not-a-task": 10}}}})
	if status != 400 {
		t.Fatal("unknown task assumption accepted")
	}
	req, _ = http.NewRequest(http.MethodPost, runBase+"/simulate", bytes.NewReader(bytes.Repeat([]byte(" "), 2<<20+1)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err = server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatalf("oversized JSON accepted: %d", response.StatusCode)
	}
}

func TestProjectInsightRecordQueryCannotEscapeKind(t *testing.T) {
	d := testDeps(t)
	if _, err := projectInsightRecords[mission.Event](context.Background(), d.DB, d.Rebind, "events; DROP TABLE tenants", "tenant", "pid", "rid", 1); err == nil {
		t.Fatal("untrusted record kind became SQL")
	}
}
