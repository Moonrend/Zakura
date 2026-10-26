// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestACPConfigUsesSpaceCatalogAndPreservesMaskedSecrets(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S"})
	a, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	b, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "B", SpaceID: space.ID})
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	endpoint := server.URL + "/api/spaces/" + space.ID + "/acp/config"
	code, out := doJSON(t, server.Client(), http.MethodGet, endpoint, token, nil)
	if code != 200 || len(out["profiles"].([]any)) < 40 {
		t.Fatalf("catalog: %d %#v", code, out)
	}
	body := map[string]any{"agents": map[string]any{"custom": map[string]any{"enabled": true, "command": "custom-acp", "setupMode": "self", "env": map[string]any{"PRIVATE_TOKEN": "env-secret"}, "managed": map[string]any{"api_key": "sk-full-secret", "base_url": "http://example.test"}}}}
	code, out = doJSON(t, server.Client(), http.MethodPut, endpoint, token, body)
	if code != 200 {
		t.Fatalf("save: %d %#v", code, out)
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "full-secret") || strings.Contains(string(raw), "env-secret") {
		t.Fatalf("secret exposed: %s", raw)
	}
	code, out = doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agents/"+b.ID+"/acp/config", token, nil)
	if code != 200 {
		t.Fatalf("sibling read: %d %#v", code, out)
	}
	masked := out["config"].(map[string]any)
	code, out = doJSON(t, server.Client(), http.MethodPut, endpoint, token, masked)
	if code != 200 {
		t.Fatalf("masked save: %d %#v", code, out)
	}
	fresh, _ := store.GetSpace(context.Background(), "tenant", space.ID)
	var cfg map[string]any
	_ = json.Unmarshal(fresh.Config, &cfg)
	profile, err := acpRuntimeProfile(acpMap(cfg), "custom")
	if err != nil || stringMap(profile["env"])["PRIVATE_TOKEN"] != "env-secret" {
		t.Fatalf("masked env was persisted: %#v %v", profile, err)
	}
	parsed := parseACPConfig(acpMap(cfg))
	if parsed.Agents["custom"].Managed["api_key"] != "sk-full-secret" {
		t.Fatalf("masked key persisted: %#v", parsed)
	}
	for _, agent := range []Agent{a, b} {
		fresh, _ := store.GetAgent(context.Background(), "tenant", agent.ID)
		if string(fresh.Config) != "{}" {
			t.Fatalf("Agent was changed: %s", fresh.Config)
		}
	}
}

func TestACPConfigKeyScopeRestrictsAgentAliases(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	s, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S"})
	a, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: s.ID})
	b, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "B", SpaceID: s.ID})
	h := &handler{deps: d, store: store}
	for _, tc := range []struct {
		path      string
		principal httpx.Principal
		want      int
	}{
		{"/agents/" + a.ID + "/acp/config", httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: a.ID}, 200},
		{"/agents/" + b.ID + "/acp/config", httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: a.ID}, 404},
		{"/spaces/" + s.ID + "/acp/config", httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: a.ID}, 404},
		{"/spaces/" + s.ID + "/acp/config", httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: s.ID}, 200},
		{"/spaces/" + s.ID + "/acp/config", httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: "other"}, 404},
	} {
		router := chi.NewRouter()
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				next.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), tc.principal)))
			})
		})
		router.Get("/agents/{id}/acp/config", h.getACPConfig)
		router.Get("/spaces/{spaceId}/acp/config", h.getACPConfig)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if w.Code != tc.want {
			t.Fatalf("%s got %d want %d: %s", tc.path, w.Code, tc.want, w.Body.String())
		}
	}
}

func TestACPConfigLegacyProfilesResolveUntilSpaceIsConfigured(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	s, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S"})
	a, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: s.ID, Config: json.RawMessage(`{"acp":{"profiles":{"legacy":{"command":"legacy-acp","args":["--stdio"],"env":{"API_TOKEN":"secret"}}}}}`)})
	h := &handler{deps: d, store: store}
	profile, err := h.acpProfile(context.Background(), "tenant", a.ID, "legacy")
	if err != nil || profile["command"] != "legacy-acp" || len(stringSlice(profile["args"])) != 1 {
		t.Fatalf("legacy profile: %#v %v", profile, err)
	}
	if err = h.saveSpaceACP(context.Background(), "tenant", s.ID, map[string]any{"agents": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	if _, err = h.acpProfile(context.Background(), "tenant", a.ID, "legacy"); err == nil {
		t.Fatal("deleted legacy profile came back from Agent config")
	}
}
