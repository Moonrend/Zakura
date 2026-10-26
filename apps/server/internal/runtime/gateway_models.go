// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"strings"
)

type gatewayModel struct {
	ID       string
	Route    ModelRoute
	Metadata map[string]any
}

// Load the inventory in a fixed number of queries, not two queries per alias.
// Missing or malformed optional metadata must not hide an otherwise ready model.
func (h *handler) gatewayModels(ctx context.Context, tenant string) ([]gatewayModel, error) {
	routes, err := h.store.ListRoutes(ctx, tenant, "chat")
	if err != nil {
		return nil, err
	}
	var upstreams []string
	if err := h.deps.Gorm.WithContext(ctx).Table("model_upstreams").Where("tenant_id=? AND status='ready'", tenant).Pluck("id", &upstreams).Error; err != nil {
		return nil, err
	}
	ready := make(map[string]bool, len(upstreams))
	for _, upstream := range upstreams {
		ready[upstream] = true
	}
	var rows []struct {
		UpstreamID  string `gorm:"column:upstream_id"`
		NativeModel string `gorm:"column:native_model"`
		MetaJSON    string `gorm:"column:meta_json"`
		OptionsJSON string `gorm:"column:options_json"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("upstream_models").Select("upstream_id, native_model, meta_json, options_json").Where("tenant_id=? AND capability='chat' AND status='ready'", tenant).Scan(&rows).Error; err != nil {
		return nil, err
	}
	type modelKey struct{ upstream, model string }
	metadata := make(map[modelKey][]string, len(rows))
	for _, row := range rows {
		metadata[modelKey{row.UpstreamID, row.NativeModel}] = []string{row.MetaJSON, row.OptionsJSON}
	}
	out := make([]gatewayModel, 0, len(routes))
	seen := make(map[string]bool, len(routes))
	for _, route := range routes {
		if route.Status != "ready" || !ready[route.UpstreamID] {
			continue
		}
		id := route.Model
		if route.Alias != nil && strings.TrimSpace(*route.Alias) != "" {
			id = *route.Alias
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		raw := metadata[modelKey{route.UpstreamID, route.Model}]
		out = append(out, gatewayModel{ID: id, Route: route, Metadata: gatewayModelMetadata(route, raw...)})
	}
	return out, nil
}

func gatewayModelMetadata(route ModelRoute, raw ...string) map[string]any {
	metadata := map[string]any{}
	for _, value := range append(raw, string(route.Options)) {
		var values map[string]any
		if json.Unmarshal([]byte(value), &values) == nil {
			for key, value := range values {
				metadata[key] = value
			}
		}
	}
	out := map[string]any{}
	contextLimit := gwFirstPositive(metadata, "contextLimit", "contextWindow", "context_length", "context_window")
	outputLimit := gwFirstPositive(metadata, "outputLimit", "maxTokens", "max_output_tokens", "maxOutputTokens")
	if limits := gwMap(metadata["limit"]); limits != nil {
		if contextLimit == 0 {
			contextLimit = gwInt(limits["context"])
		}
		if outputLimit == 0 {
			outputLimit = gwInt(limits["output"])
		}
	}
	if contextLimit > 0 {
		out["contextLimit"], out["context_length"] = contextLimit, contextLimit
	}
	if outputLimit > 0 {
		out["outputLimit"], out["max_output_tokens"] = outputLimit, outputLimit
	}
	for _, key := range []string{"reasoning", "attachment", "toolCall"} {
		if value, ok := metadata[key].(bool); ok {
			out[key] = value
		}
	}
	if name, ok := metadata["name"].(string); ok && strings.TrimSpace(name) != "" {
		out["name"] = name
	}
	return out
}

func gwFirstPositive(values map[string]any, keys ...string) int {
	for _, key := range keys {
		if value := gwInt(values[key]); value > 0 {
			return value
		}
	}
	return 0
}
