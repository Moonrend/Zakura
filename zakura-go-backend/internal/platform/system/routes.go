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
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/appdeps"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
	"golang.org/x/crypto/scrypt"
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
	var users, tenants, agents int
	_ = h.d.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM users`).Scan(&users)
	_ = h.d.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM tenants`).Scan(&tenants)
	_ = h.d.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM agents`).Scan(&agents)
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = fmt.Fprintf(w, "# TYPE zakura_up gauge\nzakura_up 1\n# TYPE zakura_users gauge\nzakura_users %d\n# TYPE zakura_tenants gauge\nzakura_tenants %d\n# TYPE zakura_agents gauge\nzakura_agents %d\n", users, tenants, agents)
}
func (h *routes) platform(w http.ResponseWriter, r *http.Request) {
	var setup bool
	var version, mode string
	_ = h.d.DB.QueryRowContext(r.Context(), `SELECT setup_completed,version,mode FROM platform_meta WHERE singleton=1`).Scan(&setup, &version, &mode)
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
			var raw string
			if h.d.DB.QueryRowContext(r.Context(), h.q(`SELECT value FROM settings WHERE owner_key='platform' AND key=?`), "auth.oauth."+id).Scan(&raw) == nil {
				var cfg struct {
					Enabled         bool   `json:"enabled"`
					ClientID        string `json:"clientId"`
					ClientSecretEnc string `json:"clientSecretEnc"`
				}
				_ = json.Unmarshal([]byte(raw), &cfg)
				if cfg.Enabled && cfg.ClientID != "" && cfg.ClientSecretEnc != "" {
					providers = append(providers, map[string]any{"id": id, "name": name, "enabled": true})
					ready[id] = true
				}
			}
		}
	}
	disabled := false
	highlighted := "auto"
	var policyRaw string
	if h.d.Edition == "saas" && h.d.DB.QueryRowContext(r.Context(), h.q(`SELECT value FROM settings WHERE owner_key='platform' AND key='auth.login'`)).Scan(&policyRaw) == nil {
		var policy struct {
			DisablePasswordLogin bool   `json:"disablePasswordLogin"`
			HighlightedMethod    string `json:"highlightedMethod"`
		}
		_ = json.Unmarshal([]byte(policyRaw), &policy)
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
	rows, err := h.d.DB.QueryContext(r.Context(), h.q(`SELECT id,name,slug FROM agents WHERE tenant_id=? ORDER BY created_at`), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	defer rows.Close()
	agents := []map[string]any{}
	for rows.Next() {
		var id, name, slug string
		_ = rows.Scan(&id, &name, &slug)
		agents = append(agents, map[string]any{"id": id, "name": name, "slug": slug, "mcpUrl": h.d.PublicURL + "/mcp/agents/" + slug})
	}
	httpx.JSON(w, 200, map[string]any{"publicBaseUrl": h.d.PublicURL, "agentMcpPattern": h.d.PublicURL + "/mcp/agents/{slug}", "authorizationServer": map[string]any{"issuer": h.d.PublicURL, "authorization_endpoint": h.d.PublicURL + "/oauth/authorize", "token_endpoint": h.d.PublicURL + "/token", "registration_endpoint": h.d.PublicURL + "/oauth/register"}, "agents": agents, "authMethods": []map[string]string{{"id": "oauth21", "name": "OAuth 2.1 + PKCE"}, {"id": "api_key", "name": "API Key"}}})
}

func (h *routes) listKeys(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	rows, err := h.d.DB.QueryContext(r.Context(), h.q(`SELECT id,COALESCE(agent_id,''),name,key_prefix,scopes,expires_at,last_used_at,created_at FROM api_keys WHERE tenant_id=? AND revoked_at IS NULL ORDER BY created_at DESC`), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, agentID, name, prefix, scopes, created string
		var expires, last sql.NullString
		_ = rows.Scan(&id, &agentID, &name, &prefix, &scopes, &expires, &last, &created)
		items = append(items, map[string]any{"id": id, "agentId": agentID, "name": name, "keyPrefix": prefix, "scopes": decodeArray(scopes), "expiresAt": nullString(expires), "lastUsedAt": nullString(last), "createdAt": created})
	}
	httpx.JSON(w, 200, items)
}
func (h *routes) createKey(w http.ResponseWriter, r *http.Request) { h.createKeyFor(w, r, "") }
func (h *routes) createAgentKey(w http.ResponseWriter, r *http.Request) {
	h.createKeyFor(w, r, chi.URLParam(r, "id"))
}
func (h *routes) createKeyFor(w http.ResponseWriter, r *http.Request, agentID string) {
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
		var count int
		_ = h.d.DB.QueryRowContext(r.Context(), h.q(`SELECT COUNT(*) FROM agents WHERE id=? AND tenant_id=?`), agentID, p.TenantID).Scan(&count)
		if count != 1 {
			httpx.Error(w, 404, "agent not found")
			return
		}
	}
	raw := "zak_" + randomString(32)
	sum := sha256.Sum256([]byte(raw))
	prefix := raw[:12]
	id := h.d.NewID()
	scopes, _ := json.Marshal(b.Scopes)
	var userID any = p.UserID
	if p.APIKey {
		userID = nil
	}
	_, err := h.d.DB.ExecContext(r.Context(), h.q(`INSERT INTO api_keys(id,tenant_id,user_id,agent_id,name,key_prefix,key_hash,scopes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`), id, p.TenantID, userID, nullIfEmpty(agentID), b.Name, prefix, hex.EncodeToString(sum[:]), string(scopes), nullIfEmpty(b.ExpiresAt), h.now())
	if err != nil {
		httpx.Error(w, 500, "create failed")
		return
	}
	httpx.JSON(w, 201, map[string]any{"id": id, "name": b.Name, "agentId": nullIfEmpty(agentID), "keyPrefix": prefix, "scopes": b.Scopes, "expiresAt": nullIfEmpty(b.ExpiresAt), "lastUsedAt": nil, "createdAt": h.now(), "rawKey": raw})
}
func (h *routes) deleteKey(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	res, err := h.d.DB.ExecContext(r.Context(), h.q(`UPDATE api_keys SET revoked_at=? WHERE id=? AND tenant_id=? AND revoked_at IS NULL`), h.now(), chi.URLParam(r, "id"), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "revoke failed")
		return
	}
	n, _ := res.RowsAffected()
	if n != 1 {
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
	if path, ok := h.avatarPath(p.UserID); ok {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			httpx.Error(w, 500, "avatar storage unavailable")
			return
		}
		tmp := path + ".tmp-" + h.d.NewID()
		if err := os.WriteFile(tmp, data, 0o600); err != nil {
			httpx.Error(w, 500, "avatar storage unavailable")
			return
		}
		if err := os.Rename(tmp, path); err != nil {
			_ = os.Remove(tmp)
			httpx.Error(w, 500, "avatar storage unavailable")
			return
		}
	}
	now := h.now()
	_, err := h.d.DB.ExecContext(r.Context(), h.q(`UPDATE users SET avatar_mime='image/jpeg',avatar_data=?,avatar_updated_at=?,updated_at=? WHERE id=?`), data, now, now, p.UserID)
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
	if path, ok := h.avatarPath(p.UserID); ok {
		_ = os.Remove(path)
	}
	if _, err := h.d.DB.ExecContext(r.Context(), h.q(`UPDATE users SET avatar_mime=NULL,avatar_data=NULL,avatar_updated_at=NULL,updated_at=? WHERE id=?`), h.now(), p.UserID); err != nil {
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
	err := h.d.DB.QueryRowContext(r.Context(), h.q(`SELECT u.avatar_mime,u.avatar_data FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE u.id=? AND m.tenant_id=?`), id, p.TenantID).Scan(&mime, &data)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if len(data) == 0 {
		path, ok := h.avatarPath(id)
		if !ok {
			http.NotFound(w, r)
			return
		}
		data, err = os.ReadFile(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		mime = sql.NullString{String: "image/jpeg", Valid: true}
	}
	contentType := mime.String
	if contentType == "" {
		contentType = "image/jpeg"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=120")
	_, _ = w.Write(data)
}
func (h *routes) avatarPath(userID string) (string, bool) {
	if h.d.DataDir == "" || len(userID) == 0 || len(userID) > 64 {
		return "", false
	}
	for _, r := range userID {
		if !(r == '-' || r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return "", false
		}
	}
	return filepath.Join(h.d.DataDir, "avatars", userID), true
}
func (h *routes) requestVerifyEmail(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.APIKey {
		httpx.Error(w, 403, "API keys cannot verify email")
		return
	}
	var email string
	var verified sql.NullString
	if err := h.d.DB.QueryRowContext(r.Context(), h.q(`SELECT email,email_verified_at FROM users WHERE id=? AND status='active'`), p.UserID).Scan(&email, &verified); err != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	if verified.Valid {
		httpx.JSON(w, 200, map[string]any{"sent": true})
		return
	}
	raw := "zat_" + randomString(32)
	sum := sha256.Sum256([]byte(raw))
	_, err := h.d.DB.ExecContext(r.Context(), h.q(`INSERT INTO auth_tokens(id,user_id,kind,token_hash,expires_at,created_at) VALUES(?,?,'email_verify',?,?,?)`), h.d.NewID(), p.UserID, hex.EncodeToString(sum[:]), h.d.Clock().UTC().Add(24*time.Hour).Format(time.RFC3339Nano), h.now())
	if err != nil {
		httpx.Error(w, 500, "request failed")
		return
	}
	sent := false
	if h.d.SendTransactionalEmail != nil {
		verifyURL := h.d.WebURL + "/verify-email?token=" + url.QueryEscape(raw)
		htmlBody := `<p>Verify your Zakura email:</p><p><a href="` + html.EscapeString(verifyURL) + `">Verify email</a></p>`
		sent = h.d.SendTransactionalEmail(r.Context(), email, "验证你的 Zakura 邮箱", htmlBody, "Verify your Zakura email:\n\n"+verifyURL) == nil
	}
	httpx.JSON(w, 200, map[string]any{"sent": sent})
}

func (h *routes) listSettings(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin {
		httpx.Error(w, 403, "Admin only")
		return
	}
	rows, err := h.d.DB.QueryContext(r.Context(), h.q(`SELECT key,value FROM settings WHERE owner_key=? ORDER BY key`), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	defer rows.Close()
	items := map[string]any{}
	for rows.Next() {
		var key, raw string
		_ = rows.Scan(&key, &raw)
		if strings.Contains(key, "secret") || strings.Contains(key, "email_transactional") {
			continue
		}
		var value any
		_ = json.Unmarshal([]byte(raw), &value)
		items[key] = value
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
	_, err := h.d.DB.ExecContext(r.Context(), h.q(`INSERT INTO settings(id,owner_key,key,value) VALUES(?,?,?,?) ON CONFLICT(owner_key,key) DO UPDATE SET value=excluded.value`), h.d.NewID(), p.TenantID, key, string(raw))
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
	_, err := h.d.DB.ExecContext(r.Context(), h.q(`INSERT INTO settings(id,owner_key,key,value) VALUES(?,'platform','email.transactional',?) ON CONFLICT(owner_key,key) DO UPDATE SET value=excluded.value`), h.d.NewID(), string(raw))
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
	var raw string
	var stored transactionalEmailStored
	if h.d.DB.QueryRowContext(ctx, `SELECT value FROM settings WHERE owner_key='platform' AND key='email.transactional'`).Scan(&raw) == nil {
		_ = json.Unmarshal([]byte(raw), &stored)
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
	var name, slug string
	var enableComputer, enableMemory, completed bool
	var stepsRaw string
	if err = h.d.DB.QueryRowContext(r.Context(), h.q(`SELECT a.name,a.slug,s.enable_computer,a.enable_memory FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.id=? AND a.tenant_id=?`), agentID, p.TenantID).Scan(&name, &slug, &enableComputer, &enableMemory); err != nil {
		httpx.Error(w, 500, "bootstrap agent unavailable")
		return
	}
	if err = h.d.DB.QueryRowContext(r.Context(), h.q(`SELECT onboarding_steps,onboarding_completed FROM tenants WHERE id=?`), p.TenantID).Scan(&stepsRaw, &completed); err != nil {
		httpx.Error(w, 500, "bootstrap tenant unavailable")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"edition": h.d.Edition,
		"agent": map[string]any{
			"id": agentID, "name": name, "slug": slug,
			"enableComputer": enableComputer, "enableMemory": enableMemory,
			"mcpAgentUrl": strings.TrimRight(h.d.PublicURL, "/") + "/mcp/agents/" + slug,
		},
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
