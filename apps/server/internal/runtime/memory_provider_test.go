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

func TestMemoryProviderFrontendContractAndSecretProtection(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	h.service = NewService(h.store)
	principal := httpx.Principal{TenantID: "tenant", UserID: "owner", Role: "owner"}
	request := httptest.NewRequest(http.MethodPost, "/api/memory-providers", strings.NewReader(`{"name":"Remote","kind":"mem0","config":{"baseUrl":"https://memory.example","apiKey":"top-secret"},"isDefault":true}`))
	request = request.WithContext(httpx.WithPrincipal(request.Context(), principal))
	response := httptest.NewRecorder()
	h.createMemoryProvider(response, request)
	var created map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &created)
	if response.Code != http.StatusCreated || created["id"] == nil || created["provider"] != nil || created["config"].(map[string]any)["apiKey"] != "***" {
		t.Fatalf("create provider contract: %d %#v", response.Code, created)
	}
	id := created["id"].(string)
	var stored string
	if err := d.DB.QueryRow(`SELECT config_json FROM memory_providers WHERE id=?`, id).Scan(&stored); err != nil || strings.Contains(stored, "top-secret") || !strings.Contains(stored, "apiKeyEnc") {
		t.Fatalf("provider secret storage: %s err=%v", stored, err)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/memory-providers", nil)
	request = request.WithContext(httpx.WithPrincipal(request.Context(), principal))
	response = httptest.NewRecorder()
	h.listMemoryProviders(response, request)
	var listed map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &listed)
	if response.Code != 200 || len(listed["providers"].([]any)) != 1 || listed["agents"] == nil || len(listed["kinds"].([]any)) != 4 {
		t.Fatalf("list provider contract: %d %#v", response.Code, listed)
	}

	route := chi.NewRouteContext()
	route.URLParams.Add("id", id)
	request = httptest.NewRequest(http.MethodPatch, "/api/memory-providers/"+id, strings.NewReader(`{"name":"Remote 2","config":{"apiKey":"***"}}`))
	request = request.WithContext(contextWithRoutePrincipal(request.Context(), route, principal))
	response = httptest.NewRecorder()
	h.patchMemoryProvider(response, request)
	var updated map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &updated)
	if response.Code != 200 || updated["name"] != "Remote 2" || updated["provider"] != nil {
		t.Fatalf("patch provider contract: %d %#v", response.Code, updated)
	}
	var preserved string
	_ = d.DB.QueryRow(`SELECT config_json FROM memory_providers WHERE id=?`, id).Scan(&preserved)
	if preserved != stored {
		var before, after map[string]any
		_ = json.Unmarshal([]byte(stored), &before)
		_ = json.Unmarshal([]byte(preserved), &after)
		if before["apiKeyEnc"] != after["apiKeyEnc"] {
			t.Fatalf("masked secret was not preserved: before=%s after=%s", stored, preserved)
		}
	}
}

func contextWithRoutePrincipal(parent context.Context, route *chi.Context, principal httpx.Principal) context.Context {
	return context.WithValue(httpx.WithPrincipal(parent, principal), chi.RouteCtxKey, route)
}
