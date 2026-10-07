package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

func TestStaleACPSavePreservesCurrentExecutionPolicy(t *testing.T) {
	for _, initial := range []string{`{}`, `{"executionMode":"host"}`} {
		t.Run(initial, func(t *testing.T) {
			h, agentID := newWebHandlerWithConfig(t, initial)
			original, config, err := h.agentConfig(context.Background(), "tenant", agentID)
			if err != nil {
				t.Fatal(err)
			}
			config["acp"] = map[string]any{"profiles": map[string]any{"example": map[string]any{"name": "Example"}}}
			if _, err := h.store.UpdateAgent(context.Background(), "tenant", agentID, map[string]any{"config": map[string]any{"executionMode": "sandbox", "cloud": map[string]any{"model": "newer"}}}); err != nil {
				t.Fatal(err)
			}
			if err := h.saveAgentConfig(context.Background(), "tenant", original, config); err != nil {
				t.Fatal(err)
			}
			_, saved, err := h.agentConfig(context.Background(), "tenant", agentID)
			if err != nil || saved["executionMode"] != "sandbox" || saved["cloud"].(map[string]any)["model"] != "newer" || saved["acp"] == nil {
				t.Fatalf("stale save changed unrelated settings: %#v err=%v", saved, err)
			}
		})
	}
}

func TestPublicAgentConfigReplacementCanChangeExecutionPolicy(t *testing.T) {
	h, agentID := newWebHandlerWithConfig(t, `{"executionMode":"sandbox","old":true}`)
	for _, config := range []map[string]any{{"executionMode": "host"}, {"executionMode": "sandbox"}, {}} {
		if _, err := h.store.UpdateAgent(context.Background(), "tenant", agentID, map[string]any{"config": config}); err != nil {
			t.Fatal(err)
		}
		a, err := h.store.GetAgent(context.Background(), "tenant", agentID)
		if err != nil {
			t.Fatal(err)
		}
		want, _ := json.Marshal(config)
		if string(a.Config) != string(want) {
			t.Fatalf("public replacement changed: got=%s want=%s", a.Config, want)
		}
	}
}

func TestConfigRoutesRetryWithoutLosingExecutionPolicy(t *testing.T) {
	for _, kind := range []string{"cloud", "providers"} {
		t.Run(kind, func(t *testing.T) {
			h, agentID := newWebHandlerWithConfig(t, `{"executionMode":"host","cloud":{"model":"old","remove":"old"},"providers":{"webFetch":{"enabled":false}}}`)
			var raced atomic.Bool
			callback := "test:agent-policy-race"
			if err := h.deps.Gorm.Callback().Query().After("gorm:query").Register(callback, func(tx *gorm.DB) {
				if tx.Statement.Table != "agents" || len(tx.Statement.Selects) != 1 || tx.Statement.Selects[0] != "config_json" || raced.Swap(true) {
					return
				}
				_, err := h.deps.DB.Exec(`UPDATE agents SET config_json=? WHERE id=?`, `{"executionMode":"sandbox","cloud":{"model":"newer","remove":"old"},"providers":{"webFetch":{"enabled":true}}}`, agentID)
				if err != nil {
					t.Errorf("concurrent save: %v", err)
				}
			}); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = h.deps.Gorm.Callback().Query().Remove(callback) })
			body := `{"systemPrompt":"hello","remove":null}`
			method := h.updateCloudConfig
			if kind == "providers" {
				body = `{"webSearch":{"enabled":true},"enableMemory":false}`
				method = h.putAgentProviders
			}
			request := httptest.NewRequest(http.MethodPut, "/api/agents/"+agentID+"/"+kind, strings.NewReader(body))
			route := chi.NewRouteContext()
			route.URLParams.Add("id", agentID)
			ctx := context.WithValue(request.Context(), chi.RouteCtxKey, route)
			request = request.WithContext(httpx.WithPrincipal(ctx, httpx.Principal{TenantID: "tenant"}))
			response := httptest.NewRecorder()
			method(response, request)
			if response.Code != http.StatusOK || !raced.Load() {
				t.Fatalf("route failed: %d %s raced=%v", response.Code, response.Body.String(), raced.Load())
			}
			a, config, err := h.agentConfig(context.Background(), "tenant", agentID)
			if err != nil || config["executionMode"] != "sandbox" {
				t.Fatalf("policy changed: %#v err=%v", config, err)
			}
			cloud := config["cloud"].(map[string]any)
			providers := config["providers"].(map[string]any)
			if cloud["model"] != "newer" || providers["webFetch"].(map[string]any)["enabled"] != true {
				t.Fatalf("unrelated settings changed: %#v", config)
			}
			if kind == "cloud" {
				if cloud["systemPrompt"] != "hello" || cloud["remove"] != nil {
					t.Fatalf("cloud patch not applied: %#v", cloud)
				}
			} else if providers["webSearch"].(map[string]any)["enabled"] != true || a.EnableMemory {
				t.Fatalf("provider patch not applied: %#v memory=%v", providers, a.EnableMemory)
			}
		})
	}
}
