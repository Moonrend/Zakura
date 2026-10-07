package admin

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const agentWebDefaultsKey = "agents.web-defaults"
const legacyAgentDefaultsKey = "agent_defaults"

type agentWebDefaults struct {
	WebSearchEnabled    bool     `json:"webSearchEnabled"`
	WebFetchEnabled     bool     `json:"webFetchEnabled"`
	SearchEngine        *string  `json:"searchEngine"`
	FetchBackend        *string  `json:"fetchBackend"`
	AutoManagedServices []string `json:"autoManagedServices"`
}

func defaultAgentWebDefaults() agentWebDefaults {
	return agentWebDefaults{
		WebSearchEnabled:    true,
		WebFetchEnabled:     true,
		AutoManagedServices: []string{},
	}
}

func agentServiceMapsToKind(key string) string {
	switch key {
	case "searxng":
		return "search-engine"
	case "jina-reader", "crawl4ai", "firecrawl":
		return "fetch-backend"
	}
	return ""
}

func normalizeAutoManagedServices(keys []string) []string {
	out := []string{}
	searchSet := false
	fetchSet := false
	for _, key := range keys {
		switch agentServiceMapsToKind(key) {
		case "search-engine":
			if !searchSet {
				out = append(out, key)
				searchSet = true
			}
		case "fetch-backend":
			if !fetchSet {
				out = append(out, key)
				fetchSet = true
			}
		}
	}
	return out
}

func normalizeAgentWebDefaults(raw map[string]any) agentWebDefaults {
	out := defaultAgentWebDefaults()
	out.WebSearchEnabled = raw["webSearchEnabled"] != false
	out.WebFetchEnabled = raw["webFetchEnabled"] != false
	if value, ok := raw["searchEngine"].(string); ok && value != "" {
		out.SearchEngine = &value
	}
	if value, ok := raw["fetchBackend"].(string); ok && value != "" {
		out.FetchBackend = &value
	}
	autoManaged := []string{}
	switch values := raw["autoManagedServices"].(type) {
	case []any:
		for _, item := range values {
			if value, ok := item.(string); ok && value != "" {
				autoManaged = append(autoManaged, value)
			}
		}
	case []string:
		for _, value := range values {
			if value != "" {
				autoManaged = append(autoManaged, value)
			}
		}
	}
	out.AutoManagedServices = normalizeAutoManagedServices(autoManaged)
	return out
}

func (a *routes) readAgentWebDefaultsRow(ctx context.Context, key string) (agentWebDefaults, bool, error) {
	var row models.Setting
	err := a.d.Gorm.WithContext(ctx).Where("owner_key=? AND key=?", "platform", key).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return agentWebDefaults{}, false, nil
	}
	if err != nil {
		return agentWebDefaults{}, false, err
	}
	var parsed map[string]any
	if json.Unmarshal([]byte(row.Value), &parsed) != nil {
		return defaultAgentWebDefaults(), true, nil
	}
	return normalizeAgentWebDefaults(parsed), true, nil
}

func (a *routes) writeAgentWebDefaults(ctx context.Context, value agentWebDefaults) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	id := a.d.NewID()
	return a.d.Gorm.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "owner_key"}, {Name: "key"}},
			DoUpdates: clause.AssignmentColumns([]string{"value"}),
		}).
		Create(&models.Setting{ID: &id, OwnerKey: "platform", Key: agentWebDefaultsKey, Value: string(raw)}).Error
}

func (a *routes) loadAgentWebDefaults(ctx context.Context) (agentWebDefaults, error) {
	value, found, err := a.readAgentWebDefaultsRow(ctx, agentWebDefaultsKey)
	if err != nil {
		return agentWebDefaults{}, err
	}
	if found {
		return value, nil
	}
	legacy, found, err := a.readAgentWebDefaultsRow(ctx, legacyAgentDefaultsKey)
	if err != nil {
		return agentWebDefaults{}, err
	}
	if !found {
		return defaultAgentWebDefaults(), nil
	}
	if err := a.writeAgentWebDefaults(ctx, legacy); err != nil {
		return agentWebDefaults{}, err
	}
	_ = a.d.Gorm.WithContext(ctx).Where("owner_key=? AND key=?", "platform", legacyAgentDefaultsKey).Delete(&models.Setting{}).Error
	return legacy, nil
}

func optionalString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func (a *routes) saveAgentWebDefaults(ctx context.Context, patch map[string]any) (agentWebDefaults, error) {
	current, err := a.loadAgentWebDefaults(ctx)
	if err != nil {
		return agentWebDefaults{}, err
	}
	merged := map[string]any{
		"webSearchEnabled":    current.WebSearchEnabled,
		"webFetchEnabled":     current.WebFetchEnabled,
		"searchEngine":        optionalString(current.SearchEngine),
		"fetchBackend":        optionalString(current.FetchBackend),
		"autoManagedServices": current.AutoManagedServices,
	}
	for _, key := range []string{"webSearchEnabled", "webFetchEnabled", "searchEngine", "fetchBackend", "autoManagedServices"} {
		if value, ok := patch[key]; ok {
			merged[key] = value
		}
	}
	normalized := normalizeAgentWebDefaults(merged)
	if err := a.writeAgentWebDefaults(ctx, normalized); err != nil {
		return agentWebDefaults{}, err
	}
	return normalized, nil
}

func (a *routes) activeManagedServices(ctx context.Context, defaults agentWebDefaults) ([]models.PlatformService, error) {
	if len(defaults.AutoManagedServices) == 0 {
		return nil, nil
	}
	var active []models.PlatformService
	if err := a.d.Gorm.WithContext(ctx).Where("service_key IN ? AND mode <> ?", defaults.AutoManagedServices, "disabled").Find(&active).Error; err != nil {
		return nil, err
	}
	return active, nil
}

func (a *routes) applyManagedWebDefaultsForTenant(ctx context.Context, tenantID string, defaults agentWebDefaults, active []models.PlatformService) error {
	if defaults.WebSearchEnabled {
		if err := a.mergeTenantManagedWebSetting(ctx, tenantID, "web-search", "engines", "defaultEngine", active, "search-engine"); err != nil {
			return err
		}
	}
	if defaults.WebFetchEnabled {
		if err := a.mergeTenantManagedWebSetting(ctx, tenantID, "web-fetch", "backends", "defaultBackend", active, "fetch-backend"); err != nil {
			return err
		}
	}
	return nil
}

func SyncManagedWebDefaultsForTenant(ctx context.Context, deps *appdeps.Dependencies, tenantID string) error {
	a := &routes{d: deps}
	defaults, err := a.loadAgentWebDefaults(ctx)
	if err != nil {
		return err
	}
	active, err := a.activeManagedServices(ctx, defaults)
	if err != nil {
		return err
	}
	if len(active) == 0 {
		return nil
	}
	return a.applyManagedWebDefaultsForTenant(ctx, tenantID, defaults, active)
}

func (a *routes) syncManagedAgentWebDefaults(ctx context.Context, defaults agentWebDefaults) error {
	active, err := a.activeManagedServices(ctx, defaults)
	if err != nil {
		return err
	}
	if len(active) == 0 {
		return nil
	}
	var tenantIDs []string
	if err := a.d.Gorm.WithContext(ctx).Table("tenants").Order("id").Pluck("id", &tenantIDs).Error; err != nil {
		return err
	}
	for _, tenantID := range tenantIDs {
		if err := a.applyManagedWebDefaultsForTenant(ctx, tenantID, defaults, active); err != nil {
			return err
		}
	}
	return nil
}

func (a *routes) mergeTenantManagedWebSetting(ctx context.Context, tenantID, settingKey, mapKey, defaultKey string, active []models.PlatformService, kind string) error {
	ids := []string{}
	for _, service := range active {
		if agentServiceMapsToKind(service.ServiceKey) == kind {
			ids = append(ids, service.ServiceKey)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	owner := "tenant:" + tenantID
	current := map[string]any{}
	var row models.Setting
	err := a.d.Gorm.WithContext(ctx).Where("owner_key=? AND key=?", owner, settingKey).Take(&row).Error
	if err == nil {
		plain, decErr := openAdmin(a.d.Secret, row.Value)
		if decErr != nil {
			return nil
		}
		_ = json.Unmarshal([]byte(plain), &current)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	entries, _ := current[mapKey].(map[string]any)
	if entries == nil {
		entries = map[string]any{}
	}
	changed := false
	for _, id := range ids {
		entry, _ := entries[id].(map[string]any)
		if entry == nil {
			entry = map[string]any{}
		}
		if enabled, ok := entry["enabled"].(bool); !ok || !enabled {
			entry["enabled"] = true
			changed = true
		}
		entries[id] = entry
	}
	if existing, _ := current[defaultKey].(string); existing == "" {
		current[defaultKey] = ids[0]
		changed = true
	}
	if !changed {
		return nil
	}
	current[mapKey] = entries
	raw, err := json.Marshal(current)
	if err != nil {
		return err
	}
	sealed, err := sealAdmin(a.d.Secret, raw)
	if err != nil {
		return err
	}
	id := a.d.NewID()
	return a.d.Gorm.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "owner_key"}, {Name: "key"}},
			DoUpdates: clause.AssignmentColumns([]string{"value"}),
		}).
		Create(&models.Setting{ID: &id, OwnerKey: owner, Key: settingKey, Value: sealed}).Error
}
