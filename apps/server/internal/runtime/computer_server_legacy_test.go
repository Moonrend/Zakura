// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestServerComputerConfigurationCannotBypassLifecycleThroughLegacyPatch(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "Space"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "tenant", Agent{Name: "Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []struct {
		id    string
		serve http.HandlerFunc
	}{{space.ID, h.patchSpace}, {agent.ID, h.patchAgent}} {
		call := func(body string) *httptest.ResponseRecorder {
			r := httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(body))
			route := chi.NewRouteContext()
			route.URLParams.Add("id", endpoint.id)
			ctx := context.WithValue(r.Context(), chi.RouteCtxKey, route)
			r = r.WithContext(httpx.WithPrincipal(ctx, httpx.Principal{TenantID: "tenant", Role: "owner"}))
			w := httptest.NewRecorder()
			endpoint.serve(w, r)
			return w
		}
		for _, body := range []string{`{"enableComputer":true}`, `{"workspaceImage":"other:image"}`, `{"runtimeNodeId":"foreign"}`, `{"workspaceKind":"host"}`} {
			if w := call(body); w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "/computer/config") {
				t.Fatalf("legacy configuration %s: %d %s", body, w.Code, w.Body)
			}
		}
		if w := call(`{"name":"Renamed"}`); w.Code != http.StatusOK {
			t.Fatalf("ordinary update blocked: %d %s", w.Code, w.Body)
		}
	}
	current, err := h.store.GetSpace(context.Background(), "tenant", space.ID)
	if err != nil || current.RuntimeNodeID != nil || current.WorkspaceImage != nil || current.EnableComputer || current.WorkspaceKind != space.WorkspaceKind {
		t.Fatalf("legacy patch changed server configuration: %+v %v", current, err)
	}
}
