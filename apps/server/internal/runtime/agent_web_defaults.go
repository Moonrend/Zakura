// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
)

const platformAgentWebDefaultsKey = "agents.web-defaults"

type platformWebToolDefaults struct {
	webSearchEnabled    bool
	webFetchEnabled     bool
	searchEngine        string
	fetchBackend        string
	autoManagedServices []string
}

func defaultPlatformWebToolDefaults() platformWebToolDefaults {
	return platformWebToolDefaults{webSearchEnabled: true, webFetchEnabled: true, autoManagedServices: []string{}}
}

func (h *handler) platformWebToolDefaults(ctx context.Context) platformWebToolDefaults {
	out := defaultPlatformWebToolDefaults()
	var row struct {
		Value string `gorm:"column:value"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("settings").Select("value").Where("owner_key=? AND key=?", "platform", platformAgentWebDefaultsKey).Take(&row).Error; err != nil {
		return out
	}
	var parsed map[string]any
	if json.Unmarshal([]byte(row.Value), &parsed) != nil {
		if plain, e := openSecretBox(h.deps.Secret, "setting:platform:"+platformAgentWebDefaultsKey, row.Value); e == nil {
			_ = json.Unmarshal(plain, &parsed)
		}
	}
	if parsed == nil {
		return out
	}
	if value, ok := parsed["webSearchEnabled"].(bool); ok {
		out.webSearchEnabled = value
	}
	if value, ok := parsed["webFetchEnabled"].(bool); ok {
		out.webFetchEnabled = value
	}
	if value, ok := parsed["searchEngine"].(string); ok && value != "" {
		out.searchEngine = value
	}
	if value, ok := parsed["fetchBackend"].(string); ok && value != "" {
		out.fetchBackend = value
	}
	switch values := parsed["autoManagedServices"].(type) {
	case []any:
		for _, item := range values {
			if value, ok := item.(string); ok && value != "" {
				out.autoManagedServices = append(out.autoManagedServices, value)
			}
		}
	case []string:
		for _, value := range values {
			if value != "" {
				out.autoManagedServices = append(out.autoManagedServices, value)
			}
		}
	}
	return out
}
