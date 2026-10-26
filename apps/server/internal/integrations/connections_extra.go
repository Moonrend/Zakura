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
)

func (h *handler) setConnectionState(w http.ResponseWriter, r *http.Request, enabled bool) {
	raw := chi.URLParam(r, "id")
	if strings.HasPrefix(raw, "instance:") {
		id := strings.TrimPrefix(raw, "instance:")
		if _, e := h.authorizeInstance(r, id); e != nil {
			writeErr(w, e)
			return
		}
		if h.lifecycle == nil {
			httpx.Error(w, 503, "runtime lifecycle unavailable")
			return
		}
		var e error
		if enabled {
			e = h.lifecycle.Start(r.Context(), principal(r).TenantID, id)
		} else {
			e = h.lifecycle.Stop(r.Context(), principal(r).TenantID, id)
		}
		if e != nil {
			writeErr(w, e)
			return
		}
	} else {
		row, e := h.loadConnection(r, raw)
		if e != nil {
			writeErr(w, e)
			return
		}
		if e = h.deps.Gorm.WithContext(r.Context()).Model(&spaceConnectorInstallation{}).Where("tenant_id = ? AND id = ?", row.TenantID, row.ID).Updates(map[string]any{"enabled": enabled, "updated_at": h.now().Format(time.RFC3339Nano)}).Error; e != nil {
			writeErr(w, e)
			return
		}
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
		Source          string         `json:"source"`
		Ref             string         `json:"ref"`
		Kind            string         `json:"kind"`
		Name            string         `json:"name"`
		SpaceID         string         `json:"spaceId"`
		AgentIDs        []string       `json:"agentIds"`
		RuntimeNodeID   *string        `json:"runtimeNodeId"`
		CredentialScope string         `json:"credentialScope"`
		Config          map[string]any `json:"config"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Source == "" {
		httpx.Error(w, 400, "source required")
		return
	}
	space, e := h.installTarget(r, b.SpaceID, b.AgentIDs)
	if e != nil {
		writeErr(w, e)
		return
	}
	ref := b.Source
	if b.Ref != "" {
		ref = b.Ref
	}
	if validRef(ref) {
		if e = h.migrateSpaceConnectors(r.Context(), p.TenantID, space); e != nil {
			writeErr(w, e)
			return
		}
		row, e := h.saveSpaceConnector(r.Context(), p.TenantID, space, ref, connectorEnvelope{Config: b.Config}, true)
		if e != nil {
			writeErr(w, e)
			return
		}
		httpx.JSON(w, 201, map[string]any{"result": connectionView(row)})
		return
	}
	if b.Kind != "mcp" && b.Kind != "mcp-http" && !strings.HasPrefix(b.Source, "https://") && !strings.HasPrefix(b.Source, "http://") {
		httpx.Error(w, 400, "unknown connector or MCP source")
		return
	}
	if _, e = safeURL(b.Source); e != nil {
		writeErr(w, e)
		return
	}
	cfg := b.Config
	if cfg == nil {
		cfg = map[string]any{}
	}
	cfg["url"] = b.Source
	cfg["ownerSpaceId"] = space
	cfg["transport"] = "http"
	secrets := map[string]any{}
	for _, key := range []string{"token", "apiKey", "accessToken", "headers", "credentials", "secret"} {
		if value, ok := cfg[key]; ok {
			secrets[key] = value
			delete(cfg, key)
		}
	}
	id := h.id()
	secretRaw, _ := json.Marshal(secrets)
	enc, e := encrypt(h.deps.Secret, "mcp:"+id, secretRaw)
	if e != nil {
		writeErr(w, e)
		return
	}
	stored, _ := json.Marshal(map[string]any{"enc": enc, "configured": len(secrets) > 0})
	cfgRaw, _ := json.Marshal(cfg)
	now := h.now().Format(time.RFC3339Nano)
	name := strings.TrimSpace(b.Name)
	if name == "" {
		name = b.Source
	}
	row := models.ComponentInstance{ID: strPtr(id), TenantID: p.TenantID, ComponentType: "mcp", ComponentRef: slugifyLocal(name), Name: name, ConfigJSON: string(cfgRaw), SecretJSON: string(stored), Status: "stopped", CreatedAt: now, UpdatedAt: now}
	e = h.deps.Gorm.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		if e := tx.Create(&row).Error; e != nil {
			return e
		}
		return tx.Exec("INSERT INTO agent_bindings(id,tenant_id,space_id,agent_id,instance_id,created_at) VALUES(?,?,?,NULL,?,?)", h.id(), p.TenantID, space, id, now).Error
	})
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"result": map[string]any{"id": "instance:" + id, "instanceId": id, "spaceId": space, "kind": "mcp-http", "name": name, "status": "stopped"}})
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
	switch b.Format {
	case "auto", "codex", "claude", "mcp", "skill":
	default:
		httpx.Error(w, 400, "invalid format")
		return
	}
	now := h.now().Format(time.RFC3339Nano)
	id := h.id()
	row := models.McpStoreSource{ID: strPtr(id), TenantID: p.TenantID, Name: b.Name, Description: b.Description, SourceURL: b.Repository, Format: b.Format, ManifestJSON: "{}", ServersJSON: "[]", Enabled: true, CreatedAt: now, UpdatedAt: now}
	if e := h.deps.Gorm.WithContext(r.Context()).Create(&row).Error; e != nil {
		writeErr(w, e)
		return
	}
	description := b.Description
	if description == "" {
		description = "Custom source"
	}
	httpx.JSON(w, 201, map[string]any{"source": map[string]any{"id": id, "name": b.Name, "description": description, "kind": "custom", "format": b.Format, "url": b.Repository}})
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
