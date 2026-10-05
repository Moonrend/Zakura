// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
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
func (h *handler) listRemoteChannels(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), h.q(`SELECT id,space_id,agent_id,platform,profile_key,label,enabled,settings_json,created_at,updated_at FROM agent_channel_bindings WHERE tenant_id=? ORDER BY created_at DESC`), principal(r).TenantID)
	if e != nil {
		writeErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, space, agent, platform, profile, label, settings, c, u string
		var enabled bool
		if rows.Scan(&id, &space, &agent, &platform, &profile, &label, &enabled, &settings, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "spaceId": space, "agentId": agent, "platform": platform, "profileKey": profile, "label": label, "enabled": enabled, "settings": json.RawMessage(settings), "createdAt": c, "updatedAt": u})
		}
	}
	httpx.JSON(w, 200, map[string]any{"channels": out})
}
func (h *handler) createRemoteChannel(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AgentID, Platform, ProfileKey, Label string
		Enabled                              bool
		Settings, Config                     json.RawMessage
	}
	if httpx.DecodeJSON(r, &b) != nil || b.AgentID == "" || b.Platform == "" {
		httpx.Error(w, 400, "agentId and platform required")
		return
	}
	p := principal(r)
	var space string
	if e := h.deps.DB.QueryRowContext(r.Context(), h.q(`SELECT space_id FROM agents WHERE tenant_id=? AND id=?`), p.TenantID, b.AgentID).Scan(&space); e != nil {
		httpx.Error(w, 404, "Agent not found")
		return
	}
	id := h.id()
	enc, e := encrypt(h.deps.Secret, p.TenantID+":"+id, b.Config)
	if e != nil {
		writeErr(w, e)
		return
	}
	now := h.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO agent_channel_bindings(id,tenant_id,space_id,agent_id,platform,profile_key,label,enabled,settings_json,config_enc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`), id, p.TenantID, space, b.AgentID, b.Platform, b.ProfileKey, b.Label, b.Enabled, rawOr(b.Settings, "{}"), enc, now, now)
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"channel": map[string]any{"id": id, "spaceId": space, "agentId": b.AgentID, "platform": b.Platform, "profileKey": b.ProfileKey, "label": b.Label, "enabled": b.Enabled}})
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
	sets := []string{}
	args := []any{}
	for k, col := range map[string]string{"label": "label", "enabled": "enabled", "profileKey": "profile_key", "settings": "settings_json"} {
		if v, ok := m[k]; ok {
			if k == "settings" {
				raw, _ := json.Marshal(v)
				v = string(raw)
			}
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if v, ok := m["config"]; ok {
		raw, _ := json.Marshal(v)
		enc, e := encrypt(h.deps.Secret, p.TenantID+":"+id, raw)
		if e != nil {
			writeErr(w, e)
			return
		}
		sets = append(sets, "config_enc=?")
		args = append(args, enc)
	}
	if len(sets) == 0 {
		httpx.Error(w, 400, "no supported fields")
		return
	}
	sets = append(sets, "updated_at=?")
	args = append(args, h.now(), p.TenantID, id)
	res, e := h.deps.DB.ExecContext(r.Context(), h.q(`UPDATE agent_channel_bindings SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`), args...)
	if e != nil {
		writeErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func decodeObject(r *http.Request) (map[string]any, error) {
	var m map[string]any
	e := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 2<<20)).Decode(&m)
	return m, e
}
func (h *handler) deleteRemoteChannel(w http.ResponseWriter, r *http.Request) {
	res, e := h.deps.DB.ExecContext(r.Context(), h.q(`DELETE FROM agent_channel_bindings WHERE tenant_id=? AND id=?`), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		writeErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) setChannelEnabled(w http.ResponseWriter, r *http.Request, enabled bool) {
	res, e := h.deps.DB.ExecContext(r.Context(), h.q(`UPDATE agent_channel_bindings SET enabled=?,updated_at=? WHERE tenant_id=? AND id=?`), enabled, h.now(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		writeErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "enabled": enabled})
}
func (h *handler) approveRemoteChannel(w http.ResponseWriter, r *http.Request) {
	h.setChannelEnabled(w, r, true)
}
func (h *handler) denyRemoteChannel(w http.ResponseWriter, r *http.Request) {
	h.setChannelEnabled(w, r, false)
}
func (h *handler) remoteWebhook(w http.ResponseWriter, r *http.Request) {
	tenant, binding := chi.URLParam(r, "tenantId"), chi.URLParam(r, "bindingId")
	var platform, agent, enc string
	var enabled bool
	e := h.deps.DB.QueryRowContext(r.Context(), h.q(`SELECT platform,agent_id,config_enc,enabled FROM agent_channel_bindings WHERE tenant_id=? AND id=?`), tenant, binding).Scan(&platform, &agent, &enc, &enabled)
	if e != nil || !enabled {
		httpx.Error(w, 404, "Channel not found")
		return
	}
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if e != nil {
		httpx.Error(w, 413, "payload too large")
		return
	}
	configRaw, e := decrypt(h.deps.Secret, tenant+":"+binding, enc)
	if e != nil {
		httpx.Error(w, 401, "invalid channel configuration")
		return
	}
	var cfg map[string]any
	_ = json.Unmarshal(configRaw, &cfg)
	if !verifyWebhook(platform, cfg, r.Header, raw) {
		httpx.Error(w, 401, "invalid signature")
		return
	}
	external := r.Header.Get("X-Event-Id")
	if external == "" {
		sum := sha256.Sum256(raw)
		external = hex.EncodeToString(sum[:])
	}
	res, e := h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO agent_channel_events(id,tenant_id,binding_id,external_event_id,received_at) VALUES(?,?,?,?,?) ON CONFLICT(binding_id,external_event_id) DO NOTHING`), h.id(), tenant, binding, external, h.now())
	if e != nil {
		writeErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.JSON(w, 202, map[string]any{"accepted": true, "duplicate": true})
		return
	}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	payload["agentId"] = agent
	payloadRaw, _ := json.Marshal(payload)
	_, e = h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO channel_events(id,tenant_id,provider,external_id,payload_json,delivery_status,attempts,last_error,created_at,processed_at) VALUES(?,?,?,?,?,'pending',0,NULL,?,NULL) ON CONFLICT(provider,external_id) DO NOTHING`), h.id(), tenant, platform, binding+":"+external, string(payloadRaw), h.now())
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 202, map[string]any{"accepted": true, "externalId": external})
}

func (h *handler) listEmailConnectors(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), h.q(`SELECT id,name,product,enabled,created_at,updated_at FROM email_connector_instances WHERE tenant_id=? ORDER BY created_at DESC`), principal(r).TenantID)
	if e != nil {
		writeErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, name, product, c, u string
		var enabled bool
		if rows.Scan(&id, &name, &product, &enabled, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "name": name, "product": product, "enabled": enabled, "createdAt": c, "updatedAt": u})
		}
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
	now := h.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO email_connector_instances(id,tenant_id,name,product,enabled,config_enc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`), id, p.TenantID, b.Name, b.Product, b.Enabled, enc, now, now)
	if e != nil {
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
	sets := []string{}
	args := []any{}
	for k, col := range map[string]string{"name": "name", "product": "product", "enabled": "enabled"} {
		if v, ok := m[k]; ok {
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if v, ok := m["config"]; ok {
		raw, _ := json.Marshal(v)
		enc, e := encrypt(h.deps.Secret, p.TenantID+":email:"+id, raw)
		if e != nil {
			writeErr(w, e)
			return
		}
		sets = append(sets, "config_enc=?")
		args = append(args, enc)
	}
	if len(sets) == 0 {
		httpx.Error(w, 400, "no supported fields")
		return
	}
	sets = append(sets, "updated_at=?")
	args = append(args, h.now(), p.TenantID, id)
	res, e := h.deps.DB.ExecContext(r.Context(), h.q(`UPDATE email_connector_instances SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`), args...)
	if e != nil {
		writeErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) deleteEmailConnector(w http.ResponseWriter, r *http.Request) {
	res, e := h.deps.DB.ExecContext(r.Context(), h.q(`DELETE FROM email_connector_instances WHERE tenant_id=? AND id=?`), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		writeErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) emailInbound(w http.ResponseWriter, r *http.Request) {
	tenant, id := chi.URLParam(r, "tenantId"), chi.URLParam(r, "connectorId")
	q := `SELECT id,config_enc FROM email_connector_instances WHERE tenant_id=? AND enabled=true`
	args := []any{tenant}
	if id != "" {
		q += ` AND id=?`
		args = append(args, id)
	}
	q += ` ORDER BY created_at LIMIT 1`
	var connector, enc string
	e := h.deps.DB.QueryRowContext(r.Context(), h.q(q), args...).Scan(&connector, &enc)
	if errors.Is(e, sql.ErrNoRows) {
		httpx.Error(w, 404, "Email connector not found")
		return
	}
	if e != nil {
		writeErr(w, e)
		return
	}
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 10<<20))
	if e != nil {
		httpx.Error(w, 413, "payload too large")
		return
	}
	cfgRaw, e := decrypt(h.deps.Secret, tenant+":email:"+connector, enc)
	if e != nil {
		httpx.Error(w, 401, "invalid connector configuration")
		return
	}
	var cfg map[string]any
	_ = json.Unmarshal(cfgRaw, &cfg)
	secret, _ := cfg["webhookSecret"].(string)
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
	agent, _ := cfg["agentId"].(string)
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
	_, e = h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO channel_events(id,tenant_id,provider,external_id,payload_json,delivery_status,attempts,last_error,created_at,processed_at) VALUES(?,?,'email',?,?,'pending',0,NULL,?,NULL) ON CONFLICT(provider,external_id) DO NOTHING`), h.id(), tenant, eventID, string(eventRaw), h.now())
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 202, map[string]any{"accepted": true, "externalId": eventID})
}
