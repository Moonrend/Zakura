// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (h *handler) registerChannels(r chi.Router) {
	r.Get("/api/remote-channels", h.listRemoteChannels)
	r.Post("/api/remote-channels", h.createRemoteChannel)
	r.Patch("/api/remote-channels/{id}", h.patchRemoteChannel)
	r.Delete("/api/remote-channels/{id}", h.deleteRemoteChannel)
	r.Post("/api/remote-channels/{id}/access/approve", h.approveRemoteChannel)
	r.Post("/api/remote-channels/{id}/access/deny", h.denyRemoteChannel)
	r.Get("/api/email-connectors", h.listEmailConnectors)
	r.Post("/api/email-connectors", h.createEmailConnector)
	r.Patch("/api/email-connectors/{id}", h.patchEmailConnector)
	r.Delete("/api/email-connectors/{id}", h.deleteEmailConnector)
}

var remotePlatforms = func() []string {
	out := make([]string, 0, len(providers))
	for _, p := range providers {
		if strings.HasPrefix(p.Ref, "remote-") {
			out = append(out, strings.TrimPrefix(p.Ref, "remote-"))
		}
	}
	return out
}()

func isRemotePlatform(platform string) bool {
	for _, p := range remotePlatforms {
		if p == platform {
			return true
		}
	}
	return false
}

type remoteChannelRow struct {
	ID, SpaceID, AgentID, Platform, ProfileKey, Label string
	SettingsJSON, ConfigEnc, CreatedAt, UpdatedAt     string
	Enabled                                           bool
}

func (h *handler) bindingView(tenant string, row remoteChannelRow) map[string]any {
	settingsObj := map[string]any{}
	if json.Unmarshal([]byte(row.SettingsJSON), &settingsObj) != nil {
		settingsObj = map[string]any{}
	}
	fields := []string{}
	if row.ConfigEnc != "" {
		if raw, de := decrypt(h.deps.Secret, tenant+":"+row.ID, row.ConfigEnc); de == nil {
			var cfg map[string]any
			if json.Unmarshal(raw, &cfg) == nil {
				for k, v := range cfg {
					if v != nil && v != "" {
						fields = append(fields, k)
					}
				}
			}
		}
	}
	return map[string]any{
		"id": row.ID, "agentId": row.AgentID, "platform": row.Platform, "profileKey": row.ProfileKey, "label": row.Label,
		"enabled": row.Enabled, "settings": settingsObj,
		"credentialsEnabled": row.ConfigEnc != "", "configuredFields": fields,
		"createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

func bindingRow(b models.AgentChannelBinding) remoteChannelRow {
	return remoteChannelRow{
		ID: *b.ID, SpaceID: b.SpaceID, AgentID: b.AgentID, Platform: b.Platform, ProfileKey: b.ProfileKey, Label: b.Label,
		Enabled: b.Enabled, SettingsJSON: b.SettingsJSON, ConfigEnc: b.ConfigEnc, CreatedAt: b.CreatedAt, UpdatedAt: b.UpdatedAt,
	}
}

func (h *handler) loadRemoteChannelRow(ctx context.Context, tenant, id string) (remoteChannelRow, error) {
	var row models.AgentChannelBinding
	e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND id = ?", tenant, id).First(&row).Error
	if e != nil {
		return remoteChannelRow{}, e
	}
	return bindingRow(row), nil
}

func emptyCredentials(raw json.RawMessage) bool {
	if len(raw) == 0 || !json.Valid(raw) {
		return true
	}
	switch strings.TrimSpace(string(raw)) {
	case "", "{}", "null":
		return true
	}
	return false
}

func asAnySlice(v any) []any {
	if arr, ok := v.([]any); ok {
		return arr
	}
	return []any{}
}

func pendingUserKey(entry any) string {
	switch t := entry.(type) {
	case string:
		return strings.TrimSpace(t)
	case map[string]any:
		if s, ok := t["userKey"].(string); ok {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func (h *handler) listRemoteChannels(w http.ResponseWriter, r *http.Request) {
	tenant := principal(r).TenantID
	var rows []models.AgentChannelBinding
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", tenant).Order("created_at DESC").Find(&rows).Error; e != nil {
		writeErr(w, e)
		return
	}
	out := make([]map[string]any, 0)
	for _, row := range rows {
		out = append(out, h.bindingView(tenant, bindingRow(row)))
	}
	base := strings.TrimRight(h.deps.PublicURL, "/")
	httpx.JSON(w, 200, map[string]any{
		"platforms":       remotePlatforms,
		"initialized":     true,
		"webhookBaseUrl":  base + "/api/remote-channels/" + tenant,
		"emailWebhookUrl": base + "/api/email/inbound/" + tenant,
		"bindings":        out,
	})
}
func (h *handler) createRemoteChannel(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AgentID            string          `json:"agentId"`
		Platform           string          `json:"platform"`
		ProfileKey         string          `json:"profileKey"`
		Label              string          `json:"label"`
		Enabled            bool            `json:"enabled"`
		Settings           json.RawMessage `json:"settings"`
		Credentials        json.RawMessage `json:"credentials"`
		CredentialsEnabled *bool           `json:"credentialsEnabled"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.AgentID == "" || b.Platform == "" {
		httpx.Error(w, 400, "agentId and platform required")
		return
	}
	if !isRemotePlatform(b.Platform) {
		httpx.Error(w, 400, "不支持的远程平台")
		return
	}
	p := principal(r)
	var agent models.Agent
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", p.TenantID, b.AgentID).First(&agent).Error; e != nil {
		httpx.Error(w, 404, "Agent not found")
		return
	}
	space := agent.SpaceID
	id := h.id()
	profileKey := b.ProfileKey
	if profileKey == "" {
		profileKey = "remote-" + b.Platform
	}
	configEnc := ""
	if !emptyCredentials(b.Credentials) && (b.CredentialsEnabled == nil || *b.CredentialsEnabled) {
		enc, e := encrypt(h.deps.Secret, p.TenantID+":"+id, b.Credentials)
		if e != nil {
			writeErr(w, e)
			return
		}
		configEnc = enc
	}
	now := h.now().Format(time.RFC3339Nano)
	create := models.AgentChannelBinding{ID: strPtr(id), TenantID: p.TenantID, SpaceID: space, AgentID: b.AgentID, Platform: b.Platform, ProfileKey: profileKey, Label: b.Label, Enabled: b.Enabled, SettingsJSON: rawOr(b.Settings, "{}"), ConfigEnc: configEnc, CreatedAt: now, UpdatedAt: now}
	if e := h.deps.Gorm.WithContext(r.Context()).Create(&create).Error; e != nil {
		writeErr(w, e)
		return
	}
	row, e := h.loadRemoteChannelRow(r.Context(), p.TenantID, id)
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"binding": h.bindingView(p.TenantID, row)})
}
func rawOr(raw json.RawMessage, fallback string) string {
	if len(raw) > 0 && json.Valid(raw) {
		return string(raw)
	}
	return fallback
}
func (h *handler) patchRemoteChannel(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	m, e := decodeObject(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	updates := map[string]any{}
	for k, col := range map[string]string{"label": "label", "enabled": "enabled", "profileKey": "profile_key", "settings": "settings_json"} {
		if v, ok := m[k]; ok {
			if k == "settings" {
				raw, _ := json.Marshal(v)
				v = string(raw)
			}
			updates[col] = v
		}
	}
	if v, ok := m["config"]; ok {
		raw, _ := json.Marshal(v)
		enc, e := encrypt(h.deps.Secret, p.TenantID+":"+id, raw)
		if e != nil {
			writeErr(w, e)
			return
		}
		updates["config_enc"] = enc
	}
	if _, hasCreds := m["credentials"]; hasCreds {
		creds := mustJSON(m["credentials"])
		enabled := true
		if v, ok := m["credentialsEnabled"]; ok {
			if bv, ok := v.(bool); ok {
				enabled = bv
			}
		}
		if !enabled {
			updates["config_enc"] = ""
		} else if !emptyCredentials(creds) {
			enc, e := encrypt(h.deps.Secret, p.TenantID+":"+id, creds)
			if e != nil {
				writeErr(w, e)
				return
			}
			updates["config_enc"] = enc
		}
	} else if v, ok := m["credentialsEnabled"]; ok {
		if bv, ok := v.(bool); ok && !bv {
			updates["config_enc"] = ""
		}
	}
	if len(updates) == 0 {
		httpx.Error(w, 400, "no supported fields")
		return
	}
	updates["updated_at"] = h.now().Format(time.RFC3339Nano)
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentChannelBinding{}).Where("tenant_id = ? AND id = ?", p.TenantID, id).Updates(updates)
	if res.Error != nil {
		writeErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	row, e := h.loadRemoteChannelRow(r.Context(), p.TenantID, id)
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"binding": h.bindingView(p.TenantID, row)})
}
func mustJSON(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	raw, e := json.Marshal(v)
	if e != nil {
		return nil
	}
	return raw
}
func decodeObject(r *http.Request) (map[string]any, error) {
	var m map[string]any
	e := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 2<<20)).Decode(&m)
	return m, e
}
func (h *handler) deleteRemoteChannel(w http.ResponseWriter, r *http.Request) {
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, chi.URLParam(r, "id")).Delete(&models.AgentChannelBinding{})
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
func (h *handler) approveRemoteChannel(w http.ResponseWriter, r *http.Request) {
	h.updateRemoteChannelAccess(w, r, true)
}
func (h *handler) denyRemoteChannel(w http.ResponseWriter, r *http.Request) {
	h.updateRemoteChannelAccess(w, r, false)
}
func (h *handler) updateRemoteChannelAccess(w http.ResponseWriter, r *http.Request, approve bool) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	var b struct {
		UserKey string `json:"userKey"`
	}
	if httpx.DecodeJSON(r, &b) != nil || strings.TrimSpace(b.UserKey) == "" {
		httpx.Error(w, 400, "userKey 必填")
		return
	}
	key := strings.TrimSpace(b.UserKey)
	row, e := h.loadRemoteChannelRow(r.Context(), p.TenantID, id)
	if e != nil {
		writeErr(w, e)
		return
	}
	settings := map[string]any{}
	_ = json.Unmarshal([]byte(row.SettingsJSON), &settings)
	allowed := []string{}
	for _, v := range asAnySlice(settings["allowedUsers"]) {
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" && !strings.EqualFold(s, key) {
			allowed = append(allowed, s)
		}
	}
	if approve {
		allowed = append(allowed, key)
	}
	kept := make([]any, 0)
	for _, entry := range asAnySlice(settings["pendingUsers"]) {
		if strings.EqualFold(pendingUserKey(entry), key) {
			continue
		}
		kept = append(kept, entry)
	}
	settings["allowedUsers"] = allowed
	settings["pendingUsers"] = kept
	raw, _ := json.Marshal(settings)
	e = h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentChannelBinding{}).
		Where("tenant_id = ? AND id = ?", p.TenantID, id).
		Updates(map[string]any{"settings_json": string(raw), "updated_at": h.now().Format(time.RFC3339Nano)}).Error
	if e != nil {
		writeErr(w, e)
		return
	}
	updated, e := h.loadRemoteChannelRow(r.Context(), p.TenantID, id)
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "binding": h.bindingView(p.TenantID, updated), "settings": settings})
}
func (h *handler) remoteWebhook(w http.ResponseWriter, r *http.Request) {
	tenant, bindingID := chi.URLParam(r, "tenantId"), chi.URLParam(r, "bindingId")
	var binding models.AgentChannelBinding
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", tenant, bindingID).First(&binding).Error
	if e != nil || !binding.Enabled {
		httpx.Error(w, 404, "Channel not found")
		return
	}
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if e != nil {
		httpx.Error(w, 413, "payload too large")
		return
	}
	configRaw, e := decrypt(h.deps.Secret, tenant+":"+bindingID, binding.ConfigEnc)
	if e != nil {
		httpx.Error(w, 401, "invalid channel configuration")
		return
	}
	var cfg map[string]any
	_ = json.Unmarshal(configRaw, &cfg)
	if !verifyWebhook(binding.Platform, cfg, r.Header, raw) {
		httpx.Error(w, 401, "invalid signature")
		return
	}
	external := r.Header.Get("X-Event-Id")
	if external == "" {
		sum := sha256.Sum256(raw)
		external = hex.EncodeToString(sum[:])
	}
	res := h.deps.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "binding_id"}, {Name: "external_event_id"}}, DoNothing: true}).Create(&models.AgentChannelEvent{ID: strPtr(h.id()), TenantID: tenant, BindingID: bindingID, ExternalEventID: external, ReceivedAt: h.now().Format(time.RFC3339Nano)})
	if res.Error != nil {
		writeErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		httpx.JSON(w, 202, map[string]any{"accepted": true, "duplicate": true})
		return
	}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	payload["agentId"] = binding.AgentID
	payloadRaw, _ := json.Marshal(payload)
	event := models.ChannelEvent{ID: strPtr(h.id()), TenantID: tenant, Provider: binding.Platform, ExternalID: bindingID + ":" + external, PayloadJSON: string(payloadRaw), DeliveryStatus: "pending", Attempts: 0, CreatedAt: h.now().Format(time.RFC3339Nano)}
	e = h.deps.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "provider"}, {Name: "external_id"}}, DoNothing: true}).Create(&event).Error
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 202, map[string]any{"accepted": true, "externalId": external})
}

func (h *handler) listEmailConnectors(w http.ResponseWriter, r *http.Request) {
	var rows []models.EmailConnectorInstance
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", principal(r).TenantID).Order("created_at DESC").Find(&rows).Error; e != nil {
		writeErr(w, e)
		return
	}
	out := make([]map[string]any, 0)
	for _, row := range rows {
		out = append(out, map[string]any{"id": *row.ID, "name": row.Name, "product": row.Product, "enabled": row.Enabled, "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt})
	}
	httpx.JSON(w, 200, map[string]any{"connectors": out})
}
func (h *handler) createEmailConnector(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct {
		Name, Product string
		Enabled       bool
		Config        json.RawMessage
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Name == "" || b.Product == "" {
		httpx.Error(w, 400, "name and product required")
		return
	}
	id := h.id()
	enc, e := encrypt(h.deps.Secret, p.TenantID+":email:"+id, b.Config)
	if e != nil {
		writeErr(w, e)
		return
	}
	now := h.now().Format(time.RFC3339Nano)
	row := models.EmailConnectorInstance{ID: strPtr(id), TenantID: p.TenantID, Name: b.Name, Product: b.Product, Enabled: b.Enabled, ConfigEnc: enc, CreatedAt: now, UpdatedAt: now}
	if e = h.deps.Gorm.WithContext(r.Context()).Create(&row).Error; e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"connector": map[string]any{"id": id, "name": b.Name, "product": b.Product, "enabled": b.Enabled}})
}
func (h *handler) patchEmailConnector(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	m, e := decodeObject(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	updates := map[string]any{}
	for k, col := range map[string]string{"name": "name", "product": "product", "enabled": "enabled"} {
		if v, ok := m[k]; ok {
			updates[col] = v
		}
	}
	if v, ok := m["config"]; ok {
		raw, _ := json.Marshal(v)
		enc, e := encrypt(h.deps.Secret, p.TenantID+":email:"+id, raw)
		if e != nil {
			writeErr(w, e)
			return
		}
		updates["config_enc"] = enc
	}
	if len(updates) == 0 {
		httpx.Error(w, 400, "no supported fields")
		return
	}
	updates["updated_at"] = h.now().Format(time.RFC3339Nano)
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.EmailConnectorInstance{}).Where("tenant_id = ? AND id = ?", p.TenantID, id).Updates(updates)
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
func (h *handler) deleteEmailConnector(w http.ResponseWriter, r *http.Request) {
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, chi.URLParam(r, "id")).Delete(&models.EmailConnectorInstance{})
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
func emailProductForRef(ref string) (string, bool) {
	p, ok := provider(ref)
	if !ok || !strings.HasPrefix(p.Ref, "email-") {
		return "", false
	}
	return strings.TrimPrefix(p.Ref, "email-"), true
}
func (h *handler) emailInbound(w http.ResponseWriter, r *http.Request) {
	tenant, id := chi.URLParam(r, "tenantId"), chi.URLParam(r, "connectorId")
	q := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND enabled = true", tenant)
	if id != "" {
		if product, ok := emailProductForRef(id); ok {
			q = q.Where("product = ?", product)
		} else {
			q = q.Where("id = ?", id)
		}
	}
	var connector models.EmailConnectorInstance
	e := q.Order("created_at").First(&connector).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		httpx.Error(w, 404, "Email connector not found")
		return
	}
	if e != nil {
		writeErr(w, e)
		return
	}
	enc := connector.ConfigEnc
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 10<<20))
	if e != nil {
		httpx.Error(w, 413, "payload too large")
		return
	}
	cfgRaw, e := decrypt(h.deps.Secret, tenant+":email:"+*connector.ID, enc)
	if e != nil {
		httpx.Error(w, 401, "invalid connector configuration")
		return
	}
	var cfg map[string]any
	_ = json.Unmarshal(cfgRaw, &cfg)
	secret, _ := cfg["inboundSecret"].(string)
	if secret == "" {
		secret, _ = cfg["webhookSecret"].(string)
	}
	sig := strings.TrimPrefix(r.Header.Get("X-Zakura-Signature"), "sha256=")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(raw)
	if secret == "" || !hmac.Equal([]byte(sig), []byte(hex.EncodeToString(mac.Sum(nil)))) {
		httpx.Error(w, 401, "invalid signature")
		return
	}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	agent, _ := cfg["inboundAgentId"].(string)
	if agent == "" {
		agent, _ = cfg["agentId"].(string)
	}
	if agent == "" {
		httpx.Error(w, 400, "email connector has no agentId")
		return
	}
	payload["agentId"] = agent
	eventID := r.Header.Get("Message-Id")
	if eventID == "" {
		sum := sha256.Sum256(raw)
		eventID = hex.EncodeToString(sum[:])
	}
	eventRaw, _ := json.Marshal(payload)
	event := models.ChannelEvent{ID: strPtr(h.id()), TenantID: tenant, Provider: "email", ExternalID: eventID, PayloadJSON: string(eventRaw), DeliveryStatus: "pending", Attempts: 0, CreatedAt: h.now().Format(time.RFC3339Nano)}
	e = h.deps.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "provider"}, {Name: "external_id"}}, DoNothing: true}).Create(&event).Error
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 202, map[string]any{"accepted": true, "externalId": eventID})
}
