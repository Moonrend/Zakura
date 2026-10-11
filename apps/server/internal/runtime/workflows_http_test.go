// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workflow"
	"github.com/go-chi/chi/v5"
)

func TestWorkflowHTTPAuthenticationAndPlanning(t *testing.T) {
	deps := testDeps(t)
	a, b := seedTenant(t, deps, "workflow-a"), seedTenant(t, deps, "workflow-b")
	h := &handler{deps: deps}
	r := chi.NewRouter()
	r.Route("/api", func(api chi.Router) {
		api.Use(httpx.Auth(deps))
		api.Use(RequireAPIScope)
		h.registerWorkflows(api)
	})
	server := httptest.NewServer(r)
	defer server.Close()
	client := server.Client()
	for _, path := range []string{"meta", "templates", "validate", "plan"} {
		method := "GET"
		if path == "validate" || path == "plan" {
			method = "POST"
		}
		resp, err := client.Post(server.URL+"/api/workflows/plan", "application/json", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatalf("unauthenticated %s: %d", path, resp.StatusCode)
		}
		request, _ := http.NewRequest(method, server.URL+"/api/workflows/"+path, strings.NewReader(`{}`))
		resp, err = client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatalf("unauthenticated route %s: %d", path, resp.StatusCode)
		}
	}
	code, meta := doJSON(t, client, "GET", server.URL+"/api/workflows/meta", a, nil)
	if code != 200 || meta["executionEnabled"] != false || meta["maxNodes"] != float64(128) {
		t.Fatalf("meta: %d %#v", code, meta)
	}
	code, templates := doArray(t, client, "GET", server.URL+"/api/workflows/templates", a)
	if code != 200 || len(templates) != 3 {
		t.Fatalf("templates: %d %#v", code, templates)
	}
	req := workflow.Templates()[0].Request
	code, validation := doJSON(t, client, "POST", server.URL+"/api/workflows/validate", a, req)
	if code != 200 || validation["valid"] != true {
		t.Fatalf("validate: %d %#v", code, validation)
	}
	code, resultA := doJSON(t, client, "POST", server.URL+"/api/workflows/plan", a, req)
	if code != 200 || resultA["schedule"] == nil {
		t.Fatalf("plan: %d %#v", code, resultA)
	}
	code, resultB := doJSON(t, client, "POST", server.URL+"/api/workflows/plan", b, req)
	if code != 200 || resultA["fingerprint"] != resultB["fingerprint"] {
		t.Fatal("stateless tenant plans differ")
	}
	// The result is a function of the submitted definition and capacities;
	// it cannot load another tenant's agents, secrets, or saved definitions.
	req.Definition.Nodes[0].DependsOn = []string{"missing"}
	code, invalid := doJSON(t, client, "POST", server.URL+"/api/workflows/plan", a, req)
	if code != 422 || invalid["schedule"] != nil {
		t.Fatalf("invalid definition: %d %#v", code, invalid)
	}
	code, validation = doJSON(t, client, "POST", server.URL+"/api/workflows/validate", a, req)
	if code != 200 || validation["valid"] != false {
		t.Fatalf("invalid validation: %d %#v", code, validation)
	}
}

func TestWorkflowHTTPStrictJSONAndBodyLimits(t *testing.T) {
	deps := testDeps(t)
	token := seedTenant(t, deps, "workflow-strict")
	h := &handler{deps: deps}
	r := chi.NewRouter()
	r.Route("/api", func(api chi.Router) { api.Use(httpx.Auth(deps)); api.Use(RequireAPIScope); h.registerWorkflows(api) })
	server := httptest.NewServer(r)
	defer server.Close()
	valid, _ := json.Marshal(workflow.Templates()[0].Request)
	bodies := []string{
		`{`, `{} {}`, `{"extra":1}`, `{"definition":{"unknown":true}}`,
		`{"options":{"maxParallel":1.5}}`, `{"definition":{"nodes":[{"durationMs":9223372036854775808}]}}`,
		string(valid) + ` {}`, `{"definition":{"name":"` + strings.Repeat("x", 2<<20) + `"}}`,
	}
	for index, body := range bodies {
		req, _ := http.NewRequest("POST", server.URL+"/api/workflows/plan", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("malformed body %d: %d", index, resp.StatusCode)
		}
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("private response can be cached")
		}
	}
	// End-to-end request stays deterministic across serial calls.
	for i := 0; i < 2; i++ {
		req, _ := http.NewRequest("POST", server.URL+"/api/workflows/plan", bytes.NewReader(valid))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatal("valid request rejected")
		}
	}
}
