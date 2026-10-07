// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"testing"
)

func setPlatformAgentWebDefaults(t *testing.T, h *handler, value string) {
	t.Helper()
	if _, err := h.deps.DB.Exec(`INSERT INTO settings(id,owner_key,key,value) VALUES('platform-web-defaults','platform','agents.web-defaults',?)`, value); err != nil {
		t.Fatal(err)
	}
}

func insertPlatformServiceEndpoint(t *testing.T, h *handler, key, endpoint string) {
	t.Helper()
	if _, err := h.deps.DB.Exec(`INSERT INTO platform_services(id,service_key,mode,endpoint_url,created_at,updated_at) VALUES(?,?,?,?,?,?)`, "ps-"+key, key, "external", endpoint, "now", "now"); err != nil {
		t.Fatal(err)
	}
}

func TestPlatformWebDefaultsDisableWebTools(t *testing.T) {
	h, agentID := newWebHandler(t)
	setPlatformAgentWebDefaults(t, h, `{"webSearchEnabled":false,"webFetchEnabled":false}`)
	if _, err := h.webSearchConfig(context.Background(), "tenant", agentID); err == nil || err.Error() != "web search is disabled for this agent" {
		t.Fatalf("expected disabled search, got %v", err)
	}
	if _, err := h.webFetchConfig(context.Background(), "tenant", agentID); err == nil || err.Error() != "web fetch is disabled for this agent" {
		t.Fatalf("expected disabled fetch, got %v", err)
	}
	names := catalogToolNames(t, h, agentID)
	if names["web_search"] || names["web_fetch"] {
		t.Fatalf("platform-disabled web tools should be hidden: %#v", names)
	}
}

func TestAgentExplicitEnabledOverridesPlatformDisabled(t *testing.T) {
	h, agentID := newWebHandlerWithConfig(t, `{"providers":{"webSearch":{"enabled":true}}}`)
	setPlatformAgentWebDefaults(t, h, `{"webSearchEnabled":false}`)
	if _, err := h.webSearchConfig(context.Background(), "tenant", agentID); err == nil || err.Error() != "web search is not configured" {
		t.Fatalf("agent override should re-enable search: %v", err)
	}
}

func TestPlatformDefaultEngineFallback(t *testing.T) {
	h, agentID := newWebHandler(t)
	if err := h.putSetting(context.Background(), "tenant:tenant", "web-search", map[string]any{
		"defaultEngine": "tavily",
		"engines": map[string]any{
			"tavily":  map[string]any{"apiKey": "t"},
			"searxng": map[string]any{},
		},
	}); err != nil {
		t.Fatal(err)
	}
	insertPlatformServiceEndpoint(t, h, "searxng", "http://searx.test")
	setPlatformAgentWebDefaults(t, h, `{"searchEngine":"searxng"}`)
	engine, err := h.webSearchConfig(context.Background(), "tenant", agentID)
	if err != nil {
		t.Fatal(err)
	}
	if engine.ID != "searxng" || engine.BaseURL != "http://searx.test" {
		t.Fatalf("platform default engine not applied: %+v", engine)
	}
}

func TestPlatformDefaultFetchBackendFallback(t *testing.T) {
	h, agentID := newWebHandler(t)
	if err := h.putSetting(context.Background(), "tenant:tenant", "web-fetch", map[string]any{"defaultBackend": "native"}); err != nil {
		t.Fatal(err)
	}
	insertPlatformServiceEndpoint(t, h, "jina-reader", "http://jina.test")
	setPlatformAgentWebDefaults(t, h, `{"fetchBackend":"jina-reader"}`)
	backend, err := h.webFetchConfig(context.Background(), "tenant", agentID)
	if err != nil {
		t.Fatal(err)
	}
	if backend.ID != "jina-reader" || backend.BaseURL != "http://jina.test" {
		t.Fatalf("platform default backend not applied: %+v", backend)
	}
}

func TestBuildAgentProvidersInheritsPlatformDefaults(t *testing.T) {
	h, agentID := newWebHandler(t)
	setPlatformAgentWebDefaults(t, h, `{"webSearchEnabled":false,"searchEngine":"searxng","fetchBackend":"jina-reader"}`)
	options, err := h.buildAgentProviders(context.Background(), "tenant", agentID)
	if err != nil {
		t.Fatal(err)
	}
	search := options["webSearch"].(map[string]any)["agent"].(map[string]any)
	if search["enabled"] != false || search["defaultEngine"] != "searxng" {
		t.Fatalf("web search did not inherit platform defaults: %#v", search)
	}
	fetch := options["webFetch"].(map[string]any)["agent"].(map[string]any)
	if fetch["enabled"] != true || fetch["defaultBackend"] != "jina-reader" {
		t.Fatalf("web fetch did not inherit platform defaults: %#v", fetch)
	}
}

func TestBuildAgentProvidersAgentOverridesPlatformDefaults(t *testing.T) {
	h, agentID := newWebHandlerWithConfig(t, `{"providers":{"webSearch":{"enabled":true,"defaultEngine":"tavily"}}}`)
	setPlatformAgentWebDefaults(t, h, `{"webSearchEnabled":false,"searchEngine":"searxng"}`)
	options, err := h.buildAgentProviders(context.Background(), "tenant", agentID)
	if err != nil {
		t.Fatal(err)
	}
	search := options["webSearch"].(map[string]any)["agent"].(map[string]any)
	if search["enabled"] != true || search["defaultEngine"] != "tavily" {
		t.Fatalf("agent values should win over platform defaults: %#v", search)
	}
}
