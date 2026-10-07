package identity

import (
	"context"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

type ssoConfig struct {
	TenantID, TenantSlug, TenantName, Protocol, Issuer, ClientID, ClientSecretEnc, AuthorizeURL, TokenURL, JWKSURL, UserinfoURL, Scopes, IDPEntityID, IDPSSOURL, IDPCertificateEnc, DefaultRole string
	JIT, Enforce                                                                                                                                                                                bool
}

func (s *Service) discoverOIDCSSO(ctx context.Context, cfg *ssoConfig) error {
	if cfg.AuthorizeURL != "" && cfg.TokenURL != "" && cfg.JWKSURL != "" {
		for _, endpoint := range []string{cfg.AuthorizeURL, cfg.TokenURL, cfg.JWKSURL} {
			if !validSSOURL(endpoint) {
				return errors.New("OIDC configuration contains an invalid endpoint")
			}
		}
		return nil
	}
	issuer := strings.TrimRight(strings.TrimSpace(cfg.Issuer), "/")
	if issuer == "" || !validSSOURL(issuer) {
		return errors.New("OIDC issuer or endpoints are incomplete")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, issuer+"/.well-known/openid-configuration", nil)
	if err != nil {
		return errors.New("OIDC discovery URL is invalid")
	}
	req.Header.Set("Accept", "application/json")
	client := s.deps.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("OIDC discovery failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("OIDC discovery returned HTTP %d", resp.StatusCode)
	}
	var metadata struct {
		Issuer       string `json:"issuer"`
		AuthorizeURL string `json:"authorization_endpoint"`
		TokenURL     string `json:"token_endpoint"`
		JWKSURL      string `json:"jwks_uri"`
		UserinfoURL  string `json:"userinfo_endpoint"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, (1<<20)+1)).Decode(&metadata); err != nil || strings.TrimRight(metadata.Issuer, "/") != issuer {
		return errors.New("OIDC discovery document is invalid")
	}
	for _, endpoint := range []string{metadata.AuthorizeURL, metadata.TokenURL, metadata.JWKSURL} {
		if !validSSOURL(endpoint) {
			return errors.New("OIDC discovery returned an invalid endpoint")
		}
	}
	if cfg.AuthorizeURL == "" {
		cfg.AuthorizeURL = metadata.AuthorizeURL
	}
	if cfg.TokenURL == "" {
		cfg.TokenURL = metadata.TokenURL
	}
	if cfg.JWKSURL == "" {
		cfg.JWKSURL = metadata.JWKSURL
	}
	if cfg.UserinfoURL == "" && validSSOURL(metadata.UserinfoURL) {
		cfg.UserinfoURL = metadata.UserinfoURL
	}
	for _, endpoint := range []string{cfg.AuthorizeURL, cfg.TokenURL, cfg.JWKSURL} {
		if !validSSOURL(endpoint) {
			return errors.New("OIDC configuration contains an invalid endpoint")
		}
	}
	return nil
}

func validSSOURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return false
	}
	return u.Scheme == "https" || u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
}

func (s *Service) loadSSO(ctx context.Context, slug string) (ssoConfig, error) {
	var c ssoConfig
	var row struct {
		TenantID          string `gorm:"column:tenant_id"`
		TenantSlug        string `gorm:"column:tenant_slug"`
		TenantName        string `gorm:"column:tenant_name"`
		Protocol          string `gorm:"column:protocol"`
		Issuer            string `gorm:"column:issuer"`
		ClientID          string `gorm:"column:client_id"`
		ClientSecretEnc   string `gorm:"column:client_secret_enc"`
		AuthorizeURL      string `gorm:"column:authorize_url"`
		TokenURL          string `gorm:"column:token_url"`
		JWKSURL           string `gorm:"column:jwks_url"`
		UserinfoURL       string `gorm:"column:userinfo_url"`
		Scopes            string `gorm:"column:scopes"`
		IDPEntityID       string `gorm:"column:idp_entity_id"`
		IDPSSOURL         string `gorm:"column:idp_sso_url"`
		IDPCertificateEnc string `gorm:"column:idp_certificate_enc"`
		JIT               bool   `gorm:"column:jit_enabled"`
		Enforce           bool   `gorm:"column:enforce_sso"`
		DefaultRole       string `gorm:"column:default_role"`
	}
	err := s.gdb(ctx).Table("tenants AS t").
		Select("t.id AS tenant_id,t.slug AS tenant_slug,t.name AS tenant_name,c.protocol,COALESCE(c.issuer,'') AS issuer,COALESCE(c.client_id,'') AS client_id,COALESCE(c.client_secret_enc,'') AS client_secret_enc,COALESCE(c.authorize_url,'') AS authorize_url,COALESCE(c.token_url,'') AS token_url,COALESCE(c.jwks_url,'') AS jwks_url,COALESCE(c.userinfo_url,'') AS userinfo_url,c.scopes,COALESCE(c.idp_entity_id,'') AS idp_entity_id,COALESCE(c.idp_sso_url,'') AS idp_sso_url,COALESCE(c.idp_certificate_enc,'') AS idp_certificate_enc,c.jit_enabled,c.enforce_sso,c.default_role").
		Joins("JOIN tenant_sso_configs c ON c.tenant_id = t.id").
		Where("t.slug = ? AND t.status = 'active' AND c.enabled = ?", slug, true).
		Take(&row).Error
	c = ssoConfig{TenantID: row.TenantID, TenantSlug: row.TenantSlug, TenantName: row.TenantName, Protocol: row.Protocol, Issuer: row.Issuer, ClientID: row.ClientID, ClientSecretEnc: row.ClientSecretEnc, AuthorizeURL: row.AuthorizeURL, TokenURL: row.TokenURL, JWKSURL: row.JWKSURL, UserinfoURL: row.UserinfoURL, Scopes: row.Scopes, IDPEntityID: row.IDPEntityID, IDPSSOURL: row.IDPSSOURL, IDPCertificateEnc: row.IDPCertificateEnc, JIT: row.JIT, Enforce: row.Enforce, DefaultRole: row.DefaultRole}
	return c, err
}
func (s *Service) discoverSSO(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Email string `json:"email"`
	}
	if httpx.DecodeJSON(r, &b) != nil || !strings.Contains(b.Email, "@") {
		httpx.JSON(w, 200, map[string]any{"sso": false})
		return
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	var account struct {
		PasswordHash *string `gorm:"column:password_hash"`
	}
	hasAccount := s.gdb(r.Context()).Table("users").Select("password_hash").Where("email = ? AND status = 'active'", email).Take(&account).Error == nil
	hasPassword := hasAccount && account.PasswordHash != nil && *account.PasswordHash != ""
	withPassword := func(body map[string]any) map[string]any {
		if hasAccount {
			body["hasPassword"] = hasPassword
		}
		return body
	}
	domain := strings.ToLower(strings.TrimSpace(strings.SplitN(b.Email, "@", 2)[1]))
	var row struct {
		Slug     string `gorm:"column:slug"`
		Protocol string `gorm:"column:protocol"`
		Required bool   `gorm:"column:required"`
	}
	err := s.gdb(r.Context()).Table("tenant_domains AS d").
		Select("t.slug AS slug,c.protocol,(c.enforce_sso OR d.join_mode='sso_required') AS required").
		Joins("JOIN tenants t ON t.id = d.tenant_id").
		Joins("JOIN tenant_sso_configs c ON c.tenant_id = t.id").
		Where("d.domain = ? AND d.verified_at IS NOT NULL AND c.enabled = ? AND t.status = ?", domain, true, "active").
		Take(&row).Error
	if err != nil {
		httpx.JSON(w, 200, withPassword(map[string]any{"sso": false}))
		return
	}
	httpx.JSON(w, 200, withPassword(map[string]any{"sso": true, "required": row.Required, "protocol": row.Protocol, "tenantSlug": row.Slug}))
}
func (s *Service) startSSO(w http.ResponseWriter, r *http.Request) {
	protocol := httpx.Param(r, "protocol")
	var b struct {
		TenantSlug string `json:"tenantSlug"`
		Email      string `json:"email"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	slug := strings.TrimSpace(b.TenantSlug)
	if slug == "" && strings.Contains(b.Email, "@") {
		domain := strings.ToLower(strings.TrimSpace(strings.SplitN(b.Email, "@", 2)[1]))
		var row struct {
			Slug string `gorm:"column:slug"`
		}
		if s.gdb(r.Context()).Table("tenant_domains AS d").
			Select("t.slug AS slug").
			Joins("JOIN tenants t ON t.id = d.tenant_id").
			Where("d.domain = ? AND d.verified_at IS NOT NULL", domain).
			Take(&row).Error == nil {
			slug = row.Slug
		}
	}
	if slug == "" {
		httpx.Error(w, 400, "unable to determine tenant")
		return
	}
	cfg, err := s.loadSSO(r.Context(), slug)
	if err != nil || cfg.Protocol != protocol {
		httpx.Error(w, 400, "SSO is not configured")
		return
	}
	if protocol == "oidc" {
		if err = s.discoverOIDCSSO(r.Context(), &cfg); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
	}
	state := mustToken(24)
	verifier := mustToken(48)
	nonce := mustToken(24)
	err = s.gdb(r.Context()).Create(&models.SsoLoginState{ID: &state, TenantID: cfg.TenantID, Protocol: protocol, CodeVerifier: &verifier, Nonce: &nonce, ExpiresAt: s.deps.Clock().UTC().Add(10 * time.Minute).Format(time.RFC3339Nano), CreatedAt: s.now()}).Error
	if err != nil {
		httpx.Error(w, 500, "state persistence failed")
		return
	}
	if protocol == "oidc" {
		challenge := sha256.Sum256([]byte(verifier))
		u, err := url.Parse(cfg.AuthorizeURL)
		if err != nil || u.Scheme != "https" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
			httpx.Error(w, 400, "invalid authorize URL")
			return
		}
		q := u.Query()
		q.Set("response_type", "code")
		q.Set("client_id", cfg.ClientID)
		q.Set("redirect_uri", s.deps.WebURL+"/console/sso/oidc/callback")
		q.Set("scope", cfg.Scopes)
		q.Set("state", state)
		q.Set("nonce", nonce)
		q.Set("code_challenge", base64.RawURLEncoding.EncodeToString(challenge[:]))
		q.Set("code_challenge_method", "S256")
		u.RawQuery = q.Encode()
		httpx.JSON(w, 200, map[string]any{"url": u.String(), "state": state})
		return
	}
	if protocol == "saml" {
		requestID := "_" + nonce
		acs := s.deps.PublicURL + "/api/auth/sso/saml/" + cfg.TenantSlug + "/acs"
		xmlRequest := fmt.Sprintf(`<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="%s" Version="2.0" IssueInstant="%s" AssertionConsumerServiceURL="%s"><saml:Issuer>%s</saml:Issuer></samlp:AuthnRequest>`, requestID, s.now(), xmlEscape(acs), xmlEscape(s.deps.PublicURL+"/saml/"+cfg.TenantSlug))
		u, err := url.Parse(cfg.IDPSSOURL)
		if err != nil || u.Scheme != "https" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
			httpx.Error(w, 400, "invalid IdP URL")
			return
		}
		q := u.Query()
		q.Set("SAMLRequest", base64.StdEncoding.EncodeToString([]byte(xmlRequest)))
		q.Set("RelayState", state)
		u.RawQuery = q.Encode()
		httpx.JSON(w, 200, map[string]any{"url": u.String(), "state": state})
		return
	}
	httpx.Error(w, 404, "unknown protocol")
}

func (s *Service) oidcCallback(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Code  string `json:"code"`
		State string `json:"state"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Code == "" || b.State == "" {
		httpx.Error(w, 400, "code and state required")
		return
	}
	var cfg ssoConfig
	var verifier, nonce, stateID string
	err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		if e := tx.QueryRowContext(r.Context(), s.q(`SELECT st.id,st.code_verifier,st.nonce,t.id,t.slug,t.name,c.protocol,COALESCE(c.issuer,''),COALESCE(c.client_id,''),COALESCE(c.client_secret_enc,''),COALESCE(c.authorize_url,''),COALESCE(c.token_url,''),COALESCE(c.jwks_url,''),COALESCE(c.userinfo_url,''),c.scopes,c.jit_enabled,c.enforce_sso,c.default_role FROM sso_login_states st JOIN tenants t ON t.id=st.tenant_id JOIN tenant_sso_configs c ON c.tenant_id=t.id WHERE st.id=? AND st.protocol='oidc' AND st.expires_at>? AND c.enabled=TRUE`), b.State, s.now()).Scan(&stateID, &verifier, &nonce, &cfg.TenantID, &cfg.TenantSlug, &cfg.TenantName, &cfg.Protocol, &cfg.Issuer, &cfg.ClientID, &cfg.ClientSecretEnc, &cfg.AuthorizeURL, &cfg.TokenURL, &cfg.JWKSURL, &cfg.UserinfoURL, &cfg.Scopes, &cfg.JIT, &cfg.Enforce, &cfg.DefaultRole); e != nil {
			return errors.New("invalid or expired state")
		}
		res, e := tx.ExecContext(r.Context(), s.q(`DELETE FROM sso_login_states WHERE id=?`), stateID)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return errors.New("state already used")
		}
		return nil
	})
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if err = s.discoverOIDCSSO(r.Context(), &cfg); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	clientSecret := ""
	if cfg.ClientSecretEnc != "" {
		plain, e := open(s.deps.Secret, cfg.ClientSecretEnc)
		if e != nil {
			httpx.Error(w, 500, "client secret unavailable")
			return
		}
		clientSecret = string(plain)
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {b.Code}, "client_id": {cfg.ClientID}, "redirect_uri": {s.deps.WebURL + "/console/sso/oidc/callback"}, "code_verifier": {verifier}}
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, cfg.TokenURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if e != nil {
		httpx.Error(w, 400, "identity provider token exchange failed")
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		httpx.Error(w, 400, "identity provider rejected the exchange")
		return
	}
	var tokenResp struct {
		IDToken string `json:"id_token"`
	}
	if json.Unmarshal(raw, &tokenResp) != nil || tokenResp.IDToken == "" {
		httpx.Error(w, 400, "identity provider returned no id_token")
		return
	}
	claims, e := s.verifyOIDCToken(r.Context(), cfg, tokenResp.IDToken, nonce)
	if e != nil {
		httpx.Error(w, 400, e.Error())
		return
	}
	email, _ := claims["email"].(string)
	name, _ := claims["name"].(string)
	if email == "" {
		httpx.Error(w, 400, "identity token has no email")
		return
	}
	s.finishSSOLogin(w, r, cfg, email, name, "oidc")
}
func (s *Service) verifyOIDCToken(ctx context.Context, cfg ssoConfig, raw, nonce string) (jwt.MapClaims, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, cfg.JWKSURL, nil)
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return nil, errors.New("JWKS fetch failed")
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var set struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
			Crv string `json:"crv"`
			X   string `json:"x"`
		}
	}
	if json.Unmarshal(body, &set) != nil {
		return nil, errors.New("invalid JWKS")
	}
	unverified := jwt.MapClaims{}
	parsed, _, err := new(jwt.Parser).ParseUnverified(raw, unverified)
	if err != nil {
		return nil, errors.New("invalid id_token")
	}
	kid, _ := parsed.Header["kid"].(string)
	var key any
	for _, j := range set.Keys {
		if kid != "" && j.Kid != kid {
			continue
		}
		switch j.Kty {
		case "RSA":
			nBytes, e1 := base64.RawURLEncoding.DecodeString(j.N)
			eBytes, e2 := base64.RawURLEncoding.DecodeString(j.E)
			if e1 == nil && e2 == nil {
				e := 0
				for _, b := range eBytes {
					e = e<<8 + int(b)
				}
				key = &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: e}
			}
		case "OKP":
			if j.Crv == "Ed25519" {
				x, _ := base64.RawURLEncoding.DecodeString(j.X)
				if len(x) == ed25519.PublicKeySize {
					key = ed25519.PublicKey(x)
				}
			}
		}
		if key != nil {
			break
		}
	}
	if key == nil {
		return nil, errors.New("signing key not found")
	}
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) { return key, nil }, jwt.WithIssuer(cfg.Issuer), jwt.WithAudience(cfg.ClientID), jwt.WithExpirationRequired())
	if err != nil || !token.Valid {
		return nil, fmt.Errorf("identity token verification failed: %w", err)
	}
	if got, _ := claims["nonce"].(string); got != nonce {
		return nil, errors.New("identity token nonce mismatch")
	}
	return claims, nil
}
func (s *Service) finishSSOLogin(w http.ResponseWriter, r *http.Request, cfg ssoConfig, email, name, protocol string) {
	result, err := s.ssoLoginResult(r.Context(), cfg, email, name, requestIP(r), r.UserAgent(), protocol)
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "suspended") || strings.Contains(err.Error(), "not provisioned") {
			status = http.StatusForbidden
		}
		httpx.Error(w, status, err.Error())
		return
	}
	delete(result, "_userId")
	httpx.JSON(w, 200, result)
}

func (s *Service) ssoLoginResult(ctx context.Context, cfg ssoConfig, email, name, ip, userAgent, protocol string) (map[string]any, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	var uid, status string
	var admin bool
	var account models.User
	err := s.gdb(ctx).Select("id,status,is_platform_admin").Where("email = ?", email).Take(&account).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		if !cfg.JIT {
			return nil, errors.New("account is not provisioned")
		}
		uid = s.deps.NewID()
		now := s.now()
		nameValue := name
		err = s.gdb(ctx).Create(&models.User{ID: &uid, Email: email, Name: &nameValue, Status: "active", EmailVerifiedAt: &now, CreatedAt: now, UpdatedAt: now}).Error
	} else if err == nil {
		uid, status, admin = derefString(account.ID), account.Status, account.IsPlatformAdmin
	}
	if err != nil || status == "suspended" {
		return nil, errors.New("account suspended")
	}
	role := cfg.DefaultRole
	if role != "owner" && role != "admin" && role != "member" {
		role = "member"
	}
	now := s.now()
	err = s.gdb(ctx).Exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET status='active',updated_at=excluded.updated_at`, s.deps.NewID(), cfg.TenantID, uid, role, now, now).Error
	if err != nil {
		return nil, errors.New("membership update failed")
	}
	t := Tenant{ID: cfg.TenantID, Slug: cfg.TenantSlug, Name: cfg.TenantName}
	u := User{ID: uid, Email: email, Name: name, IsPlatformAdmin: admin}
	methods, mfaEnabled, required, decisionErr := s.mfaDecision(ctx, uid, role)
	if decisionErr != nil {
		return nil, decisionErr
	}
	if required && len(methods) == 0 {
		ticket, e := s.issueAuthToken(ctx, "mfa_enrollment", uid, map[string]any{"tenantId": cfg.TenantID, "role": role})
		if e != nil {
			return nil, e
		}
		return map[string]any{"mfaEnrollmentRequired": true, "mfaEnrollmentTicket": ticket, "methods": []string{"totp"}, "code": "mfa_enrollment_required", "tenant": t, "_userId": uid}, nil
	}
	if (required || mfaEnabled) && len(methods) > 0 {
		ticket, e := s.issueAuthToken(ctx, "mfa_login", uid, map[string]any{"tenantId": cfg.TenantID, "role": role})
		if e != nil {
			return nil, e
		}
		return map[string]any{"mfaRequired": true, "mfaTicket": ticket, "methods": methods, "tenant": t, "_userId": uid}, nil
	}
	token, err := s.issueSession(ctx, u, t, role, ip, userAgent)
	if err != nil {
		return nil, errors.New("session issue failed")
	}
	_ = s.Audit(ctx, cfg.TenantID, "sso.login", uid, "user", uid, map[string]any{"protocol": protocol})
	s.recordLoginUsage(ctx, cfg.TenantID, uid, protocol)
	return map[string]any{"session": token, "tenant": t, "role": role, "_userId": uid}, nil
}

func (s *Service) samlMetadata(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.loadSSO(r.Context(), httpx.Param(r, "slug"))
	if err != nil || cfg.Protocol != "saml" {
		httpx.Error(w, 404, "SAML is not configured")
		return
	}
	entity := s.deps.PublicURL + "/saml/" + cfg.TenantSlug
	acs := s.deps.PublicURL + "/api/auth/sso/saml/" + cfg.TenantSlug + "/acs"
	w.Header().Set("Content-Type", "application/samlmetadata+xml")
	_, _ = fmt.Fprintf(w, `<?xml version="1.0"?><EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="%s"><SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="%s" index="0" isDefault="true"/></SPSSODescriptor></EntityDescriptor>`, xmlEscape(entity), xmlEscape(acs))
}
func (s *Service) samlACS(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		s.samlFailure(w, r, errors.New("invalid SAML form"))
		return
	}
	rawResponse, state := r.Form.Get("SAMLResponse"), r.Form.Get("RelayState")
	if rawResponse == "" || state == "" {
		s.samlFailure(w, r, errors.New("SAMLResponse and RelayState required"))
		return
	}
	slug := httpx.Param(r, "slug")
	var cfg ssoConfig
	var nonce, stateID string
	err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		if e := tx.QueryRowContext(r.Context(), s.q(`SELECT st.id,st.nonce,t.id,t.slug,t.name,c.protocol,COALESCE(c.idp_entity_id,''),COALESCE(c.idp_sso_url,''),COALESCE(c.idp_certificate_enc,''),c.jit_enabled,c.enforce_sso,c.default_role FROM sso_login_states st JOIN tenants t ON t.id=st.tenant_id JOIN tenant_sso_configs c ON c.tenant_id=t.id WHERE st.id=? AND st.protocol='saml' AND st.expires_at>? AND t.slug=? AND c.enabled=TRUE`), state, s.now(), slug).Scan(&stateID, &nonce, &cfg.TenantID, &cfg.TenantSlug, &cfg.TenantName, &cfg.Protocol, &cfg.IDPEntityID, &cfg.IDPSSOURL, &cfg.IDPCertificateEnc, &cfg.JIT, &cfg.Enforce, &cfg.DefaultRole); e != nil {
			return errors.New("invalid or expired SAML state")
		}
		res, e := tx.ExecContext(r.Context(), s.q(`DELETE FROM sso_login_states WHERE id=?`), stateID)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return errors.New("SAML state already used")
		}
		return nil
	})
	if err != nil {
		s.samlFailure(w, r, err)
		return
	}
	decoded, err := base64.StdEncoding.DecodeString(removeSpace(rawResponse))
	if err != nil || len(decoded) > 2<<20 {
		s.samlFailure(w, r, errors.New("invalid SAML response encoding"))
		return
	}
	root, err := parseXMLDocument(decoded)
	if err != nil {
		s.samlFailure(w, r, errors.New("invalid SAML XML"))
		return
	}
	certRaw, err := open(s.deps.Secret, cfg.IDPCertificateEnc)
	if err != nil {
		s.samlFailure(w, r, errors.New("SAML certificate unavailable"))
		return
	}
	signed, err := verifySAMLSignature(root, string(certRaw))
	if err != nil {
		s.samlFailure(w, r, err)
		return
	}
	if status := root.find("StatusCode"); status != nil && !strings.HasSuffix(status.attr("Value"), ":Success") {
		s.samlFailure(w, r, errors.New("identity provider reported SAML failure"))
		return
	}
	assertion := signed
	if assertion.Local != "Assertion" {
		assertion = signed.find("Assertion")
	}
	if assertion == nil {
		s.samlFailure(w, r, errors.New("signed SAML assertion missing"))
		return
	}
	issuer := assertion.find("Issuer")
	if issuer == nil || strings.TrimSpace(issuer.text()) != cfg.IDPEntityID {
		s.samlFailure(w, r, errors.New("SAML issuer mismatch"))
		return
	}
	if err = validateSAMLTimes(assertion, s.deps.Clock().UTC()); err != nil {
		s.samlFailure(w, r, err)
		return
	}
	entity := s.deps.PublicURL + "/saml/" + cfg.TenantSlug
	audience := assertion.find("Audience")
	if audience == nil || strings.TrimSpace(audience.text()) != entity {
		s.samlFailure(w, r, errors.New("SAML audience mismatch"))
		return
	}
	if conf := assertion.find("SubjectConfirmationData"); conf != nil {
		acs := s.deps.PublicURL + "/api/auth/sso/saml/" + cfg.TenantSlug + "/acs"
		if v := conf.attr("Recipient"); v != "" && v != acs {
			s.samlFailure(w, r, errors.New("SAML recipient mismatch"))
			return
		}
		if v := conf.attr("InResponseTo"); v != "" && v != "_"+nonce {
			s.samlFailure(w, r, errors.New("SAML request correlation failed"))
			return
		}
	}
	email := samlAttribute(assertion, "email", "mail", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress")
	if email == "" {
		if nameID := assertion.find("NameID"); nameID != nil {
			email = strings.TrimSpace(nameID.text())
		}
	}
	if !validEmail(email) {
		s.samlFailure(w, r, errors.New("SAML assertion contains no valid email"))
		return
	}
	name := samlAttribute(assertion, "name", "displayName", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name")
	result, err := s.ssoLoginResult(r.Context(), cfg, email, name, requestIP(r), r.UserAgent(), "saml")
	if err != nil {
		s.samlFailure(w, r, err)
		return
	}
	uid, _ := result["_userId"].(string)
	delete(result, "_userId")
	result["next"] = "/dashboard/agents"
	ticket, err := s.issueAuthToken(r.Context(), "sso_exchange", uid, result)
	if err != nil {
		s.samlFailure(w, r, errors.New("SSO ticket issue failed"))
		return
	}
	http.Redirect(w, r, s.deps.WebURL+"/console/sso/callback?ticket="+url.QueryEscape(ticket), http.StatusFound)
}

func (s *Service) samlFailure(w http.ResponseWriter, r *http.Request, err error) {
	http.Redirect(w, r, s.deps.WebURL+"/login?sso_error="+url.QueryEscape(err.Error()), http.StatusFound)
}
func validateSAMLTimes(assertion *xmlNode, now time.Time) error {
	skew := 2 * time.Minute
	if conditions := assertion.find("Conditions"); conditions != nil {
		if v := conditions.attr("NotBefore"); v != "" {
			t, err := time.Parse(time.RFC3339Nano, v)
			if err != nil || now.Add(skew).Before(t) {
				return errors.New("SAML assertion is not yet valid")
			}
		}
		if v := conditions.attr("NotOnOrAfter"); v != "" {
			t, err := time.Parse(time.RFC3339Nano, v)
			if err != nil || !now.Add(-skew).Before(t) {
				return errors.New("SAML assertion expired")
			}
		}
	}
	if conf := assertion.find("SubjectConfirmationData"); conf != nil {
		if v := conf.attr("NotOnOrAfter"); v != "" {
			t, err := time.Parse(time.RFC3339Nano, v)
			if err != nil || !now.Add(-skew).Before(t) {
				return errors.New("SAML subject confirmation expired")
			}
		}
	}
	return nil
}
func samlAttribute(assertion *xmlNode, names ...string) string {
	wanted := map[string]bool{}
	for _, name := range names {
		wanted[strings.ToLower(name)] = true
	}
	var walk func(*xmlNode) string
	walk = func(n *xmlNode) string {
		if n.Local == "Attribute" && wanted[strings.ToLower(n.attr("Name"))] {
			if v := n.find("AttributeValue"); v != nil {
				return strings.TrimSpace(v.text())
			}
		}
		for _, child := range n.Children {
			if v := walk(child); v != "" {
				return v
			}
		}
		return ""
	}
	return walk(assertion)
}
func (s *Service) exchangeSSOTicket(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Ticket string `json:"ticket"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "ticket required")
		return
	}
	h := sha256.Sum256([]byte(b.Ticket))
	var id, metaRaw string
	err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		if e := tx.QueryRowContext(r.Context(), s.q(`SELECT id,meta_json FROM auth_tokens WHERE token_hash=? AND kind='sso_exchange' AND consumed_at IS NULL AND expires_at>?`), hex.EncodeToString(h[:]), s.now()).Scan(&id, &metaRaw); e != nil {
			return errors.New("invalid ticket")
		}
		res, e := tx.ExecContext(r.Context(), s.q(`UPDATE auth_tokens SET consumed_at=? WHERE id=? AND consumed_at IS NULL`), s.now(), id)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return errors.New("ticket already used")
		}
		return nil
	})
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	meta := decodeObject(metaRaw)
	httpx.JSON(w, 200, meta)
}
func xmlEscape(v string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(v))
	return b.String()
}
