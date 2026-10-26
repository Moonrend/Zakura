// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestBoundAPIKeysEnforceCoreResourceScope(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S"})
	other, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "Other"})
	a, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	b, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "B", SpaceID: space.ID})
	c, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "C", SpaceID: other.ID})
	h := &handler{deps: d, store: store}
	for _, tc := range []struct {
		name string
		p    httpx.Principal
		path string
		want int
	}{
		{"space_own_agent", httpx.Principal{SpaceID: space.ID}, "/api/agents/" + a.ID, 200},
		{"space_sibling_agent", httpx.Principal{SpaceID: space.ID}, "/api/agents/" + b.ID, 200},
		{"space_foreign_agent", httpx.Principal{SpaceID: space.ID}, "/api/agents/" + c.ID, 404},
		{"space_foreign_space", httpx.Principal{SpaceID: space.ID}, "/api/spaces/" + other.ID, 404},
		{"agent_own", httpx.Principal{AgentID: a.ID}, "/api/agents/" + a.ID, 200},
		{"agent_sibling", httpx.Principal{AgentID: a.ID}, "/api/agents/" + b.ID, 404},
		{"agent_shared_settings", httpx.Principal{AgentID: a.ID}, "/api/spaces/" + space.ID, 404},
		{"bound_global_management", httpx.Principal{SpaceID: space.ID}, "/api/model-upstreams", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := tc.p
			p.APIKey, p.APIKeyScopes, p.TenantID = true, `["api"]`, "tenant"
			router := chi.NewRouter()
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					next.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), p)))
				})
			})
			router.Use(h.resourceScopeMiddleware)
			router.Get("/api/agents/{id}", h.getAgent)
			router.Get("/api/spaces/{id}", h.getSpace)
			router.Get("/api/model-upstreams", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if w.Code != tc.want {
				t.Fatalf("code=%d want=%d body=%s", w.Code, tc.want, w.Body.String())
			}
		})
	}
	for _, p := range []httpx.Principal{{TenantID: "tenant", APIKey: true, AgentID: a.ID}, {TenantID: "tenant", APIKey: true, SpaceID: space.ID}} {
		r := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
		r = r.WithContext(httpx.WithPrincipal(r.Context(), p))
		w := httptest.NewRecorder()
		h.listAgents(w, r)
		var rows []map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
			t.Fatal(err)
		}
		want := 2
		if p.AgentID != "" {
			want = 1
		}
		if len(rows) != want {
			t.Fatalf("list leak: %#v", rows)
		}
	}
}
