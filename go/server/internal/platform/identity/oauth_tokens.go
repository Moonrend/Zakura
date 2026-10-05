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

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
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
		_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE oauth_refresh_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL`), s.now(), hex.EncodeToString(h[:]))
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
	var email, name string
	if subject == "" || s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT email,COALESCE(name,'') FROM users WHERE id=? AND status='active'`), subject).Scan(&email, &name) != nil {
		oauthError(w, 401, "invalid_token", "User not found")
		return
	}
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
	rows, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT DISTINCT c.id,c.client_id,c.client_name,c.redirect_uris_json,c.grant_types_json,c.response_types_json,c.token_endpoint_auth_method,c.scope,c.registration_type,c.tenant_id,c.created_at
		FROM oauth_clients c WHERE c.tenant_id=? OR (c.tenant_id IS NULL AND (EXISTS(SELECT 1 FROM oauth_refresh_tokens rt WHERE rt.tenant_id=? AND rt.client_id=c.client_id) OR EXISTS(SELECT 1 FROM oauth_auth_codes ac WHERE ac.tenant_id=? AND ac.client_id=c.client_id))) ORDER BY c.created_at`), p.TenantID, p.TenantID, p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	items := []map[string]any{}
	for rows.Next() {
		var id, cid, name, redirects, grants, responses, method, scope, reg, created string
		var boundTenant sql.NullString
		_ = rows.Scan(&id, &cid, &name, &redirects, &grants, &responses, &method, &scope, &reg, &boundTenant, &created)
		items = append(items, map[string]any{"id": id, "clientId": cid, "clientName": name, "redirectUris": decodeStringArray(redirects), "grantTypes": decodeStringArray(grants), "responseTypes": decodeStringArray(responses), "tokenEndpointAuthMethod": method, "scope": scope, "registrationType": reg, "tenantBound": boundTenant.Valid && boundTenant.String == p.TenantID, "createdAt": created})
	}
	rows.Close()
	rows2, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT id,mcp_url,host,client_id,client_name,source,secret_enc,registration_endpoint,scope,instance_id,created_at,updated_at FROM upstream_oauth_clients WHERE tenant_id=? ORDER BY created_at`), p.TenantID)
	outbound := []map[string]any{}
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	for rows2.Next() {
		var id, mcpURL, host, clientID, clientName, source, created, updated string
		var secret, registration, instance sql.NullString
		var scope string
		_ = rows2.Scan(&id, &mcpURL, &host, &clientID, &clientName, &source, &secret, &registration, &scope, &instance, &created, &updated)
		outbound = append(outbound, map[string]any{"id": id, "mcpUrl": mcpURL, "host": host, "clientId": clientID, "clientName": clientName, "source": source, "hasSecret": secret.Valid && secret.String != "", "registrationEndpoint": nullString(registration), "scope": scope, "instanceId": nullString(instance), "createdAt": created, "updatedAt": updated})
	}
	rows2.Close()
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
