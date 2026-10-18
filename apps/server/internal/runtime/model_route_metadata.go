// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
)

type modelRouteWithMetadata struct {
	ModelRoute
	Meta map[string]any `json:"meta"`
}

func (h *handler) modelRoutesWithMetadata(ctx context.Context, tenant string, routes []ModelRoute) ([]modelRouteWithMetadata, error) {
	var rows []struct {
		UpstreamID  string `gorm:"column:upstream_id"`
		NativeModel string `gorm:"column:native_model"`
		Capability  string `gorm:"column:capability"`
		MetaJSON    string `gorm:"column:meta_json"`
		OptionsJSON string `gorm:"column:options_json"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("upstream_models").Select("upstream_id,native_model,capability,meta_json,options_json").Where("tenant_id=?", tenant).Scan(&rows).Error; err != nil {
		return nil, err
	}
	type key struct{ upstream, model, capability string }
	inventory := make(map[key][]string, len(rows))
	for _, row := range rows {
		inventory[key{row.UpstreamID, row.NativeModel, row.Capability}] = []string{row.MetaJSON, row.OptionsJSON}
	}
	out := make([]modelRouteWithMetadata, 0, len(routes))
	for _, route := range routes {
		raw := inventory[key{route.UpstreamID, route.Model, route.Capability}]
		meta := map[string]any{}
		for _, value := range append(raw, string(route.Options)) {
			var fields map[string]any
			if json.Unmarshal([]byte(value), &fields) == nil {
				for name, value := range fields {
					meta[name] = value
				}
			}
		}
		for name, value := range gatewayModelMetadata(route, raw...) {
			meta[name] = value
		}
		out = append(out, modelRouteWithMetadata{ModelRoute: route, Meta: meta})
	}
	return out, nil
}
