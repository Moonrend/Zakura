package identity

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func (s *Service) token(w http.ResponseWriter, r *http.Request) {
	v, err := requestValues(r)
	if err != nil {
		oauthError(w, 400, "invalid_request", err.Error())
		return
	}
	c, err := s.authenticateOAuthClient(r, v)
	if err != nil {
		oauthError(w, 401, "invalid_client", err.Error())
		return
	}
	switch v.Get("grant_type") {
	case "authorization_code":
		s.exchangeCode(w, r, c, v)
	case "refresh_token":
		s.exchangeRefresh(w, r, c, v)
	default:
		oauthError(w, 400, "unsupported_grant_type", "unsupported grant_type")
	}
}
func (s *Service) authenticateOAuthClient(r *http.Request, v url.Values) (oauthClient, error) {
	clientID, secret := v.Get("client_id"), v.Get("client_secret")
	if id, pw, ok := r.BasicAuth(); ok {
		clientID, secret = id, pw
	}
	c, err := s.resolveOAuthClient(r.Context(), clientID)
	if err != nil {
		return c, errors.New("unknown client")
	}
	assertion := v.Get("client_assertion")
	if c.Method == "private_key_jwt" || assertion != "" {
		if err := s.verifyClientAssertion(r.Context(), c, assertion, v.Get("client_assertion_type")); err != nil {
			return c, err
		}
		return c, nil
	}
	if c.Method != "none" && !oauthClientSecretMatches(c.SecretHash, secret) {
		return c, errors.New("bad client secret")
	}
	return c, nil
}

// Pinned Zakura persists OAuth client secrets as a SHA-256 hex digest. Accept
// the prerelease Go bcrypt representation as a read-only fallback so databases
// created during the rewrite remain usable while every new write is compatible
// with the TypeScript schema.
func oauthClientSecretMatches(stored, secret string) bool {
	h := sha256.Sum256([]byte(secret))
	want := hex.EncodeToString(h[:])
	if len(stored) == len(want) && subtle.ConstantTimeCompare([]byte(stored), []byte(want)) == 1 {
		return true
	}
	return bcrypt.CompareHashAndPassword([]byte(stored), []byte(secret)) == nil
}
func (s *Service) exchangeCode(w http.ResponseWriter, r *http.Request, c oauthClient, v url.Values) {
	raw := v.Get("code")
	h := sha256.Sum256([]byte(raw))
	key, keyErr := s.signingKey(r.Context())
	if keyErr != nil {
		oauthError(w, 500, "server_error", "token signing failed")
		return
	}
	var id, userID, tenantID, redirectURI, scope, challenge, method string
	var agentID, resource sql.NullString
	var out map[string]any
	var issueErr error
	err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		if e := tx.QueryRowContext(r.Context(), s.q(`SELECT id,user_id,tenant_id,agent_id,redirect_uri,scope,resource,COALESCE(code_challenge,''),COALESCE(code_challenge_method,'') FROM oauth_auth_codes WHERE code_hash=? AND client_id=? AND used_at IS NULL AND expires_at>?`), hex.EncodeToString(h[:]), c.ID, s.now()).Scan(&id, &userID, &tenantID, &agentID, &redirectURI, &scope, &resource, &challenge, &method); e != nil {
			return errors.New("invalid or expired code")
		}
		if redirectURI != v.Get("redirect_uri") {
			return errors.New("redirect_uri mismatch")
		}
		verifier := v.Get("code_verifier")
		digest := sha256.Sum256([]byte(verifier))
		if method != "S256" || subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(digest[:])), []byte(challenge)) != 1 {
			return errors.New("invalid code_verifier")
		}
		res, e := tx.ExecContext(r.Context(), s.q(`UPDATE oauth_auth_codes SET used_at=? WHERE id=? AND used_at IS NULL`), s.now(), id)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return errors.New("authorization code already used")
		}
		if requested := strings.TrimSpace(v.Get("resource")); requested != "" {
			resource = sql.NullString{String: requested, Valid: true}
		}
		out, issueErr = s.issueOAuthTokensTx(r.Context(), tx, key, c.ID, userID, tenantID, nullString(agentID), scope, nullString(resource), "")
		return issueErr
	})
	if err != nil {
		if issueErr != nil {
			oauthError(w, 500, "server_error", "token issue failed")
			return
		}
		oauthError(w, 400, "invalid_grant", err.Error())
		return
	}
	httpx.JSON(w, 200, out)
}
func (s *Service) exchangeRefresh(w http.ResponseWriter, r *http.Request, c oauthClient, v url.Values) {
	raw := v.Get("refresh_token")
	h := sha256.Sum256([]byte(raw))
	key, keyErr := s.signingKey(r.Context())
	if keyErr != nil {
		oauthError(w, 500, "server_error", "token signing failed")
		return
	}
	var id, family, userID, tenantID, scope string
	var agentID, resource sql.NullString
	var out map[string]any
	var issueErr error
	err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		if e := tx.QueryRowContext(r.Context(), s.q(`SELECT id,COALESCE(family_id,id),user_id,tenant_id,agent_id,scope,resource FROM oauth_refresh_tokens WHERE token_hash=? AND client_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`), hex.EncodeToString(h[:]), c.ID, s.now()).Scan(&id, &family, &userID, &tenantID, &agentID, &scope, &resource); e != nil {
			return errors.New("invalid refresh token")
		}
		res, e := tx.ExecContext(r.Context(), s.q(`UPDATE oauth_refresh_tokens SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL`), s.now(), id)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return errors.New("refresh token already used")
		}
		if requested := strings.TrimSpace(v.Get("resource")); requested != "" {
			resource = sql.NullString{String: requested, Valid: true}
		}
		out, issueErr = s.issueOAuthTokensTx(r.Context(), tx, key, c.ID, userID, tenantID, nullString(agentID), scope, nullString(resource), family)
		return issueErr
	})
	if err != nil {
		if issueErr != nil {
			oauthError(w, 500, "server_error", "token issue failed")
			return
		}
		oauthError(w, 400, "invalid_grant", err.Error())
		return
	}
	httpx.JSON(w, 200, out)
}
func (s *Service) issueOAuthTokensTx(ctx context.Context, tx *sql.Tx, key *oauthSigningKey, clientID, userID, tenantID string, agentID any, scope string, resource any, family string) (map[string]any, error) {
	var email, name, role string
	if tx.QueryRowContext(ctx, s.q(`SELECT u.email,COALESCE(u.name,''),m.role FROM users u JOIN tenant_memberships m ON m.user_id=u.id JOIN tenants t ON t.id=m.tenant_id WHERE u.id=? AND m.tenant_id=? AND u.status='active' AND m.status='active' AND t.status='active'`), userID, tenantID).Scan(&email, &name, &role) != nil {
		return nil, errors.New("inactive account")
	}
	now := s.deps.Clock().UTC()
	audience := any(clientID)
	if resource != nil && resource != "" {
		audience = resource
	}
	claims := jwt.MapClaims{"iss": s.deps.PublicURL, "sub": userID, "aud": audience, "tid": tenantID, "cid": clientID, "aid": agentID, "resource": resource, "scope": scope, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(), "jti": s.deps.NewID()}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = key.Kid
	token.Header["typ"] = "at+jwt"
	access, err := token.SignedString(key.Private)
	if err != nil {
		return nil, err
	}
	refresh := "rcr_" + mustToken(32)
	h := sha256.Sum256([]byte(refresh))
	if family == "" {
		family = s.deps.NewID()
	}
	_, err = tx.ExecContext(ctx, s.q(`INSERT INTO oauth_refresh_tokens(id,family_id,token_hash,client_id,user_id,tenant_id,agent_id,scope,resource,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`), s.deps.NewID(), family, hex.EncodeToString(h[:]), clientID, userID, tenantID, agentID, scope, resource, now.Add(30*24*time.Hour).Format(time.RFC3339Nano), s.now())
	if err != nil {
		return nil, err
	}
	out := map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": 3600, "refresh_token": refresh, "scope": scope}
	if scopeContains(scope, "openid") {
		idClaims := jwt.MapClaims{"iss": s.deps.PublicURL, "sub": userID, "aud": clientID, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(), "auth_time": now.Unix()}
		if scopeContains(scope, "email") {
			idClaims["email"], idClaims["email_verified"] = email, true
		}
		if scopeContains(scope, "profile") {
			if name != "" {
				idClaims["name"] = name
			}
			idClaims["preferred_username"] = email
		}
		idToken := jwt.NewWithClaims(jwt.SigningMethodRS256, idClaims)
		idToken.Header["kid"] = key.Kid
		signed, signErr := idToken.SignedString(key.Private)
		if signErr != nil {
			return nil, signErr
		}
		out["id_token"] = signed
	}
	return out, nil
}
func (s *Service) revokeToken(w http.ResponseWriter, r *http.Request) {
	v, err := requestValues(r)
	if err == nil {
		h := sha256.Sum256([]byte(v.Get("token")))
		_ = s.gdb(r.Context()).Model(&models.OauthRefreshToken{}).Where("token_hash = ? AND revoked_at IS NULL", hex.EncodeToString(h[:])).Update("revoked_at", s.now()).Error
	}
	w.WriteHeader(200)
}

type oauthClaimsKey struct{}

func (s *Service) oauthBearer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Fields(r.Header.Get("Authorization"))
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			oauthError(w, 401, "invalid_token", "Bearer token required")
			return
		}
		key, keyErr := s.signingKey(r.Context())
		if keyErr != nil {
			oauthError(w, 500, "server_error", "signing key unavailable")
			return
		}
		claims := jwt.MapClaims{}
		token, err := jwt.ParseWithClaims(parts[1], claims, func(t *jwt.Token) (any, error) {
			switch t.Method {
			case jwt.SigningMethodRS256:
				return &key.Private.PublicKey, nil
			case jwt.SigningMethodEdDSA:
				seed := sha256.Sum256(append(append([]byte{}, s.deps.Secret...), []byte("zakura-oauth-eddsa-v1")...))
				return ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey), nil
			default:
				return nil, errors.New("invalid algorithm")
			}
		}, jwt.WithIssuer(s.deps.PublicURL), jwt.WithExpirationRequired(), jwt.WithValidMethods([]string{"RS256", "EdDSA"}), jwt.WithTimeFunc(func() time.Time { return s.deps.Clock() }))
		if err != nil || !token.Valid {
			oauthError(w, 401, "invalid_token", "Invalid access token")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), oauthClaimsKey{}, claims)))
	})
}
func (s *Service) userinfo(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(oauthClaimsKey{}).(jwt.MapClaims)
	subject, _ := c["sub"].(string)
	if subject == "" {
		oauthError(w, 401, "invalid_token", "User not found")
		return
	}
	var account models.User
	if s.gdb(r.Context()).Select("email,name").Where("id = ? AND status = 'active'", subject).Take(&account).Error != nil {
		oauthError(w, 401, "invalid_token", "User not found")
		return
	}
	email, name := account.Email, derefString(account.Name)
	out := map[string]any{"sub": subject}
	scope, _ := c["scope"].(string)
	if scopeContains(scope, "email") || scopeContains(scope, "openid") || scopeContains(scope, "mcp") {
		out["email"], out["email_verified"] = email, true
	}
	if scopeContains(scope, "profile") || scopeContains(scope, "openid") {
		if name != "" {
			out["name"] = name
		}
		out["preferred_username"] = email
	}
	httpx.JSON(w, 200, out)
}

func scopeContains(scope, expected string) bool {
	for _, item := range strings.Fields(scope) {
		if item == expected {
			return true
		}
	}
	return false
}
func (s *Service) listOAuthClients(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var rows []struct {
		ID           string  `gorm:"column:id"`
		ClientID     string  `gorm:"column:client_id"`
		ClientName   string  `gorm:"column:client_name"`
		Redirects    string  `gorm:"column:redirect_uris_json"`
		Grants       string  `gorm:"column:grant_types_json"`
		Responses    string  `gorm:"column:response_types_json"`
		Method       string  `gorm:"column:token_endpoint_auth_method"`
		Scope        string  `gorm:"column:scope"`
		Registration string  `gorm:"column:registration_type"`
		TenantID     *string `gorm:"column:tenant_id"`
		CreatedAt    string  `gorm:"column:created_at"`
	}
	if err := s.gdb(r.Context()).Table("oauth_clients AS c").
		Select("DISTINCT c.id,c.client_id,c.client_name,c.redirect_uris_json,c.grant_types_json,c.response_types_json,c.token_endpoint_auth_method,c.scope,c.registration_type,c.tenant_id,c.created_at").
		Where("c.tenant_id = ? OR (c.tenant_id IS NULL AND (EXISTS(SELECT 1 FROM oauth_refresh_tokens rt WHERE rt.tenant_id = ? AND rt.client_id = c.client_id) OR EXISTS(SELECT 1 FROM oauth_auth_codes ac WHERE ac.tenant_id = ? AND ac.client_id = c.client_id)))", p.TenantID, p.TenantID, p.TenantID).
		Order("c.created_at").Find(&rows).Error; err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	items := []map[string]any{}
	for _, row := range rows {
		items = append(items, map[string]any{"id": row.ID, "clientId": row.ClientID, "clientName": row.ClientName, "redirectUris": decodeStringArray(row.Redirects), "grantTypes": decodeStringArray(row.Grants), "responseTypes": decodeStringArray(row.Responses), "tokenEndpointAuthMethod": row.Method, "scope": row.Scope, "registrationType": row.Registration, "tenantBound": row.TenantID != nil && *row.TenantID == p.TenantID, "createdAt": row.CreatedAt})
	}
	var upstream []models.UpstreamOauthClient
	if err := s.gdb(r.Context()).Where("tenant_id = ?", p.TenantID).Order("created_at").Find(&upstream).Error; err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	outbound := []map[string]any{}
	for _, record := range upstream {
		outbound = append(outbound, map[string]any{"id": derefString(record.ID), "mcpUrl": record.McpURL, "host": record.Host, "clientId": record.ClientID, "clientName": record.ClientName, "source": record.Source, "hasSecret": record.SecretEnc != nil && *record.SecretEnc != "", "registrationEndpoint": nullableString(record.RegistrationEndpoint), "scope": record.Scope, "instanceId": nullableString(record.InstanceID), "createdAt": record.CreatedAt, "updatedAt": record.UpdatedAt})
	}
	dcr := []map[string]any{}
	byo := []map[string]any{}
	for _, item := range outbound {
		if item["source"] == "dcr" {
			dcr = append(dcr, item)
		} else if item["source"] == "byo" {
			byo = append(byo, item)
		}
	}
	httpx.JSON(w, 200, map[string]any{"inbound": items, "outbound": outbound, "dcr": dcr, "byo": byo})
}
func requestValues(r *http.Request) (url.Values, error) {
	if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
		var m map[string]string
		if err := httpx.DecodeJSON(r, &m); err != nil {
			return nil, err
		}
		v := url.Values{}
		for k, x := range m {
			v.Set(k, x)
		}
		return v, nil
	}
	if err := r.ParseForm(); err != nil {
		return nil, err
	}
	return r.PostForm, nil
}
func decodeStringArray(raw string) []string {
	var v []string
	_ = json.Unmarshal([]byte(raw), &v)
	if v == nil {
		v = []string{}
	}
	return v
}
