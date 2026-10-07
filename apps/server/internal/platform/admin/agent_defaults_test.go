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
