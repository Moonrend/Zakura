package identity_test

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/identity"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
)

type oauthSpaceRig struct {
	d                             *appdeps.Dependencies
	r                             *chi.Mux
	session, tenant, user, client string
}

func newOAuthSpaceRig(t *testing.T) *oauthSpaceRig {
	t.Helper()
	d := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, d)
	r.With(httpx.Auth(d)).Get("/mcp/probe", func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		httpx.JSON(w, 200, map[string]any{"spaceId": p.SpaceID, "agentId": p.AgentID, "expiresAt": p.OAuthExpiresAt.Unix()})
	})
	session := setupUser(t, r, "space-oauth@example.test", "Space OAuth")
	var tenant, user string
	if err := d.DB.QueryRow(`SELECT tenant_id,user_id FROM tenant_memberships LIMIT 1`).Scan(&tenant, &user); err != nil {
		t.Fatal(err)
	}
	now := d.Clock().Format(time.RFC3339Nano)
	for _, id := range []string{"own", "other"} {
		id := id
		if err := d.Gorm.Create(&models.Space{ID: &id, TenantID: tenant, Name: id, Slug: id, WorkspaceKind: "host", WorkspaceStatus: "stopped", ConfigJSON: "{}", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct{ id, space string }{{"own-agent", "own"}, {"same-space-agent", "own"}, {"foreign-agent", "other"}} {
		id := row.id
		if err := d.Gorm.Create(&models.Agent{ID: &id, TenantID: tenant, SpaceID: row.space, Name: id, Slug: id, Description: "", ConfigJSON: "{}", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
			t.Fatal(err)
		}
	}
	registered := call(t, r, http.MethodPost, "/oauth/register", map[string]any{"redirect_uris": []string{"http://localhost/callback"}, "token_endpoint_auth_method": "none"}, "")
	var client struct {
		ID string `json:"client_id"`
	}
	decode(t, registered, &client)
	if registered.Code != 201 || client.ID == "" {
		t.Fatalf("client registration: %d %s", registered.Code, registered.Body.String())
	}
	return &oauthSpaceRig{d: d, r: r, session: session, tenant: tenant, user: user, client: client.ID}
}

func (r *oauthSpaceRig) consent(t *testing.T, resource, agent string) (*httptest.ResponseRecorder, string) {
	t.Helper()
	digest := sha256.Sum256([]byte("resource-bound-pkce-verifier-for-tests"))
	body := map[string]any{"clientId": r.client, "redirectUri": "http://localhost/callback", "scope": "mcp", "codeChallenge": base64.RawURLEncoding.EncodeToString(digest[:]), "codeChallengeMethod": "S256", "approved": true}
	if resource != "" {
		body["resource"] = resource
	}
	if agent != "" {
		body["agent"] = agent
	}
	response := call(t, r.r, http.MethodPost, "/api/oauth/consent", body, r.session)
	var out struct {
		Redirect string `json:"redirectUrl"`
	}
	decode(t, response, &out)
	u, _ := url.Parse(out.Redirect)
	return response, u.Query().Get("code")
}
func (r *oauthSpaceRig) exchange(code, resource string) *httptest.ResponseRecorder {
	v := url.Values{"grant_type": {"authorization_code"}, "client_id": {r.client}, "code": {code}, "redirect_uri": {"http://localhost/callback"}, "code_verifier": {"resource-bound-pkce-verifier-for-tests"}}
	if resource != "" {
		v.Set("resource", resource)
	}
	return callForm(r.r, "/token", v)
}
func (r *oauthSpaceRig) refresh(token, resource string) *httptest.ResponseRecorder {
	v := url.Values{"grant_type": {"refresh_token"}, "client_id": {r.client}, "refresh_token": {token}}
	if resource != "" {
		v.Set("resource", resource)
	}
	return callForm(r.r, "/token", v)
}
func oauthSpaceTokens(t *testing.T, response *httptest.ResponseRecorder) (string, string, jwt.MapClaims) {
	t.Helper()
	if response.Code != 200 {
		t.Fatalf("token exchange: %d %s", response.Code, response.Body.String())
	}
	var out struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
	}
	decode(t, response, &out)
	claims := jwt.MapClaims{}
	if _, _, err := jwt.NewParser().ParseUnverified(out.Access, claims); err != nil {
		t.Fatal(err)
	}
	return out.Access, out.Refresh, claims
}

func TestOAuthSpaceResourceConsentIssueAuthenticateAndRefresh(t *testing.T) {
	for _, resource := range []string{"/mcp/spaces/own", "/mcp/agents/own-agent"} {
		t.Run(resource, func(t *testing.T) {
			rig := newOAuthSpaceRig(t)
			approved := rig.d.PublicURL + resource
			response, code := rig.consent(t, approved, "")
			if response.Code != 200 || code == "" {
				t.Fatalf("consent %d %s", response.Code, response.Body.String())
			}
			access, refresh, claims := oauthSpaceTokens(t, rig.exchange(code, approved))
			wantAgent := ""
			if strings.Contains(resource, "/agents/") {
				wantAgent = "own-agent"
			}
			canonical := rig.d.PublicURL + "/mcp/spaces/own"
			if claims["spaceId"] != "own" || claims["resource"] != canonical || claims["aud"] != canonical || (wantAgent != "" && claims["aid"] != wantAgent) {
				t.Fatalf("issued binding %#v", claims)
			}
			probe := call(t, rig.r, http.MethodGet, "/mcp/probe", nil, access)
			if probe.Code != 200 || !strings.Contains(probe.Body.String(), `"spaceId":"own"`) || !strings.Contains(probe.Body.String(), `"agentId":"`+wantAgent+`"`) {
				t.Fatalf("actual httpx parsing: %d %s", probe.Code, probe.Body.String())
			}
			var authenticated struct {
				ExpiresAt int64 `json:"expiresAt"`
			}
			decode(t, probe, &authenticated)
			expiresAt, err := claims.GetExpirationTime()
			if err != nil || expiresAt == nil || authenticated.ExpiresAt != expiresAt.Unix() {
				t.Fatalf("original OAuth lifetime lost: principal=%d claims=%v err=%v", authenticated.ExpiresAt, expiresAt, err)
			}
			_, nextRefresh, next := oauthSpaceTokens(t, rig.refresh(refresh, canonical))
			if next["spaceId"] != claims["spaceId"] || next["aid"] != claims["aid"] || next["resource"] != claims["resource"] {
				t.Fatalf("refresh lost binding %#v", next)
			}
			if call(t, rig.r, http.MethodGet, "/api/me", nil, access).Code != http.StatusForbidden {
				t.Fatal("mcp-only OAuth escaped API capability check")
			}
			if _, err := rig.d.DB.Exec(`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=? AND user_id=?`, rig.tenant, rig.user); err != nil {
				t.Fatal(err)
			}
			if call(t, rig.r, http.MethodGet, "/mcp/probe", nil, access).Code != http.StatusUnauthorized {
				t.Fatal("revoked membership still authenticated")
			}
			if rig.refresh(nextRefresh, "").Code == 200 {
				t.Fatal("revoked membership refreshed")
			}
		})
	}
}

func TestOAuthSpaceResourceCannotChangeApprovedGrant(t *testing.T) {
	rig := newOAuthSpaceRig(t)
	own := rig.d.PublicURL + "/mcp/spaces/own"
	other := rig.d.PublicURL + "/mcp/spaces/other"
	for _, resource := range []string{"https://evil.example/mcp/spaces/own", rig.d.PublicURL + "/mcp/spaces/missing", own + "/extra", own + "?x=1", own + "#fragment", rig.d.PublicURL + "/mcp/agents/missing"} {
		if response, _ := rig.consent(t, resource, ""); response.Code != 400 {
			t.Fatalf("invalid resource approved %q: %d", resource, response.Code)
		}
	}
	if response, _ := rig.consent(t, other, "own-agent"); response.Code != 400 {
		t.Fatal("cross-Space explicit Agent approved")
	}
	if response, _ := rig.consent(t, rig.d.PublicURL+"/mcp/agents/same-space-agent", "own-agent"); response.Code != 400 {
		t.Fatal("other Agent alias approved")
	}
	if response, _ := rig.consent(t, "", "missing"); response.Code != 400 {
		t.Fatal("unknown Agent silently became tenant token")
	}
	_, code := rig.consent(t, own, "own-agent")
	if response := rig.exchange(code, other); response.Code != 400 {
		t.Fatalf("code changed Space: %d %s", response.Code, response.Body.String())
	}
	_, refresh, _ := oauthSpaceTokens(t, rig.exchange(code, own))
	for _, resource := range []string{other, rig.d.PublicURL + "/mcp/agents/same-space-agent", "https://evil.example/mcp/spaces/own"} {
		if response := rig.refresh(refresh, resource); response.Code != 400 {
			t.Fatalf("refresh changed resource %q: %d", resource, response.Code)
		}
	}
	_, refresh, _ = oauthSpaceTokens(t, rig.refresh(refresh, rig.d.PublicURL+"/mcp/agents/own-agent"))
	if _, err := rig.d.DB.Exec(`UPDATE agents SET space_id='other' WHERE id='own-agent'`); err != nil {
		t.Fatal(err)
	}
	if response := rig.refresh(refresh, ""); response.Code != 400 {
		t.Fatalf("moved Agent retargeted refresh: %d %s", response.Code, response.Body.String())
	}
	_, unboundCode := rig.consent(t, "", "")
	if response := rig.exchange(unboundCode, own); response.Code != 400 {
		t.Fatal("unbound code acquired unapproved Space")
	}
}

func TestOAuthSpaceResourceRefreshPinsImmutableSpaceID(t *testing.T) {
	rig := newOAuthSpaceRig(t)
	_, code := rig.consent(t, rig.d.PublicURL+"/mcp/spaces/own", "")
	_, refresh, _ := oauthSpaceTokens(t, rig.exchange(code, ""))
	if _, err := rig.d.DB.Exec(`UPDATE spaces SET slug='retired' WHERE id='own'`); err != nil {
		t.Fatal(err)
	}
	if _, err := rig.d.DB.Exec(`UPDATE spaces SET slug='own' WHERE id='other'`); err != nil {
		t.Fatal(err)
	}
	if response := rig.refresh(refresh, ""); response.Code != 400 {
		t.Fatalf("reused slug retargeted grant: %d %s", response.Code, response.Body.String())
	}
}

func TestOAuthLegacyAgentBindingAndSignedResourceValidation(t *testing.T) {
	rig := newOAuthSpaceRig(t)
	sign := func(extra jwt.MapClaims) string {
		claims := jwt.MapClaims{"iss": rig.d.PublicURL, "sub": rig.user, "tenantId": rig.tenant, "scope": "mcp", "iat": rig.d.Clock().Unix(), "exp": rig.d.Clock().Add(time.Hour).Unix()}
		for k, v := range extra {
			claims[k] = v
		}
		seed := sha256.Sum256(append(append([]byte{}, rig.d.Secret...), []byte("zakura-oauth-eddsa-v1")...))
		token, err := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims).SignedString(ed25519.NewKeyFromSeed(seed[:]))
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	legacy := sign(jwt.MapClaims{"aid": "own-agent"})
	probe := call(t, rig.r, http.MethodGet, "/mcp/probe", nil, legacy)
	if probe.Code != 200 || !strings.Contains(probe.Body.String(), `"spaceId":"own"`) {
		t.Fatalf("legacy Agent not canonicalized: %d %s", probe.Code, probe.Body.String())
	}
	own := rig.d.PublicURL + "/mcp/spaces/own"
	for _, extra := range []jwt.MapClaims{
		{"aid": "missing"},
		{"aid": "own-agent", "spaceId": "other", "resource": own, "aud": own},
		{"aid": "own-agent", "resource": rig.d.PublicURL + "/mcp/spaces/other", "aud": rig.d.PublicURL + "/mcp/spaces/other"},
		{"resource": own, "aud": "wrong"},
		{"resource": "https://evil.example/mcp/spaces/own", "aud": "https://evil.example/mcp/spaces/own"},
		{"spaceId": "own"},
		{"aid": []string{"own-agent"}},
	} {
		if response := call(t, rig.r, http.MethodGet, "/mcp/probe", nil, sign(extra)); response.Code != 401 {
			raw, _ := json.Marshal(extra)
			t.Fatalf("invalid signed binding accepted %s: %d", raw, response.Code)
		}
	}
	// Signed resource-only legacy tokens can be narrowed from their trusted
	// same-origin resource; they do not need a made-up Agent for zero-Agent Spaces.
	if response := call(t, rig.r, http.MethodGet, "/mcp/probe", nil, sign(jwt.MapClaims{"resource": own, "aud": own})); response.Code != 200 {
		t.Fatalf("trusted resource-only binding: %d", response.Code)
	}
	binding, err := httpx.ResolveOAuthMCPResource(context.Background(), rig.d, rig.d.DB, rig.tenant, own, "own-agent")
	if err != nil || binding.AgentID != "own-agent" || binding.SpaceID != "own" {
		t.Fatalf("resource resolution %#v %v", binding, err)
	}
	p := httpx.Principal{TenantID: rig.tenant, OAuth: true, SpaceID: "own", AgentID: "own-agent"}
	if err := httpx.AuthorizeResource(context.Background(), rig.d, p, "own", "own-agent"); err != nil {
		t.Fatalf("own Agent body rejected: %v", err)
	}
	for _, bodyAgent := range []string{"same-space-agent", "foreign-agent"} {
		if err := httpx.AuthorizeResource(context.Background(), rig.d, p, "", bodyAgent); err == nil {
			t.Fatalf("OAuth body Agent escaped binding: %s", bodyAgent)
		}
	}
}
