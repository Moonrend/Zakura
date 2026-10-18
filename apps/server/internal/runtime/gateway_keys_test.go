// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/system"
	"github.com/go-chi/chi/v5"
)

func TestGatewaySpaceKeyCreationAndScopedKeyCannotMint(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Gateway", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Legacy", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	other, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Other", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	rootKey := "zak_test-root"
	hash := sha256.Sum256([]byte(rootKey))
	_, err = d.DB.Exec(`INSERT INTO api_keys(id,tenant_id,name,key_prefix,key_hash,scopes,created_at) VALUES('root','tenant','root','zak_test',?,'["*"]',?)`, hex.EncodeToString(hash[:]), d.Clock())
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	system.RegisterRoutes(router, d)
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	var scopedKey string
	for _, path := range []string{"/api/spaces/" + space.ID + "/keys", "/api/agents/" + agent.ID + "/keys"} {
		status, body := doJSON(t, server.Client(), http.MethodPost, server.URL+path, rootKey, map[string]any{"name": "gateway", "scopes": []string{"gateway"}})
		if status != http.StatusCreated || body["spaceId"] != space.ID || body["agentId"] != nil {
			t.Fatalf("create %s: %d %#v", path, status, body)
		}
		scopedKey, _ = body["rawKey"].(string)
		status, body = doJSON(t, server.Client(), http.MethodGet, server.URL+"/v1/models", scopedKey, nil)
		if status != http.StatusOK {
			t.Fatalf("Space gateway auth: %d %#v", status, body)
		}
	}
	status, body := doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/api-keys", rootKey, map[string]any{"name": "unbound", "scopes": []string{"gateway"}})
	if status != http.StatusBadRequest {
		t.Fatalf("unbound gateway key: %d %#v", status, body)
	}
	status, body = doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/spaces/"+space.ID+"/keys", rootKey, map[string]any{"name": "scoped-admin", "scopes": []string{"*"}})
	if status != http.StatusCreated {
		t.Fatalf("scoped admin: %d %#v", status, body)
	}
	adminKey, _ := body["rawKey"].(string)
	for _, path := range []string{"/api/api-keys", "/api/spaces/" + space.ID + "/keys", "/api/spaces/" + other.ID + "/keys", "/api/agents/" + agent.ID + "/keys"} {
		status, body = doJSON(t, server.Client(), http.MethodPost, server.URL+path, adminKey, map[string]any{"name": "escalated", "scopes": []string{"*"}})
		if status != http.StatusForbidden {
			t.Fatalf("scoped key minted %s: %d %#v", path, status, body)
		}
	}
	status, body = doJSON(t, server.Client(), http.MethodDelete, server.URL+"/api/api-keys/root", adminKey, nil)
	if status != http.StatusNotFound {
		t.Fatalf("scoped key revoked root: %d %#v", status, body)
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request = request.WithContext(httpx.WithPrincipal(request.Context(), httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: space.ID, APIKeyScopes: `["gateway:chat"]`}))
	w := httptest.NewRecorder()
	(&handler{deps: d, store: store}).listGatewayModels(w, request)
	if w.Code != http.StatusForbidden {
		t.Fatalf("chat-only models scope: %d", w.Code)
	}
}

func TestGatewayHTTPFaithfulErrors(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "Space", WorkspaceKind: "local"})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "2")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"expired upstream key"}}`))
	}))
	defer up.Close()
	provider, _ := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Up", Protocol: "openai", Config: raw(map[string]any{"baseUrl": up.URL})})
	_, _ = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "M", Capability: "chat", Model: "m", UpstreamID: provider.ID})
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`))
	req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: space.ID, APIKeyScopes: `["gateway"]`}))
	w := httptest.NewRecorder()
	h.gateway("chat", "messages")(w, req)
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if w.Code != http.StatusUnauthorized || body["type"] != "error" || w.Header().Get("Retry-After") != "2" || !strings.Contains(w.Body.String(), "expired upstream key") {
		t.Fatalf("code=%d headers=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
}
