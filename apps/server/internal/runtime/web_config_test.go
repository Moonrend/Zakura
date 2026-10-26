// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
)

func TestEffectiveWebSpaceInheritanceAndAgentNarrowing(t *testing.T) {
	h, agentID := newWebHandler(t)
	ctx := context.Background()
	agent, _ := h.store.GetAgent(ctx, "tenant", agentID)
	if err := h.putSetting(ctx, "tenant:tenant", "web-search", map[string]any{"defaultEngine": "tavily", "engines": map[string]any{"tavily": map[string]any{"apiKey": "test"}, "serper": map[string]any{"apiKey": "test"}}}); err != nil {
		t.Fatal(err)
	}
	if err := h.mergeSpaceWebProviders(ctx, "tenant", agent.SpaceID, map[string]any{"webSearch": map[string]any{"defaultEngine": "serper"}, "webFetch": map[string]any{"enabled": false}}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.updateAgentConfig(ctx, "tenant", agentID, nil, func(cfg map[string]any) error {
		cfg["providers"] = map[string]any{"webFetch": map[string]any{"enabled": true}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	effective, err := h.effectiveWeb(ctx, "tenant", agent.SpaceID, agentID)
	if err != nil {
		t.Fatal(err)
	}
	if effective.search.ID != "serper" || effective.searchSource != "space" || effective.fetchEnabled {
		t.Fatalf("wrong inheritance %#v", effective)
	}
	options, err := h.webProviderOptions(ctx, "tenant", agent.SpaceID, "")
	if err != nil {
		t.Fatal(err)
	}
	search := options["webSearch"].(map[string]any)
	if search["status"] != "ready" || search["source"] != "space" || len(search["engines"].([]map[string]any)) != 2 {
		t.Fatal(search)
	}
	// An Agent cannot re-enable its Space's disabled tool, nor enable private
	// host access denied by tenant policy.
	if err := h.mergeSpaceWebProviders(ctx, "tenant", agent.SpaceID, map[string]any{"webFetch": map[string]any{"enabled": true, "allowPrivateHosts": true}}); err != nil {
		t.Fatal(err)
	}
	effective, err = h.effectiveWeb(ctx, "tenant", agent.SpaceID, agentID)
	if err != nil || effective.fetch.AllowPrivateHosts {
		t.Fatalf("agent broadened private-host policy %v %#v", err, effective.fetch)
	}
}
func TestEffectiveWebZeroAgentTruthfulConfigured(t *testing.T) {
	h, agentID := newWebHandler(t)
	ctx := context.Background()
	agent, _ := h.store.GetAgent(ctx, "tenant", agentID)
	if _, err := h.deps.DB.Exec(`DELETE FROM agents WHERE id=?`, agentID); err != nil {
		t.Fatal(err)
	}
	options, err := h.webProviderOptions(ctx, "tenant", agent.SpaceID, "")
	if err != nil {
		t.Fatal(err)
	}
	search := options["webSearch"].(map[string]any)
	fetch := options["webFetch"].(map[string]any)
	if search["status"] != "unconfigured" || search["configured"] != false || len(search["engines"].([]map[string]any)) != 0 {
		t.Fatal(search)
	}
	if fetch["status"] != "ready" || fetch["effective"].(map[string]any)["defaultBackend"] != "native" {
		t.Fatal(fetch)
	}
	if err = h.mergeSpaceWebProviders(ctx, "tenant", agent.SpaceID, map[string]any{"webFetch": map[string]any{"defaultBackend": "missing"}}); err != nil {
		t.Fatal(err)
	}
	options, err = h.webProviderOptions(ctx, "tenant", agent.SpaceID, "")
	if err != nil || options["webFetch"].(map[string]any)["status"] != "unconfigured" {
		t.Fatalf("invented configured backend %v %#v", err, options)
	}
}
func TestWebConcurrentPartialSaveKeepsSiblings(t *testing.T) {
	h, agentID := newWebHandler(t)
	ctx := context.Background()
	agent, _ := h.store.GetAgent(ctx, "tenant", agentID)
	_, err := h.store.mutateSpaceConfig(ctx, "tenant", agent.SpaceID, func(cfg map[string]any) error {
		cfg["unrelated"] = "keep"
		cfg["providers"] = map[string]any{"mcp": map[string]any{"mode": "selected"}, "webSearch": map[string]any{"enabled": true, "defaultEngine": "tavily"}}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, patch := range []map[string]any{{"webSearch": map[string]any{"enabled": false}}, {"webSearch": map[string]any{"defaultEngine": "serper"}}} {
		wg.Add(1)
		go func(patch map[string]any) {
			defer wg.Done()
			<-start
			errs <- h.mergeSpaceWebProviders(ctx, "tenant", agent.SpaceID, patch)
		}(patch)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	space, _ := h.store.GetSpace(ctx, "tenant", agent.SpaceID)
	var cfg map[string]any
	_ = json.Unmarshal(space.Config, &cfg)
	search := nestedMap(cfg, "providers", "webSearch")
	if cfg["unrelated"] != "keep" || nestedMap(cfg, "providers", "mcp")["mode"] != "selected" || search["enabled"] != false || search["defaultEngine"] != "serper" {
		t.Fatal(cfg)
	}
	if err = h.mergeSpaceWebProviders(ctx, "tenant", agent.SpaceID, map[string]any{"webSearch": map[string]any{"defaultEngine": nil}}); err != nil {
		t.Fatal(err)
	}
	space, _ = h.store.GetSpace(ctx, "tenant", agent.SpaceID)
	cfg = configMap(space.Config)
	search = nestedMap(cfg, "providers", "webSearch")
	if _, ok := search["defaultEngine"]; ok || search["enabled"] != false {
		t.Fatal(search)
	}
}
func TestWebPolicyPlatformCannotBeBroadened(t *testing.T) {
	h, agentID := newWebHandler(t)
	ctx := context.Background()
	agent, _ := h.store.GetAgent(ctx, "tenant", agentID)
	if err := h.putSetting(ctx, "platform", platformAgentWebDefaultsKey, map[string]any{"webSearchEnabled": false, "webFetchEnabled": false}); err != nil {
		t.Fatal(err)
	}
	if err := h.mergeSpaceWebProviders(ctx, "tenant", agent.SpaceID, map[string]any{"webSearch": map[string]any{"enabled": true}, "webFetch": map[string]any{"enabled": true}}); err != nil {
		t.Fatal(err)
	}
	cfg, err := h.effectiveWeb(ctx, "tenant", agent.SpaceID, agentID)
	if err != nil || cfg.searchEnabled || cfg.fetchEnabled {
		t.Fatalf("platform policy broadened %v %#v", err, cfg)
	}
}
