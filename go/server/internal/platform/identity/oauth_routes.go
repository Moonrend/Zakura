package identity

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
)

func registerOAuthRoutes(r chi.Router, d *appdeps.Dependencies, s *Service) {
	for _, path := range []string{"/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/oauth/discovery"} {
		r.Get(path, s.oauthMetadata)
	}
	r.Get("/.well-known/oauth-authorization-server/*", s.oauthMetadata)
	r.Get("/.well-known/openid-configuration/*", s.oauthMetadata)
	r.Get("/.well-known/oauth-protected-resource", s.resourceMetadata)
	r.Get("/.well-known/oauth-protected-resource/*", s.resourceMetadata)
	r.Get("/.well-known/jwks.json", s.jwks)
	r.Get("/oauth/jwks", s.jwks)
	r.Post("/oauth/register", s.registerClient)
	r.Post("/register", s.registerClient)
	r.Get("/oauth/authorize", s.authorizeRedirect)
	r.Get("/authorize", s.authorizeRedirect)
	r.Post("/oauth/token", s.token)
	r.Post("/token", s.token)
	r.Post("/token/revoke", s.revokeToken)
	r.With(s.oauthBearer).Get("/oauth/userinfo", s.userinfo)
	r.With(s.oauthBearer).Post("/oauth/userinfo", s.userinfo)
	r.With(s.oauthBearer).Get("/userinfo", s.userinfo)
	r.With(s.oauthBearer).Post("/userinfo", s.userinfo)
	// The authorization console fetches client metadata before the user has
	// signed in. Request validation itself is public; consent remains session
	// authenticated below.
	r.Get("/api/oauth/authorize-info", s.authorizeInfo)
	r.Group(func(g chi.Router) {
		g.Use(httpx.Auth(d))
		g.Get("/api/oauth/clients", s.listOAuthClients)
		g.Post("/api/oauth/consent", s.consent)
	})
}

func (s *Service) oauthMetadata(w http.ResponseWriter, r *http.Request) {
	i := s.deps.PublicURL
	httpx.JSON(w, 200, map[string]any{
		"issuer": i, "authorization_endpoint": i + "/authorize", "token_endpoint": i + "/token", "registration_endpoint": i + "/oauth/register", "userinfo_endpoint": i + "/userinfo", "revocation_endpoint": i + "/token/revoke", "jwks_uri": i + "/.well-known/jwks.json",
		"scopes_supported": []string{"mcp", "api", "openid", "email", "profile", "offline_access"}, "response_types_supported": []string{"code"}, "response_modes_supported": []string{"query"}, "grant_types_supported": []string{"authorization_code", "refresh_token"}, "code_challenge_methods_supported": []string{"S256"}, "token_endpoint_auth_methods_supported": []string{"none", "private_key_jwt", "client_secret_post", "client_secret_basic"},
		"subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "access_token_signing_alg_values_supported": []string{"RS256"}, "claim_types_supported": []string{"normal"}, "claims_supported": []string{"sub", "iss", "aud", "exp", "iat", "auth_time", "email", "email_verified", "name", "preferred_username"}, "authorization_response_iss_parameter_supported": true, "client_id_metadata_document_supported": true,
	})
}
func (s *Service) resourceMetadata(w http.ResponseWriter, r *http.Request) {
	resource := s.deps.PublicURL
	if strings.HasPrefix(r.URL.Path, "/.well-known/oauth-protected-resource/") {
		resource += "/" + strings.TrimPrefix(r.URL.Path, "/.well-known/oauth-protected-resource/")
	}
	httpx.JSON(w, 200, map[string]any{"resource": resource, "authorization_servers": []string{s.deps.PublicURL}, "bearer_methods_supported": []string{"header"}, "scopes_supported": []string{"mcp", "api", "openid", "email", "profile", "offline_access"}, "resource_documentation": s.deps.PublicURL + "/"})
}
func (s *Service) jwks(w http.ResponseWriter, r *http.Request) {
	key, err := s.signingKey(r.Context())
	if err != nil {
		oauthError(w, 500, "server_error", "signing key unavailable")
		return
	}
	httpx.JSON(w, 200, map[string]any{"keys": []map[string]any{rsaPublicJWK(key)}})
}

func (s *Service) registerClient(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ClientName              string   `json:"client_name"`
		RedirectURIs            []string `json:"redirect_uris"`
		GrantTypes              []string `json:"grant_types"`
		ResponseTypes           []string `json:"response_types"`
		TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
		Scope                   string   `json:"scope"`
	}
	if httpx.DecodeJSON(r, &b) != nil || len(b.RedirectURIs) == 0 {
		oauthError(w, 400, "invalid_client_metadata", "redirect_uris required")
		return
	}
	for _, raw := range b.RedirectURIs {
		if !allowedOAuthRedirect(raw) {
			oauthError(w, 400, "invalid_redirect_uri", "invalid redirect URI")
			return
		}
	}
	b.ClientName = strings.TrimSpace(b.ClientName)
	if b.ClientName == "" {
		b.ClientName = "MCP Client"
	}
	if len(b.GrantTypes) == 0 {
		b.GrantTypes = []string{"authorization_code", "refresh_token"}
	}
	if len(b.ResponseTypes) == 0 {
		b.ResponseTypes = []string{"code"}
	}
	if b.TokenEndpointAuthMethod == "" {
		b.TokenEndpointAuthMethod = "none"
	}
	if b.TokenEndpointAuthMethod != "none" && b.TokenEndpointAuthMethod != "client_secret_post" && b.TokenEndpointAuthMethod != "client_secret_basic" {
		oauthError(w, 400, "invalid_client_metadata", "unsupported token endpoint auth method")
		return
	}
	clientToken, tokenErr := randomToken(16)
	if tokenErr != nil {
		oauthError(w, 500, "server_error", "registration failed")
		return
	}
	clientID := "ocl_" + clientToken
	var secret, secretHash string
	if b.TokenEndpointAuthMethod != "none" {
		secretToken, secretErr := randomToken(24)
		if secretErr != nil {
			oauthError(w, 500, "server_error", "registration failed")
			return
		}
		secret = "ocs_" + secretToken
		h := sha256.Sum256([]byte(secret))
		secretHash = hex.EncodeToString(h[:])
	}
	redirects, _ := json.Marshal(b.RedirectURIs)
	grants, _ := json.Marshal(b.GrantTypes)
	responses, _ := json.Marshal(b.ResponseTypes)
	clientRowID := s.deps.NewID()
	var secretHashPtr *string
	if secretHash != "" {
		secretHashPtr = &secretHash
	}
	err := s.gdb(r.Context()).Create(&models.OauthClient{ID: &clientRowID, ClientID: clientID, ClientSecretHash: secretHashPtr, ClientName: b.ClientName, RedirectUrisJSON: string(redirects), GrantTypesJSON: string(grants), ResponseTypesJSON: string(responses), TokenEndpointAuthMethod: b.TokenEndpointAuthMethod, Scope: defaultString(b.Scope, "mcp"), RegistrationType: "dynamic", CreatedAt: s.now(), UpdatedAt: s.now()}).Error
	if err != nil {
		oauthError(w, 500, "server_error", "registration failed")
		return
	}
	out := map[string]any{"client_id": clientID, "client_id_issued_at": s.deps.Clock().UTC().Unix(), "client_name": b.ClientName, "redirect_uris": b.RedirectURIs, "grant_types": b.GrantTypes, "response_types": b.ResponseTypes, "token_endpoint_auth_method": b.TokenEndpointAuthMethod, "scope": defaultString(strings.TrimSpace(b.Scope), "mcp")}
	if secret != "" {
		out["client_secret"] = secret
	}
	httpx.JSON(w, 201, out)
}

func (s *Service) authorizeRedirect(w http.ResponseWriter, r *http.Request) {
	u, _ := url.Parse(s.deps.WebURL + "/console/oauth/authorize")
	u.RawQuery = r.URL.Query().Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

type oauthClient struct {
	ID, Name, SecretHash, Redirects, Method, Scope, Registration string
	TenantID                                                     sql.NullString
}

func (s *Service) validAuthorizeRequest(ctx context.Context, q url.Values) (oauthClient, error) {
	var c oauthClient
	responseType := defaultString(q.Get("response_type"), "code")
	if responseType != "code" {
		return c, errors.New("response_type must be code")
	}
	if q.Get("code_challenge") == "" || defaultString(q.Get("code_challenge_method"), "S256") != "S256" {
		return c, errors.New("PKCE S256 required")
	}
	c, err := s.resolveOAuthClient(ctx, q.Get("client_id"))
	if err != nil {
		return c, errors.New("unknown client")
	}
	if redirectRegistered(c, q.Get("redirect_uri")) {
		return c, nil
	}
	return c, errors.New("redirect_uri not registered")
}
func (s *Service) authorizeInfo(w http.ResponseWriter, r *http.Request) {
	c, err := s.validAuthorizeRequest(r.Context(), r.URL.Query())
	if err != nil {
		oauthError(w, 400, "invalid_request", err.Error())
		return
	}
	var registered []string
	_ = json.Unmarshal([]byte(c.Redirects), &registered)
	httpx.JSON(w, 200, map[string]any{
		"issuer":      s.deps.PublicURL,
		"client":      map[string]any{"clientId": c.ID, "clientName": defaultString(c.Name, "MCP Client"), "registrationType": c.Registration},
		"redirectUri": r.URL.Query().Get("redirect_uri"), "scope": defaultString(r.URL.Query().Get("scope"), "mcp"), "resource": nullIfEmpty(r.URL.Query().Get("resource")), "agent": nullIfEmpty(r.URL.Query().Get("agent")), "codeChallengeMethod": defaultString(r.URL.Query().Get("code_challenge_method"), "S256"), "registeredRedirectUris": registered,
	})
}
func (s *Service) consent(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var b struct {
		ClientID, ClientIDSnake                       string
		RedirectURI, RedirectURISnake                 string
		Scope, State, Resource, AgentSlug             string
		CodeChallenge, CodeChallengeSnake             string
		CodeChallengeMethod, CodeChallengeMethodSnake string
		Approved                                      *bool
	}
	var rawBody map[string]json.RawMessage
	if httpx.DecodeJSON(r, &rawBody) != nil {
		oauthError(w, 400, "invalid_request", "invalid request")
		return
	}
	decodeField := func(key string, target *string) { _ = json.Unmarshal(rawBody[key], target) }
	decodeField("clientId", &b.ClientID)
	decodeField("client_id", &b.ClientIDSnake)
	decodeField("redirectUri", &b.RedirectURI)
	decodeField("redirect_uri", &b.RedirectURISnake)
	decodeField("scope", &b.Scope)
	decodeField("state", &b.State)
	decodeField("resource", &b.Resource)
	decodeField("agent", &b.AgentSlug)
	decodeField("codeChallenge", &b.CodeChallenge)
	decodeField("code_challenge", &b.CodeChallengeSnake)
	decodeField("codeChallengeMethod", &b.CodeChallengeMethod)
	decodeField("code_challenge_method", &b.CodeChallengeMethodSnake)
	if value, ok := rawBody["approved"]; ok {
		var approved bool
		if json.Unmarshal(value, &approved) == nil {
			b.Approved = &approved
		}
	}
	b.ClientID = defaultString(b.ClientID, b.ClientIDSnake)
	b.RedirectURI = defaultString(b.RedirectURI, b.RedirectURISnake)
	b.CodeChallenge = defaultString(b.CodeChallenge, b.CodeChallengeSnake)
	b.CodeChallengeMethod = defaultString(defaultString(b.CodeChallengeMethod, b.CodeChallengeMethodSnake), "S256")
	q := url.Values{"response_type": {"code"}, "client_id": {b.ClientID}, "redirect_uri": {b.RedirectURI}, "scope": {b.Scope}, "state": {b.State}, "code_challenge": {b.CodeChallenge}, "code_challenge_method": {b.CodeChallengeMethod}}
	c, err := s.validAuthorizeRequest(r.Context(), q)
	if err != nil {
		oauthError(w, 400, "invalid_request", err.Error())
		return
	}
	if c.Registration != "cimd" {
		if c.TenantID.Valid && c.TenantID.String != p.TenantID {
			oauthError(w, 403, "access_denied", "Client belongs to another tenant")
			return
		}
		if !c.TenantID.Valid {
			if err = s.gdb(r.Context()).Model(&models.OauthClient{}).Where("client_id = ? AND tenant_id IS NULL", c.ID).Updates(map[string]any{"tenant_id": p.TenantID, "updated_at": s.now()}).Error; err != nil {
				oauthError(w, 500, "server_error", "client binding failed")
				return
			}
		}
	}
	redirect, _ := url.Parse(b.RedirectURI)
	rq := redirect.Query()
	if b.Approved != nil && !*b.Approved {
		rq.Set("error", "access_denied")
		if b.State != "" {
			rq.Set("state", b.State)
		}
		if redirect.Scheme == "http" || redirect.Scheme == "https" {
			rq.Set("iss", s.deps.PublicURL)
		}
		redirect.RawQuery = rq.Encode()
		httpx.JSON(w, 200, map[string]any{"redirect": redirect.String(), "redirectUrl": redirect.String()})
		return
	}
	code := "zac_" + mustToken(32)
	h := sha256.Sum256([]byte(code))
	var agentID *string
	slug := strings.TrimSpace(b.AgentSlug)
	if slug == "" && b.Resource != "" {
		if resourceURL, parseErr := url.Parse(b.Resource); parseErr == nil {
			parts := strings.Split(strings.Trim(resourceURL.Path, "/"), "/")
			if len(parts) >= 3 && parts[0] == "mcp" && parts[1] == "agents" {
				slug, _ = url.PathUnescape(parts[2])
			}
		}
	}
	if slug != "" {
		var resolved string
		if queryErr := s.gdb(r.Context()).Table("agents").Select("id").Where("tenant_id = ? AND slug = ?", p.TenantID, slug).Take(&resolved).Error; queryErr == nil {
			agentID = &resolved
		}
	}
	scope := normalizeOAuthScope(defaultString(b.Scope, c.Scope), c.ID)
	var resourcePtr *string
	resource := strings.TrimSpace(b.Resource)
	if resource != "" {
		resourcePtr = &resource
	}
	challenge := b.CodeChallenge
	methodS256 := "S256"
	codeID := s.deps.NewID()
	err = s.gdb(r.Context()).Create(&models.OauthAuthCode{ID: &codeID, CodeHash: hex.EncodeToString(h[:]), ClientID: b.ClientID, UserID: p.UserID, TenantID: p.TenantID, AgentID: agentID, RedirectURI: b.RedirectURI, Scope: scope, Resource: resourcePtr, CodeChallenge: &challenge, CodeChallengeMethod: &methodS256, ExpiresAt: s.deps.Clock().UTC().Add(5 * time.Minute).Format(time.RFC3339Nano), CreatedAt: s.now()}).Error
	if err != nil {
		oauthError(w, 500, "server_error", "code issue failed")
		return
	}
	rq.Set("code", code)
	if redirect.Scheme == "http" || redirect.Scheme == "https" {
		rq.Set("iss", s.deps.PublicURL)
	}
	if b.State != "" {
		rq.Set("state", b.State)
	}
	redirect.RawQuery = rq.Encode()
	httpx.JSON(w, 200, map[string]any{"redirect": redirect.String(), "redirectUrl": redirect.String()})
}

func normalizeOAuthScope(scope, clientID string) string {
	seen := map[string]bool{}
	out := []string{}
	for _, item := range strings.Fields(scope) {
		if !seen[item] {
			seen[item] = true
			out = append(out, item)
		}
	}
	if isCIMDClientID(clientID) {
		u, _ := url.Parse(clientID)
		if u.Hostname() == "chatgpt.com" || u.Hostname() == "chat.openai.com" {
			for _, item := range []string{"openid", "email", "profile"} {
				if !seen[item] {
					seen[item] = true
					out = append(out, item)
				}
			}
		}
	}
	if len(out) == 0 {
		return "mcp"
	}
	return strings.Join(out, " ")
}

func oauthError(w http.ResponseWriter, status int, code, desc string) {
	httpx.JSON(w, status, map[string]any{"error": code, "error_description": desc})
}
func mustToken(n int) string {
	v, err := randomToken(n)
	if err != nil {
		panic(err)
	}
	return v
}
func nullIfEmpty(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func defaultString(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return v
}
