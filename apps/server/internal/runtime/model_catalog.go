// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"gorm.io/gorm"
)

const modelCatalogMaxBytes = 32 << 20

var modelCatalogSources = []struct{ name, url string }{
	{"models.dev", "https://models.dev/api.json"},
	{"llm-metadata", "https://basellm.github.io/llm-metadata/api/all.json"},
}

type catalogEntry struct {
	Source, ProviderID, ProviderName, ModelID string
	Meta                                      map[string]any
}

type catalogRefreshResult struct {
	CatalogEntries  int                     `json:"catalogEntries"`
	Matched         int                     `json:"matched"`
	Updated         int                     `json:"updated"`
	Unmatched       int                     `json:"unmatched"`
	Unchanged       int                     `json:"unchanged"`
	UnmatchedModels []catalogUnmatchedModel `json:"unmatchedModels"`
	Failed          map[string]string       `json:"failed"`
}

type catalogUnmatchedModel struct {
	ID          string `json:"id"`
	NativeModel string `json:"nativeModel"`
	Reason      string `json:"reason"`
}

func (h *handler) fetchModelCatalog(ctx context.Context, source, target string) ([]catalogEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	client := http.DefaultClient
	if h.deps.HTTPClient != nil {
		client = h.deps.HTTPClient
	}
	clone := *client
	clone.Jar = nil
	clone.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || req.URL.Scheme != "https" || req.URL.Host != via[0].URL.Host {
			return errors.New("unexpected model catalog redirect")
		}
		return nil
	}
	resp, err := clone.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("catalog HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, modelCatalogMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > modelCatalogMaxBytes {
		return nil, errors.New("model catalog exceeds size limit")
	}
	return parseModelCatalog(source, raw)
}

func parseModelCatalog(source string, raw []byte) ([]catalogEntry, error) {
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("invalid model catalog: %w", err)
	}
	entries := map[string]catalogEntry{}
	add := func(providerID string, provider, model map[string]any, modelID string) {
		if model == nil || strings.TrimSpace(modelID) == "" || providerID == "" {
			return
		}
		entry := normalizeCatalogEntry(source, providerID, provider, modelID, model)
		entries[providerID+"\x00"+modelID] = entry
	}
	if list, ok := root["models"].([]any); ok && source == "llm-metadata" {
		providers := map[string]map[string]any{}
		if list, ok := root["providers"].([]any); ok {
			for _, value := range list {
				p := gwMap(value)
				providers[gwStr(p["id"])] = p
			}
		}
		for _, value := range list {
			m := gwMap(value)
			p := firstNonEmpty(gwStr(m["provider"]), gwStr(m["providerId"]))
			add(p, providers[p], m, gwStr(m["id"]))
		}
	} else {
		for providerID, value := range root {
			provider := gwMap(value)
			for modelID, value := range gwMap(provider["models"]) {
				model := gwMap(value)
				add(providerID, provider, model, firstNonEmpty(gwStr(model["id"]), modelID))
			}
		}
	}
	if len(entries) == 0 {
		return nil, errors.New("model catalog contains no valid entries")
	}
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]catalogEntry, 0, len(keys))
	for _, key := range keys {
		out = append(out, entries[key])
	}
	return out, nil
}

func normalizeCatalogEntry(source, providerID string, provider map[string]any, modelID string, model map[string]any) catalogEntry {
	providerName := firstNonEmpty(gwStr(provider["name"]), providerID)
	meta := map[string]any{
		"source": source, "providerId": providerID, "providerName": providerName,
		"modelId": modelID, "name": firstNonEmpty(gwStr(model["name"]), modelID), "raw": model,
	}
	for dest, src := range map[string]string{"description": "description", "family": "family", "knowledge": "knowledge", "releaseDate": "release_date", "defaultReasonLevel": "default_reason_level"} {
		if value := firstNonEmpty(gwStr(model[dest]), gwStr(model[src])); value != "" {
			meta[dest] = value
		}
	}
	for dest, src := range map[string]string{"apiBase": "api", "npm": "npm"} {
		if value := gwStr(provider[src]); value != "" {
			meta[dest] = value
		}
	}
	for dest, src := range map[string]string{"reasoning": "reasoning", "toolCall": "tool_call", "attachment": "attachment", "openWeights": "open_weights"} {
		if value, ok := model[dest].(bool); ok {
			meta[dest] = value
		} else if value, ok := model[src].(bool); ok {
			meta[dest] = value
		}
	}
	for dest, src := range map[string]string{"contextLimit": "context", "outputLimit": "output"} {
		if value, ok := gwMap(model["limit"])[src].(float64); ok && value >= 0 {
			meta[dest] = value
		}
	}
	modalities := map[string]any{}
	for _, key := range []string{"input", "output"} {
		if values := catalogStrings(gwMap(model["modalities"])[key]); values != nil {
			modalities[key] = values
		}
	}
	if len(modalities) > 0 {
		meta["modalities"] = modalities
	}
	cost := map[string]any{}
	for dest, src := range map[string]string{"input": "input", "output": "output", "cacheRead": "cache_read", "cacheWrite": "cache_write"} {
		values := gwMap(model["cost"])
		value, ok := values[dest].(float64)
		if !ok {
			value, ok = values[src].(float64)
		}
		if ok && value >= 0 {
			cost[dest] = value
		}
	}
	if len(cost) > 0 {
		meta["cost"] = cost
	}
	levels := catalogStrings(model["reasoningLevels"])
	if levels == nil {
		levels = catalogStrings(model["reasoning_levels"])
	}
	if levels == nil {
		if options, ok := model["reasoning_options"].([]any); ok {
			for _, value := range options {
				option := gwMap(value)
				switch option["type"] {
				case "toggle":
					levels = append(levels, "none")
				case "effort":
					levels = append(levels, catalogStrings(option["values"])...)
				}
			}
		}
	}
	if levels != nil {
		seen := map[string]bool{}
		unique := []string{}
		for _, level := range levels {
			if !seen[level] {
				unique = append(unique, level)
				seen[level] = true
			}
		}
		meta["reasoningLevels"] = unique
		if len(unique) > 0 {
			if _, exists := meta["reasoning"]; !exists {
				meta["reasoning"] = true
			}
		}
		if seen["auto"] && meta["defaultReasonLevel"] == nil {
			meta["defaultReasonLevel"] = "auto"
		}
	}
	id := strings.ToLower(modelID + " " + gwStr(meta["name"]))
	caps := []string{}
	switch {
	case strings.Contains(id, "embed"):
		caps = append(caps, "embedding")
	case strings.Contains(id, "rerank"), strings.Contains(id, "ranker"):
		caps = append(caps, "rerank")
	default:
		for _, modality := range catalogStrings(modalities["output"]) {
			if modality == "image" {
				caps = append(caps, "image")
			}
		}
		if len(caps) == 0 || containsCatalogString(modalities["output"], "text") {
			caps = append(caps, "chat")
		}
	}
	meta["capabilities"] = caps
	return catalogEntry{source, providerID, providerName, modelID, meta}
}

func catalogStrings(value any) []string {
	if values, ok := value.([]string); ok {
		return values
	}
	values, ok := value.([]any)
	if !ok {
		return nil
	}
	out := []string{}
	for _, value := range values {
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			out = append(out, strings.TrimSpace(text))
		}
	}
	return out
}

func containsCatalogString(value any, want string) bool {
	for _, text := range catalogStrings(value) {
		if text == want {
			return true
		}
	}
	return false
}

func catalogAPIHostMatches(a, b string) bool {
	left, e1 := url.Parse(a)
	right, e2 := url.Parse(b)
	return e1 == nil && e2 == nil && left.Hostname() != "" && strings.EqualFold(left.Hostname(), right.Hostname())
}

// Without a previous catalog value, an existing field is conservatively manual.
// Merge leaves rather than replacing nested pricing/modality objects wholesale.
func mergeCatalogMeta(current, previous, next map[string]any, removeMissing bool) map[string]any {
	out := map[string]any{}
	for key, value := range current {
		out[key] = value
	}
	for key, value := range next {
		old, hadOld := previous[key]
		present, exists := current[key]
		if !exists {
			out[key] = value
		} else if nested := gwMap(value); nested != nil && gwMap(present) != nil {
			out[key] = mergeCatalogMeta(gwMap(present), gwMap(old), nested, removeMissing)
		} else if hadOld && reflect.DeepEqual(present, old) {
			out[key] = value
		}
	}
	if removeMissing {
		for key, old := range previous {
			if _, exists := next[key]; !exists && reflect.DeepEqual(current[key], old) {
				delete(out, key)
			}
		}
	}
	return out
}

func catalogMetaJSON(raw string) map[string]any {
	var meta map[string]any
	_ = json.Unmarshal([]byte(raw), &meta)
	if meta == nil {
		meta = map[string]any{}
	}
	return meta
}

func (h *handler) refreshCatalogMetadata(ctx context.Context, tenant string) (catalogRefreshResult, error) {
	result := catalogRefreshResult{Failed: map[string]string{}, UnmatchedModels: []catalogUnmatchedModel{}}
	fresh := map[string][]catalogEntry{}
	for _, source := range modelCatalogSources {
		entries, err := h.fetchModelCatalog(ctx, source.name, source.url)
		if err != nil {
			result.Failed[source.name] = err.Error()
		} else {
			fresh[source.name] = entries
		}
	}
	if len(fresh) == 0 {
		return result, errors.New("所有模型元数据源均刷新失败；已有数据保持不变")
	}
	err := h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Lock before reading either snapshot, including on SQLite. Concurrent
		// refreshes must not advance the baseline without the inventory update.
		if err := tx.Exec("UPDATE tenants SET updated_at=updated_at WHERE id=?", tenant).Error; err != nil {
			return err
		}
		var cached []models.ModelCatalogEntry
		if err := tx.Where("tenant_id=?", tenant).Find(&cached).Error; err != nil {
			return err
		}
		previous, next := []catalogEntry{}, []catalogEntry{}
		for _, row := range cached {
			entry := catalogEntry{row.Source, row.ProviderID, row.ProviderName, row.ModelID, catalogMetaJSON(row.MetaJSON)}
			previous = append(previous, entry)
			if _, replaced := fresh[row.Source]; !replaced {
				next = append(next, entry)
			}
		}
		now := runtimeTimeString(h.store.now())
		for _, source := range modelCatalogSources {
			entries, ok := fresh[source.name]
			if !ok {
				continue
			}
			if err := tx.Where("tenant_id=? AND source=?", tenant, source.name).Delete(&models.ModelCatalogEntry{}).Error; err != nil {
				return err
			}
			rows := make([]models.ModelCatalogEntry, 0, len(entries))
			for _, entry := range entries {
				id := h.store.id()
				raw, err := json.Marshal(entry.Meta)
				if err != nil {
					return err
				}
				rows = append(rows, models.ModelCatalogEntry{ID: &id, TenantID: tenant, Source: entry.Source, ProviderID: entry.ProviderID, ProviderName: entry.ProviderName, ModelID: entry.ModelID, Name: gwStr(entry.Meta["name"]), MetaJSON: string(raw), CreatedAt: now, UpdatedAt: now})
			}
			if err := tx.CreateInBatches(rows, 50).Error; err != nil {
				return err
			}
			next = append(next, entries...)
		}
		result.CatalogEntries = len(next)
		oldIndex, newIndex := newCatalogIndex(previous), newCatalogIndex(next)
		var inventory []struct {
			ID             string `gorm:"column:id"`
			NativeModel    string `gorm:"column:native_model"`
			CanonicalModel string `gorm:"column:canonical_model"`
			Capability     string `gorm:"column:capability"`
			MetaJSON       string `gorm:"column:meta_json"`
			Protocol       string `gorm:"column:protocol"`
			ConfigJSON     string `gorm:"column:config_json"`
		}
		if err := tx.Table("upstream_models AS m").Select("m.id, m.native_model, m.canonical_model, m.capability, m.meta_json, u.protocol, u.config_json").Joins("JOIN model_upstreams AS u ON u.id=m.upstream_id AND u.tenant_id=m.tenant_id").Where("m.tenant_id=?", tenant).Scan(&inventory).Error; err != nil {
			return err
		}
		for _, row := range inventory {
			if row.Protocol == "typesafe" || row.Capability == "evaluation" {
				continue
			}
			apiBase := gwStr(catalogMetaJSON(row.ConfigJSON)["baseUrl"])
			entry, reason := newIndex.resolve(row.NativeModel, row.CanonicalModel, row.Capability, apiBase)
			if entry == nil {
				result.Unmatched++
				result.UnmatchedModels = append(result.UnmatchedModels, catalogUnmatchedModel{row.ID, row.NativeModel, reason})
				continue
			}
			result.Matched++
			current := catalogMetaJSON(row.MetaJSON)
			var baseline map[string]any
			// Use the source previously stored on this deployment. A matcher
			// fix may choose another provider; its old values are not the baseline.
			if old, exists := oldIndex.byOrigin[strings.ToLower(gwStr(current["providerId"]))+"\x00"+gwStr(current["modelId"])]; exists {
				baseline = old.Meta
			} else if old := oldIndex.match(row.NativeModel, row.CanonicalModel, row.Capability, apiBase); old != nil {
				baseline = old.Meta
			}
			updated := mergeCatalogMeta(current, baseline, entry.Meta, true)
			// Compare serialized JSON so decoded []any and normalized []string
			// have identical semantics on subsequent refreshes.
			raw, err := json.Marshal(updated)
			if err != nil {
				return err
			}
			before, _ := json.Marshal(current)
			if string(raw) == string(before) {
				result.Unchanged++
				continue
			}
			write := tx.Table("upstream_models").Where("tenant_id=? AND id=? AND meta_json=?", tenant, row.ID, row.MetaJSON).Updates(map[string]any{"meta_json": string(raw), "updated_at": now})
			if write.Error != nil {
				return write.Error
			}
			if write.RowsAffected != 1 {
				return errors.New("模型元数据已被同时编辑，请重试刷新")
			}
			result.Updated++
		}
		return nil
	})
	return result, err
}
