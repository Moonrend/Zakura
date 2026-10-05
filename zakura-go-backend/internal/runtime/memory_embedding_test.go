// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestMemoryEmbeddingWriteStatsAndRebuild(t *testing.T) {
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" {
			http.NotFound(w, r)
			return
		}
		calls.Add(1)
		var request map[string]any
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request["model"] != "embed-test" || request["input"] == "" {
			t.Errorf("embedding request: %#v", request)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": "embed-test", "data": []map[string]any{{"index": 0, "embedding": []float64{0.1, 0.2, 0.3}}}})
	}))
	defer provider.Close()
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	now := d.Clock()
	config, _ := json.Marshal(map[string]any{"embedding": map[string]any{"enabled": true, "baseUrl": provider.URL + "/v1", "model": "embed-test"}})
	_, err := d.DB.Exec(`INSERT INTO memory_providers(id,tenant_id,name,slug,kind,config_json,secret_json,enabled,is_default,status,created_at,updated_at) VALUES('memory','tenant','Built-in','builtin','builtin',?,'{}',true,true,'ready',?,?)`, string(config), now, now)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = d.DB.Exec(`UPDATE agents SET memory_provider_id='memory' WHERE id=?`, agent.ID)
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	code, created := doJSON(t, server.Client(), "POST", server.URL+"/api/agents/"+agent.ID+"/memory/items", token, map[string]any{"content": "remember me"})
	if code != http.StatusCreated || created["embeddingWarning"] != nil {
		t.Fatalf("create embedded memory: %d %#v", code, created)
	}
	var embedding, model, hash string
	var dimensions int
	if err = d.DB.QueryRow(`SELECT embedding,embedding_model,embedding_dim,content_hash FROM memories WHERE id=?`, created["id"]).Scan(&embedding, &model, &dimensions, &hash); err != nil || embedding != `[0.1,0.2,0.3]` || model != "embed-test" || dimensions != 3 || hash == "" {
		t.Fatalf("stored embedding: %q %q %d %q err=%v", embedding, model, dimensions, hash, err)
	}
	code, stats := doJSON(t, server.Client(), "GET", server.URL+"/api/agents/"+agent.ID+"/memory/embedding-stats", token, nil)
	if code != 200 || stats["enabled"] != true || stats["model"] != "embed-test" || stats["stats"].(map[string]any)["withEmbedding"] != float64(1) {
		t.Fatalf("embedding stats: %d %#v", code, stats)
	}
	code, _ = doJSON(t, server.Client(), "PATCH", server.URL+"/api/agents/"+agent.ID+"/memory/items/"+created["id"].(string), token, map[string]any{"content": "updated"})
	if code != 200 {
		t.Fatalf("patch memory: %d", code)
	}
	code, rebuilt := doJSON(t, server.Client(), "POST", server.URL+"/api/agents/"+agent.ID+"/memory/reembed", token, map[string]any{})
	if code != 200 || rebuilt["updated"] != float64(1) || rebuilt["failed"] != float64(0) || calls.Load() != 2 {
		t.Fatalf("reembed: %d %#v calls=%d", code, rebuilt, calls.Load())
	}
}
