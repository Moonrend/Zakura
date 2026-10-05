package identity

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
)

type loginProviderDef struct{ Name, AuthorizeURL, TokenURL, UserinfoURL, Scope string }

var loginProviders = map[string]loginProviderDef{"google": {"Google", "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token", "https://openidconnect.googleapis.com/v1/userinfo", "openid email profile"}, "github": {"GitHub", "https://github.com/login/oauth/authorize", "https://github.com/login/oauth/access_token", "https://api.github.com/user", "read:user user:email"}, "microsoft": {"Microsoft", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "https://login.microsoftonline.com/common/oauth2/v2.0/token", "https://graph.microsoft.com/v1.0/me", "openid profile email User.Read"}, "zerocat": {"ZeroCat", "https://api.zcservice.houlang.cloud/oauth/authorize", "https://api.zcservice.houlang.cloud/oauth/token", "https://api.zcservice.houlang.cloud/oauth/userinfo", "user:read"}}

type loginProviderConfig struct {
	Enabled           bool   `json:"enabled"`
	ClientID          string `json:"clientId"`
	ClientSecretEnc   string `json:"clientSecretEnc"`
	AuthorizeURL      string `json:"authorizeUrl"`
	TokenURL          string `json:"tokenUrl"`
	UserinfoURL       string `json:"userinfoUrl"`
	Scope             string `json:"scope"`
	AllowRegistration bool   `json:"allowRegistration"`
}

func (s *Service) loadLoginProvider(ctx context.Context, id string) (loginProviderConfig, loginProviderDef, error) {
	def, ok := loginProviders[id]
	if !ok {
		return loginProviderConfig{}, def, errors.New("unknown oauth provider")
	}
	cfg := loginProviderConfig{AuthorizeURL: def.AuthorizeURL, TokenURL: def.TokenURL, UserinfoURL: def.UserinfoURL, Scope: def.Scope, AllowRegistration: true}
	var raw string
	if s.deps.DB.QueryRowContext(ctx, s.q(`SELECT value FROM settings WHERE owner_key='platform' AND key=?`), "auth.oauth."+id).Scan(&raw) == nil {
		_ = json.Unmarshal([]byte(raw), &cfg)
	}
	return cfg, def, nil
}
func (s *Service) passwordLoginEnabled(ctx context.Context) bool {
	var raw string
	disabled := false
	if s.deps.DB.QueryRowContext(ctx, s.q(`SELECT value FROM settings WHERE owner_key='platform' AND key='auth.login'`)).Scan(&raw) == nil {
		var policy struct {
			DisablePasswordLogin bool `json:"disablePasswordLogin"`
		}
		_ = json.Unmarshal([]byte(raw), &policy)
		disabled = policy.DisablePasswordLogin
	}
	if !disabled {
		return true
	}
	for id := range loginProviders {
		cfg, _, _ := s.loadLoginProvider(ctx, id)
		if cfg.Enabled && cfg.ClientID != "" && cfg.ClientSecretEnc != "" {
			return false
		}
	}
	return true
}
func (s *Service) oauthLoginProvider(w http.ResponseWriter, r *http.Request) {
	id := httpx.Param(r, "provider")
	cfg, def, err := s.loadLoginProvider(r.Context(), id)
	if err != nil {
		httpx.Error(w, 404, err.Error())
		return
	}
	httpx.JSON(w, 200, map[string]any{"provider": id, "name": def.Name, "enabled": cfg.Enabled && cfg.ClientID != "" && cfg.ClientSecretEnc != "", "redirectUri": strings.TrimRight(s.deps.WebURL, "/") + "/console/oauth/" + id + "/callback"})
}
func (s *Service) startOAuthLogin(w http.ResponseWriter, r *http.Request) {
	id := httpx.Param(r, "provider")
	cfg, def, err := s.loadLoginProvider(r.Context(), id)
	if err != nil {
		httpx.Error(w, 404, err.Error())
		return
	}
	if !cfg.Enabled || cfg.ClientID == "" || cfg.ClientSecretEnc == "" {
		httpx.Error(w, 400, def.Name+" OAuth is not configured")
		return
	}
	state := mustToken(24)
	verifier := mustToken(32)
	challenge := sha256.Sum256([]byte(verifier))
	_, err = s.deps.DB.ExecContext(r.Context(), s.q(`INSERT INTO oauth_login_states(id,provider,code_verifier,expires_at,created_at) VALUES(?,?,?,?,?)`), state, id, verifier, s.deps.Clock().UTC().Add(10*time.Minute).Format(time.RFC3339Nano), s.now())
	if err != nil {
		httpx.Error(w, 500, "state persistence failed")
		return
	}
	u, err := url.Parse(cfg.AuthorizeURL)
	if err != nil || u.Scheme != "https" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		httpx.Error(w, 400, "invalid provider authorize URL")
		return
	}
	q := u.Query()
	q.Set("client_id", cfg.ClientID)
	q.Set("redirect_uri", strings.TrimRight(s.deps.WebURL, "/")+"/console/oauth/"+id+"/callback")
	q.Set("response_type", "code")
	q.Set("scope", cfg.Scope)
	q.Set("state", state)
	q.Set("code_challenge", base64.RawURLEncoding.EncodeToString(challenge[:]))
	q.Set("code_challenge_method", "S256")
	if id == "google" || id == "microsoft" {
		q.Set("prompt", "select_account")
	}
	u.RawQuery = q.Encode()
	httpx.JSON(w, 200, map[string]any{"authorizeUrl": u.String()})
}
func (s *Service) completeOAuthLogin(w http.ResponseWriter, r *http.Request) {
	id := httpx.Param(r, "provider")
	cfg, def, err := s.loadLoginProvider(r.Context(), id)
	if err != nil {
		httpx.Error(w, 404, err.Error())
		return
	}
	var b struct {
		Code  string `json:"code"`
		State string `json:"state"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Code == "" || b.State == "" {
		httpx.Error(w, 400, "code and state required")
		return
	}
	var verifier, stateID string
	err = appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		if e := tx.QueryRowContext(r.Context(), s.q(`SELECT id,code_verifier FROM oauth_login_states WHERE id=? AND provider=? AND expires_at>?`), b.State, id, s.now()).Scan(&stateID, &verifier); e != nil {
			return errors.New("invalid or expired OAuth state")
		}
		res, e := tx.ExecContext(r.Context(), s.q(`DELETE FROM oauth_login_states WHERE id=?`), stateID)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return errors.New("OAuth state already used")
		}
		return nil
	})
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	secret, err := open(s.deps.Secret, cfg.ClientSecretEnc)
	if err != nil {
		httpx.Error(w, 500, "provider secret unavailable")
		return
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {b.Code}, "client_id": {cfg.ClientID}, "client_secret": {string(secret)}, "redirect_uri": {strings.TrimRight(s.deps.WebURL, "/") + "/console/oauth/" + id + "/callback"}, "code_verifier": {verifier}}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, cfg.TokenURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	client := s.deps.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		httpx.Error(w, 400, "OAuth token exchange failed")
		return
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	var tokens struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	_ = json.Unmarshal(raw, &tokens)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || tokens.AccessToken == "" {
		httpx.Error(w, 400, firstText(tokens.Description, tokens.Error, "OAuth token exchange failed"))
		return
	}
	infoReq, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, cfg.UserinfoURL, nil)
	infoReq.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	infoReq.Header.Set("Accept", "application/json")
	if id == "github" {
		infoReq.Header.Set("User-Agent", "zakura-oauth")
	}
	infoResp, err := client.Do(infoReq)
	if err != nil {
		httpx.Error(w, 400, "OAuth profile request failed")
		return
	}
	profileRaw, _ := io.ReadAll(io.LimitReader(infoResp.Body, 1<<20))
	infoResp.Body.Close()
	var profile map[string]any
	if infoResp.StatusCode < 200 || infoResp.StatusCode >= 300 || json.Unmarshal(profileRaw, &profile) != nil {
		httpx.Error(w, 400, "OAuth profile request failed")
		return
	}
	subject, email, name, verified := normalizeSocialProfile(id, profile)
	if id == "github" {
		if githubEmail, githubVerified := fetchGitHubEmail(r.Context(), client, cfg.UserinfoURL, tokens.AccessToken); githubEmail != "" {
			email, verified = githubEmail, githubVerified
		}
	}
	if subject == "" || !validEmail(email) {
		httpx.Error(w, 400, def.Name+" did not return a usable identity")
		return
	}
	user, tenant, role, err := s.linkSocialIdentity(r.Context(), id, subject, email, name, verified, cfg.AllowRegistration, profileRaw)
	if err != nil {
		httpx.Error(w, 403, err.Error())
		return
	}
	result, err := s.socialAuthResult(r.Context(), user, tenant, role, requestIP(r), r.UserAgent())
	if err != nil {
		httpx.Error(w, 500, err.Error())
		return
	}
	httpx.JSON(w, 200, result)
}

func normalizeSocialProfile(provider string, profile map[string]any) (subject, email, name string, verified bool) {
	email = strings.ToLower(strings.TrimSpace(stringAny(profile["email"])))
	switch provider {
	case "zerocat":
		subject = strings.TrimSpace(stringAny(profile["openid"]))
		username := strings.TrimSpace(stringAny(profile["username"]))
		if email == "" && username != "" {
			email = strings.ToLower(username) + "@zerocat.oauth"
		}
		if email == "" && subject != "" {
			safe := strings.Map(func(r rune) rune {
				if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("._-", r) {
					return r
				}
				return '_'
			}, strings.ToLower(subject))
			email = safe + "@zerocat.oauth"
		}
		verified, _ = profile["email_verified"].(bool)
		verified = verified && !strings.HasSuffix(email, "@zerocat.oauth")
		name = firstText(stringAny(profile["nickname"]), username, strings.Split(email, "@")[0], "ZeroCat User")
	case "google":
		subject = strings.TrimSpace(stringAny(profile["sub"]))
		verified, _ = profile["email_verified"].(bool)
		name = firstText(stringAny(profile["name"]), stringAny(profile["given_name"]), strings.Split(email, "@")[0], "Google User")
	case "github":
		subject = strings.TrimSpace(stringAny(profile["id"]))
		name = firstText(stringAny(profile["name"]), stringAny(profile["login"]), strings.Split(email, "@")[0], "GitHub User")
	case "microsoft":
		subject = strings.TrimSpace(stringAny(profile["id"]))
		if email == "" {
			email = strings.ToLower(strings.TrimSpace(stringAny(profile["mail"])))
		}
		if email == "" {
			email = strings.ToLower(strings.TrimSpace(stringAny(profile["userPrincipalName"])))
		}
		verified = email != ""
		name = firstText(stringAny(profile["displayName"]), strings.Split(email, "@")[0], "Microsoft User")
	default:
		subject = firstText(stringAny(profile["sub"]), stringAny(profile["id"]))
		verified, _ = profile["email_verified"].(bool)
		name = firstText(stringAny(profile["name"]), email)
	}
	return subject, email, name, verified
}

func fetchGitHubEmail(ctx context.Context, client *http.Client, userinfoURL, token string) (string, bool) {
	u, err := url.Parse(userinfoURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", false
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/emails"
	u.RawQuery = ""
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "zakura-oauth")
	resp, err := client.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", false
	}
	type emailRecord struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	var list []emailRecord
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&list) != nil {
		return "", false
	}
	for _, preference := range []func(emailRecord) bool{
		func(item emailRecord) bool { return item.Primary && item.Verified },
		func(item emailRecord) bool { return item.Verified },
		func(emailRecord) bool { return true },
	} {
		for _, item := range list {
			email := strings.ToLower(strings.TrimSpace(item.Email))
			if preference(item) && validEmail(email) {
				return email, item.Verified
			}
		}
	}
	return "", false
}

func (s *Service) linkSocialIdentity(ctx context.Context, provider, subject, email, name string, verified, allowRegistration bool, profile []byte) (User, Tenant, string, error) {
	var uid string
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT user_id FROM oauth_identities WHERE provider=? AND provider_user_id=?`), provider, subject).Scan(&uid)
	if errors.Is(err, sql.ErrNoRows) {
		if verified {
			_ = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id FROM users WHERE email=?`), email).Scan(&uid)
		}
		if uid == "" {
			if !allowRegistration {
				return User{}, Tenant{}, "", errors.New("OAuth account is not linked and registration is disabled")
			}
			uid = s.deps.NewID()
			tid := s.deps.NewID()
			slug := slugify(name) + "-" + strings.ToLower(tid[:6])
			now := s.now()
			err = appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
				if _, e := tx.ExecContext(ctx, s.q(`INSERT INTO users(id,email,name,is_platform_admin,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,FALSE,'active',NULL,?,?)`), uid, email, name, now, now); e != nil {
					return e
				}
				if _, e := tx.ExecContext(ctx, s.q(`INSERT INTO tenants(id,slug,name,is_default,onboarding_completed,onboarding_steps,status,created_at,updated_at) VALUES(?,?,?,FALSE,FALSE,'{}','active',?,?)`), tid, slug, name+" Workspace", now, now); e != nil {
					return e
				}
				_, e := tx.ExecContext(ctx, s.q(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'owner','active',?,?)`), s.deps.NewID(), tid, uid, now, now)
				return e
			})
			if err != nil {
				return User{}, Tenant{}, "", err
			}
		}
		_, err = s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO oauth_identities(id,provider,provider_user_id,user_id,profile_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`), s.deps.NewID(), provider, subject, uid, string(profile), s.now(), s.now())
		if err != nil {
			return User{}, Tenant{}, "", err
		}
	} else if err != nil {
		return User{}, Tenant{}, "", err
	} else {
		_, _ = s.deps.DB.ExecContext(ctx, s.q(`UPDATE oauth_identities SET profile_json=?,updated_at=? WHERE provider=? AND provider_user_id=?`), string(profile), s.now(), provider, subject)
	}
	var u User
	if err = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,email,COALESCE(name,''),is_platform_admin FROM users WHERE id=? AND status='active'`), uid).Scan(&u.ID, &u.Email, &u.Name, &u.IsPlatformAdmin); err != nil {
		return u, Tenant{}, "", errors.New("account unavailable")
	}
	var t Tenant
	var role string
	if err = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT t.id,t.slug,t.name,t.is_default,t.onboarding_completed,m.role FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id WHERE m.user_id=? AND m.status='active' AND t.status='active' ORDER BY t.created_at LIMIT 1`), uid).Scan(&t.ID, &t.Slug, &t.Name, &t.IsDefault, &t.OnboardingCompleted, &role); err != nil {
		return u, t, "", errors.New("account has no active tenant")
	}
	return u, t, role, nil
}
func (s *Service) socialAuthResult(ctx context.Context, u User, t Tenant, role, ip, ua string) (map[string]any, error) {
	var totp sql.NullString
	var passkeys int
	var policy string
	_ = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT totp_enabled_at FROM users WHERE id=?`), u.ID).Scan(&totp)
	_ = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM user_webauthn_credentials WHERE user_id=?`), u.ID).Scan(&passkeys)
	_ = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT mfa_policy FROM tenants WHERE id=?`), t.ID).Scan(&policy)
	methods := []string{}
	if totp.Valid {
		methods = append(methods, "totp", "recovery")
	}
	if passkeys > 0 {
		methods = append(methods, "webauthn")
	}
	required := policy == "all" || (policy == "admins" && (role == "owner" || role == "admin"))
	if required && len(methods) == 0 {
		ticket, e := s.issueAuthToken(ctx, "mfa_enrollment", u.ID, map[string]any{"tenantId": t.ID, "role": role})
		return map[string]any{"mfaEnrollmentRequired": true, "mfaEnrollmentTicket": ticket, "methods": []string{"totp"}, "code": "mfa_enrollment_required"}, e
	}
	if len(methods) > 0 {
		ticket, e := s.issueAuthToken(ctx, "mfa_login", u.ID, map[string]any{"tenantId": t.ID, "role": role})
		return map[string]any{"mfaRequired": true, "mfaTicket": ticket, "methods": methods, "user": u, "tenant": t, "next": map[bool]string{true: "/dashboard/agents", false: "/onboarding"}[t.OnboardingCompleted]}, e
	}
	token, e := s.issueSession(ctx, u, t, role, ip, ua)
	if e == nil {
		s.recordLoginUsage(ctx, t.ID, u.ID, "oauth")
	}
	return map[string]any{"session": token, "user": u, "tenant": t, "next": map[bool]string{true: "/dashboard/agents", false: "/onboarding"}[t.OnboardingCompleted]}, e
}
func stringAny(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case float64:
		return strings.TrimSuffix(strings.TrimSuffix(strconv.FormatFloat(x, 'f', -1, 64), ".0"), ".")
	}
	return ""
}
func firstText(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
