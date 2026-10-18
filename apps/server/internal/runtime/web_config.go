// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"strings"
)

type effectiveWebConfig struct {
	search                            webSearchEngine
	fetch                             webFetchBackend
	searchEnabled, fetchEnabled       bool
	searchConfigured, fetchConfigured bool
	searchErr, fetchErr               error
	searchSource, fetchSource         string
	searchChoices, fetchChoices       []map[string]any
	searchDefault, fetchDefault       string
	spaceSearch, spaceFetch           map[string]any
}

func (h *handler) tenantWebSetting(ctx context.Context, tenant, key string) (map[string]any, error) {
	value, err := h.getSetting(ctx, "tenant:"+tenant, key)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return map[string]any{}, nil
	}
	return value, err
}
func configMap(raw json.RawMessage) map[string]any {
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return out
}
func narrowedEnabled(parent bool, override map[string]any) bool {
	if enabled, ok := override["enabled"].(bool); ok {
		return parent && enabled
	}
	return parent
}
func (h *handler) effectiveWeb(ctx context.Context, tenant, spaceID, agentID string) (effectiveWebConfig, error) {
	out := effectiveWebConfig{searchChoices: []map[string]any{}, fetchChoices: []map[string]any{}, searchSource: "tenant", fetchSource: "tenant"}
	space, err := h.store.GetSpace(ctx, tenant, spaceID)
	if err != nil {
		return out, err
	}
	providers := nestedMap(configMap(space.Config), "providers")
	out.spaceSearch = nestedMap(providers, "webSearch")
	out.spaceFetch = nestedMap(providers, "webFetch")
	agentSearch, agentFetch := map[string]any{}, map[string]any{}
	if agentID != "" {
		agent, err := h.store.GetAgent(ctx, tenant, agentID)
		if err != nil {
			return out, err
		}
		if agent.SpaceID != spaceID {
			return out, ErrNotFound
		}
		agentSearch = agentProviderConfig(agent, "webSearch")
		agentFetch = agentProviderConfig(agent, "webFetch")
	}
	platform := h.platformWebToolDefaults(ctx)
	searchSettings, err := h.tenantWebSetting(ctx, tenant, "web-search")
	if err != nil {
		return out, err
	}
	fetchSettings, err := h.tenantWebSetting(ctx, tenant, "web-fetch")
	if err != nil {
		return out, err
	}
	out.searchEnabled = narrowedEnabled(narrowedEnabled(narrowedEnabled(platform.webSearchEnabled, searchSettings), out.spaceSearch), agentSearch)
	out.fetchEnabled = narrowedEnabled(narrowedEnabled(narrowedEnabled(platform.webFetchEnabled, fetchSettings), out.spaceFetch), agentFetch)
	engines := nestedMap(searchSettings, "engines")
	configured := map[string]webSearchEngine{}
	for _, id := range webSearchEngineIDs {
		entry := nestedMap(engines, id)
		if engine, ok := webSearchEngineFromEntry(h, ctx, id, entry); ok {
			// Keyless Jina must still be explicitly configured; never invent an engine
			// absent from settings. A real platform SearXNG endpoint is usable though.
			if len(entry) == 0 && !(id == "searxng" && engine.BaseURL != "") {
				continue
			}
			configured[id] = engine
			out.searchChoices = append(out.searchChoices, map[string]any{"id": id, "name": id, "configured": true})
		}
	}
	inheritedSearch := firstNonEmpty(platform.searchEngine, mapStringValue(searchSettings["defaultEngine"]))
	if inheritedSearch == "auto" {
		inheritedSearch = ""
	}
	if inheritedSearch == "" {
		for _, id := range webSearchEngineIDs {
			if _, ok := configured[id]; ok {
				inheritedSearch = id
				break
			}
		}
	}
	out.searchDefault = inheritedSearch
	if platform.searchEngine != "" {
		out.searchSource = "platform"
	}
	selected := inheritedSearch
	if value := mapStringValue(out.spaceSearch["defaultEngine"]); value != "" && value != "auto" {
		selected = value
		out.searchSource = "space"
	}
	if value := mapStringValue(agentSearch["defaultEngine"]); value != "" && value != "auto" {
		selected = value
		out.searchSource = "agent"
	}
	var ok bool
	out.search, ok = configured[selected]
	out.searchConfigured = ok
	if selected != "" {
		out.search.ID = selected
	}
	if !ok {
		out.searchErr = errors.New("web search is not configured")
	}
	if !out.searchEnabled {
		out.searchErr = errors.New("web search is disabled for this agent")
	}
	backends := nestedMap(fetchSettings, "backends")
	available := map[string]webFetchBackend{}
	allowPrivate := mapBoolValue(fetchSettings["allowPrivateHosts"])
	if value, ok := out.spaceFetch["allowPrivateHosts"].(bool); ok {
		allowPrivate = allowPrivate && value
	}
	if value, ok := agentFetch["allowPrivateHosts"].(bool); ok {
		allowPrivate = allowPrivate && value
	}
	for _, id := range []string{"native", "jina-reader", "firecrawl", "crawl4ai"} {
		entry := nestedMap(backends, id)
		if enabled, ok := entry["enabled"].(bool); ok && !enabled {
			continue
		}
		backend := webFetchBackend{ID: id, AllowPrivateHosts: allowPrivate, APIKey: strings.TrimSpace(mapStringValue(entry["apiKey"]))}
		switch id {
		case "native":
		case "jina-reader":
			backend.BaseURL = firstNonEmpty(mapStringValue(entry["baseUrl"]), h.platformServiceEndpoint(ctx, id), "https://r.jina.ai")
		case "firecrawl":
			backend.BaseURL = firstNonEmpty(mapStringValue(entry["baseUrl"]), h.platformServiceEndpoint(ctx, id))
			if backend.BaseURL == "" && backend.APIKey != "" {
				backend.BaseURL = "https://api.firecrawl.dev"
			}
			if backend.BaseURL == "" {
				continue
			}
		case "crawl4ai":
			backend.BaseURL = firstNonEmpty(mapStringValue(entry["baseUrl"]), h.platformServiceEndpoint(ctx, id))
			if backend.BaseURL == "" {
				continue
			}
		}
		available[id] = backend
		out.fetchChoices = append(out.fetchChoices, map[string]any{"id": id, "name": id, "configured": true})
	}
	inheritedFetch := firstNonEmpty(platform.fetchBackend, mapStringValue(fetchSettings["defaultBackend"]), "native")
	if inheritedFetch == "auto" {
		inheritedFetch = "native"
	}
	out.fetchDefault = inheritedFetch
	if platform.fetchBackend != "" {
		out.fetchSource = "platform"
	}
	selected = inheritedFetch
	if value := mapStringValue(out.spaceFetch["defaultBackend"]); value != "" && value != "auto" {
		selected = value
		out.fetchSource = "space"
	}
	if value := mapStringValue(agentFetch["defaultBackend"]); value != "" && value != "auto" {
		selected = value
		out.fetchSource = "agent"
	}
	out.fetch, ok = available[selected]
	out.fetchConfigured = ok
	out.fetch.ID = selected
	if !ok {
		out.fetchErr = fmt.Errorf("web fetch backend %q is not configured", selected)
	}
	if !out.fetchEnabled {
		out.fetchErr = errors.New("web fetch is disabled for this agent")
	}
	return out, nil
}
func (h *handler) webProviderOptions(ctx context.Context, tenant, space, agent string) (map[string]any, error) {
	cfg, err := h.effectiveWeb(ctx, tenant, space, agent)
	if err != nil {
		return nil, err
	}
	status := func(enabled bool, err error) string {
		if !enabled {
			return "disabled"
		}
		if err != nil {
			return "unconfigured"
		}
		return "ready"
	}
	search := map[string]any{"instanceId": "builtin:web-search", "status": status(cfg.searchEnabled, cfg.searchErr), "configured": cfg.searchConfigured, "source": cfg.searchSource, "engines": cfg.searchChoices, "tenantDefaultEngine": cfg.searchDefault, "tenantDefaultEngineName": cfg.searchDefault, "effective": map[string]any{"enabled": cfg.searchEnabled, "defaultEngine": cfg.search.ID}, "space": map[string]any{"enabled": cfg.searchEnabled, "defaultEngine": valueOrNil(cfg.spaceSearch, "defaultEngine")}}
	fetch := map[string]any{"instanceId": "builtin:web-fetch", "status": status(cfg.fetchEnabled, cfg.fetchErr), "configured": cfg.fetchConfigured, "source": cfg.fetchSource, "backends": cfg.fetchChoices, "tenantDefaultBackend": cfg.fetchDefault, "tenantDefaultBackendName": cfg.fetchDefault, "effective": map[string]any{"enabled": cfg.fetchEnabled, "defaultBackend": cfg.fetch.ID}, "space": map[string]any{"enabled": cfg.fetchEnabled, "defaultBackend": valueOrNil(cfg.spaceFetch, "defaultBackend")}}
	search["agent"] = search["space"]
	fetch["agent"] = fetch["space"] // compatibility DTO
	if agent != "" {
		record, err := h.store.GetAgent(ctx, tenant, agent)
		if err != nil {
			return nil, err
		}
		search["agent"] = map[string]any{"enabled": cfg.searchEnabled, "defaultEngine": valueOrNil(agentProviderConfig(record, "webSearch"), "defaultEngine")}
		fetch["agent"] = map[string]any{"enabled": cfg.fetchEnabled, "defaultBackend": valueOrNil(agentProviderConfig(record, "webFetch"), "defaultBackend")}
	}
	return map[string]any{"webSearch": search, "webFetch": fetch}, nil
}
func mergeWebProviderPatch(providers, patch map[string]any) error {
	for _, key := range []string{"webSearch", "webFetch"} {
		value, ok := patch[key]
		if !ok {
			continue
		}
		if value == nil {
			delete(providers, key)
			continue
		}
		fields, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("%s must be an object", key)
		}
		for field, v := range fields {
			if v == nil {
				continue
			}
			switch field {
			case "enabled", "allowPrivateHosts":
				if _, ok := v.(bool); !ok {
					return fmt.Errorf("%s must be boolean", field)
				}
			case "defaultEngine", "defaultBackend":
				if _, ok := v.(string); !ok {
					return fmt.Errorf("%s must be string or null", field)
				}
			default:
				return fmt.Errorf("unsupported %s field %s", key, field)
			}
		}
		current := nestedMap(providers, key)
		mergeConfigPatch(current, fields)
		providers[key] = current
	}
	return nil
}
func (h *handler) mergeSpaceWebProviders(ctx context.Context, tenant, space string, patch map[string]any) error {
	_, err := h.store.mutateSpaceConfig(ctx, tenant, space, func(cfg map[string]any) error {
		providers := nestedMap(cfg, "providers")
		if err := mergeWebProviderPatch(providers, patch); err != nil {
			return err
		}
		cfg["providers"] = providers
		return nil
	})
	return err
}
func (h *handler) webToolAvailability(ctx context.Context, tenant, space, agent string) (bool, bool) {
	cfg, err := h.effectiveWeb(ctx, tenant, space, agent)
	if err != nil {
		return false, false
	}
	return cfg.searchEnabled && cfg.searchErr == nil, cfg.fetchEnabled && cfg.fetchErr == nil
}
