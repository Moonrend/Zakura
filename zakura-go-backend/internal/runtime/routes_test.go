// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestRuntimeRouteGroupsAreRegistered(t *testing.T) {
	d := testDeps(t)
	r := chi.NewRouter()
	RegisterRoutes(r, d)
	got := map[string]bool{}
	if e := chi.Walk(r, func(method, route string, _ http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		got[method+" "+route] = true
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	expected := []string{
		"GET /api/agents/{id}/desktop", "POST /api/agents/{id}/desktop-ticket", "POST /api/agents/{id}/terminal-ticket",
		"GET /api/agents/{id}/migrations", "POST /api/agents/{id}/migrations", "GET /api/migrations/{jobId}", "GET /api/migrations/{jobId}/events",
		"PUT /api/agents/{id}/projects/{slug}/hooks", "POST /api/agents/{id}/projects/{slug}/skills", "GET /api/agents/{id}/projects/{slug}/skills/{name}/file",
		"GET /api/capabilities", "GET /api/capabilities/web-fetch", "PUT /api/capabilities/web-search",
		"POST /api/model-upstreams/{id}/auth/start", "POST /api/model-upstreams/{id}/auth/poll", "POST /api/model-upstreams/{id}/auth/logout",
		"GET /api/otel/config", "POST /api/otel/v1/logs", "GET /api/spaces/{id}/graph",
		"GET /api/runtime-nodes/{id}/install.sh", "GET /api/runtime-nodes/{id}/install.ps1", "POST /api/runtime-nodes/register",
		"GET /api/system/image-updates", "POST /api/system/image-updates/check-all", "GET /api/zakurabot/ws",
		"POST /api/platform-services/{key}/start", "POST /api/platform-services/{key}/health",
		"POST /api/mcp/upstream-oauth/start", "GET /api/mcp/upstream-oauth/callback", "POST /api/mcp/store/sync",
	}
	for _, key := range expected {
		if !got[key] {
			t.Errorf("missing route %s", key)
		}
	}
}
