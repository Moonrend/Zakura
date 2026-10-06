package system

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/scrypt"
	"gorm.io/gorm/clause"
)

type routes struct{ d *appdeps.Dependencies }

func RegisterRoutes(r chi.Router, d *appdeps.Dependencies) {
	h := &routes{d: d}
	d.SendTransactionalEmail = h.sendTransactionalEmail
	for _, path := range []string{"/health", "/healthz", "/livez"} {
		r.Get(path, h.live)
	}
	for _, path := range []string{"/readyz", "/api/ready", "/api/readyz"} {
		r.Get(path, h.ready)
	}
	r.Get("/metrics", h.metrics)
	r.Get("/api/metrics", h.metrics)
	// The preserved frontend must be able to discover whether setup is complete
	// before it has a session. Keep this route outside the authenticated group,
	// matching the TypeScript server's public-path allowlist.
	r.Get("/api/platform", h.platform)
	r.Group(func(g chi.Router) {
		g.Use(httpx.Auth(d))
		g.Get("/api/connect", h.connect)
		g.Get("/api/api-keys", h.listKeys)
		g.Post("/api/api-keys", h.createKey)
		g.Delete("/api/api-keys/{id}", h.deleteKey)
		g.Post("/api/agents/{id}/keys", h.createAgentKey)
		g.Post("/api/spaces/{id}/keys", h.createSpaceKey)
		g.Post("/api/me/avatar", h.putAvatar)
		g.Delete("/api/me/avatar", h.deleteAvatar)
		g.Get("/api/users/{id}/avatar", h.getAvatar)
		g.Post("/api/me/verify-email", h.requestVerifyEmail)
		g.Get("/api/settings", h.listSettings)
		g.Put("/api/settings/{key}", h.putSetting)
		g.Get("/api/settings/email/transactional", h.getEmailSettings)
		g.Put("/api/settings/email/transactional", h.putEmailSettings)
		g.Post("/api/tenant/onboarding/bootstrap", h.bootstrap)
	})
}
func (h *routes) q(v string) string { return h.d.Rebind(v) }
func (h *routes) now() string       { return h.d.Clock().UTC().Format(time.RFC3339Nano) }
func (h *routes) live(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
func (h *routes) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := h.d.DB.PingContext(ctx); err != nil {
		httpx.JSON(w, 503, map[string]any{"ok": false, "database": "unavailable"})
		return
	}
	if h.d.OAuthPublicKey == nil {
		httpx.JSON(w, 503, map[string]any{"ok": false, "database": "ready", "oauthSigningKey": "unavailable"})
		return
	}
	if _, err := h.d.OAuthPublicKey(ctx); err != nil {
		httpx.JSON(w, 503, map[string]any{"ok": false, "database": "ready", "oauthSigningKey": "unavailable"})
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "database": "ready", "oauthSigningKey": "ready"})
}
func (h *routes) metrics(w http.ResponseWriter, r *http.Request) {
	var users, tenants, agents int64
	_ = h.d.Gorm.WithContext(r.Context()).Model(&models.User{}).Count(&users)
	_ = h.d.Gorm.WithContext(r.Context()).Model(&models.Tenant{}).Count(&tenants)
	_ = h.d.Gorm.WithContext(r.Context()).Model(&models.Agent{}).Count(&agents)
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = fmt.Fprintf(w, "# TYPE zakura_up gauge\nzakura_up 1\n# TYPE zakura_users gauge\nzakura_users %d\n# TYPE zakura_tenants gauge\nzakura_tenants %d\n# TYPE zakura_agents gauge\nzakura_agents %d\n", users, tenants, agents)
}
func (h *routes) platform(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var meta models.PlatformMetum
	setup := false
	var version, mode string
	if h.d.Gorm.WithContext(ctx).Select("setup_completed,version,mode").Where("singleton=1").Take(&meta).Error == nil {
		setup = meta.SetupCompleted
		version = meta.Version
		mode = meta.Mode
	}
	if version == "" {
		version = "go-rewrite"
	}
	if mode == "" {
		mode = map[bool]string{true: "saas", false: "local"}[h.d.MultiTenant]
	}
	providers := []map[string]any{}
	ready := map[string]bool{}
	if h.d.Edition == "saas" {
		for _, provider := range []struct{ id, name string }{{"zerocat", "ZeroCat"}, {"google", "Google"}, {"github", "GitHub"}, {"microsoft", "Microsoft"}} {
			id, name := provider.id, provider.name
			var row models.Setting
			if h.d.Gorm.WithContext(ctx).Where("owner_key='platform' AND key=?", "auth.oauth."+id).Take(&row).Error == nil {
				var cfg struct {
					Enabled         bool   `json:"enabled"`
					ClientID        string `json:"clientId"`
					ClientSecretEnc string `json:"clientSecretEnc"`
				}
				_ = json.Unmarshal([]byte(row.Value), &cfg)
				if cfg.Enabled && cfg.ClientID != "" && cfg.ClientSecretEnc != "" {
					providers = append(providers, map[string]any{"id": id, "name": name, "enabled": true})
					ready[id] = true
				}
			}
		}
	}
	disabled := false
	highlighted := "auto"
	var policyRow models.Setting
	if h.d.Edition == "saas" && h.d.Gorm.WithContext(ctx).Where("owner_key='platform' AND key='auth.login'").Take(&policyRow).Error == nil {
		var policy struct {
			DisablePasswordLogin bool   `json:"disablePasswordLogin"`
			HighlightedMethod    string `json:"highlightedMethod"`
		}
		_ = json.Unmarshal([]byte(policyRow.Value), &policy)
		disabled = policy.DisablePasswordLogin && len(ready) > 0
		if policy.HighlightedMethod != "" {
			highlighted = policy.HighlightedMethod
		}
		if highlighted != "auto" && highlighted != "password" && !ready[highlighted] {
			highlighted = "auto"
		}
	}
	httpx.JSON(w, 200, map[string]any{"setupCompleted": setup, "version": version, "mode": mode, "multiTenant": h.d.MultiTenant, "edition": h.d.Edition, "registrationEnabled": h.d.Edition == "saas" && !disabled, "passwordLoginEnabled": !disabled, "oauthProviders": providers, "highlightedLoginMethod": highlighted})
}
func (h *routes) connect(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var rows []models.Space
	if err := h.d.Gorm.WithContext(r.Context()).Select("id,name,slug").Where("tenant_id=?", p.TenantID).Order("created_at").Find(&rows).Error; err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	spaces := []map[string]any{}
	for _, space := range rows {
		spaces = append(spaces, map[string]any{"id": deref(space.ID), "name": space.Name, "slug": space.Slug, "mcpUrl": h.d.PublicURL + "/mcp/spaces/" + space.Slug})
	}
	httpx.JSON(w, 200, map[string]any{"publicBaseUrl": h.d.PublicURL, "spaceMcpPattern": h.d.PublicURL + "/mcp/spaces/{slug}", "agentMcpPattern": h.d.PublicURL + "/mcp/agents/{slug}", "authorizationServer": map[string]any{"issuer": h.d.PublicURL, "authorization_endpoint": h.d.PublicURL + "/oauth/authorize", "token_endpoint": h.d.PublicURL + "/token", "registration_endpoint": h.d.PublicURL + "/oauth/register"}, "spaces": spaces, "authMethods": []map[string]string{{"id": "oauth21", "name": "OAuth 2.1 + PKCE"}, {"id": "api_key", "name": "API Key"}}})
}

func (h *routes) listKeys(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var rows []models.APIKey
	if err := h.d.Gorm.WithContext(r.Context()).Where("tenant_id=? AND revoked_at IS NULL", p.TenantID).Order("created_at DESC").Find(&rows).Error; err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	items := []map[string]any{}
	for _, key := range rows {
		agentID := ""
		if key.AgentID != nil {
			agentID = *key.AgentID
		}
		spaceID := ""
		if key.SpaceID != nil {
			spaceID = *key.SpaceID
		}
		items = append(items, map[string]any{"id": deref(key.ID), "agentId": agentID, "spaceId": spaceID, "name": key.Name, "keyPrefix": key.KeyPrefix, "scopes": decodeArray(key.Scopes), "expiresAt": nullStringPtr(key.ExpiresAt), "lastUsedAt": nullStringPtr(key.LastUsedAt), "createdAt": key.CreatedAt})
	}
	httpx.JSON(w, 200, items)
}
func (h *routes) createKey(w http.ResponseWriter, r *http.Request) { h.createKeyFor(w, r, "", "") }
func (h *routes) createAgentKey(w http.ResponseWriter, r *http.Request) {
	h.createKeyFor(w, r, chi.URLParam(r, "id"), "")
}
func (h *routes) createSpaceKey(w http.ResponseWriter, r *http.Request) {
	h.createKeyFor(w, r, "", chi.URLParam(r, "id"))
}
func (h *routes) createKeyFor(w http.ResponseWriter, r *http.Request, agentID, spaceID string) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var b struct {
		Name      string   `json:"name"`
		Scopes    []string `json:"scopes"`
		ExpiresAt string   `json:"expiresAt"`
	}
	if httpx.DecodeJSON(r, &b) != nil || strings.TrimSpace(b.Name) == "" {
		httpx.Error(w, 400, "name required")
		return
	}
	if len(b.Scopes) == 0 {
		b.Scopes = []string{"*"}
	}
	for i := range b.Scopes {
		b.Scopes[i] = strings.TrimSpace(b.Scopes[i])
		if b.Scopes[i] == "" {
			httpx.Error(w, 400, "scope cannot be empty")
			return
		}
	}
	if b.ExpiresAt != "" {
		if _, err := time.Parse(time.RFC3339, b.ExpiresAt); err != nil {
			httpx.Error(w, 400, "invalid expiresAt")
			return
		}
	}
	if agentID != "" {
		var count int64
		_ = h.d.Gorm.WithContext(r.Context()).Model(&models.Agent{}).Where("id=? AND tenant_id=?", agentID, p.TenantID).Count(&count)
		if count != 1 {
			httpx.Error(w, 404, "agent not found")
			return
		}
	}
	if spaceID != "" {
		var count int64
		_ = h.d.Gorm.WithContext(r.Context()).Model(&models.Space{}).Where("id=? AND tenant_id=?", spaceID, p.TenantID).Count(&count)
		if count != 1 {
			httpx.Error(w, 404, "space not found")
			return
		}
	}
	raw := "zak_" + randomString(32)
	sum := sha256.Sum256([]byte(raw))
	prefix := raw[:12]
	id := h.d.NewID()
	scopes, _ := json.Marshal(b.Scopes)
	var userID *string
	if !p.APIKey {
		uid := p.UserID
		userID = &uid
	}
	err := h.d.Gorm.WithContext(r.Context()).Create(&models.APIKey{ID: &id, TenantID: p.TenantID, UserID: userID, AgentID: strPtr(agentID), SpaceID: strPtr(spaceID), Name: b.Name, KeyPrefix: prefix, KeyHash: hex.EncodeToString(sum[:]), Scopes: string(scopes), ExpiresAt: strPtr(b.ExpiresAt), CreatedAt: h.now()}).Error
	if err != nil {
		httpx.Error(w, 500, "create failed")
		return
	}
	httpx.JSON(w, 201, map[string]any{"id": id, "name": b.Name, "agentId": nullIfEmpty(agentID), "spaceId": nullIfEmpty(spaceID), "keyPrefix": prefix, "scopes": b.Scopes, "expiresAt": nullIfEmpty(b.ExpiresAt), "lastUsedAt": nil, "createdAt": h.now(), "rawKey": raw})
}
func (h *routes) deleteKey(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	res := h.d.Gorm.WithContext(r.Context()).Model(&models.APIKey{}).Where("id=? AND tenant_id=? AND revoked_at IS NULL", chi.URLParam(r, "id"), p.TenantID).Update("revoked_at", h.now())
	if res.Error != nil {
		httpx.Error(w, 500, "revoke failed")
		return
	}
	if res.RowsAffected != 1 {
		httpx.Error(w, 404, "API Key not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (h *routes) putAvatar(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.APIKey {
		httpx.Error(w, 403, "API keys cannot update profile")
		return
	}
	const maxAvatarBytes = 256 << 10
	r.Body = http.MaxBytesReader(w, r.Body, maxAvatarBytes+(64<<10))
	var data []byte
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		if err := r.ParseMultipartForm(maxAvatarBytes); err != nil {
			httpx.Error(w, 400, "invalid upload")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			httpx.Error(w, 400, "file required")
			return
		}
		defer file.Close()
		data, _ = io.ReadAll(io.LimitReader(file, maxAvatarBytes+1))
		_ = header
	} else {
		data, _ = io.ReadAll(io.LimitReader(r.Body, maxAvatarBytes+1))
	}
	if len(data) == 0 || len(data) > maxAvatarBytes {
		httpx.Error(w, 400, "image must be at most 256KB")
		return
	}
	if len(data) < 3 || data[0] != 0xff || data[1] != 0xd8 || data[2] != 0xff {
		httpx.Error(w, 400, "JPEG required")
		return
	}
	now := h.now()
	err := h.d.Gorm.WithContext(r.Context()).Model(&models.User{}).Where("id=?", p.UserID).Updates(map[string]any{"avatar_mime": "image/jpeg", "avatar_data": data, "avatar_updated_at": now, "updated_at": now}).Error
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "avatarRev": h.d.Clock().UnixMilli()})
}
func (h *routes) deleteAvatar(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.APIKey {
		httpx.Error(w, 403, "API keys cannot update profile")
		return
	}
	if err := h.d.Gorm.WithContext(r.Context()).Model(&models.User{}).Where("id=?", p.UserID).Updates(map[string]any{"avatar_mime": nil, "avatar_data": nil, "avatar_updated_at": nil, "updated_at": h.now()}).Error; err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *routes) getAvatar(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	id := chi.URLParam(r, "id")
	var mime sql.NullString
	var data []byte
	err := h.d.Gorm.WithContext(r.Context()).Raw(`SELECT u.avatar_mime,u.avatar_data FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE u.id=? AND m.tenant_id=?`, id, p.TenantID).Row().Scan(&mime, &data)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if len(data) == 0 {
		http.NotFound(w, r)
		return
	}
	contentType := mime.String
	if contentType == "" {
		contentType = "image/jpeg"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=120")
	_, _ = w.Write(data)
}
func (h *routes) requestVerifyEmail(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.APIKey {
		httpx.Error(w, 403, "API keys cannot verify email")
		return
	}
	var user models.User
	if err := h.d.Gorm.WithContext(r.Context()).Select("email,email_verified_at").Where("id=? AND status='active'", p.UserID).Take(&user).Error; err != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	if user.EmailVerifiedAt != nil {
		httpx.JSON(w, 200, map[string]any{"sent": true})
		return
	}
	raw := "zat_" + randomString(32)
	sum := sha256.Sum256([]byte(raw))
	id := h.d.NewID()
	userID := p.UserID
	err := h.d.Gorm.WithContext(r.Context()).Create(&models.AuthToken{ID: &id, UserID: &userID, Kind: "email_verify", TokenHash: hex.EncodeToString(sum[:]), MetaJSON: "{}", ExpiresAt: h.d.Clock().UTC().Add(24 * time.Hour).Format(time.RFC3339Nano), CreatedAt: h.now()}).Error
	if err != nil {
		httpx.Error(w, 500, "request failed")
		return
	}
	sent := false
	if h.d.SendTransactionalEmail != nil {
		verifyURL := h.d.WebURL + "/verify-email?token=" + url.QueryEscape(raw)
		htmlBody := `<p>Verify your Zakura email:</p><p><a href="` + html.EscapeString(verifyURL) + `">Verify email</a></p>`
		sent = h.d.SendTransactionalEmail(r.Context(), user.Email, "验证你的 Zakura 邮箱", htmlBody, "Verify your Zakura email:\n\n"+verifyURL) == nil
	}
	httpx.JSON(w, 200, map[string]any{"sent": sent})
}

func (h *routes) listSettings(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var rows []models.Setting
	if err := h.d.Gorm.WithContext(r.Context()).Where("owner_key=?", p.TenantID).Order("key").Find(&rows).Error; err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	items := map[string]any{}
	for _, row := range rows {
		if strings.Contains(row.Key, "secret") || strings.Contains(row.Key, "email_transactional") {
			continue
		}
		var value any
		_ = json.Unmarshal([]byte(row.Value), &value)
		items[row.Key] = value
	}
	httpx.JSON(w, 200, map[string]any{"settings": items})
}
func (h *routes) putSetting(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin {
		httpx.Error(w, 403, "Admin only")
		return
	}
	key := chi.URLParam(r, "key")
	if strings.Contains(strings.ToLower(key), "secret") || key == "email_transactional" || key == "email.transactional" {
		httpx.Error(w, 400, "use the dedicated secret settings endpoint")
		return
	}
	var value any
	if httpx.DecodeJSON(r, &value) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	raw, _ := json.Marshal(value)
	id := h.d.NewID()
	err := h.d.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_key"}, {Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value"})}).Create(&models.Setting{ID: &id, OwnerKey: p.TenantID, Key: key, Value: string(raw)}).Error
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *routes) getEmailSettings(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if !h.canManageTransactionalEmail(p) {
		httpx.Error(w, 403, "Admin only")
		return
	}
	stored := h.loadTransactionalEmail(r.Context())
	httpx.JSON(w, 200, h.publicTransactionalEmail(stored))
}
func (h *routes) putEmailSettings(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if !h.canManageTransactionalEmail(p) {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var b struct {
		Enabled    *bool   `json:"enabled"`
		FromEmail  *string `json:"fromEmail"`
		BaseURL    *string `json:"baseUrl"`
		ProviderID *string `json:"providerId"`
		APIToken   *string `json:"apiToken"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	stored := h.loadTransactionalEmail(r.Context())
	if b.Enabled != nil {
		stored.Enabled = *b.Enabled
	}
	if b.FromEmail != nil {
		stored.FromEmail = strings.TrimSpace(*b.FromEmail)
	}
	if b.BaseURL != nil {
		stored.BaseURL = strings.TrimSpace(*b.BaseURL)
	}
	if b.ProviderID != nil {
		stored.ProviderID = strings.TrimSpace(*b.ProviderID)
	}
	if b.APIToken != nil {
		stored.APITokenEnc = ""
		if token := strings.TrimSpace(*b.APIToken); token != "" {
			var err error
			stored.APITokenEnc, err = encrypt(h.d.Secret, mustJSON(map[string]string{"secret": token}))
			if err != nil {
				httpx.Error(w, 500, "encryption failed")
				return
			}
		}
	}
	raw, _ := json.Marshal(stored)
	id := h.d.NewID()
	err := h.d.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_key"}, {Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value"})}).Create(&models.Setting{ID: &id, OwnerKey: "platform", Key: "email.transactional", Value: string(raw)}).Error
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	httpx.JSON(w, 200, h.publicTransactionalEmail(stored))
}

type transactionalEmailStored struct {
	Enabled     bool   `json:"enabled"`
	FromEmail   string `json:"fromEmail"`
	BaseURL     string `json:"baseUrl"`
	ProviderID  string `json:"providerId"`
	APITokenEnc string `json:"apiTokenEnc"`
}

func (h *routes) canManageTransactionalEmail(p httpx.Principal) bool {
	if p.APIKey {
		return false
	}
	if h.d.Edition == "saas" {
		return p.IsPlatformAdmin
	}
	return p.IsPlatformAdmin || p.Role == "owner" || p.Role == "admin"
}
func (h *routes) loadTransactionalEmail(ctx context.Context) transactionalEmailStored {
	var row models.Setting
	var stored transactionalEmailStored
	if h.d.Gorm.WithContext(ctx).Where("owner_key='platform' AND key='email.transactional'").Take(&row).Error == nil {
		_ = json.Unmarshal([]byte(row.Value), &stored)
	}
	return stored
}
func (h *routes) publicTransactionalEmail(stored transactionalEmailStored) map[string]any {
	hasToken := stored.APITokenEnc != ""
	secret := ""
	if hasToken {
		if raw, err := decrypt(h.d.Secret, stored.APITokenEnc); err == nil {
			var value map[string]string
			if json.Unmarshal(raw, &value) == nil {
				secret = strings.TrimSpace(value["secret"])
			}
		}
	}
	return map[string]any{"enabled": stored.Enabled, "fromEmail": strings.TrimSpace(stored.FromEmail), "baseUrl": strings.TrimSpace(stored.BaseURL), "providerId": strings.TrimSpace(stored.ProviderID), "hasApiToken": hasToken, "ready": stored.Enabled && strings.TrimSpace(stored.FromEmail) != "" && secret != ""}
}

func (h *routes) sendTransactionalEmail(ctx context.Context, to, subject, htmlBody, textBody string) error {
	stored := h.loadTransactionalEmail(ctx)
	if !stored.Enabled || strings.TrimSpace(stored.FromEmail) == "" || stored.APITokenEnc == "" {
		return errors.New("transactional email is not configured")
	}
	secretRaw, err := decrypt(h.d.Secret, stored.APITokenEnc)
	if err != nil {
		return errors.New("transactional email token is unavailable")
	}
	var secret map[string]string
	if json.Unmarshal(secretRaw, &secret) != nil || strings.TrimSpace(secret["secret"]) == "" {
		return errors.New("transactional email token is unavailable")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(stored.BaseURL), "/")
	if baseURL == "" {
		baseURL = "http://localhost:3000"
	}
	payload, _ := json.Marshal(map[string]any{
		"from": stored.FromEmail, "to": []string{strings.TrimSpace(to)},
		"subject": strings.TrimSpace(subject), "html": htmlBody, "text": textBody,
		"provider_id": strings.TrimSpace(stored.ProviderID),
	})
	requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, baseURL+"/emails", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(secret["secret"]))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "zakura-go/transactional-email")
	client := h.d.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	response, readErr := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if readErr != nil {
		return readErr
	}
	if len(response) > 1<<20 {
		return errors.New("transactional email response is too large")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("transactional email returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func (h *routes) bootstrap(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var spaceID, agentID, providerID string
	created := false
	err := appdeps.InTx(r.Context(), h.d.DB, func(tx *sql.Tx) error {
		e := tx.QueryRowContext(r.Context(), h.q(`SELECT id FROM memory_providers WHERE tenant_id=? AND is_default=TRUE ORDER BY created_at LIMIT 1`), p.TenantID).Scan(&providerID)
		if errors.Is(e, sql.ErrNoRows) {
			providerID = h.d.NewID()
			if _, e = tx.ExecContext(r.Context(), h.q(`INSERT INTO memory_providers(id,tenant_id,name,slug,kind,config_json,secret_json,enabled,is_default,status,created_at,updated_at) VALUES(?,?,?,'default','builtin','{}','{}',TRUE,TRUE,'ready',?,?)`), providerID, p.TenantID, "Default Memory", h.now(), h.now()); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
		e = tx.QueryRowContext(r.Context(), h.q(`SELECT id FROM spaces WHERE tenant_id=? ORDER BY created_at LIMIT 1`), p.TenantID).Scan(&spaceID)
		if errors.Is(e, sql.ErrNoRows) {
			spaceID = h.d.NewID()
			if _, e = tx.ExecContext(r.Context(), h.q(`INSERT INTO spaces(id,tenant_id,name,slug,description,config_json,created_at,updated_at) VALUES(?,?,?,'default','','{}',?,?)`), spaceID, p.TenantID, "Default Space", h.now(), h.now()); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
		e = tx.QueryRowContext(r.Context(), h.q(`SELECT id FROM agents WHERE tenant_id=? AND space_id=? ORDER BY created_at LIMIT 1`), p.TenantID, spaceID).Scan(&agentID)
		if errors.Is(e, sql.ErrNoRows) {
			agentID = h.d.NewID()
			_, e = tx.ExecContext(r.Context(), h.q(`INSERT INTO agents(id,tenant_id,space_id,name,slug,description,enable_memory,memory_provider_id,config_json,created_at,updated_at) VALUES(?,?,?,'Zakura','zakura','引导自动创建的默认 Agent',TRUE,?,'{}',?,?)`), agentID, p.TenantID, spaceID, providerID, h.now(), h.now())
			created = e == nil
		} else if e == nil {
			_, e = tx.ExecContext(r.Context(), h.q(`UPDATE agents SET enable_memory=TRUE,memory_provider_id=COALESCE(memory_provider_id,?),updated_at=? WHERE id=? AND tenant_id=?`), providerID, h.now(), agentID, p.TenantID)
		}
		return e
	})
	if err != nil {
		httpx.Error(w, 500, "bootstrap failed")
		return
	}
	var name, slug, spaceName, spaceSlug string
	var enableComputer, enableMemory, completed bool
	var stepsRaw string
	if err = h.d.Gorm.WithContext(r.Context()).Raw(`SELECT a.name,a.slug,s.name,s.slug,s.enable_computer,a.enable_memory FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.id=? AND a.tenant_id=?`, agentID, p.TenantID).Row().Scan(&name, &slug, &spaceName, &spaceSlug, &enableComputer, &enableMemory); err != nil {
		httpx.Error(w, 500, "bootstrap agent unavailable")
		return
	}
	var tenantRow models.Tenant
	if err = h.d.Gorm.WithContext(r.Context()).Select("onboarding_steps,onboarding_completed").Where("id=?", p.TenantID).Take(&tenantRow).Error; err != nil {
		httpx.Error(w, 500, "bootstrap tenant unavailable")
		return
	}
	stepsRaw = tenantRow.OnboardingSteps
	completed = tenantRow.OnboardingCompleted
	httpx.JSON(w, 200, map[string]any{
		"edition": h.d.Edition,
		"agent": map[string]any{
			"id": agentID, "name": name, "slug": slug,
			"enableComputer": enableComputer, "enableMemory": enableMemory,
		},
		"spaces":  []map[string]any{{"id": spaceID, "name": spaceName, "slug": spaceSlug, "mcpUrl": strings.TrimRight(h.d.PublicURL, "/") + "/mcp/spaces/" + spaceSlug}},
		"created": created, "computerStarting": false,
		"steps": decodeObject(stepsRaw), "completed": completed,
	})
}

func randomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func nullIfEmpty(v string) any {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}
func nullString(v sql.NullString) any {
	if v.Valid {
		return v.String
	}
	return nil
}
func nullStringPtr(value *string) any {
	if value != nil {
		return *value
	}
	return nil
}
func deref(value *string) string {
	if value != nil {
		return *value
	}
	return ""
}
func strPtr(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}
func decodeArray(raw string) []any {
	var out []any
	_ = json.Unmarshal([]byte(raw), &out)
	if out == nil {
		out = []any{}
	}
	return out
}
func decodeObject(raw string) map[string]any {
	out := map[string]any{}
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}
func encrypt(secret, plain []byte) (string, error) {
	key, err := scrypt.Key(secret, []byte("zakura-v1"), 16384, 8, 1, 32)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, plain, nil)
	ciphertext, tag := sealed[:len(sealed)-gcm.Overhead()], sealed[len(sealed)-gcm.Overhead():]
	payload := append(append(append([]byte{}, nonce...), tag...), ciphertext...)
	return base64.RawURLEncoding.EncodeToString(payload), nil
}
func decrypt(secret []byte, encoded string) ([]byte, error) {
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(payload) < 28 {
		return nil, errors.New("invalid encrypted value")
	}
	key, err := scrypt.Key(secret, []byte("zakura-v1"), 16384, 8, 1, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce, tag, ciphertext := payload[:12], payload[12:28], payload[28:]
	sealed := append(append([]byte{}, ciphertext...), tag...)
	return gcm.Open(nil, nonce, sealed, nil)
}
func mustJSON(value any) []byte {
	raw, _ := json.Marshal(value)
	return raw
}
