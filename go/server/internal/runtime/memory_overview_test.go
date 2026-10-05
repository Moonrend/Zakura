// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestMemoryOverviewUsesIntegerPinnedStorage(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Space"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Agent", SpaceID: space.ID, EnableMemory: true})
	if err != nil {
		t.Fatal(err)
	}
	pinned, err := store.CreateMemory(context.Background(), "tenant", agent.ID, Memory{Layer: "fact", Content: "pinned", Pinned: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateMemory(context.Background(), "tenant", agent.ID, Memory{Layer: "fact", Content: "ordinary"}); err != nil {
		t.Fatal(err)
	}
	var stored int
	if err = d.DB.QueryRow(`SELECT pinned FROM memories WHERE id=?`, pinned.ID).Scan(&stored); err != nil || stored != 1 {
		t.Fatalf("integer pinned storage: %d %v", stored, err)
	}
	items, err := store.ListMemories(context.Background(), "tenant", agent.ID, "", "", 100)
	if err != nil || len(items) != 2 || !items[0].Pinned {
		t.Fatalf("integer pinned scan: %#v %v", items, err)
	}

	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	code, body := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agents/"+agent.ID+"/memory", token, nil)
	stats, _ := body["stats"].(map[string]any)
	byLayer, _ := stats["byLayer"].(map[string]any)
	if code != http.StatusOK || stats["total"] != float64(2) || stats["pinned"] != float64(1) || byLayer["fact"] != float64(2) {
		t.Fatalf("memory overview stats: %d %#v", code, body)
	}

	code, patched := doJSON(t, server.Client(), http.MethodPatch, server.URL+"/api/agents/"+agent.ID+"/memory/items/"+pinned.ID, token, map[string]any{"pinned": false})
	if code != http.StatusOK || patched["pinned"] != false {
		t.Fatalf("patch integer pinned: %d %#v", code, patched)
	}
	if err = d.DB.QueryRow(`SELECT pinned FROM memories WHERE id=?`, pinned.ID).Scan(&stored); err != nil || stored != 0 {
		t.Fatalf("patched integer pinned storage: %d %v", stored, err)
	}
}
