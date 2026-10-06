// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/rediscache"
	"github.com/alicebob/miniredis/v2"
)

func newCountingMCPTools(calls *atomic.Int64) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		if method, _ := req["method"].(string); method == "tools/list" {
			calls.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": map[string]any{"tools": []any{
				map[string]any{"name": "search_issues", "description": "Search issues by query.", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string", "description": "Search text."}}, "required": []any{"query"}}},
			}}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": map[string]any{}})
	}))
}

func TestCachedAgentToolCatalogRedisShared(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer mr.Close()
	d.Redis = rediscache.Open(context.Background(), "redis://"+mr.Addr())
	if !d.Redis.Enabled() {
		t.Fatal("cache not enabled")
	}
	var calls atomic.Int64
	server := newCountingMCPTools(&calls)
	defer server.Close()
	insertMCPInstance(t, d, "mcp-count", "tenant", nil, "gh", "GitHub", map[string]any{"url": server.URL})
	insertMCPBinding(t, d, "bind-count", "tenant", space.ID, "mcp-count")
	first := &handler{deps: d, store: store}
	first.service = NewService(store)
	if _, err := first.cachedAgentToolCatalog(context.Background(), "tenant", agent.ID); err != nil {
		t.Fatal(err)
	}
	second := &handler{deps: d, store: store}
	second.service = NewService(store)
	catalog, err := second.cachedAgentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected a single tools/list build, got %d", calls.Load())
	}
	byName := catalogByName(catalog)
	if tool, ok := byName["mcp__gh__search_issues"]; !ok || tool.Description != "Search issues by query." {
		t.Fatalf("redis catalog lost tool data: %+v", catalog.Tools)
	}
	if tool := byName["mcp__gh__search_issues"]; tool.InputSchema["type"] != "object" {
		t.Fatalf("redis catalog lost input schema: %#v", tool.InputSchema)
	}
}

func TestCachedAgentToolCatalogRedisDownFallsBack(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	d.Redis = rediscache.Open(context.Background(), "redis://"+mr.Addr())
	mr.Close()
	var calls atomic.Int64
	server := newCountingMCPTools(&calls)
	defer server.Close()
	insertMCPInstance(t, d, "mcp-down", "tenant", nil, "gh", "GitHub", map[string]any{"url": server.URL})
	insertMCPBinding(t, d, "bind-down", "tenant", space.ID, "mcp-down")
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	catalog, err := h.cachedAgentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected db build despite redis outage, got %d", calls.Load())
	}
	if _, ok := catalogByName(catalog)["mcp__gh__search_issues"]; !ok {
		t.Fatalf("missing tool after redis outage: %v", catalog.Tools)
	}
}

func TestSessionLoadedToolsInvalidation(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	session, err := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer mr.Close()
	d.Redis = rediscache.Open(context.Background(), "redis://"+mr.Addr())
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	ctx := context.Background()
	if loaded := h.sessionLoadedTools(ctx, "tenant", agent.ID, session.ID); len(loaded) != 0 {
		t.Fatalf("expected empty loaded set, got %v", loaded)
	}
	if err := h.persistSessionLoadedTools(ctx, "tenant", agent.ID, session.ID, []string{"mcp__gh__search_issues"}); err != nil {
		t.Fatal(err)
	}
	loaded := h.sessionLoadedTools(ctx, "tenant", agent.ID, session.ID)
	if !loaded["mcp__gh__search_issues"] {
		t.Fatalf("invalidation failed, loaded = %v", loaded)
	}
}
