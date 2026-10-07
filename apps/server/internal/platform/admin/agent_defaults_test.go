package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

func TestApplyAgentDefaultsPreservesConcurrentExecutionPolicy(t *testing.T) {
	a := infraTestRoutes(t)
	for _, statement := range []string{
		`INSERT INTO users(id,email,created_at,updated_at) VALUES('user','user@example.test','now','now')`,
		`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES('tenant','tenant','Tenant','now','now')`,
		`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,created_at,updated_at) VALUES('membership','tenant','user','owner','now','now')`,
		`INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES('space','tenant','Space','space','now','now')`,
		`INSERT INTO agents(id,tenant_id,space_id,name,slug,config_json,created_at,updated_at) VALUES('agent','tenant','space','Agent','agent','{"executionMode":"host"}','now','now')`,
	} {
		if _, err := a.d.DB.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	var raced atomic.Bool
	callback := "test:default-policy-race"
	if err := a.d.Gorm.Callback().Query().After("gorm:query").Register(callback, func(tx *gorm.DB) {
		if tx.Statement.Table != "agents" || len(tx.Statement.Selects) != 1 || tx.Statement.Selects[0] != "config_json" || raced.Swap(true) {
			return
		}
		_, err := a.d.DB.Exec(`UPDATE agents SET config_json=? WHERE id='agent'`, `{"executionMode":"sandbox","cloud":{"model":"newer"},"providers":{"webSearch":{"defaultEngine":"auto"}}}`)
		if err != nil {
			t.Errorf("concurrent save: %v", err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.d.Gorm.Callback().Query().Remove(callback) })
	request := httptest.NewRequest(http.MethodPost, "/api/admin/users/user/agent-defaults/apply", nil)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", "user")
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
	response := httptest.NewRecorder()
	a.applyAgentDefaults(response, request)
	if response.Code != http.StatusOK || !raced.Load() {
		t.Fatalf("defaults failed: %d %s raced=%v", response.Code, response.Body.String(), raced.Load())
	}
	var stored string
	if err := a.d.DB.QueryRow(`SELECT config_json FROM agents WHERE id='agent'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(stored), &config); err != nil {
		t.Fatal(err)
	}
	if config["executionMode"] != "sandbox" || config["cloud"].(map[string]any)["model"] != "newer" {
		t.Fatalf("unrelated settings overwritten: %s", stored)
	}
	providers := config["providers"].(map[string]any)
	search := providers["webSearch"].(map[string]any)
	if search["enabled"] != true || search["defaultEngine"] != "auto" || providers["webFetch"].(map[string]any)["enabled"] != true {
		t.Fatalf("defaults changed provider settings: %s", stored)
	}
	response = httptest.NewRecorder()
	a.applyAgentDefaults(response, request)
	var result map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &result)
	if response.Code != http.StatusOK || result["updated"] != float64(0) {
		t.Fatalf("repeated defaults should be a no-op: %d %s", response.Code, response.Body.String())
	}
}

func TestAgentDefaultsGetDefaultShape(t *testing.T) {
	a := infraTestRoutes(t)
	response := infraCall(t, a.agentDefaults, http.MethodGet, "")
	if response.Code != http.StatusOK {
		t.Fatalf("get: %d %s", response.Code, response.Body.String())
	}
	body := infraDecode(t, response)
	if body["webSearchEnabled"] != true || body["webFetchEnabled"] != true {
		t.Fatalf("defaults should be enabled: %v", body)
	}
	if body["searchEngine"] != nil || body["fetchBackend"] != nil {
		t.Fatalf("defaults should be null: %v", body)
	}
	services, ok := body["autoManagedServices"].([]any)
	if !ok || len(services) != 0 {
		t.Fatalf("autoManagedServices should be empty: %v", body)
	}
}

func TestAgentDefaultsPutMergeAndNormalize(t *testing.T) {
	a := infraTestRoutes(t)
	first := infraCall(t, a.putAgentDefaults, http.MethodPut, `{"searchEngine":"searxng","autoManagedServices":["firecrawl","crawl4ai","searxng"]}`)
	if first.Code != http.StatusOK {
		t.Fatalf("put: %d %s", first.Code, first.Body.String())
	}
	body := infraDecode(t, first)
	if body["webSearchEnabled"] != true || body["webFetchEnabled"] != true || body["searchEngine"] != "searxng" {
		t.Fatalf("first put body: %v", body)
	}
	services := body["autoManagedServices"].([]any)
	if len(services) != 2 || services[0] != "firecrawl" || services[1] != "searxng" {
		t.Fatalf("normalized services: %v", services)
	}
	second := infraCall(t, a.putAgentDefaults, http.MethodPut, `{"webFetchEnabled":false}`)
	body = infraDecode(t, second)
	if body["webSearchEnabled"] != true || body["webFetchEnabled"] != false || body["searchEngine"] != "searxng" {
		t.Fatalf("merge should keep previous values: %v", body)
	}
	if fetched := body["autoManagedServices"].([]any); len(fetched) != 2 || fetched[0] != "firecrawl" {
		t.Fatalf("merge should keep services: %v", body)
	}
	third := infraCall(t, a.putAgentDefaults, http.MethodPut, `{"searchEngine":null}`)
	body = infraDecode(t, third)
	if body["searchEngine"] != nil {
		t.Fatalf("null should clear searchEngine: %v", body)
	}
	invalid := infraCall(t, a.putAgentDefaults, http.MethodPut, `[1,2]`)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("non-object body should be rejected: %d %s", invalid.Code, invalid.Body.String())
	}
	if broken := infraCall(t, a.putAgentDefaults, http.MethodPut, `not json`); broken.Code != http.StatusBadRequest {
		t.Fatalf("invalid json should be rejected: %d %s", broken.Code, broken.Body.String())
	}
}

func TestAgentDefaultsLegacyMigration(t *testing.T) {
	a := infraTestRoutes(t)
	if _, err := a.d.DB.Exec(`INSERT INTO settings(id,owner_key,key,value) VALUES('legacy','platform','agent_defaults',?)`,
		`{"webSearchEnabled":false,"searchEngine":"searxng","autoManagedServices":["firecrawl","crawl4ai","searxng"]}`); err != nil {
		t.Fatal(err)
	}
	response := infraCall(t, a.agentDefaults, http.MethodGet, "")
	if response.Code != http.StatusOK {
		t.Fatalf("get: %d %s", response.Code, response.Body.String())
	}
	body := infraDecode(t, response)
	if body["webSearchEnabled"] != false || body["searchEngine"] != "searxng" {
		t.Fatalf("legacy value not migrated: %v", body)
	}
	if services := body["autoManagedServices"].([]any); len(services) != 2 || services[0] != "firecrawl" || services[1] != "searxng" {
		t.Fatalf("legacy services not normalized: %v", services)
	}
	var migrated, legacy int
	if err := a.d.DB.QueryRow(`SELECT COUNT(*) FROM settings WHERE key='agents.web-defaults' AND owner_key='platform'`).Scan(&migrated); err != nil {
		t.Fatal(err)
	}
	if err := a.d.DB.QueryRow(`SELECT COUNT(*) FROM settings WHERE key='agent_defaults' AND owner_key='platform'`).Scan(&legacy); err != nil {
		t.Fatal(err)
	}
	if migrated != 1 || legacy != 0 {
		t.Fatalf("migration state: migrated=%d legacy=%d", migrated, legacy)
	}
	stored, found, err := a.readAgentWebDefaultsRow(context.Background(), agentWebDefaultsKey)
	if err != nil || !found || stored.WebSearchEnabled {
		t.Fatalf("migrated value not persisted: %+v found=%v err=%v", stored, found, err)
	}
}

func TestAgentDefaultsSyncManagedServices(t *testing.T) {
	a := infraTestRoutes(t)
	if _, err := a.d.DB.Exec(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES('tenant','tenant','Tenant','now','now')`); err != nil {
		t.Fatal(err)
	}
	if _, err := a.d.DB.Exec(`INSERT INTO platform_services(id,service_key,mode,created_at,updated_at) VALUES('ps','searxng','external','now','now')`); err != nil {
		t.Fatal(err)
	}
	response := infraCall(t, a.putAgentDefaults, http.MethodPut, `{"autoManagedServices":["searxng"]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("put: %d %s", response.Code, response.Body.String())
	}
	var sealed string
	if err := a.d.DB.QueryRow(`SELECT value FROM settings WHERE owner_key='tenant:tenant' AND key='web-search'`).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	plain, err := openAdmin(a.d.Secret, sealed)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(plain), &config); err != nil {
		t.Fatal(err)
	}
	if config["defaultEngine"] != "searxng" {
		t.Fatalf("defaultEngine not seeded: %v", config)
	}
	engines, _ := config["engines"].(map[string]any)
	entry, _ := engines["searxng"].(map[string]any)
	if entry["enabled"] != true {
		t.Fatalf("searxng engine not enabled: %v", config)
	}
}
