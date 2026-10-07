// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
