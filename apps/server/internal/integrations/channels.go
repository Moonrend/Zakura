// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"bytes"
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
		"id": row.ID, "spaceId": row.SpaceID, "agentId": row.AgentID, "platform": row.Platform, "profileKey": row.ProfileKey, "label": row.Label,
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

type remoteSender struct {
	UserKey     string
	Email       string
	DisplayName string
}

func webhookObject(raw []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var payload map[string]any
	if e := decoder.Decode(&payload); e != nil || payload == nil {
		if e == nil {
			e = errors.New("JSON object required")
		}
		return nil, e
	}
	var extra any
	if e := decoder.Decode(&extra); !errors.Is(e, io.EOF) {
		if e == nil {
			e = errors.New("multiple JSON values")
		}
		return nil, e
	}
	return payload, nil
}

func objectValue(values map[string]any, key string) map[string]any {
	value, _ := values[key].(map[string]any)
	return value
}

func firstObject(value any) map[string]any {
	items, _ := value.([]any)
	if len(items) == 0 {
		return nil
	}
	item, _ := items[0].(map[string]any)
	return item
}

func identityValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
}

func senderFromObject(values map[string]any, idKeys, emailKeys, nameKeys []string) remoteSender {
	if values == nil {
		return remoteSender{}
	}
	sender := remoteSender{}
	for _, key := range idKeys {
		if sender.UserKey = identityValue(values[key]); sender.UserKey != "" {
			break
		}
	}
	for _, key := range emailKeys {
		if sender.Email = identityValue(values[key]); sender.Email != "" {
			break
		}
	}
	for _, key := range nameKeys {
		if sender.DisplayName = identityValue(values[key]); sender.DisplayName != "" {
			break
		}
	}
	if sender.UserKey == "" {
		sender.UserKey = sender.Email
	}
	return sender
}

func remoteWebhookSender(platform string, payload map[string]any) (remoteSender, bool) {
	var sender remoteSender
	switch platform {
	case "zakurabot":
		sender = senderFromObject(payload, []string{"senderId", "userId"}, []string{"email"}, []string{"senderName", "userName"})
	case "slack":
		event := objectValue(payload, "event")
		sender = senderFromObject(event, []string{"user"}, nil, nil)
		if sender.UserKey == "" {
			sender = senderFromObject(objectValue(payload, "user"), []string{"id"}, []string{"email"}, []string{"name", "real_name"})
		}
	case "teams":
		sender = senderFromObject(objectValue(payload, "from"), []string{"id", "aadObjectId"}, []string{"email"}, []string{"name"})
	case "gchat":
		sender = senderFromObject(objectValue(objectValue(payload, "message"), "sender"), []string{"name"}, []string{"email"}, []string{"displayName"})
		if sender.UserKey == "" {
			sender = senderFromObject(objectValue(payload, "user"), []string{"name"}, []string{"email"}, []string{"displayName"})
		}
	case "discord":
		sender = senderFromObject(objectValue(objectValue(payload, "member"), "user"), []string{"id"}, nil, []string{"global_name", "username"})
		if sender.UserKey == "" {
			sender = senderFromObject(objectValue(payload, "author"), []string{"id"}, nil, []string{"global_name", "username"})
		}
		if sender.UserKey == "" {
			sender = senderFromObject(objectValue(payload, "user"), []string{"id"}, nil, []string{"global_name", "username"})
		}
	case "telegram":
		for _, key := range []string{"message", "edited_message", "channel_post", "edited_channel_post"} {
			sender = senderFromObject(objectValue(objectValue(payload, key), "from"), []string{"id"}, nil, []string{"username", "first_name"})
			if sender.UserKey != "" {
				break
			}
		}
		if sender.UserKey == "" {
			sender = senderFromObject(objectValue(objectValue(payload, "callback_query"), "from"), []string{"id"}, nil, []string{"username", "first_name"})
		}
	case "github":
		sender = senderFromObject(objectValue(payload, "sender"), []string{"id"}, []string{"email"}, []string{"login"})
	case "linear":
		sender = senderFromObject(objectValue(payload, "actor"), []string{"id"}, []string{"email"}, []string{"name"})
	case "whatsapp":
		entry := firstObject(payload["entry"])
		change := firstObject(entry["changes"])
		value := objectValue(change, "value")
		message := firstObject(value["messages"])
		sender = senderFromObject(message, []string{"from"}, nil, nil)
		if contact := firstObject(value["contacts"]); contact != nil {
			if sender.UserKey == "" {
				sender.UserKey = identityValue(contact["wa_id"])
			}
			sender.DisplayName = identityValue(objectValue(contact, "profile")["name"])
		}
	case "twilio":
		sender = senderFromObject(payload, []string{"From", "from"}, nil, nil)
	case "messenger":
		entry := firstObject(payload["entry"])
		message := firstObject(entry["messaging"])
		sender = senderFromObject(objectValue(message, "sender"), []string{"id"}, nil, nil)
	case "resend":
		data := objectValue(payload, "data")
		sender = senderFromObject(data, []string{"from"}, []string{"from"}, nil)
		address := emailAddress(sender.UserKey)
		sender.UserKey, sender.Email = address, address
	case "webex":
		data := objectValue(payload, "data")
		sender = senderFromObject(data, []string{"personId"}, []string{"personEmail"}, []string{"personDisplayName"})
	case "mattermost":
		sender = senderFromObject(payload, []string{"user_id", "userId"}, []string{"user_email"}, []string{"user_name", "userName"})
	case "weixin":
		sender = senderFromObject(payload, []string{"from_user_id", "fromUserId", "senderId"}, nil, []string{"from_user_name", "fromUserName"})
		if sender.UserKey == "" {
			sender = senderFromObject(objectValue(payload, "from"), []string{"id", "userId"}, nil, []string{"name"})
		}
	}
	sender.UserKey = strings.TrimSpace(sender.UserKey)
	return sender, sender.UserKey != ""
}

func remoteChannelAllowsAll(settings map[string]any) (bool, error) {
	if raw, ok := settings["allowAll"]; ok {
		allowAll, valid := raw.(bool)
		if !valid {
			return false, errors.New("invalid allowAll setting")
		}
		return allowAll, nil
	}
	return false, nil
}

func remoteSenderAllowed(settings map[string]any, sender remoteSender) (bool, error) {
	raw, ok := settings["allowedUsers"]
	if !ok {
		return false, nil
	}
	allowed, valid := raw.([]any)
	if !valid {
		return false, errors.New("invalid allowedUsers setting")
	}
	for _, value := range allowed {
		key, valid := value.(string)
		if !valid {
			return false, errors.New("invalid allowedUsers entry")
		}
		if strings.EqualFold(strings.TrimSpace(key), sender.UserKey) {
			return true, nil
		}
	}
	return false, nil
}

func addPendingSender(settings map[string]any, sender remoteSender, requestedAt string) (bool, error) {
	pending := []any{}
	if raw, ok := settings["pendingUsers"]; ok {
		var valid bool
		pending, valid = raw.([]any)
		if !valid {
			return false, errors.New("invalid pendingUsers setting")
		}
	}
	for _, entry := range pending {
		if strings.EqualFold(pendingUserKey(entry), sender.UserKey) {
			return false, nil
		}
	}
	entry := map[string]any{"userKey": sender.UserKey, "requestedAt": requestedAt}
	if sender.Email != "" {
		entry["email"] = sender.Email
	}
	if sender.DisplayName != "" {
		entry["displayName"] = sender.DisplayName
	}
	settings["pendingUsers"] = append(pending, entry)
	return true, nil
}

func emailSenderValue(value any) string {
	switch typed := value.(type) {
	case string:
		return emailAddress(typed)
	case map[string]any:
		if value, ok := typed["email"]; ok {
			return emailAddress(identityValue(value))
		}
		if value, ok := typed["address"]; ok {
			return emailAddress(identityValue(value))
		}
	}
	return ""
}

func emailWebhookSender(payload map[string]any) string {
	data := objectValue(payload, "data")
	if value, ok := data["from"]; ok {
		return emailSenderValue(value)
	}
	if value, ok := payload["from"]; ok {
		return emailSenderValue(value)
	}
	if value, ok := payload["sender"]; ok {
		return emailSenderValue(value)
	}
	return ""
}

func (h *handler) listRemoteChannels(w http.ResponseWriter, r *http.Request) {
	tenant := principal(r).TenantID
	space, e := h.requestedSpace(r)
	if e != nil {
		writeErr(w, e)
		return
	}
	var rows []models.AgentChannelBinding
	query := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", tenant)
	if space != "" {
		query = query.Where("space_id = ?", space)
	}
	if e := query.Order("created_at DESC").Find(&rows).Error; e != nil {
		writeErr(w, e)
		return
	}
	out := make([]map[string]any, 0)
	for _, row := range rows {
		if h.authorizeChannel(r, bindingRow(row)) != nil {
			continue
		}
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
		SpaceID            string          `json:"spaceId"`
		AgentID            string          `json:"agentId"`
		Platform           string          `json:"platform"`
		ProfileKey         string          `json:"profileKey"`
		Label              string          `json:"label"`
		Enabled            bool            `json:"enabled"`
		Settings           json.RawMessage `json:"settings"`
		Credentials        json.RawMessage `json:"credentials"`
		CredentialsEnabled *bool           `json:"credentialsEnabled"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Platform == "" {
		httpx.Error(w, 400, "platform required")
		return
	}
	if !isRemotePlatform(b.Platform) {
		httpx.Error(w, 400, "不支持的远程平台")
		return
	}
	p := principal(r)
	space, e := h.resourceSpace(r, b.SpaceID, b.AgentID)
	if e != nil {
		writeErr(w, e)
		return
	}
	if b.Enabled && b.AgentID == "" {
		httpx.Error(w, 400, "enabled channel requires a reply Agent")
		return
	}
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
	create := map[string]any{"id": id, "tenant_id": p.TenantID, "space_id": space, "agent_id": nil, "platform": b.Platform, "profile_key": profileKey, "label": b.Label, "enabled": b.Enabled, "settings_json": rawOr(b.Settings, "{}"), "config_enc": configEnc, "created_at": now, "updated_at": now}
	if b.AgentID != "" {
		create["agent_id"] = b.AgentID
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentChannelBinding{}).Create(create).Error; e != nil {
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
	existing, e := h.loadRemoteChannelRow(r.Context(), p.TenantID, id)
	if e != nil {
		writeErr(w, e)
		return
	}
	if e = h.authorizeChannel(r, existing); e != nil {
		writeErr(w, e)
		return
	}
	updates := map[string]any{}
	if value, ok := m["spaceId"]; ok {
		if space, ok := value.(string); !ok || space != existing.SpaceID {
			httpx.Error(w, 400, "channel Space cannot change")
			return
		}
	}
	agent := existing.AgentID
	if value, ok := m["agentId"]; ok {
		if value == nil {
			agent = ""
		} else {
			var valid bool
			agent, valid = value.(string)
			if !valid {
				httpx.Error(w, 400, "invalid agentId")
				return
			}
		}
		if _, e = h.resourceSpace(r, existing.SpaceID, agent); e != nil {
			writeErr(w, e)
			return
		}
		if agent == "" {
			updates["agent_id"] = nil
			updates["enabled"] = false
		} else {
			updates["agent_id"] = agent
		}
	}
	if value, ok := m["enabled"]; ok {
		enabled, valid := value.(bool)
		if !valid {
			httpx.Error(w, 400, "invalid enabled")
			return
		}
		if enabled && agent == "" {
			httpx.Error(w, 400, "enabled channel requires a reply Agent")
			return
		}
	}
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
	e := httpx.DecodeJSON(r, &m)
	if e == nil && m == nil {
		e = errors.New("JSON object required")
	}
	return m, e
}
func (h *handler) deleteRemoteChannel(w http.ResponseWriter, r *http.Request) {
	row, e := h.loadRemoteChannelRow(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		writeErr(w, e)
		return
	}
	if e = h.authorizeChannel(r, row); e != nil {
		writeErr(w, e)
		return
	}
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
	if e = h.authorizeChannel(r, row); e != nil {
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
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if e != nil {
		httpx.Error(w, 413, "payload too large")
		return
	}
	external := r.Header.Get("X-Event-Id")
	if external == "" {
		sum := sha256.Sum256(raw)
		external = hex.EncodeToString(sum[:])
	}
	var duplicate, pending bool
	var responseErr string
	e = h.deps.Gorm.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		var binding models.AgentChannelBinding
		if e := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("tenant_id = ? AND id = ?", tenant, bindingID).First(&binding).Error; e != nil || !binding.Enabled || binding.AgentID == "" {
			responseErr = "not_found"
			if e != nil && !errors.Is(e, gorm.ErrRecordNotFound) {
				return e
			}
			return errors.New("channel not found")
		}
		configRaw, e := decrypt(h.deps.Secret, tenant+":"+bindingID, binding.ConfigEnc)
		if e != nil {
			responseErr = "configuration"
			return e
		}
		var cfg map[string]any
		if json.Unmarshal(configRaw, &cfg) != nil {
			responseErr = "configuration"
			return errors.New("invalid channel configuration")
		}
		if !verifyWebhook(binding.Platform, cfg, r.Header, raw) {
			responseErr = "signature"
			return errors.New("invalid signature")
		}
		payload, e := webhookObject(raw)
		if e != nil {
			responseErr = "json"
			return e
		}
		settings := map[string]any{}
		if json.Unmarshal([]byte(binding.SettingsJSON), &settings) != nil || settings == nil {
			responseErr = "policy"
			return errors.New("invalid channel access policy")
		}
		allowed, e := remoteChannelAllowsAll(settings)
		if e != nil {
			responseErr = "policy"
			return e
		}
		if !allowed {
			sender, ok := remoteWebhookSender(binding.Platform, payload)
			if !ok {
				responseErr = "sender"
				return errors.New("webhook sender missing")
			}
			allowed, e = remoteSenderAllowed(settings, sender)
			if e != nil {
				responseErr = "policy"
				return e
			}
			if !allowed {
				changed, e := addPendingSender(settings, sender, h.now().Format(time.RFC3339Nano))
				if e != nil {
					responseErr = "policy"
					return e
				}
				if changed {
					settingsRaw, _ := json.Marshal(settings)
					if e = tx.Model(&models.AgentChannelBinding{}).Where("tenant_id = ? AND id = ?", tenant, bindingID).Updates(map[string]any{"settings_json": string(settingsRaw), "updated_at": h.now().Format(time.RFC3339Nano)}).Error; e != nil {
						return e
					}
				}
				pending = true
				return nil
			}
		}
		res := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "binding_id"}, {Name: "external_event_id"}}, DoNothing: true}).Create(&models.AgentChannelEvent{ID: strPtr(h.id()), TenantID: tenant, BindingID: bindingID, ExternalEventID: external, ReceivedAt: h.now().Format(time.RFC3339Nano)})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			duplicate = true
			return nil
		}
		payload["agentId"] = binding.AgentID
		payloadRaw, _ := json.Marshal(payload)
		event := models.ChannelEvent{ID: strPtr(h.id()), TenantID: tenant, Provider: binding.Platform, ExternalID: bindingID + ":" + external, PayloadJSON: string(payloadRaw), DeliveryStatus: "pending", Attempts: 0, CreatedAt: h.now().Format(time.RFC3339Nano)}
		return tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "provider"}, {Name: "external_id"}}, DoNothing: true}).Create(&event).Error
	})
	if e != nil {
		switch responseErr {
		case "not_found":
			httpx.Error(w, 404, "Channel not found")
		case "configuration":
			httpx.Error(w, 401, "invalid channel configuration")
		case "signature":
			httpx.Error(w, 401, "invalid signature")
		case "json":
			httpx.Error(w, 400, "invalid JSON")
		case "sender":
			httpx.Error(w, 400, "webhook sender missing")
		case "policy":
			httpx.Error(w, 400, "invalid channel access policy")
		default:
			writeErr(w, e)
		}
		return
	}
	if duplicate {
		httpx.JSON(w, 202, map[string]any{"accepted": true, "duplicate": true})
		return
	}
	if pending {
		httpx.JSON(w, 202, map[string]any{"accepted": true, "pending": true})
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
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 10<<20))
	if e != nil {
		httpx.Error(w, 413, "payload too large")
		return
	}
	eventID := r.Header.Get("Message-Id")
	if eventID == "" {
		sum := sha256.Sum256(raw)
		eventID = hex.EncodeToString(sum[:])
	}
	ignored := false
	responseErr := ""
	e = h.deps.Gorm.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		q := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("tenant_id = ? AND enabled = true", tenant)
		if id != "" {
			if product, ok := emailProductForRef(id); ok {
				q = q.Where("product = ?", product)
			} else {
				q = q.Where("id = ?", id)
			}
		}
		var connector models.EmailConnectorInstance
		if e := q.Order("created_at").First(&connector).Error; e != nil {
			if errors.Is(e, gorm.ErrRecordNotFound) {
				responseErr = "not_found"
			}
			return e
		}
		if connector.ID == nil {
			responseErr = "configuration"
			return errors.New("email connector has no id")
		}
		cfgRaw, e := decrypt(h.deps.Secret, tenant+":email:"+*connector.ID, connector.ConfigEnc)
		if e != nil {
			responseErr = "configuration"
			return e
		}
		var cfg map[string]any
		if json.Unmarshal(cfgRaw, &cfg) != nil {
			responseErr = "configuration"
			return errors.New("invalid connector configuration")
		}
		secret := emailStringValue(cfg, "inboundSecret")
		if secret == "" {
			secret = emailStringValue(cfg, "webhookSecret")
		}
		sig := strings.TrimPrefix(r.Header.Get("X-Zakura-Signature"), "sha256=")
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(raw)
		if secret == "" || !hmac.Equal([]byte(sig), []byte(hex.EncodeToString(mac.Sum(nil)))) {
			responseErr = "signature"
			return errors.New("invalid signature")
		}
		payload, e := webhookObject(raw)
		if e != nil {
			responseErr = "json"
			return e
		}
		if !emailBoolValue(cfg, "inboundEnabled") {
			ignored = true
			return nil
		}
		sender := emailWebhookSender(payload)
		if sender == "" {
			responseErr = "sender"
			return errors.New("email sender missing")
		}
		allowlist := emailListValue(cfg["allowedEmails"])
		if len(allowlist) == 0 || !allowedSender(sender, allowlist) {
			ignored = true
			return nil
		}
		agent := emailStringValue(cfg, "inboundAgentId")
		if agent == "" {
			agent = emailStringValue(cfg, "agentId")
		}
		if agent == "" {
			responseErr = "agent"
			return errors.New("email connector has no agentId")
		}
		payload["agentId"] = agent
		eventRaw, _ := json.Marshal(payload)
		event := models.ChannelEvent{ID: strPtr(h.id()), TenantID: tenant, Provider: "email", ExternalID: eventID, PayloadJSON: string(eventRaw), DeliveryStatus: "pending", Attempts: 0, CreatedAt: h.now().Format(time.RFC3339Nano)}
		return tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "provider"}, {Name: "external_id"}}, DoNothing: true}).Create(&event).Error
	})
	if e != nil {
		switch responseErr {
		case "not_found":
			httpx.Error(w, 404, "Email connector not found")
		case "configuration":
			httpx.Error(w, 401, "invalid connector configuration")
		case "signature":
			httpx.Error(w, 401, "invalid signature")
		case "json":
			httpx.Error(w, 400, "invalid JSON")
		case "sender":
			httpx.Error(w, 400, "email sender missing")
		case "agent":
			httpx.Error(w, 400, "email connector has no agentId")
		default:
			writeErr(w, e)
		}
		return
	}
	if ignored {
		httpx.JSON(w, 202, map[string]any{"accepted": true, "ignored": true})
		return
	}
	httpx.JSON(w, 202, map[string]any{"accepted": true, "externalId": eventID})
}
