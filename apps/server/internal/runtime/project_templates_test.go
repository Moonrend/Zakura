// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
	"github.com/go-chi/chi/v5"
)

func TestTemplateHTTPVersionPreviewInstantiateAndIsolation(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "template-tenant")
	other := seedTenant(t, d, "other-template-tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "template-tenant", Space{Name: "Template Workspace", WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "template-tenant", Agent{Name: "Template Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	projects := projectexec.NewStore(d.DB, d.Dialect, d.Rebind)
	h := &handler{deps: d, store: store, projects: projects, projectEngine: projectexec.NewEngine(projects, nil, nil, projectexec.DefaultEngineConfig())}
	router := chi.NewRouter()
	router.Route("/api", func(r chi.Router) { r.Use(httpx.Auth(d)); r.Use(RequireAPIScope); h.registerProjectTemplates(r) })
	call := func(method, path, tok string, body any) (int, map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(body)
		request := httptest.NewRequest(method, "/api/project-templates"+path, bytes.NewReader(raw))
		request.Header.Set("Authorization", "Bearer "+tok)
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		var result map[string]any
		_ = json.Unmarshal(recorder.Body.Bytes(), &result)
		return recorder.Code, result
	}
	dfn := blueprint.Recipes()[1].Definition
	code, result := call("POST", "/", token, map[string]any{"definition": dfn})
	if code != 201 {
		t.Fatalf("create: %d %#v", code, result)
	}
	id := result["id"].(string)
	if result["createdBy"] != "" {
		t.Fatal("API key actor was stored as user")
	}
	if code, _ = call("GET", "/"+id, other, nil); code != 404 {
		t.Fatalf("tenant read leaked: %d", code)
	}
	if code, _ = call("PATCH", "/"+id, other, map[string]any{"expectedRevision": 1, "definition": dfn}); code != 404 {
		t.Fatalf("tenant update leaked: %d", code)
	}
	requestWithoutWriteRole := httptest.NewRequest("POST", "/api/project-templates/", nil).WithContext(httpx.WithPrincipal(context.Background(), httpx.Principal{TenantID: "template-tenant", Role: "guest"}))
	denied := httptest.NewRecorder()
	h.projectAccess(http.HandlerFunc(h.templateCreate)).ServeHTTP(denied, requestWithoutWriteRole)
	if denied.Code != 403 {
		t.Fatalf("unprivileged write allowed: %d", denied.Code)
	}
	input := map[string]any{"expectedRevision": 1, "spaceId": space.ID, "parameters": map[string]any{"product": "Zakura", "includeJapanese": false}, "agentMapping": map[string]any{"writer": agent.ID, "reviewer": agent.ID}}
	code, result = call("POST", "/"+id+"/preview", token, input)
	if code != 200 {
		t.Fatalf("preview: %d %#v", code, result)
	}
	if len(result["instances"].([]any)) != 5 || len(result["skipped"].([]any)) != 2 {
		t.Fatalf("matrix conditions: %#v", result)
	}
	var count int
	if err = d.DB.QueryRow(`SELECT count(*) FROM execution_projects`).Scan(&count); err != nil || count != 0 {
		t.Fatal("preview created project", err)
	}
	code, result = call("POST", "/"+id+"/instantiate", token, input)
	if code != 201 {
		t.Fatalf("instantiate: %d %#v", code, result)
	}
	project := result["project"].(map[string]any)
	if project["status"] != "draft" || project["createdBy"] != "" {
		t.Fatalf("wrong project: %#v", project)
	}
	if err = d.DB.QueryRow(`SELECT count(*) FROM execution_runs`).Scan(&count); err != nil || count != 0 {
		t.Fatal("instantiate unexpectedly started a run", err)
	}
	persisted, err := projects.GetProject(context.Background(), "template-tenant", project["id"].(string))
	if err != nil || len(persisted.Plan.Tasks) != 5 {
		t.Fatalf("persisted expansion: %#v %v", persisted, err)
	}
	code, document := call("GET", "/"+id+"/export", token, nil)
	if code != 200 || document["schema"] != blueprint.Schema {
		t.Fatalf("export: %d %#v", code, document)
	}
	if code, _ = call("POST", "/import", token, document); code != 201 {
		t.Fatalf("roundtrip import: %d", code)
	}
	dfn.Description = "Updated template description"
	code, result = call("PATCH", "/"+id, token, map[string]any{"expectedRevision": 1, "definition": dfn})
	if code != 200 || result["currentVersion"] != float64(2) {
		t.Fatalf("new version: %d %#v", code, result)
	}
	if code, _ = call("POST", "/"+id+"/instantiate", token, input); code != 409 {
		t.Fatalf("stale instantiate accepted: %d", code)
	}
	input["expectedRevision"] = 2
	input["version"] = 1
	if code, _ = call("POST", "/"+id+"/preview", token, input); code != 200 {
		t.Fatalf("explicit old immutable version: %d", code)
	}
	input["parameters"] = map[string]any{"product": "Zakura", "output": "../host"}
	if code, _ = call("POST", "/"+id+"/preview", token, input); code != 422 {
		t.Fatalf("unsafe path accepted: %d", code)
	}
	if _, err = d.DB.Exec(`INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES('template-tenant',1,'now')`); err != nil {
		t.Fatal(err)
	}
	input["parameters"] = map[string]any{"product": "Zakura"}
	if code, _ = call("POST", "/"+id+"/instantiate", token, input); code != 409 {
		t.Fatalf("draining instantiate accepted: %d", code)
	}
	if code, _ = call("DELETE", "/"+id+"?expectedRevision=2", token, nil); code != 409 {
		t.Fatalf("draining template delete accepted: %d", code)
	}
}

func TestTemplateHTTPBoundCredentialsAndCrossSpaceAgents(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "template-scope")
	store := NewStore(d)
	a, err := store.CreateSpace(context.Background(), "template-scope", Space{Name: "A", WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := store.CreateSpace(context.Background(), "template-scope", Space{Name: "B", WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "template-scope", Agent{Name: "Other space", SpaceID: b.ID})
	if err != nil {
		t.Fatal(err)
	}
	projects := projectexec.NewStore(d.DB, d.Dialect, d.Rebind)
	h := &handler{deps: d, store: store, projects: projects, projectEngine: projectexec.NewEngine(projects, nil, nil, projectexec.DefaultEngineConfig())}
	router := chi.NewRouter()
	router.Route("/api", func(r chi.Router) { r.Use(httpx.Auth(d)); h.registerProjectTemplates(r) })
	dfn := blueprint.Recipes()[0].Definition
	body := map[string]any{"definition": dfn, "spaceId": a.ID, "parameters": map[string]any{"feature": "Useful feature", "requirements": "A useful production feature with validated behavior"}, "agentMapping": map[string]string{"architect": agent.ID, "developer": agent.ID, "reviewer": agent.ID}}
	raw, _ := json.Marshal(body)
	request := httptest.NewRequest("POST", "/api/project-templates/preview", bytes.NewReader(raw))
	request.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code == 200 {
		t.Fatal("accepted agent mapped from another space")
	}
	// Test the tenant-only gate directly, independent of token scope defaults.
	for _, p := range []httpx.Principal{{TenantID: "template-scope", APIKey: true, AgentID: agent.ID}, {TenantID: "template-scope", OAuth: true, SpaceID: a.ID}} {
		request := httptest.NewRequest("GET", "/api/project-templates/", nil).WithContext(httpx.WithPrincipal(context.Background(), p))
		recorder := httptest.NewRecorder()
		h.projectAccess(http.HandlerFunc(h.templateList)).ServeHTTP(recorder, request)
		if recorder.Code != 403 {
			t.Fatalf("bound principal allowed: %d", recorder.Code)
		}
	}
}
