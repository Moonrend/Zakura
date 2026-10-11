// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestFetchUpstreamModelListParsing(t *testing.T) {
	d := testDeps(t)
	store := NewStore(d)
	cases := []struct {
		name    string
		payload string
		want    []remoteModel
	}{
		{"array", `[{"id":"a"},{"id":"b","name":"B"}]`, []remoteModel{{ID: "a", Capability: "chat"}, {ID: "b", Name: "B", Capability: "chat"}}},
		{"data", `{"data":[{"id":"a","owned_by":"openai"}]}`, []remoteModel{{ID: "a", OwnedBy: "openai", Capability: "chat"}}},
		{"models-name", `{"models":[{"name":"models/gemini-1.5-pro"}]}`, []remoteModel{{ID: "models/gemini-1.5-pro", Capability: "chat"}}},
		{"display", `{"data":[{"id":"x","display_name":"X","owned_by":"z"}]}`, []remoteModel{{ID: "x", Name: "X", OwnedBy: "z", Capability: "chat"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, tc.payload)
			}))
			defer provider.Close()
			tenant := "tenant-" + tc.name
			seedTenant(t, d, tenant)
			up, e := store.CreateUpstream(context.Background(), tenant, Upstream{Name: "fake", Protocol: "openai", Config: json.RawMessage(`{"baseUrl":"` + provider.URL + `"}`)})
			if e != nil {
				t.Fatal(e)
			}
			h := &handler{deps: d, store: store}
			h.service = NewService(store)
			u, e := store.GetUpstream(context.Background(), tenant, up.ID)
			if e != nil {
				t.Fatal(e)
			}
			list, e := h.fetchUpstreamModelList(context.Background(), tenant, u)
			if e != nil {
				t.Fatal(e)
			}
			if len(list) != len(tc.want) {
				t.Fatalf("got %#v want %#v", list, tc.want)
			}
			for i := range tc.want {
				if list[i] != tc.want[i] {
					t.Fatalf("item %d got %#v want %#v", i, list[i], tc.want[i])
				}
			}
		})
	}
}

func TestSyncModelsRespectsSelectionAndNeverDeletes(t *testing.T) {
	d := testDeps(t)
	tok := seedTenant(t, d, "tenant-a")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("missing decrypted model credential: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{
			map[string]any{"id": "A"}, map[string]any{"id": "B"}, map[string]any{"id": "C"},
		}})
	}))
	defer provider.Close()
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	client := server.Client()
	code, out := doJSON(t, client, "POST", server.URL+"/api/model-upstreams", tok, map[string]any{"name": "fake", "protocol": "openai", "config": map[string]any{"baseUrl": provider.URL, "apiKey": "test-key"}})
	if code != 201 {
		t.Fatalf("upstream: %d %#v", code, out)
	}
	up := out["id"].(string)
	code, out = doJSON(t, client, "POST", server.URL+"/api/upstream-models", tok, map[string]any{"upstreamId": up, "nativeModel": "D"})
	if code != 201 {
		t.Fatalf("model D: %d %#v", code, out)
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/model-upstreams/"+up+"/sync-models", tok, map[string]any{"modelIds": []string{"A", "Z"}})
	if code != 200 {
		t.Fatalf("sync: %d %#v", code, out)
	}
	if out["synced"].(float64) != 1 || out["created"].(float64) != 1 || out["updated"].(float64) != 0 {
		t.Fatalf("sync counts: %#v", out)
	}
	unmatched := out["unmatchedModels"].([]any)
	if len(unmatched) != 1 || unmatched[0].(map[string]any)["nativeModel"] != "Z" {
		t.Fatalf("unmatched: %#v", out)
	}
	code, models := doJSON(t, client, "GET", server.URL+"/api/upstream-models?upstreamId="+up, tok, nil)
	if code != 200 {
		t.Fatalf("list: %d %#v", code, models)
	}
	got := map[string]bool{}
	for _, m := range models["models"].([]any) {
		got[m.(map[string]any)["nativeModel"].(string)] = true
	}
	if !got["A"] || !got["D"] || got["B"] || got["C"] {
		t.Fatalf("models after selective sync: %#v", got)
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/model-upstreams/"+up+"/sync-models", tok, nil)
	if code != 200 {
		t.Fatalf("sync all: %d %#v", code, out)
	}
	if out["synced"].(float64) != 3 {
		t.Fatalf("sync all counts: %#v", out)
	}
	code, models = doJSON(t, client, "GET", server.URL+"/api/upstream-models?upstreamId="+up, tok, nil)
	if code != 200 {
		t.Fatalf("list2: %d %#v", code, models)
	}
	got = map[string]bool{}
	for _, m := range models["models"].([]any) {
		got[m.(map[string]any)["nativeModel"].(string)] = true
	}
	if !got["A"] || !got["B"] || !got["C"] || !got["D"] {
		t.Fatalf("models after full sync (D must survive): %#v", got)
	}
}

func TestPatchUpstreamModelCheckNoDelete(t *testing.T) {
	d := testDeps(t)
	tok := seedTenant(t, d, "tenant-a")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("missing decrypted model credential: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"id": "A"}}})
	}))
	defer provider.Close()
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	client := server.Client()
	code, out := doJSON(t, client, "POST", server.URL+"/api/model-upstreams", tok, map[string]any{"name": "fake", "protocol": "openai", "config": map[string]any{"baseUrl": provider.URL, "apiKey": "test-key"}})
	if code != 201 {
		t.Fatalf("upstream: %d %#v", code, out)
	}
	up := out["id"].(string)
	code, out = doJSON(t, client, "POST", server.URL+"/api/upstream-models", tok, map[string]any{"upstreamId": up, "nativeModel": "D"})
	if code != 201 {
		t.Fatalf("model D: %d %#v", code, out)
	}
	code, out = doJSON(t, client, "PATCH", server.URL+"/api/model-upstreams/"+up, tok, map[string]any{"name": "renamed", "config": map[string]any{"baseUrl": provider.URL, "apiKey": "test-key"}})
	if code != 200 {
		t.Fatalf("patch: %d %#v", code, out)
	}
	mc, ok := out["modelCheck"].(map[string]any)
	if !ok || mc["status"] != "healthy" || mc["removed"].(float64) != 0 {
		t.Fatalf("modelCheck: %#v", out)
	}
	var status string
	if e := d.DB.QueryRow(`SELECT status FROM model_upstreams WHERE id=?`, up).Scan(&status); e != nil || status != "ready" {
		t.Fatalf("upstream status: %v %q", e, status)
	}
	code, models := doJSON(t, client, "GET", server.URL+"/api/upstream-models?upstreamId="+up, tok, nil)
	if code != 200 || len(models["models"].([]any)) != 1 {
		t.Fatalf("local model deleted: %d %#v", code, models)
	}
}

func TestPatchUpstreamCredentialMerge(t *testing.T) {
	d := testDeps(t)
	tok := seedTenant(t, d, "tenant-a")
	var mu sync.Mutex
	lastAuth := ""
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		lastAuth = r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"id": "A"}}})
	}))
	defer provider.Close()
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	client := server.Client()
	code, out := doJSON(t, client, "POST", server.URL+"/api/model-upstreams", tok, map[string]any{"name": "fake", "protocol": "openai", "config": map[string]any{"baseUrl": provider.URL, "apiKey": "old-key"}})
	if code != 201 {
		t.Fatalf("create: %d %#v", code, out)
	}
	up := out["id"].(string)
	probeAuth := func() string {
		code, models := doJSON(t, client, "GET", server.URL+"/api/model-upstreams/"+up+"/models", tok, nil)
		if code != 200 {
			t.Fatalf("models: %d %#v", code, models)
		}
		mu.Lock()
		defer mu.Unlock()
		return lastAuth
	}
	if got := probeAuth(); got != "Bearer old-key" {
		t.Fatalf("initial credential: %q", got)
	}
	// Patch without any secret key must keep the stored envelope.
	code, out = doJSON(t, client, "PATCH", server.URL+"/api/model-upstreams/"+up, tok, map[string]any{"name": "renamed", "config": map[string]any{"baseUrl": provider.URL}})
	if code != 200 {
		t.Fatalf("patch no key: %d %#v", code, out)
	}
	if got := probeAuth(); got != "Bearer old-key" {
		t.Fatalf("credential lost after no-key patch: %q", got)
	}
	// Patch with an empty apiKey must keep the stored envelope.
	code, out = doJSON(t, client, "PATCH", server.URL+"/api/model-upstreams/"+up, tok, map[string]any{"config": map[string]any{"baseUrl": provider.URL, "apiKey": ""}})
	if code != 200 {
		t.Fatalf("patch empty key: %d %#v", code, out)
	}
	if got := probeAuth(); got != "Bearer old-key" {
		t.Fatalf("credential wiped by empty key patch: %q", got)
	}
	// Patch with a new apiKey overrides the stored envelope.
	code, out = doJSON(t, client, "PATCH", server.URL+"/api/model-upstreams/"+up, tok, map[string]any{"config": map[string]any{"baseUrl": provider.URL, "apiKey": "new-key"}})
	if code != 200 {
		t.Fatalf("patch new key: %d %#v", code, out)
	}
	if got := probeAuth(); got != "Bearer new-key" {
		t.Fatalf("credential not overridden: %q", got)
	}
}

func TestGroupUpstreamModels(t *testing.T) {
	dn := func(s string) *string { return &s }
	rows := []UpstreamModel{
		{ID: "1", CanonicalModel: "gpt-4", Capability: "chat"},
		{ID: "2", CanonicalModel: "gpt-4", DisplayName: dn("GPT-4"), Capability: "chat", IsDefault: true},
		{ID: "3", CanonicalModel: "gpt-4", DisplayName: dn("Later"), Capability: "chat"},
		{ID: "4", CanonicalModel: "gpt-4", Capability: "embedding"},
		{ID: "5", CanonicalModel: "claude", DisplayName: dn("Claude"), Capability: "chat"},
		{ID: "6", CanonicalModel: "claude", Capability: "chat", IsDefault: true},
	}
	groups := groupUpstreamModels(rows)
	if len(groups) != 3 {
		t.Fatalf("groups = %d %#v", len(groups), groups)
	}
	if groups[0].CanonicalModel != "gpt-4" || groups[0].Capability != "chat" || groups[0].DisplayName != "GPT-4" || !groups[0].IsDefault || len(groups[0].Deployments) != 3 {
		t.Fatalf("g0 %#v", groups[0])
	}
	if groups[1].CanonicalModel != "gpt-4" || groups[1].Capability != "embedding" || groups[1].DisplayName != "gpt-4" || groups[1].IsDefault || len(groups[1].Deployments) != 1 {
		t.Fatalf("g1 %#v", groups[1])
	}
	if groups[2].CanonicalModel != "claude" || groups[2].Capability != "chat" || groups[2].DisplayName != "Claude" || !groups[2].IsDefault || len(groups[2].Deployments) != 2 {
		t.Fatalf("g2 %#v", groups[2])
	}
	if groups[0].Deployments[0].ID != "1" || groups[0].Deployments[2].ID != "3" {
		t.Fatalf("deployment order changed: %#v", groups[0].Deployments)
	}
}

func TestListUpstreamModelsGroupedShape(t *testing.T) {
	d := testDeps(t)
	tok := seedTenant(t, d, "tenant-a")
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	client := server.Client()
	code, out := doJSON(t, client, "POST", server.URL+"/api/model-upstreams", tok, map[string]any{"name": "fake", "protocol": "openai", "config": map[string]any{"baseUrl": "https://api.example.com/v1"}})
	if code != 201 {
		t.Fatalf("create upstream: %d %#v", code, out)
	}
	up := out["id"].(string)
	if code, out = doJSON(t, client, "POST", server.URL+"/api/upstream-models", tok, map[string]any{"upstreamId": up, "nativeModel": "A", "capability": "chat"}); code != 201 {
		t.Fatalf("model A: %d %#v", code, out)
	}
	if code, out = doJSON(t, client, "POST", server.URL+"/api/upstream-models", tok, map[string]any{"upstreamId": up, "nativeModel": "B", "canonicalModel": "bee", "displayName": "Bee", "capability": "embedding"}); code != 201 {
		t.Fatalf("model B: %d %#v", code, out)
	}
	code, flat := doJSON(t, client, "GET", server.URL+"/api/upstream-models", tok, nil)
	if code != 200 {
		t.Fatalf("flat list: %d %#v", code, flat)
	}
	flatModels := flat["models"].([]any)
	if len(flatModels) != 2 {
		t.Fatalf("flat models = %#v", flatModels)
	}
	if _, grouped := flatModels[0].(map[string]any)["deployments"]; grouped {
		t.Fatalf("flat shape must not contain deployments: %#v", flatModels[0])
	}
	code, grouped := doJSON(t, client, "GET", server.URL+"/api/upstream-models?grouped=1", tok, nil)
	if code != 200 {
		t.Fatalf("grouped list: %d %#v", code, grouped)
	}
	groups := grouped["models"].([]any)
	if len(groups) != 2 {
		t.Fatalf("grouped models = %#v", groups)
	}
	first := groups[0].(map[string]any)
	if first["canonicalModel"] != "A" || first["capability"] != "chat" || first["displayName"] != "A" {
		t.Fatalf("group0 = %#v", first)
	}
	if len(first["deployments"].([]any)) != 1 {
		t.Fatalf("group0 deployments = %#v", first["deployments"])
	}
	second := groups[1].(map[string]any)
	if second["canonicalModel"] != "bee" || second["capability"] != "embedding" || second["displayName"] != "Bee" {
		t.Fatalf("group1 = %#v", second)
	}
}
