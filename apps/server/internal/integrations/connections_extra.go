// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (h *handler) setConnectionState(w http.ResponseWriter, r *http.Request, enabled bool) {
	p := principal(r)
	raw := chi.URLParam(r, "id")
	kind, id := "connector", strings.TrimPrefix(raw, "connector:")
	if strings.HasPrefix(raw, "instance:") {
		kind = "instance"
		id = strings.TrimPrefix(raw, "instance:")
	}
	now := h.now().Format(time.RFC3339Nano)
	var res *gorm.DB
	if kind == "connector" {
		res = h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentConnectorInstallation{}).
			Where("tenant_id = ? AND id = ?", p.TenantID, id).
			Updates(map[string]any{"enabled": enabled, "updated_at": now})
	} else {
		status := "stopped"
		if enabled {
			status = "running"
		}
		res = h.deps.Gorm.WithContext(r.Context()).Model(&models.ComponentInstance{}).
			Where("tenant_id = ? AND id = ?", p.TenantID, id).
			Updates(map[string]any{"status": status, "updated_at": now})
	}
	if res.Error != nil {
		writeErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "enabled": enabled})
}
func (h *handler) startConnection(w http.ResponseWriter, r *http.Request) {
	h.setConnectionState(w, r, true)
}
func (h *handler) stopConnection(w http.ResponseWriter, r *http.Request) {
	h.setConnectionState(w, r, false)
}
func (h *handler) installConnection(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct {
		Source, Kind, Name string
		AgentIDs           []string        `json:"agentIds"`
		Config             json.RawMessage `json:"config"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Source == "" || len(b.AgentIDs) == 0 {
		httpx.Error(w, 400, "source and agentIds required")
		return
	}
	ref := b.Source
	if validRef(ref) {
		installed := 0
		for _, agent := range b.AgentIDs {
			raw, _ := json.Marshal(map[string]any{"config": json.RawMessage(b.Config)})
			enc, _ := encrypt(h.deps.Secret, p.TenantID+":"+agent+":"+ref, raw)
			now := h.now().Format(time.RFC3339Nano)
			row := models.AgentConnectorInstallation{ID: strPtr(h.id()), TenantID: p.TenantID, AgentID: agent, ConnectorRef: ref, Enabled: true, ConfigEnc: enc, CreatedAt: now, UpdatedAt: now}
			if e := h.deps.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "agent_id"}, {Name: "connector_ref"}},
				DoUpdates: clause.AssignmentColumns([]string{"enabled", "config_enc", "updated_at"}),
			}).Create(&row).Error; e == nil {
				installed++
			}
		}
		meta, _ := provider(ref)
		httpx.JSON(w, http.StatusCreated, map[string]any{"result": map[string]any{"id": "connector:" + ref, "kind": "platform", "name": meta.Name, "status": "installed", "installed": installed}})
		return
	}
	if b.Kind == "mcp" || strings.HasPrefix(b.Source, "http://") || strings.HasPrefix(b.Source, "https://") {
		if _, e := safeURL(b.Source); e != nil {
			writeErr(w, e)
			return
		}
		cfg := map[string]any{"url": b.Source}
		secretValues := map[string]any{}
		if len(b.Config) > 0 {
			_ = json.Unmarshal(b.Config, &cfg)
			cfg["url"] = b.Source
		}
		for _, key := range []string{"token", "apiKey", "accessToken", "headers", "credentials", "secret"} {
			if value, ok := cfg[key]; ok {
				secretValues[key] = value
				delete(cfg, key)
			}
		}
		cfgRaw, _ := json.Marshal(cfg)
		now := h.now().Format(time.RFC3339Nano)
		created := []string{}
		for _, agent := range b.AgentIDs {
			id := h.id()
			secretRaw, _ := json.Marshal(secretValues)
			enc, encErr := encrypt(h.deps.Secret, "mcp:"+id, secretRaw)
			if encErr != nil {
				writeErr(w, encErr)
				return
			}
			secretStored, _ := json.Marshal(map[string]any{"enc": enc, "configured": len(secretValues) > 0})
			row := models.ComponentInstance{ID: strPtr(id), TenantID: p.TenantID, AgentID: strPtr(agent), ComponentType: "mcp", ComponentRef: slugifyLocal(b.Name), Name: b.Name, ConfigJSON: string(cfgRaw), SecretJSON: string(secretStored), Status: "ready", CreatedAt: now, UpdatedAt: now}
			if e := h.deps.Gorm.WithContext(r.Context()).Create(&row).Error; e == nil {
				created = append(created, id)
			}
		}
		if len(created) == 0 {
			httpx.Error(w, http.StatusBadRequest, "no eligible agents")
			return
		}
		result := map[string]any{"id": created[0], "instanceId": created[0], "instanceIds": created, "kind": "mcp-http", "name": b.Name, "status": "ready"}
		httpx.JSON(w, http.StatusCreated, map[string]any{"result": result})
		return
	}
	httpx.Error(w, 400, "unknown connector or MCP source")
}
func slugifyLocal(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	v = strings.NewReplacer(" ", "-", "/", "-", ":", "-").Replace(v)
	return strings.Trim(v, "-")
}
func (h *handler) createConnectionSource(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct{ Name, Description, Repository, Format string }
	if httpx.DecodeJSON(r, &b) != nil || b.Repository == "" {
		httpx.Error(w, 400, "repository required")
		return
	}
	if _, e := safeURL(b.Repository); e != nil {
		writeErr(w, e)
		return
	}
	if b.Name == "" {
		b.Name = b.Repository
	}
	if b.Format == "" {
		b.Format = "auto"
	}
	now := h.now().Format(time.RFC3339Nano)
	id := h.id()
	row := models.McpStoreSource{ID: strPtr(id), TenantID: p.TenantID, Name: b.Name, Description: b.Description, SourceURL: b.Repository, Format: b.Format, ManifestJSON: "{}", ServersJSON: "[]", Enabled: true, CreatedAt: now, UpdatedAt: now}
	if e := h.deps.Gorm.WithContext(r.Context()).Create(&row).Error; e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"source": map[string]any{"id": id, "name": b.Name, "sourceUrl": b.Repository, "format": b.Format}})
}
func (h *handler) deleteConnectionSource(w http.ResponseWriter, r *http.Request) {
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, chi.URLParam(r, "id")).Delete(&models.McpStoreSource{})
	if res.Error != nil {
		writeErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) listProviderCatalog(w http.ResponseWriter, r *http.Request) {
	items := make([]map[string]any, 0, len(providers))
	for _, p := range providers {
		items = append(items, map[string]any{"id": p.Ref, "name": p.Name, "description": p.Description, "category": p.Category, "capabilities": p.Capabilities, "authKind": p.AuthKind})
	}
	var rows []models.ProviderCatalog
	if e := h.deps.Gorm.WithContext(r.Context()).Where("enabled = true").Order("name").Find(&rows).Error; e == nil {
		for _, row := range rows {
			var meta map[string]any
			_ = json.Unmarshal([]byte(row.ManifestJSON), &meta)
			items = append(items, map[string]any{"id": *row.ID, "name": row.Name, "description": meta["description"], "category": row.Kind, "capabilities": meta["capabilities"], "configSchema": meta["configSchema"]})
		}
	}
	httpx.JSON(w, 200, map[string]any{"providers": items})
}
