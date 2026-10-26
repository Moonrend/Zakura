// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Space installations own credentials and configuration. Agent IDs are routing
// inputs only; legacy ciphertext keeps its ORIGINAL scope until it is resealed.
type spaceConnectorInstallation struct {
	ID           string `gorm:"column:id;primaryKey"`
	TenantID     string `gorm:"column:tenant_id"`
	SpaceID      string `gorm:"column:space_id"`
	ConnectorRef string `gorm:"column:connector_ref"`
	Enabled      bool   `gorm:"column:enabled"`
	ConfigEnc    string `gorm:"column:config_enc"`
	CreatedAt    string `gorm:"column:created_at"`
	UpdatedAt    string `gorm:"column:updated_at"`
}

func (spaceConnectorInstallation) TableName() string { return "space_connector_installations" }

type legacySpaceConnector struct {
	ID              string `gorm:"column:id;primaryKey"`
	TenantID        string `gorm:"column:tenant_id"`
	SpaceID         string `gorm:"column:space_id"`
	AgentID         string `gorm:"column:agent_id"`
	ConnectorRef    string `gorm:"column:connector_ref"`
	Enabled         bool   `gorm:"column:enabled"`
	ConfigEnc       string `gorm:"column:config_enc"`
	SettingsEnc     string `gorm:"column:settings_enc"`
	EncryptionScope string `gorm:"column:encryption_scope"`
	SettingsScope   string `gorm:"column:settings_scope"`
	Resolved        bool   `gorm:"column:resolved"`
	CreatedAt       string `gorm:"column:created_at"`
	UpdatedAt       string `gorm:"column:updated_at"`
}

func (legacySpaceConnector) TableName() string { return "space_connector_legacy_installations" }

type connectorEnvelope struct {
	ProfileKey string         `json:"profileKey"`
	Config     map[string]any `json:"config"`
	Settings   map[string]any `json:"settings,omitempty"`
}

func connectorScope(tenant, space, ref string) string { return tenant + ":space:" + space + ":" + ref }

// New canonical Space rows are scope-authenticated; legacy TS scrypt payloads
// and early-Go v1 payloads remain readable through decrypt with exact old scope.
func sealSpaceConnector(secret []byte, scope string, raw []byte) (string, error) {
	key := sha256.Sum256(append(append([]byte{}, secret...), []byte(scope)...))
	block, e := aes.NewCipher(key[:])
	if e != nil {
		return "", e
	}
	gcm, e := cipher.NewGCM(block)
	if e != nil {
		return "", e
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return "", e
	}
	sealed := gcm.Seal(nonce, nonce, raw, []byte(scope))
	return "v1." + base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (h *handler) resourceSpace(r *http.Request, space, agent string) (string, error) {
	p := principal(r)
	if agent != "" {
		var row models.Agent
		if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", p.TenantID, agent).First(&row).Error; e != nil {
			return "", e
		}
		if space != "" && space != row.SpaceID {
			return "", httpx.ErrResourceScope
		}
		space = row.SpaceID
	}
	if e := httpx.AuthorizeResource(r.Context(), h.deps, p, space, agent); e != nil {
		return "", e
	}
	return space, nil
}
func (h *handler) authorizeChannel(r *http.Request, row remoteChannelRow) error {
	return httpx.AuthorizeResource(r.Context(), h.deps, principal(r), row.SpaceID, row.AgentID)
}
func (h *handler) requestedSpace(r *http.Request) (string, error) {
	space, agent := r.URL.Query().Get("spaceId"), r.URL.Query().Get("agentId")
	p := principal(r)
	if space == "" && agent == "" && p.APIKey {
		space, agent = p.SpaceID, p.AgentID
	}
	if space == "" && agent == "" {
		return "", nil
	}
	return h.resourceSpace(r, space, agent)
}
func (h *handler) allowedSpaces(r *http.Request) ([]string, error) {
	space, e := h.requestedSpace(r)
	if e != nil {
		return nil, e
	}
	if space != "" {
		if httpx.AuthorizeResource(r.Context(), h.deps, principal(r), space, "") != nil {
			return []string{}, nil
		}
		return []string{space}, nil
	}
	var rows []models.Space
	if e = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", principal(r).TenantID).Find(&rows).Error; e != nil {
		return nil, e
	}
	out := []string{}
	for _, row := range rows {
		if row.ID != nil && httpx.AuthorizeResource(r.Context(), h.deps, principal(r), *row.ID, "") == nil {
			out = append(out, *row.ID)
		}
	}
	return out, nil
}

// Archive first, then migrate only identical candidates. Conflicts and corrupt
// ciphertext remain intact and visible, never field-unioned or picked by age.
func (h *handler) migrateSpaceConnectors(ctx context.Context, tenant, space string) error {
	return h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var rows []models.AgentConnectorInstallation
		if e := tx.Table("agent_connector_installations AS i").Select("i.*").Joins("JOIN agents a ON a.id=i.agent_id AND a.tenant_id=i.tenant_id").Where("i.tenant_id = ? AND a.space_id = ?", tenant, space).Find(&rows).Error; e != nil {
			return e
		}
		for _, row := range rows {
			archived := legacySpaceConnector{ID: *row.ID, TenantID: tenant, SpaceID: space, AgentID: row.AgentID, ConnectorRef: row.ConnectorRef, Enabled: row.Enabled, ConfigEnc: row.ConfigEnc, EncryptionScope: tenant + ":" + row.AgentID + ":" + row.ConnectorRef, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
			for _, candidate := range legacyEmailRef(row.ConnectorRef) {
				var setting models.ConnectorSetting
				e := tx.Where("scope_key = ? AND connector_ref = ?", tenant, candidate).First(&setting).Error
				if errors.Is(e, gorm.ErrRecordNotFound) {
					continue
				}
				if e != nil {
					return e
				}
				archived.SettingsEnc = setting.ConfigEnc
				archived.SettingsScope = tenant + ":" + setting.ConnectorRef
				break
			}
			if e := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&archived).Error; e != nil {
				return e
			}
			if e := tx.Where("tenant_id = ? AND id = ?", tenant, *row.ID).Delete(&models.AgentConnectorInstallation{}).Error; e != nil {
				return e
			}
		}
		var archived []legacySpaceConnector
		if e := tx.Where("tenant_id = ? AND space_id = ? AND resolved = ?", tenant, space, false).Order("id").Find(&archived).Error; e != nil {
			return e
		}
		groups := map[string][]legacySpaceConnector{}
		for _, row := range archived {
			ref := canonicalRef(row.ConnectorRef)
			groups[ref] = append(groups[ref], row)
		}
		for ref, group := range groups {
			var existing spaceConnectorInstallation
			e := tx.Where("tenant_id = ? AND space_id = ? AND connector_ref = ?", tenant, space, ref).First(&existing).Error
			if e == nil {
				continue
			}
			if !errors.Is(e, gorm.ErrRecordNotFound) {
				return e
			}
			var first connectorEnvelope
			identical := true
			for i, row := range group {
				cfg, e := h.legacyEnvelope(row)
				if e != nil {
					identical = false
					break
				}
				if i == 0 {
					first = cfg
				} else if !reflect.DeepEqual(first, cfg) || row.Enabled != group[0].Enabled {
					identical = false
					break
				}
			}
			if !identical {
				continue
			}
			raw, e := json.Marshal(first)
			if e != nil {
				return e
			}
			enc, e := sealSpaceConnector(h.deps.Secret, connectorScope(tenant, space, ref), raw)
			if e != nil {
				return e
			}
			row := spaceConnectorInstallation{ID: h.id(), TenantID: tenant, SpaceID: space, ConnectorRef: ref, Enabled: group[0].Enabled, ConfigEnc: enc, CreatedAt: group[0].CreatedAt, UpdatedAt: group[0].UpdatedAt}
			if e := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; e != nil {
				return e
			}
			ids := []string{}
			for _, old := range group {
				ids = append(ids, old.ID)
			}
			if e := tx.Model(&legacySpaceConnector{}).Where("id IN ?", ids).Update("resolved", true).Error; e != nil {
				return e
			}
		}
		return nil
	})
}
func (h *handler) legacyEnvelope(row legacySpaceConnector) (connectorEnvelope, error) {
	var cfg connectorEnvelope
	raw := []byte(`{"config":{}}`)
	var e error
	if row.ConfigEnc != "" {
		raw, e = decrypt(h.deps.Secret, row.EncryptionScope, row.ConfigEnc)
	}
	if e != nil {
		return cfg, e
	}
	if e = json.Unmarshal(raw, &cfg); e != nil {
		return cfg, e
	}
	var original map[string]any
	if e = json.Unmarshal(raw, &original); e != nil || original == nil {
		return cfg, errors.New("invalid legacy connector configuration")
	}
	if _, wrapped := original["config"]; !wrapped {
		cfg.Config = original
		cfg.ProfileKey = ""
	}
	if row.SettingsEnc != "" {
		raw, e = decrypt(h.deps.Secret, row.SettingsScope, row.SettingsEnc)
		if e != nil {
			return cfg, e
		}
		if e = json.Unmarshal(raw, &cfg.Settings); e != nil {
			return cfg, e
		}
	}
	return cfg, nil
}
func (h *handler) spaceEnvelope(row spaceConnectorInstallation) (connectorEnvelope, error) {
	var cfg connectorEnvelope
	raw, e := decrypt(h.deps.Secret, connectorScope(row.TenantID, row.SpaceID, row.ConnectorRef), row.ConfigEnc)
	if e == nil {
		e = json.Unmarshal(raw, &cfg)
	}
	return cfg, e
}
func (h *handler) saveSpaceConnector(ctx context.Context, tenant, space, ref string, cfg connectorEnvelope, enabled bool) (spaceConnectorInstallation, error) {
	ref = canonicalRef(ref)
	raw, e := json.Marshal(cfg)
	if e != nil {
		return spaceConnectorInstallation{}, e
	}
	enc, e := sealSpaceConnector(h.deps.Secret, connectorScope(tenant, space, ref), raw)
	if e != nil {
		return spaceConnectorInstallation{}, e
	}
	now := h.now().Format(time.RFC3339Nano)
	row := spaceConnectorInstallation{ID: h.id(), TenantID: tenant, SpaceID: space, ConnectorRef: ref, Enabled: enabled, ConfigEnc: enc, CreatedAt: now, UpdatedAt: now}
	e = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if e := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "space_id"}, {Name: "connector_ref"}}, DoUpdates: clause.AssignmentColumns([]string{"enabled", "config_enc", "updated_at"})}).Create(&row).Error; e != nil {
			return e
		}
		// Explicit configuration is a user decision; archived alternatives remain.
		var old []legacySpaceConnector
		if e := tx.Where("tenant_id = ? AND space_id = ?", tenant, space).Find(&old).Error; e != nil {
			return e
		}
		for _, v := range old {
			if canonicalRef(v.ConnectorRef) == ref {
				if e := tx.Model(&legacySpaceConnector{}).Where("id = ?", v.ID).Update("resolved", true).Error; e != nil {
					return e
				}
			}
		}
		row = spaceConnectorInstallation{}
		return tx.Where("tenant_id = ? AND space_id = ? AND connector_ref = ?", tenant, space, ref).First(&row).Error
	})
	return row, e
}
func (h *handler) loadConnection(r *http.Request, id string) (spaceConnectorInstallation, error) {
	id = strings.TrimPrefix(id, "connector:")
	var row spaceConnectorInstallation
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, id).First(&row).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		// Old ID routes are adapters, not a second owner.
		var old legacySpaceConnector
		if e = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, id).First(&old).Error; e != nil {
			if !errors.Is(e, gorm.ErrRecordNotFound) {
				return row, e
			}
			var source models.AgentConnectorInstallation
			if e = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, id).First(&source).Error; e != nil {
				return row, e
			}
			space, e := h.resourceSpace(r, "", source.AgentID)
			if e != nil {
				return row, e
			}
			old = legacySpaceConnector{TenantID: source.TenantID, SpaceID: space, ConnectorRef: source.ConnectorRef}
		}
		if _, e = h.resourceSpace(r, old.SpaceID, ""); e != nil {
			return row, e
		}
		if e = h.migrateSpaceConnectors(r.Context(), old.TenantID, old.SpaceID); e != nil {
			return row, e
		}
		row = spaceConnectorInstallation{}
		e = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND space_id = ? AND connector_ref = ?", old.TenantID, old.SpaceID, canonicalRef(old.ConnectorRef)).First(&row).Error
	}
	if e != nil {
		return row, e
	}
	_, e = h.resourceSpace(r, row.SpaceID, "")
	return row, e
}
func connectionView(row spaceConnectorInstallation) map[string]any {
	meta, _ := provider(row.ConnectorRef)
	status := "disabled"
	if row.Enabled {
		status = "installed"
	}
	return map[string]any{"id": "connector:" + row.ID, "installationId": row.ID, "spaceId": row.SpaceID, "name": meta.Name, "kind": "platform", "status": status, "providerId": row.ConnectorRef, "connectorRef": row.ConnectorRef, "enabled": row.Enabled, "slug": row.ConnectorRef, "agentIds": []string{}, "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt}
}

func (h *handler) installTarget(r *http.Request, space string, agents []string) (string, error) {
	for _, agent := range agents {
		next, e := h.resourceSpace(r, space, agent)
		if e != nil {
			return "", e
		}
		space = next
	}
	return h.resourceSpace(r, space, "")
}
func (h *handler) authorizeInstance(r *http.Request, id string) (string, error) {
	var row models.ComponentInstance
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, id).First(&row).Error; e != nil {
		return "", e
	}
	var cfg map[string]any
	_ = json.Unmarshal([]byte(row.ConfigJSON), &cfg)
	space, _ := cfg["ownerSpaceId"].(string)
	if space != "" {
		return h.resourceSpace(r, space, "")
	}
	if row.AgentID != nil && *row.AgentID != "" {
		return h.resourceSpace(r, "", *row.AgentID)
	}
	return "", httpx.ErrResourceScope
}

// Tenant auth profiles remain tenant/platform-owned. A resource-bound key may
// use an authorized Space installation, but cannot administer tenant secrets.
func (h *handler) integrationResourceGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := principal(r)
		if p.APIKey && p.AgentID != "" && r.Method != "GET" && !(strings.HasPrefix(r.URL.Path, "/api/connectors/") && strings.HasSuffix(r.URL.Path, "/send")) {
			httpx.Error(w, 404, "Not found")
			return
		}
		if p.APIKey && (p.SpaceID != "" || p.AgentID != "") && (strings.HasPrefix(r.URL.Path, "/api/connectors/profiles") || strings.Contains(r.URL.Path, "/oauth/") || strings.HasPrefix(r.URL.Path, "/api/email-connectors") || strings.HasPrefix(r.URL.Path, "/api/connections/sources") && r.Method != "GET") {
			httpx.Error(w, 404, "Not found")
			return
		}
		if _, e := h.requestedSpace(r); e != nil {
			writeErr(w, e)
			return
		}
		next.ServeHTTP(w, r)
	})
}
