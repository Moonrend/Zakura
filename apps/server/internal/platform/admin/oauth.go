package admin

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/scrypt"
	"gorm.io/gorm/clause"
)

type providerDef struct{ Name, AuthorizeURL, TokenURL, UserinfoURL, Scope string }

var providerDefs = map[string]providerDef{
	"google":    {"Google", "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token", "https://openidconnect.googleapis.com/v1/userinfo", "openid email profile"},
	"github":    {"GitHub", "https://github.com/login/oauth/authorize", "https://github.com/login/oauth/access_token", "https://api.github.com/user", "read:user user:email"},
	"microsoft": {"Microsoft", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "https://login.microsoftonline.com/common/oauth2/v2.0/token", "https://graph.microsoft.com/oidc/userinfo", "openid email profile"},
	"zerocat":   {"ZeroCat", "https://id.zerocat.dev/oauth/authorize", "https://id.zerocat.dev/oauth/token", "https://id.zerocat.dev/oauth/userinfo", "openid email profile"},
}

type providerStored struct {
	Enabled           bool   `json:"enabled"`
	ClientID          string `json:"clientId"`
	ClientSecretEnc   string `json:"clientSecretEnc"`
	AuthorizeURL      string `json:"authorizeUrl"`
	TokenURL          string `json:"tokenUrl"`
	UserinfoURL       string `json:"userinfoUrl"`
	Scope             string `json:"scope"`
	AllowRegistration bool   `json:"allowRegistration"`
}

func (a *routes) readSetting(ctx context.Context, key string) (string, error) {
	var row models.Setting
	if err := a.d.Gorm.WithContext(ctx).Where("owner_key='platform' AND key=?", key).Take(&row).Error; err != nil {
		return "", err
	}
	return row.Value, nil
}
func (a *routes) writeSetting(ctx context.Context, key, raw string) error {
	id := a.d.NewID()
	return a.d.Gorm.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_key"}, {Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value"})}).Create(&models.Setting{ID: &id, OwnerKey: "platform", Key: key, Value: raw}).Error
}
func (a *routes) loadProvider(ctx context.Context, id string) (providerStored, providerDef, error) {
	def, ok := providerDefs[id]
	if !ok {
		return providerStored{}, def, errors.New("unknown oauth provider")
	}
	stored := providerStored{AuthorizeURL: def.AuthorizeURL, TokenURL: def.TokenURL, UserinfoURL: def.UserinfoURL, Scope: def.Scope, AllowRegistration: true}
	if raw, err := a.readSetting(ctx, "auth.oauth."+id); err == nil {
		_ = json.Unmarshal([]byte(raw), &stored)
	}
	return stored, def, nil
}
func (a *routes) publicProvider(ctx context.Context, id string) (map[string]any, error) {
	stored, def, err := a.loadProvider(ctx, id)
	if err != nil {
		return nil, err
	}
	hasSecret := stored.ClientSecretEnc != ""
	return map[string]any{"id": id, "name": def.Name, "enabled": stored.Enabled, "ready": stored.Enabled && stored.ClientID != "" && hasSecret, "clientId": stored.ClientID, "hasClientSecret": hasSecret, "authorizeUrl": stored.AuthorizeURL, "tokenUrl": stored.TokenURL, "userinfoUrl": stored.UserinfoURL, "scope": stored.Scope, "allowRegistration": stored.AllowRegistration, "redirectUri": strings.TrimRight(a.d.WebURL, "/") + "/console/oauth/" + id + "/callback"}, nil
}
func (a *routes) oauthProviders(w http.ResponseWriter, r *http.Request) {
	providers := []map[string]any{}
	ready := []string{}
	for _, id := range []string{"zerocat", "google", "github", "microsoft"} {
		item, _ := a.publicProvider(r.Context(), id)
		providers = append(providers, item)
		if item["ready"] == true {
			ready = append(ready, id)
		}
	}
	policy := map[string]any{"disablePasswordLogin": false, "highlightedMethod": "auto"}
	if raw, err := a.readSetting(r.Context(), "auth.login"); err == nil {
		_ = json.Unmarshal([]byte(raw), &policy)
	}
	disabled, _ := policy["disablePasswordLogin"].(bool)
	effectiveDisabled := disabled && len(ready) > 0
	highlighted, _ := policy["highlightedMethod"].(string)
	if highlighted == "" {
		highlighted = "auto"
	}
	effective := highlighted
	if effective != "auto" && effective != "password" && !contains(ready, effective) {
		effective = "auto"
	}
	httpx.JSON(w, 200, map[string]any{"providers": providers, "disablePasswordLogin": disabled, "passwordLoginEnabled": !effectiveDisabled, "anyOauthReady": len(ready) > 0, "highlightedMethod": highlighted, "highlightedMethodEffective": effective})
}
func (a *routes) putLoginPolicy(w http.ResponseWriter, r *http.Request) {
	var b struct {
		DisablePasswordLogin bool   `json:"disablePasswordLogin"`
		HighlightedMethod    string `json:"highlightedMethod"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	if b.HighlightedMethod == "" {
		b.HighlightedMethod = "auto"
	}
	if b.HighlightedMethod != "auto" && b.HighlightedMethod != "password" {
		if _, ok := providerDefs[b.HighlightedMethod]; !ok {
			httpx.Error(w, 400, "invalid highlightedMethod")
			return
		}
	}
	if b.DisablePasswordLogin {
		ready := false
		for id := range providerDefs {
			item, _ := a.publicProvider(r.Context(), id)
			ready = ready || item["ready"] == true
		}
		if !ready {
			httpx.Error(w, 400, "enable at least one ready OAuth provider before disabling password login")
			return
		}
		if b.HighlightedMethod == "password" {
			b.HighlightedMethod = "auto"
		}
	}
	raw, _ := json.Marshal(b)
	if err := a.writeSetting(r.Context(), "auth.login", string(raw)); err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	a.oauthProviders(w, r)
}
func (a *routes) oauthProvider(w http.ResponseWriter, r *http.Request) {
	item, err := a.publicProvider(r.Context(), chi.URLParam(r, "provider"))
	if err != nil {
		httpx.Error(w, 404, err.Error())
		return
	}
	httpx.JSON(w, 200, item)
}
func (a *routes) putOAuthProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "provider")
	stored, def, err := a.loadProvider(r.Context(), id)
	if err != nil {
		httpx.Error(w, 404, err.Error())
		return
	}
	var patch struct {
		Enabled           *bool   `json:"enabled"`
		ClientID          *string `json:"clientId"`
		ClientSecret      *string `json:"clientSecret"`
		AuthorizeURL      *string `json:"authorizeUrl"`
		TokenURL          *string `json:"tokenUrl"`
		UserinfoURL       *string `json:"userinfoUrl"`
		Scope             *string `json:"scope"`
		AllowRegistration *bool   `json:"allowRegistration"`
	}
	if httpx.DecodeJSON(r, &patch) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	if patch.Enabled != nil {
		stored.Enabled = *patch.Enabled
	}
	if patch.ClientID != nil {
		stored.ClientID = strings.TrimSpace(*patch.ClientID)
	}
	if patch.ClientSecret != nil && strings.TrimSpace(*patch.ClientSecret) != "" {
		stored.ClientSecretEnc, err = sealAdmin(a.d.Secret, []byte(strings.TrimSpace(*patch.ClientSecret)))
		if err != nil {
			httpx.Error(w, 500, "secret encryption failed")
			return
		}
	}
	if patch.AuthorizeURL != nil {
		stored.AuthorizeURL = defaultText(*patch.AuthorizeURL, def.AuthorizeURL)
	}
	if patch.TokenURL != nil {
		stored.TokenURL = defaultText(*patch.TokenURL, def.TokenURL)
	}
	if patch.UserinfoURL != nil {
		stored.UserinfoURL = defaultText(*patch.UserinfoURL, def.UserinfoURL)
	}
	if patch.Scope != nil {
		stored.Scope = defaultText(*patch.Scope, def.Scope)
	}
	if patch.AllowRegistration != nil {
		stored.AllowRegistration = *patch.AllowRegistration
	}
	raw, _ := json.Marshal(stored)
	if err = a.writeSetting(r.Context(), "auth.oauth."+id, string(raw)); err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	item, _ := a.publicProvider(r.Context(), id)
	httpx.JSON(w, 200, item)
}
func sealAdmin(secret, plain []byte) (string, error) {
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
	jsonPlain, _ := json.Marshal(string(plain))
	sealed := gcm.Seal(nil, nonce, jsonPlain, nil)
	ciphertext, tag := sealed[:len(sealed)-gcm.Overhead()], sealed[len(sealed)-gcm.Overhead():]
	payload := append(append(append([]byte{}, nonce...), tag...), ciphertext...)
	return base64.RawURLEncoding.EncodeToString(payload), nil
}
func contains(items []string, v string) bool {
	for _, item := range items {
		if item == v {
			return true
		}
	}
	return false
}
func defaultText(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return strings.TrimSpace(v)
}
