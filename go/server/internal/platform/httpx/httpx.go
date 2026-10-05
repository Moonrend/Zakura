package httpx

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
)

const maxJSONBody = 2 << 20

type Principal struct {
	UserID          string `json:"userId"`
	TenantID        string `json:"tenantId"`
	Email           string `json:"email"`
	Role            string `json:"role"`
	SessionID       string `json:"sid"`
	IsPlatformAdmin bool   `json:"isPlatformAdmin"`
	APIKey          bool   `json:"apiKey"`
	APIKeyID        string `json:"-"`
	AgentID         string `json:"-"`
	APIKeyScopes    string `json:"-"`
	OAuth           bool   `json:"-"`
	OAuthScope      string `json:"-"`
}

type principalKey struct{}

func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}
func Param(r *http.Request, name string) string { return chi.URLParam(r, name) }

func JSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func Error(w http.ResponseWriter, status int, message string) {
	JSON(w, status, map[string]any{"error": message})
}

func DecodeJSON(r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, maxJSONBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return errors.New("request body must contain one JSON value")
		}
		return err
	}
	return nil
}

func Auth(deps *appdeps.Dependencies) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := bearerToken(r.Header.Get("Authorization"))
			if raw == "" {
				Error(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			p, err := authenticate(r.Context(), deps, raw)
			if err != nil {
				Error(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			if p.OAuth && !oauthScopeAllows(p.OAuthScope, r.URL.Path) {
				Error(w, http.StatusForbidden, "insufficient_scope")
				return
			}
			if p.APIKey && strings.HasPrefix(r.URL.Path, "/api/") && !apiKeyAllows(p.APIKeyScopes, "api") {
				Error(w, http.StatusForbidden, "insufficient_scope")
				return
			}
			next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), p)))
		})
	}
}

func OptionalAuth(deps *appdeps.Dependencies) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := bearerToken(r.Header.Get("Authorization"))
			if raw == "" {
				next.ServeHTTP(w, r)
				return
			}
			if p, err := authenticate(r.Context(), deps, raw); err == nil && (!p.OAuth || oauthScopeAllows(p.OAuthScope, r.URL.Path)) {
				r = r.WithContext(WithPrincipal(r.Context(), p))
			}
			next.ServeHTTP(w, r)
		})
	}
}

func RequireRole(roles ...string) func(http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, role := range roles {
		allowed[role] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := PrincipalFrom(r.Context())
			if !ok {
				Error(w, 401, "unauthorized")
				return
			}
			if !allowed[p.Role] && !p.IsPlatformAdmin {
				Error(w, 403, "forbidden")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func RequirePlatformAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			Error(w, 401, "unauthorized")
			return
		}
		if !p.IsPlatformAdmin {
			Error(w, 403, "Platform admin only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func bearerToken(v string) string {
	parts := strings.Fields(v)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

func authenticate(ctx context.Context, deps *appdeps.Dependencies, raw string) (Principal, error) {
	if strings.HasPrefix(raw, "zak_") || strings.HasPrefix(raw, "zk_") {
		h := sha256.Sum256([]byte(raw))
		p := Principal{UserID: "api-key", Role: "api_key", APIKey: true}
		err := deps.DB.QueryRowContext(ctx, deps.Rebind(`SELECT k.id,k.tenant_id,k.name,COALESCE(k.agent_id,''),k.scopes FROM api_keys k JOIN tenants t ON t.id=k.tenant_id WHERE k.key_hash=? AND k.revoked_at IS NULL AND t.status='active' AND (k.expires_at IS NULL OR k.expires_at>?)`), hex.EncodeToString(h[:]), deps.Clock().UTC().Format(time.RFC3339Nano)).Scan(&p.APIKeyID, &p.TenantID, &p.Email, &p.AgentID, &p.APIKeyScopes)
		if err != nil {
			return Principal{}, err
		}
		_, _ = deps.DB.ExecContext(ctx, deps.Rebind(`UPDATE api_keys SET last_used_at=? WHERE id=?`), deps.Clock().UTC().Format(time.RFC3339Nano), p.APIKeyID)
		return p, nil
	}
	// OAuth 2.1 access tokens are EdDSA JWTs derived from the same server secret
	// as the authorization server key. They act as the signing user, but only
	// the `api` scope may reach ordinary APIs (`mcp` is sufficient for /mcp).
	if p, err := authenticateOAuthAccess(ctx, deps, raw); err == nil {
		return p, nil
	}
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("invalid signing method")
		}
		return deps.Secret, nil
	}, jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || !token.Valid {
		return Principal{}, errors.New("invalid token")
	}
	stringClaim := func(k string) string { v, _ := claims[k].(string); return v }
	p := Principal{UserID: stringClaim("sub"), TenantID: stringClaim("tenantId"), Email: stringClaim("email"), Role: stringClaim("role"), SessionID: stringClaim("sid")}
	admin, _ := claims["isPlatformAdmin"].(bool)
	p.IsPlatformAdmin = admin
	if p.UserID == "" || p.TenantID == "" || p.SessionID == "" {
		return Principal{}, errors.New("missing claims")
	}
	h := sha256.Sum256([]byte(raw))
	var dbUser, dbTenant, userStatus, tenantStatus, membershipStatus, dbRole, dbEmail string
	var dbAdmin bool
	err = deps.DB.QueryRowContext(ctx, deps.Rebind(`SELECT s.user_id,s.tenant_id,u.status,t.status,m.status,m.role,u.email,u.is_platform_admin
		FROM user_sessions s
		JOIN users u ON u.id=s.user_id
		JOIN tenants t ON t.id=s.tenant_id
		JOIN tenant_memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id
		WHERE s.id=? AND (s.token_hash=? OR s.token_hash IS NULL) AND s.revoked_at IS NULL AND s.expires_at>?`), p.SessionID, hex.EncodeToString(h[:]), deps.Clock().UTC().Format(time.RFC3339Nano)).Scan(&dbUser, &dbTenant, &userStatus, &tenantStatus, &membershipStatus, &dbRole, &dbEmail, &dbAdmin)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Principal{}, errors.New("revoked session")
		}
		return Principal{}, err
	}
	if dbUser != p.UserID || dbTenant != p.TenantID || userStatus != "active" || tenantStatus != "active" || membershipStatus != "active" {
		return Principal{}, errors.New("inactive principal")
	}
	p.IsPlatformAdmin = dbAdmin
	p.Role = dbRole
	p.Email = dbEmail
	return p, nil
}

func authenticateOAuthAccess(ctx context.Context, deps *appdeps.Dependencies, raw string) (Principal, error) {
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		switch t.Method {
		case jwt.SigningMethodRS256:
			if deps.OAuthPublicKey == nil {
				return nil, errors.New("OAuth signing key unavailable")
			}
			return deps.OAuthPublicKey(ctx)
		case jwt.SigningMethodEdDSA:
			// Read-only compatibility for access tokens issued by early Go builds.
			seed := sha256.Sum256(append(append([]byte{}, deps.Secret...), []byte("zakura-oauth-eddsa-v1")...))
			return ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey), nil
		default:
			return nil, errors.New("invalid signing method")
		}
	}, jwt.WithIssuer(deps.PublicURL), jwt.WithExpirationRequired(), jwt.WithValidMethods([]string{"RS256", "EdDSA"}), jwt.WithTimeFunc(func() time.Time { return deps.Clock() }))
	if err != nil || !token.Valid {
		return Principal{}, errors.New("invalid OAuth access token")
	}
	stringClaim := func(name string) string {
		value, _ := claims[name].(string)
		return value
	}
	tenantID := stringClaim("tid")
	if tenantID == "" {
		tenantID = stringClaim("tenantId")
	}
	p := Principal{UserID: stringClaim("sub"), TenantID: tenantID, AgentID: stringClaim("aid"), OAuthScope: stringClaim("scope"), OAuth: true}
	if p.UserID == "" || p.TenantID == "" {
		return Principal{}, errors.New("invalid OAuth principal")
	}
	var userStatus, tenantStatus, membershipStatus string
	err = deps.DB.QueryRowContext(ctx, deps.Rebind(`SELECT u.email,u.is_platform_admin,u.status,t.status,m.role,m.status
		FROM users u JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=? JOIN tenants t ON t.id=m.tenant_id WHERE u.id=?`), p.TenantID, p.UserID).
		Scan(&p.Email, &p.IsPlatformAdmin, &userStatus, &tenantStatus, &p.Role, &membershipStatus)
	if err != nil || userStatus != "active" || tenantStatus != "active" || membershipStatus != "active" {
		return Principal{}, errors.New("inactive OAuth principal")
	}
	return p, nil
}

func oauthScopeAllows(scope, path string) bool {
	wantsMCP := path == "/mcp" || strings.HasPrefix(path, "/mcp/")
	for _, item := range strings.Fields(scope) {
		if item == "api" || (wantsMCP && item == "mcp") {
			return true
		}
	}
	return false
}

func apiKeyAllows(raw, expected string) bool {
	var scopes []string
	if json.Unmarshal([]byte(raw), &scopes) != nil {
		return false
	}
	for _, scope := range scopes {
		if scope == "*" || scope == expected {
			return true
		}
	}
	return false
}
