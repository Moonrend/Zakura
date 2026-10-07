package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestComputerSelectionHTTP(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	ctx := context.Background()
	space, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "S"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	chat, err := h.store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,settings_json,secret_ref,created_at,updated_at) VALUES('one','tenant',?,'One','e2b','{"apiKey":"secret-value"}','secret-ref','now','now')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	h.registerComputers(router)
	call := func(method, path, body string, p httpx.Principal) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	p := httpx.Principal{TenantID: "tenant"}
	path := "/agents/" + agent.ID + "/cloud/sessions/" + chat.ID + "/computer"
	for _, body := range []string{`{}`, `{"computerId":""}`, `{"computerId":42}`} {
		if w := call(http.MethodPut, path, body, p); w.Code != 400 {
			t.Fatalf("invalid %s: %d %s", body, w.Code, w.Body)
		}
	}
	if w := call(http.MethodPut, path, `{"computerId":"missing"}`, p); w.Code != 404 {
		t.Fatalf("missing: %d %s", w.Code, w.Body)
	}
	for _, body := range []string{`{"computerId":"one"}`, `{"computerId":null}`} {
		if w := call(http.MethodPut, path, body, p); w.Code != 200 {
			t.Fatalf("selection: %d %s", w.Code, w.Body)
		}
		if w := call(http.MethodGet, path, "", p); w.Code != 200 || strings.TrimSpace(w.Body.String()) != body {
			t.Fatalf("read selection: %d %s", w.Code, w.Body)
		}
	}
	w := call(http.MethodGet, "/spaces/"+space.ID+"/computers", "", p)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"id":"one"`) || strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "apiKey") {
		t.Fatalf("catalog: %d %s", w.Code, w.Body)
	}
	bound := httpx.Principal{TenantID: "tenant", SpaceID: space.ID, AgentID: agent.ID}
	if w := call(http.MethodGet, path+"s", "", bound); w.Code != 200 || !strings.Contains(w.Body.String(), `"id":"one"`) || strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "apiKey") {
		t.Fatalf("bound session catalog: %d %s", w.Code, w.Body)
	}
	if w := call(http.MethodGet, "/spaces/"+space.ID+"/computers", "", bound); w.Code != 403 {
		t.Fatalf("agent credential escaped session catalog: %d", w.Code)
	}
	if w := call(http.MethodGet, "/agents/"+agent.ID+"/cloud/sessions/missing/computers", "", bound); w.Code != 404 {
		t.Fatalf("missing session catalog: %d %s", w.Code, w.Body)
	}
	for _, p := range []httpx.Principal{{TenantID: "tenant", SpaceID: "foreign"}, {TenantID: "tenant", AgentID: "foreign"}} {
		if w := call(http.MethodGet, path+"s", "", p); w.Code != 403 {
			t.Fatalf("catalog scope bypass: %d", w.Code)
		}
		if w := call(http.MethodPut, path, `{"computerId":"one"}`, p); w.Code != 403 {
			t.Fatalf("scope bypass: %d", w.Code)
		}
	}
	if w := call(http.MethodGet, path+"s", "", httpx.Principal{TenantID: "other"}); w.Code == 200 {
		t.Fatal("cross-tenant catalog leak")
	}
	if w := call(http.MethodGet, path, "", httpx.Principal{TenantID: "other"}); w.Code == 200 {
		t.Fatal("cross-tenant selection leak")
	}
}

func TestComputerManagementHTTP(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "S"})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	h.registerComputers(router)
	path := "/spaces/" + space.ID + "/computers"
	call := func(method, path, body string, p httpx.Principal) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	body := `{"name":"E2B","provider":"e2b","config":{"apiKey":"private-key-value","template":"base"}}`
	for _, p := range []httpx.Principal{{TenantID: "tenant"}, {TenantID: "tenant", Role: "admin", SpaceID: "other"}, {TenantID: "tenant", Role: "admin", APIKey: true, APIKeyScopes: `["api"]`}} {
		if w := call("POST", path, body, p); w.Code != 403 {
			t.Fatalf("management bypass: %d %s", w.Code, w.Body)
		}
	}
	p := httpx.Principal{TenantID: "tenant", Role: "owner"}
	for range 2 {
		w := call("POST", path, body, p)
		if w.Code != 201 || strings.Contains(w.Body.String(), "private-key-value") {
			t.Fatalf("create: %d %s", w.Code, w.Body)
		}
	}
	var ciphertext, computerID string
	if err := d.DB.QueryRow(`SELECT secret_ref,id FROM computers WHERE space_id=? LIMIT 1`, space.ID).Scan(&ciphertext, &computerID); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(ciphertext, "private-key-value") {
		t.Fatal("plaintext credential stored")
	}
	plain, err := computers.OpenCredentials(d.Secret, "tenant", space.ID, computerID, ciphertext)
	if err != nil || !strings.Contains(string(plain), "private-key-value") {
		t.Fatalf("credential roundtrip: %v", err)
	}
	var count int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM computer_runtimes`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("configuration provisioned runtime %d %v", count, err)
	}
	if w := call("POST", path, `{"name":"bad","provider":"e2b","config":{}}`, p); w.Code != 400 {
		t.Fatalf("missing credential: %d", w.Code)
	}
}
