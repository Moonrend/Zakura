// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/go-chi/chi/v5"
)

func seedMemorySearchHarness(t *testing.T) (*handler, *Store, Agent) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, EnableMemory: true})
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	return h, store, agent
}

func insertMemory(t *testing.T, h *handler, agentID, id, content, embedding string, dim *int) {
	t.Helper()
	now := h.deps.Clock()
	var emb any
	var embDim any
	if embedding != "" {
		emb = embedding
		if dim != nil {
			embDim = *dim
		}
	}
	_, err := h.deps.DB.Exec(`INSERT INTO memories(id,tenant_id,agent_id,layer,content,tags_json,pinned,importance,source,metadata_json,embedding,embedding_dim,created_at,updated_at) VALUES(?,?,?,'fact',?,'[]',0,'3','manual','{}',?,?,?,?)`, id, "tenant", agentID, content, emb, embDim, now, now)
	if err != nil {
		t.Fatal(err)
	}
}

func TestRunMemorySearchSemanticMerge(t *testing.T) {
	embedding := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"model": "embed-test", "data": []map[string]any{{"index": 0, "embedding": []float64{1, 0, 0}}}})
	}))
	defer embedding.Close()

	h, store, agent := seedMemorySearchHarness(t)
	up, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "embed", Protocol: "openai", Config: raw(map[string]any{"baseUrl": embedding.URL})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "embed", Capability: "embedding", UpstreamID: up.ID, Model: "embed", Priority: 100, Weight: 100, IsDefault: true}); err != nil {
		t.Fatal(err)
	}
	now := h.deps.Clock()
	config, _ := json.Marshal(map[string]any{"embedding": map[string]any{"enabled": true, "routeSlug": "embed", "model": "embed-test"}})
	if _, err = h.deps.DB.Exec(`INSERT INTO memory_providers(id,tenant_id,name,slug,kind,config_json,secret_json,enabled,is_default,status,created_at,updated_at) VALUES('memory','tenant','Built-in','builtin','builtin',?,'{}',true,true,'ready',?,?)`, string(config), now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = h.deps.DB.Exec(`UPDATE agents SET memory_provider_id='memory' WHERE id=?`, agent.ID); err != nil {
		t.Fatal(err)
	}
	dim := 3
	insertMemory(t, h, agent.ID, "same", "bananas are yellow", `[1,0,0]`, &dim)
	insertMemory(t, h, agent.ID, "orthogonal", "carrots are orange", `[0,1,0]`, &dim)
	insertMemory(t, h, agent.ID, "opposite", "grapes are purple", `[-1,0,0]`, &dim)
	insertMemory(t, h, agent.ID, "like", "apple pie recipe", "", nil)

	searchRaw, searchErr := h.runBuiltinTool(context.Background(), "tenant", agent.ID, "memory_search", raw(map[string]any{"query": "apple"}))
	out := decodeBuiltinResult(t, searchRaw, searchErr)
	results, _ := out["results"].([]any)
	if len(results) != 2 {
		t.Fatalf("merged results: %#v", out)
	}
	first, _ := results[0].(map[string]any)
	if first["id"] != "same" {
		t.Fatalf("semantic hit should rank first: %#v", results)
	}
	score, ok := first["score"].(float64)
	if !ok || score <= 0.9 {
		t.Fatalf("semantic score: %#v", first)
	}
	likeEntry, _ := results[1].(map[string]any)
	if likeEntry["id"] != "like" {
		t.Fatalf("like hit should follow: %#v", results)
	}
	if _, hasScore := likeEntry["score"]; hasScore {
		t.Fatalf("like hit should not carry score: %#v", likeEntry)
	}
	for _, raw := range results {
		entry := raw.(map[string]any)
		if entry["id"] == "orthogonal" || entry["id"] == "opposite" {
			t.Fatalf("below-threshold hit leaked: %#v", results)
		}
	}
}

func TestRunMemorySearchWithoutEmbedding(t *testing.T) {
	h, _, agent := seedMemorySearchHarness(t)
	insertMemory(t, h, agent.ID, "like", "apple pie recipe", "", nil)
	searchRaw, searchErr := h.runBuiltinTool(context.Background(), "tenant", agent.ID, "memory_search", raw(map[string]any{"query": "apple"}))
	out := decodeBuiltinResult(t, searchRaw, searchErr)
	results, _ := out["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("like-only results: %#v", out)
	}
	entry, _ := results[0].(map[string]any)
	if entry["id"] != "like" {
		t.Fatalf("like hit: %#v", results)
	}
	if _, hasScore := entry["score"]; hasScore {
		t.Fatalf("like-only hit should not carry score: %#v", entry)
	}
}

func TestMemorySearchTrigramSkipsNonPostgres(t *testing.T) {
	h, _, agent := seedMemorySearchHarness(t)
	if got := h.deps.Gorm.Dialector.Name(); got != "sqlite" {
		t.Fatalf("expected sqlite test deps, got %q", got)
	}
	hits, err := h.memorySearchTrigram(context.Background(), "tenant", agent.ID, "apple pie", 5)
	if err != nil || hits != nil {
		t.Fatalf("non-postgres trigram search: hits=%v err=%v", hits, err)
	}
}

func testPostgresDeps(t *testing.T) *appdeps.Dependencies {
	t.Helper()
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_URL is not set")
	}
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.DB.Close() })
	if conn.Dialect != "postgres" {
		t.Fatalf("expected postgres dialect, got %q", conn.Dialect)
	}
	if _, err = conn.DB.ExecContext(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatalf("reset disposable PostgreSQL database: %v", err)
	}
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("apply PostgreSQL migrations: %v", err)
	}
	gdb, err := conn.Gorm()
	if err != nil {
		t.Fatal(err)
	}
	return &appdeps.Dependencies{DB: conn.DB, Gorm: gdb, Dialect: conn.Dialect, Rebind: conn.Rebind, Clock: func() time.Time { return time.Now().UTC() }, NewID: func() string { return "pg-id" }}
}

func TestMemorySearchTrigramPostgres(t *testing.T) {
	d := testPostgresDeps(t)
	ctx := context.Background()
	now := d.Clock().Format(time.RFC3339Nano)
	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := d.DB.ExecContext(ctx, d.Rebind(statement), args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES(?,?,?,?,?)`, "tenant", "tenant", "Tenant", now, now)
	exec(`INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,?)`, "space", "tenant", "Space", "space", now, now)
	exec(`INSERT INTO agents(id,tenant_id,space_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, "agent", "tenant", "space", "Agent", "agent", now, now)
	insert := func(id, content string) {
		exec(`INSERT INTO memories(id,tenant_id,agent_id,layer,content,tags_json,pinned,importance,source,metadata_json,created_at,updated_at) VALUES(?,?,?,'fact',?,'[]',0,'3','manual','{}',?,?)`, id, "tenant", "agent", content, now, now)
	}
	insert("close", "apple pie recipe")
	insert("far", "carrots are orange")
	h := &handler{deps: d}
	hits, err := h.memorySearchTrigram(ctx, "tenant", "agent", "apple pie recipe", 10)
	if err != nil {
		t.Fatalf("trigram search: %v", err)
	}
	if len(hits) != 1 || hits[0].Memory.ID != "close" {
		t.Fatalf("trigram hits: %#v", hits)
	}
	if !hits[0].Semantic || hits[0].Score <= 0.2 || hits[0].Score > 1 {
		t.Fatalf("trigram score/semantic: %#v", hits[0])
	}
}

func TestMemorySearchTrigramProbeFailureCached(t *testing.T) {
	d := testPostgresDeps(t)
	ctx := context.Background()
	if _, err := d.DB.ExecContext(ctx, `DROP EXTENSION IF EXISTS pg_trgm`); err != nil {
		t.Skipf("cannot drop pg_trgm: %v", err)
	}
	h := &handler{deps: d}
	hits, err := h.memorySearchTrigram(ctx, "tenant", "agent", "apple", 5)
	if err != nil || hits != nil {
		t.Fatalf("probe failure should return nil,nil: hits=%v err=%v", hits, err)
	}
	h.trigramMu.Lock()
	state := h.trigramStates["tenant/agent"]
	h.trigramMu.Unlock()
	if state != "no" {
		t.Fatalf("probe failure should cache no, got %q", state)
	}
}

func TestComposerDesktopGroupIncludesComputerKey(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Space", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	code, body := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agents/"+agent.ID+"/cloud/composer", token, nil)
	if code != http.StatusOK {
		t.Fatalf("composer: %d %#v", code, body)
	}
	groups, _ := body["groups"].([]any)
	found := false
	for _, raw := range groups {
		group := raw.(map[string]any)
		if group["id"] != "builtin:desktop" {
			continue
		}
		found = true
		tools, _ := group["tools"].([]any)
		hasKey := false
		for _, tool := range tools {
			if tool == "computer_key" {
				hasKey = true
			}
		}
		if !hasKey {
			t.Fatalf("desktop group missing computer_key: %#v", group)
		}
	}
	if !found {
		t.Fatalf("desktop group missing: %#v", groups)
	}
}
