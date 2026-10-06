package identity_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/admin"
	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	platformdb "github.com/Moonrend/Zakura/go/server/internal/platform/db"
	"github.com/Moonrend/Zakura/go/server/internal/platform/identity"
	"github.com/Moonrend/Zakura/go/server/internal/platform/migrations"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
)

func TestSetupLoginAndTenantLifecycle(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)

	setup := call(t, r, http.MethodPost, "/api/setup", map[string]any{
		"adminEmail": "admin@example.com", "adminPassword": "correct-horse-battery",
		"adminName": "Admin", "tenantName": "Acme",
	}, "")
	if setup.Code != http.StatusOK {
		t.Fatalf("setup: %d %s", setup.Code, setup.Body.String())
	}
	var setupBody struct {
		Session string `json:"session"`
	}
	decode(t, setup, &setupBody)
	if setupBody.Session == "" {
		t.Fatal("setup did not issue a session")
	}

	me := call(t, r, http.MethodGet, "/api/me", nil, setupBody.Session)
	if me.Code != http.StatusOK {
		t.Fatalf("me: %d %s", me.Code, me.Body.String())
	}

	created := call(t, r, http.MethodPost, "/api/tenants", map[string]any{"name": "Research", "slug": "research"}, setupBody.Session)
	if created.Code != http.StatusCreated {
		t.Fatalf("create tenant: %d %s", created.Code, created.Body.String())
	}
	var createdBody struct {
		Session string `json:"session"`
		Tenant  struct {
			ID   string `json:"id"`
			Slug string `json:"slug"`
		} `json:"tenant"`
	}
	decode(t, created, &createdBody)
	if createdBody.Tenant.Slug != "research" || createdBody.Session == "" {
		t.Fatalf("bad create response: %+v", createdBody)
	}

	login := call(t, r, http.MethodPost, "/api/auth/login", map[string]any{"email": "admin@example.com", "password": "correct-horse-battery", "tenantSlug": "research"}, "")
	if login.Code != http.StatusOK {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}

	bad := call(t, r, http.MethodPost, "/api/auth/login", map[string]any{"email": "admin@example.com", "password": "wrong"}, "")
	if bad.Code != http.StatusUnauthorized {
		t.Fatalf("bad login status=%d", bad.Code)
	}

	revoke := call(t, r, http.MethodDelete, "/api/me/sessions/does-not-exist", nil, createdBody.Session)
	if revoke.Code != http.StatusOK {
		t.Fatalf("revoke: %d", revoke.Code)
	}
}

func TestTenantTeamFrontendContracts(t *testing.T) {
	deps := testDeps(t)
	deps.Edition = "saas"
	deps.MultiTenant = true
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)

	defaultSession := setupUser(t, r, "team-owner@example.com", "Default Team")
	created := call(t, r, http.MethodPost, "/api/tenants", map[string]any{"name": "Second Team"}, defaultSession)
	if created.Code != http.StatusCreated {
		t.Fatalf("create team: %d %s", created.Code, created.Body.String())
	}
	var createBody struct {
		Session string `json:"session"`
		Tenant  struct {
			ID string `json:"id"`
		} `json:"tenant"`
	}
	decode(t, created, &createBody)

	members := call(t, r, http.MethodGet, "/api/tenant/members", nil, createBody.Session)
	if members.Code != http.StatusOK {
		t.Fatalf("members: %d %s", members.Code, members.Body.String())
	}
	var memberBody struct {
		Members []struct {
			ID   string `json:"id"`
			Role string `json:"role"`
			User struct {
				ID    string `json:"id"`
				Email string `json:"email"`
				Name  string `json:"name"`
			} `json:"user"`
		} `json:"members"`
	}
	decode(t, members, &memberBody)
	if len(memberBody.Members) != 1 || memberBody.Members[0].Role != "owner" || memberBody.Members[0].User.Email != "team-owner@example.com" {
		t.Fatalf("member DTO does not match frontend contract: %+v", memberBody)
	}

	deleted := call(t, r, http.MethodDelete, "/api/tenant/current", nil, createBody.Session)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete team: %d %s", deleted.Code, deleted.Body.String())
	}
	var deleteBody struct {
		OK      bool   `json:"ok"`
		Session string `json:"session"`
		Team    struct {
			ID                  string `json:"id"`
			Name                string `json:"name"`
			OnboardingCompleted bool   `json:"onboardingCompleted"`
		} `json:"team"`
	}
	decode(t, deleted, &deleteBody)
	if !deleteBody.OK || deleteBody.Session == "" || deleteBody.Team.ID == "" || deleteBody.Team.Name != "Default Team" {
		t.Fatalf("delete response does not match frontend contract: %+v", deleteBody)
	}
	if me := call(t, r, http.MethodGet, "/api/me", nil, deleteBody.Session); me.Code != http.StatusOK {
		t.Fatalf("replacement session is not usable: %d %s", me.Code, me.Body.String())
	}

	defaultDelete := call(t, r, http.MethodDelete, "/api/tenant/current", nil, deleteBody.Session)
	if defaultDelete.Code != http.StatusBadRequest {
		t.Fatalf("default team delete status=%d body=%s", defaultDelete.Code, defaultDelete.Body.String())
	}
}

func TestSessionAuthorizationUsesCurrentMembershipAndTenantState(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	session := setupUser(t, r, "role-refresh@example.com", "Role Team")
	var tenantID, userID string
	if err := deps.DB.QueryRow(`SELECT tenant_id,user_id FROM tenant_memberships LIMIT 1`).Scan(&tenantID, &userID); err != nil {
		t.Fatal(err)
	}
	if _, err := deps.DB.Exec(`UPDATE tenant_memberships SET role='member' WHERE tenant_id=? AND user_id=?`, tenantID, userID); err != nil {
		t.Fatal(err)
	}
	current := call(t, r, http.MethodGet, "/api/tenant/current", nil, session)
	if current.Code != http.StatusOK {
		t.Fatalf("current tenant: %d %s", current.Code, current.Body.String())
	}
	var currentBody struct {
		Role string `json:"role"`
	}
	decode(t, current, &currentBody)
	if currentBody.Role != "member" {
		t.Fatalf("stale JWT role was trusted: %+v", currentBody)
	}
	if members := call(t, r, http.MethodGet, "/api/tenant/members", nil, session); members.Code != http.StatusForbidden {
		t.Fatalf("demoted session retained admin access: %d %s", members.Code, members.Body.String())
	}
	if _, err := deps.DB.Exec(`UPDATE tenants SET status='suspended' WHERE id=?`, tenantID); err != nil {
		t.Fatal(err)
	}
	if me := call(t, r, http.MethodGet, "/api/me", nil, session); me.Code != http.StatusUnauthorized {
		t.Fatalf("suspended tenant session remained active: %d %s", me.Code, me.Body.String())
	}
}

func TestConcurrentSetupCreatesExactlyOnePlatformAdmin(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, email := range []string{"first@example.com", "second@example.com"} {
		wg.Add(1)
		go func(email string) {
			defer wg.Done()
			raw, _ := json.Marshal(map[string]any{"adminEmail": email, "adminPassword": "concurrent-setup-password", "tenantName": "Concurrent"})
			req := httptest.NewRequest(http.MethodPost, "/api/setup", bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
			rr := httptest.NewRecorder()
			r.ServeHTTP(rr, req)
			codes <- rr.Code
		}(email)
	}
	wg.Wait()
	close(codes)
	ok, rejected := 0, 0
	for code := range codes {
		if code == http.StatusOK {
			ok++
		} else if code == http.StatusBadRequest {
			rejected++
		}
	}
	var admins int
	if err := deps.DB.QueryRow(`SELECT COUNT(*) FROM users WHERE is_platform_admin=TRUE`).Scan(&admins); err != nil {
		t.Fatal(err)
	}
	if ok != 1 || rejected != 1 || admins != 1 {
		t.Fatalf("setup race: ok=%d rejected=%d admins=%d", ok, rejected, admins)
	}
}

func TestLoginThrottleIsDurableAndClearsOnSuccess(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	setupUser(t, r, "throttle@example.com", "Throttle")
	for i := 0; i < 8; i++ {
		failed := call(t, r, http.MethodPost, "/api/auth/login", map[string]any{"email": "throttle@example.com", "password": "wrong-password"}, "")
		if failed.Code != http.StatusUnauthorized {
			t.Fatalf("failure %d status=%d body=%s", i+1, failed.Code, failed.Body.String())
		}
	}
	blocked := call(t, r, http.MethodPost, "/api/auth/login", map[string]any{"email": "throttle@example.com", "password": "wrong-password"}, "")
	if blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("ninth failure status=%d body=%s", blocked.Code, blocked.Body.String())
	}
	success := call(t, r, http.MethodPost, "/api/auth/login", map[string]any{"email": "throttle@example.com", "password": "setup-password-123"}, "")
	if success.Code != http.StatusOK {
		t.Fatalf("valid login after failures: %d %s", success.Code, success.Body.String())
	}
	again := call(t, r, http.MethodPost, "/api/auth/login", map[string]any{"email": "throttle@example.com", "password": "wrong-password"}, "")
	if again.Code != http.StatusUnauthorized {
		t.Fatalf("throttle was not cleared: %d %s", again.Code, again.Body.String())
	}
}

func TestInviteIsTenantBoundAndSingleUse(t *testing.T) {
	deps := testDeps(t)
	deps.Edition = "saas"
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	admin := setupUser(t, r, "owner@example.com", "Owner Corp")
	memberResp := call(t, r, http.MethodPost, "/api/auth/register", map[string]any{"email": "member@example.com", "password": "a-secure-member-pass", "tenantName": "Member Home"}, "")
	if memberResp.Code != http.StatusCreated {
		t.Fatalf("register member: %d %s", memberResp.Code, memberResp.Body.String())
	}
	var member struct {
		Session string `json:"session"`
	}
	decode(t, memberResp, &member)
	inviteResp := call(t, r, http.MethodPost, "/api/tenant/invites", map[string]any{"email": "member@example.com", "role": "member"}, admin)
	if inviteResp.Code != http.StatusCreated {
		t.Fatalf("invite: %d %s", inviteResp.Code, inviteResp.Body.String())
	}
	var invite struct {
		Token string `json:"token"`
	}
	decode(t, inviteResp, &invite)
	accepted := call(t, r, http.MethodPost, "/api/invites/"+invite.Token+"/accept", map[string]any{}, member.Session)
	if accepted.Code != http.StatusOK {
		t.Fatalf("accept: %d %s", accepted.Code, accepted.Body.String())
	}
	replay := call(t, r, http.MethodPost, "/api/invites/"+invite.Token+"/accept", map[string]any{}, member.Session)
	if replay.Code != http.StatusNotFound {
		t.Fatalf("replay should fail, got %d", replay.Code)
	}
}

func TestOAuthCodeAndRefreshAreSingleUse(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	session := setupUser(t, r, "oauth@example.com", "OAuth Team")
	clientResp := call(t, r, http.MethodPost, "/oauth/register", map[string]any{"client_name": "test", "redirect_uris": []string{"http://localhost/callback"}, "token_endpoint_auth_method": "none"}, "")
	if clientResp.Code != 201 {
		t.Fatalf("register client: %d %s", clientResp.Code, clientResp.Body.String())
	}
	var client struct {
		ClientID string `json:"client_id"`
	}
	decode(t, clientResp, &client)
	if !strings.HasPrefix(client.ClientID, "ocl_") {
		t.Fatalf("client id is not pinned format: %q", client.ClientID)
	}
	privateResp := call(t, r, http.MethodPost, "/oauth/register", map[string]any{"redirect_uris": []string{"http://localhost/private"}, "token_endpoint_auth_method": "client_secret_post"}, "")
	if privateResp.Code != http.StatusCreated {
		t.Fatalf("register private client: %d %s", privateResp.Code, privateResp.Body.String())
	}
	var privateClient struct {
		ClientID         string `json:"client_id"`
		ClientSecret     string `json:"client_secret"`
		ClientIDIssuedAt int64  `json:"client_id_issued_at"`
		ClientName       string `json:"client_name"`
	}
	decode(t, privateResp, &privateClient)
	if !strings.HasPrefix(privateClient.ClientID, "ocl_") || !strings.HasPrefix(privateClient.ClientSecret, "ocs_") || privateClient.ClientIDIssuedAt != deps.Clock().Unix() || privateClient.ClientName != "MCP Client" {
		t.Fatalf("private registration contract: %+v", privateClient)
	}
	var persistedSecret string
	if err := deps.DB.QueryRow(`SELECT client_secret_hash FROM oauth_clients WHERE client_id=?`, privateClient.ClientID).Scan(&persistedSecret); err != nil {
		t.Fatal(err)
	}
	secretDigest := sha256.Sum256([]byte(privateClient.ClientSecret))
	if persistedSecret != hex.EncodeToString(secretDigest[:]) {
		t.Fatalf("OAuth secret persistence is not TS-compatible SHA-256: %q", persistedSecret)
	}
	verifier := "this-is-a-long-pkce-verifier-used-by-the-test"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	consent := call(t, r, http.MethodPost, "/api/oauth/consent", map[string]any{"clientId": client.ClientID, "redirectUri": "http://localhost/callback", "scope": "openid profile email mcp api", "state": "s", "codeChallenge": challenge, "codeChallengeMethod": "S256", "approved": true}, session)
	if consent.Code != 200 {
		t.Fatalf("consent: %d %s", consent.Code, consent.Body.String())
	}
	var consentBody struct {
		RedirectURL string `json:"redirectUrl"`
	}
	decode(t, consent, &consentBody)
	u, _ := url.Parse(consentBody.RedirectURL)
	code := u.Query().Get("code")
	if code == "" {
		t.Fatal("missing code")
	}
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {client.ClientID}, "code": {code}, "redirect_uri": {"http://localhost/callback"}, "code_verifier": {verifier}}
	var results [2]*httptest.ResponseRecorder
	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func(idx int) { defer wg.Done(); results[idx] = callForm(r, "/token", form) }(i)
	}
	wg.Wait()
	ok, bad := 0, 0
	var tokenBody struct {
		RefreshToken string `json:"refresh_token"`
		AccessToken  string `json:"access_token"`
		IDToken      string `json:"id_token"`
	}
	for _, rr := range results {
		if rr.Code == 200 {
			ok++
			decode(t, rr, &tokenBody)
		} else if rr.Code == 400 {
			bad++
		}
	}
	if ok != 1 || bad != 1 {
		t.Fatalf("code replay statuses %d,%d", results[0].Code, results[1].Code)
	}
	if tokenBody.AccessToken == "" || tokenBody.IDToken == "" || !strings.HasPrefix(tokenBody.RefreshToken, "rcr_") {
		t.Fatalf("pinned OAuth token response missing fields: %+v", tokenBody)
	}
	unverified, _, err := jwt.NewParser().ParseUnverified(tokenBody.AccessToken, jwt.MapClaims{})
	if err != nil || unverified == nil || unverified.Method.Alg() != "RS256" || unverified.Header["typ"] != "at+jwt" {
		header := map[string]any(nil)
		if unverified != nil {
			header = unverified.Header
		}
		t.Fatalf("access token is not pinned RS256 at+jwt: header=%#v err=%v", header, err)
	}
	userinfo := call(t, r, http.MethodGet, "/userinfo", nil, tokenBody.AccessToken)
	if userinfo.Code != http.StatusOK || !strings.Contains(userinfo.Body.String(), "oauth@example.com") {
		t.Fatalf("userinfo with issued token: %d %s", userinfo.Code, userinfo.Body.String())
	}
	oauthMe := call(t, r, http.MethodGet, "/api/me", nil, tokenBody.AccessToken)
	if oauthMe.Code != http.StatusOK {
		t.Fatalf("RS256 OAuth token did not authenticate API request: %d %s", oauthMe.Code, oauthMe.Body.String())
	}
	jwks := call(t, r, http.MethodGet, "/.well-known/jwks.json", nil, "")
	if jwks.Code != http.StatusOK || !strings.Contains(jwks.Body.String(), `"kty":"RSA"`) || !strings.Contains(jwks.Body.String(), `"alg":"RS256"`) {
		t.Fatalf("RS256 JWKS: %d %s", jwks.Code, jwks.Body.String())
	}
	refresh := url.Values{"grant_type": {"refresh_token"}, "client_id": {client.ClientID}, "refresh_token": {tokenBody.RefreshToken}}
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func(idx int) { defer wg.Done(); results[idx] = callForm(r, "/token", refresh) }(i)
	}
	wg.Wait()
	ok, bad = 0, 0
	for _, rr := range results {
		if rr.Code == 200 {
			ok++
		} else if rr.Code == 400 {
			bad++
		}
	}
	if ok != 1 || bad != 1 {
		t.Fatalf("refresh replay statuses %d,%d", results[0].Code, results[1].Code)
	}
}

type identityRoundTripFunc func(*http.Request) (*http.Response, error)

func (f identityRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCIMDAuthorizationFlowWithFakeMetadataService(t *testing.T) {
	deps := testDeps(t)
	const clientID = "https://cimd.example/oauth/client.json"
	var metadataCalls atomic.Int32
	deps.ResolveIPs = func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("203.0.113.10")}, nil }
	deps.HTTPClient = &http.Client{Transport: identityRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		metadataCalls.Add(1)
		if req.URL.String() != clientID {
			return &http.Response{StatusCode: 404, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Cache-Control": {"max-age=3600"}}, Body: io.NopCloser(strings.NewReader(`{"client_id":"https://cimd.example/oauth/client.json","client_name":"CIMD Test","redirect_uris":["https://cimd.example/callback"],"token_endpoint_auth_methods_supported":["none"],"scope":"mcp openid email profile"}`)), Request: req}, nil
	})}
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	session := setupUser(t, r, "cimd@example.com", "CIMD Team")
	verifier := "cimd-pkce-verifier-with-more-than-forty-three-characters"
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	query := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {"https://cimd.example/callback"}, "scope": {"mcp openid email profile"}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}}
	info := call(t, r, http.MethodGet, "/api/oauth/authorize-info?"+query.Encode(), nil, "")
	if info.Code != http.StatusOK {
		t.Fatalf("CIMD authorize info: %d %s", info.Code, info.Body.String())
	}
	consent := call(t, r, http.MethodPost, "/api/oauth/consent", map[string]any{"client_id": clientID, "redirect_uri": "https://cimd.example/callback", "scope": "mcp openid email profile", "code_challenge": challenge, "code_challenge_method": "S256"}, session)
	if consent.Code != http.StatusOK {
		t.Fatalf("CIMD consent: %d %s", consent.Code, consent.Body.String())
	}
	var consentBody struct {
		RedirectURL string `json:"redirect"`
	}
	decode(t, consent, &consentBody)
	redirect, _ := url.Parse(consentBody.RedirectURL)
	if redirect.Query().Get("iss") != deps.PublicURL || redirect.Query().Get("code") == "" {
		t.Fatalf("CIMD redirect lacks code/issuer: %q", consentBody.RedirectURL)
	}
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {redirect.Query().Get("code")}, "redirect_uri": {"https://cimd.example/callback"}, "code_verifier": {verifier}}
	tokens := callForm(r, "/token", form)
	if tokens.Code != http.StatusOK || !strings.Contains(tokens.Body.String(), `"id_token"`) || !strings.Contains(tokens.Body.String(), `"access_token"`) {
		t.Fatalf("CIMD token exchange: %d %s", tokens.Code, tokens.Body.String())
	}
	var registration string
	var tenantID sql.NullString
	if err := deps.DB.QueryRow(`SELECT registration_type,tenant_id FROM oauth_clients WHERE client_id=?`, clientID).Scan(&registration, &tenantID); err != nil {
		t.Fatal(err)
	}
	if registration != "cimd" || tenantID.Valid || metadataCalls.Load() != 1 {
		t.Fatalf("CIMD persistence/cache: registration=%q tenant=%v calls=%d", registration, tenantID, metadataCalls.Load())
	}
}

func TestImportsPinnedTypeScriptOAuthSigningKey(t *testing.T) {
	deps := testDeps(t)
	dir := t.TempDir()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	document, _ := json.Marshal(map[string]any{"kid": "zakura-existing-key", "privateKeyPem": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))})
	if err = os.WriteFile(filepath.Join(dir, "oauth-signing.json"), document, 0o600); err != nil {
		t.Fatal(err)
	}
	deps.DataDir = dir
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	first := call(t, r, http.MethodGet, "/.well-known/jwks.json", nil, "")
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), "zakura-existing-key") {
		t.Fatalf("existing TypeScript key not imported: %d %s", first.Code, first.Body.String())
	}
	var encrypted string
	if err = deps.DB.QueryRow(`SELECT value FROM settings WHERE owner_key='platform' AND key='oauth_signing_key'`).Scan(&encrypted); err != nil || encrypted == "" || strings.Contains(encrypted, "PRIVATE KEY") {
		t.Fatalf("signing key was not durably encrypted: value=%q err=%v", encrypted, err)
	}
	if err = os.WriteFile(filepath.Join(dir, "oauth-signing.json"), []byte(`{"corrupted":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	r2 := chi.NewRouter()
	identity.RegisterRoutes(r2, deps)
	second := call(t, r2, http.MethodGet, "/.well-known/jwks.json", nil, "")
	if second.Code != http.StatusOK || !strings.Contains(second.Body.String(), "zakura-existing-key") {
		t.Fatalf("persisted imported key was not reused ahead of a stale file: %d %s", second.Code, second.Body.String())
	}
}

func TestMFAEnrollmentAndLoginChallenge(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	admin := setupUser(t, r, "mfa@example.com", "MFA Team")
	policy := call(t, r, http.MethodPut, "/api/tenant/identity/mfa", map[string]any{"policy": "all"}, admin)
	if policy.Code != 200 {
		t.Fatalf("policy: %d %s", policy.Code, policy.Body.String())
	}
	login := call(t, r, http.MethodPost, "/api/auth/login", map[string]any{"email": "mfa@example.com", "password": "setup-password-123"}, "")
	if login.Code != 200 {
		t.Fatalf("login: %d", login.Code)
	}
	var enrollment struct {
		Required bool   `json:"mfaEnrollmentRequired"`
		Ticket   string `json:"mfaEnrollmentTicket"`
	}
	decode(t, login, &enrollment)
	if !enrollment.Required || enrollment.Ticket == "" {
		t.Fatalf("expected enrollment challenge: %s", login.Body.String())
	}
	start := call(t, r, http.MethodPost, "/api/auth/mfa/enrollment/totp/start", map[string]any{"ticket": enrollment.Ticket}, "")
	if start.Code != 200 {
		t.Fatalf("start: %d %s", start.Code, start.Body.String())
	}
	var setup struct {
		Secret string `json:"secret"`
	}
	decode(t, start, &setup)
	code := testTOTP(setup.Secret, deps.Clock())
	complete := call(t, r, http.MethodPost, "/api/auth/mfa/enrollment/totp/complete", map[string]any{"ticket": enrollment.Ticket, "code": code}, "")
	if complete.Code != 200 {
		t.Fatalf("complete: %d %s", complete.Code, complete.Body.String())
	}
	var done struct {
		Session string `json:"session"`
	}
	decode(t, complete, &done)
	if done.Session == "" {
		t.Fatal("missing session")
	}
	login = call(t, r, http.MethodPost, "/api/auth/login", map[string]any{"email": "mfa@example.com", "password": "setup-password-123"}, "")
	var challenge struct {
		Required bool   `json:"mfaRequired"`
		Ticket   string `json:"mfaTicket"`
	}
	decode(t, login, &challenge)
	if !challenge.Required {
		t.Fatalf("expected login challenge: %s", login.Body.String())
	}
	verified := call(t, r, http.MethodPost, "/api/auth/mfa/complete", map[string]any{"ticket": challenge.Ticket, "code": code}, "")
	if verified.Code != 200 {
		t.Fatalf("verify: %d %s", verified.Code, verified.Body.String())
	}
}

func TestOIDCSSOWithDeterministicFakeIdP(t *testing.T) {
	deps := testDeps(t)
	deps.Edition = "saas"
	deps.VerifyDomain = func(context.Context, string, string) error { return nil }
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	admin := setupUser(t, r, "owner@example.com", "Corp")
	defaults := call(t, r, http.MethodGet, "/api/tenant/identity/sso", nil, admin)
	if defaults.Code != http.StatusOK || !strings.Contains(defaults.Body.String(), `"protocol":"oidc"`) || !strings.Contains(defaults.Body.String(), `"jitEnabled":true`) || strings.Contains(defaults.Body.String(), `"sso":null`) {
		t.Fatalf("default SSO contract: %d %s", defaults.Code, defaults.Body.String())
	}
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	var nonce atomic.Value
	var idp *httptest.Server
	idp = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/.well-known/openid-configuration":
			json.NewEncoder(w).Encode(map[string]any{"issuer": idp.URL, "authorization_endpoint": idp.URL + "/authorize", "token_endpoint": idp.URL + "/token", "jwks_uri": idp.URL + "/jwks", "userinfo_endpoint": idp.URL + "/userinfo"})
		case "/jwks":
			kid := sha256.Sum256(pub)
			json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{"kty": "OKP", "crv": "Ed25519", "kid": fmt.Sprintf("%x", kid[:8]), "x": base64.RawURLEncoding.EncodeToString(pub)}}})
		case "/token":
			claims := jwt.MapClaims{"iss": idp.URL, "aud": "sso-client", "sub": "subject-1", "email": "member@corp.example", "name": "Member", "nonce": nonce.Load().(string), "iat": time.Now().Add(-time.Minute).Unix(), "exp": time.Now().Add(time.Hour).Unix()}
			tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
			kid := sha256.Sum256(pub)
			tok.Header["kid"] = fmt.Sprintf("%x", kid[:8])
			raw, _ := tok.SignedString(priv)
			json.NewEncoder(w).Encode(map[string]string{"id_token": raw})
		default:
			http.NotFound(w, req)
		}
	}))
	defer idp.Close()
	domain := call(t, r, http.MethodPost, "/api/tenant/identity/domains", map[string]any{"domain": "corp.example"}, admin)
	if domain.Code != 201 {
		t.Fatalf("domain: %d %s", domain.Code, domain.Body.String())
	}
	var d struct {
		Domain struct {
			ID       string `json:"id"`
			Verified bool   `json:"verified"`
			TXTHost  string `json:"txtHost"`
			TXTToken string `json:"txtToken"`
		} `json:"domain"`
	}
	decode(t, domain, &d)
	if d.Domain.Verified || d.Domain.TXTHost != "_zakura-verify.corp.example" || d.Domain.TXTToken == "" {
		t.Fatalf("domain DTO: %+v", d.Domain)
	}
	blockedMode := call(t, r, http.MethodPatch, "/api/tenant/identity/domains/"+d.Domain.ID, map[string]any{"joinMode": "auto_join"}, admin)
	if blockedMode.Code != http.StatusBadRequest {
		t.Fatalf("unverified auto join status=%d body=%s", blockedMode.Code, blockedMode.Body.String())
	}
	verified := call(t, r, http.MethodPost, "/api/tenant/identity/domains/"+d.Domain.ID+"/verify", map[string]any{}, admin)
	if verified.Code != 200 {
		t.Fatalf("verify: %d", verified.Code)
	}
	passwordUser := call(t, r, http.MethodPost, "/api/auth/register", map[string]any{"email": "password@corp.example", "password": "password-user-secret", "tenantName": "Password User"}, "")
	if passwordUser.Code != http.StatusCreated {
		t.Fatalf("pre-policy registration: %d %s", passwordUser.Code, passwordUser.Body.String())
	}
	config := call(t, r, http.MethodPut, "/api/tenant/identity/sso", map[string]any{"protocol": "oidc", "enabled": true, "issuer": idp.URL, "clientId": "sso-client", "scopes": "openid email profile", "jitEnabled": true, "defaultRole": "member"}, admin)
	if config.Code != 200 {
		t.Fatalf("sso config: %d %s", config.Code, config.Body.String())
	}
	var configured struct {
		SSO struct {
			Enabled         bool   `json:"enabled"`
			Protocol        string `json:"protocol"`
			ClientID        string `json:"clientId"`
			JITEnabled      bool   `json:"jitEnabled"`
			DefaultRole     string `json:"defaultRole"`
			RedirectURI     string `json:"redirectUri"`
			ACSURL          string `json:"acsUrl"`
			MetadataURL     string `json:"metadataUrl"`
			HasClientSecret bool   `json:"hasClientSecret"`
		} `json:"sso"`
	}
	decode(t, config, &configured)
	if !configured.SSO.Enabled || configured.SSO.Protocol != "oidc" || configured.SSO.ClientID != "sso-client" || !configured.SSO.JITEnabled || configured.SSO.DefaultRole != "member" || configured.SSO.RedirectURI == "" || configured.SSO.ACSURL == "" || configured.SSO.MetadataURL == "" || configured.SSO.HasClientSecret {
		t.Fatalf("public SSO response mismatch: %+v", configured.SSO)
	}
	loaded := call(t, r, http.MethodGet, "/api/tenant/identity/sso", nil, admin)
	if loaded.Code != http.StatusOK || !strings.Contains(loaded.Body.String(), `"clientId":"sso-client"`) || strings.Contains(loaded.Body.String(), "clientSecret") {
		t.Fatalf("public SSO load: %d %s", loaded.Code, loaded.Body.String())
	}
	autoJoin := call(t, r, http.MethodPatch, "/api/tenant/identity/domains/"+d.Domain.ID, map[string]any{"joinMode": "auto_join"}, admin)
	if autoJoin.Code != http.StatusOK {
		t.Fatalf("auto-join domain policy: %d %s", autoJoin.Code, autoJoin.Body.String())
	}
	if _, err := deps.DB.Exec(`UPDATE users SET email_verified_at=? WHERE email='password@corp.example'`, deps.Clock().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	autoJoinedLogin := call(t, r, http.MethodPost, "/api/auth/login", map[string]any{"email": "password@corp.example", "password": "password-user-secret"}, "")
	var autoJoined int
	_ = deps.DB.QueryRow(`SELECT COUNT(*) FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=(SELECT tenant_id FROM tenant_domains WHERE id=?) AND u.email='password@corp.example' AND m.role='member'`, d.Domain.ID).Scan(&autoJoined)
	if autoJoinedLogin.Code != http.StatusOK || autoJoined != 1 {
		t.Fatalf("verified-domain auto join: status=%d memberships=%d body=%s", autoJoinedLogin.Code, autoJoined, autoJoinedLogin.Body.String())
	}
	requireSSO := call(t, r, http.MethodPatch, "/api/tenant/identity/domains/"+d.Domain.ID, map[string]any{"joinMode": "sso_required"}, admin)
	if requireSSO.Code != http.StatusOK {
		t.Fatalf("require SSO domain policy: %d %s", requireSSO.Code, requireSSO.Body.String())
	}
	blockedLogin := call(t, r, http.MethodPost, "/api/auth/login", map[string]any{"email": "password@corp.example", "password": "password-user-secret"}, "")
	if blockedLogin.Code != http.StatusForbidden || !strings.Contains(blockedLogin.Body.String(), `"code":"sso_required"`) {
		t.Fatalf("SSO password barrier: %d %s", blockedLogin.Code, blockedLogin.Body.String())
	}
	blockedRegistration := call(t, r, http.MethodPost, "/api/auth/register", map[string]any{"email": "new@corp.example", "password": "new-user-password", "tenantName": "Blocked"}, "")
	if blockedRegistration.Code != http.StatusForbidden || !strings.Contains(blockedRegistration.Body.String(), `"code":"sso_required"`) {
		t.Fatalf("SSO registration barrier: %d %s", blockedRegistration.Code, blockedRegistration.Body.String())
	}
	start := call(t, r, http.MethodPost, "/api/auth/sso/oidc/start", map[string]any{"email": "member@corp.example"}, "")
	if start.Code != 200 {
		t.Fatalf("start: %d %s", start.Code, start.Body.String())
	}
	var begin struct {
		URL   string `json:"url"`
		State string `json:"state"`
	}
	decode(t, start, &begin)
	authURL, _ := url.Parse(begin.URL)
	nonce.Store(authURL.Query().Get("nonce"))
	callback := call(t, r, http.MethodPost, "/api/auth/sso/oidc/callback", map[string]any{"code": "fake-code", "state": begin.State}, "")
	if callback.Code != 200 {
		t.Fatalf("callback: %d %s", callback.Code, callback.Body.String())
	}
	var result struct {
		Session string `json:"session"`
	}
	decode(t, callback, &result)
	if result.Session == "" {
		t.Fatal("missing SSO session")
	}
}

func TestSocialOAuthWithDeterministicFakeProvider(t *testing.T) {
	deps := testDeps(t)
	deps.Edition = "saas"
	var tokenCalls atomic.Int64
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			tokenCalls.Add(1)
			if err := r.ParseForm(); err != nil || r.Form.Get("code") != "provider-code" || r.Form.Get("client_secret") != "provider-secret" || r.Form.Get("code_verifier") == "" {
				http.Error(w, "bad exchange", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fake-access"})
		case "/userinfo":
			if r.Header.Get("Authorization") != "Bearer fake-access" {
				http.Error(w, "bad token", http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 12345, "email": nil, "name": "Social User"})
		case "/userinfo/emails":
			if r.Header.Get("Authorization") != "Bearer fake-access" {
				http.Error(w, "bad token", http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode([]map[string]any{{"email": "social@example.com", "primary": true, "verified": true}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer idp.Close()
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	admin.RegisterRoutes(r, deps)
	adminSession := setupUser(t, r, "owner@example.com", "Owner")
	configured := call(t, r, http.MethodPut, "/api/admin/oauth/github", map[string]any{
		"enabled": true, "clientId": "provider-client", "clientSecret": "provider-secret",
		"authorizeUrl": idp.URL + "/authorize", "tokenUrl": idp.URL + "/token",
		"userinfoUrl": idp.URL + "/userinfo", "scope": "read:user user:email", "allowRegistration": true,
	}, adminSession)
	if configured.Code != http.StatusOK {
		t.Fatalf("configure social provider: %d %s", configured.Code, configured.Body.String())
	}
	policy := call(t, r, http.MethodPut, "/api/admin/oauth/login-policy", map[string]any{"disablePasswordLogin": true, "highlightedMethod": "github"}, adminSession)
	if policy.Code != http.StatusOK {
		t.Fatalf("configure login policy: %d %s", policy.Code, policy.Body.String())
	}
	info := call(t, r, http.MethodGet, "/api/info", nil, "")
	if info.Code != http.StatusOK {
		t.Fatalf("public info: %d %s", info.Code, info.Body.String())
	}
	var publicInfo struct {
		PasswordLoginEnabled   bool   `json:"passwordLoginEnabled"`
		RegistrationEnabled    bool   `json:"registrationEnabled"`
		HighlightedLoginMethod string `json:"highlightedLoginMethod"`
		OauthProviders         []struct {
			ID      string `json:"id"`
			Enabled bool   `json:"enabled"`
		} `json:"oauthProviders"`
	}
	decode(t, info, &publicInfo)
	githubReady := false
	for _, provider := range publicInfo.OauthProviders {
		githubReady = githubReady || provider.ID == "github" && provider.Enabled
	}
	if publicInfo.PasswordLoginEnabled || publicInfo.RegistrationEnabled || publicInfo.HighlightedLoginMethod != "github" || !githubReady {
		t.Fatalf("public login discovery mismatch: %+v", publicInfo)
	}
	start := call(t, r, http.MethodPost, "/api/auth/oauth/github/start", map[string]any{}, "")
	if start.Code != http.StatusOK {
		t.Fatalf("start social OAuth: %d %s", start.Code, start.Body.String())
	}
	var started struct {
		AuthorizeURL string `json:"authorizeUrl"`
	}
	decode(t, start, &started)
	authorizeURL, err := url.Parse(started.AuthorizeURL)
	if err != nil || authorizeURL.Query().Get("code_challenge") == "" || authorizeURL.Query().Get("state") == "" {
		t.Fatalf("invalid authorize URL: %q err=%v", started.AuthorizeURL, err)
	}
	callbackBody := map[string]any{"code": "provider-code", "state": authorizeURL.Query().Get("state")}
	callback := call(t, r, http.MethodPost, "/api/auth/oauth/github/callback", callbackBody, "")
	if callback.Code != http.StatusOK {
		t.Fatalf("social callback: %d %s", callback.Code, callback.Body.String())
	}
	var result struct {
		Session string `json:"session"`
		User    struct {
			Email string `json:"email"`
		} `json:"user"`
	}
	decode(t, callback, &result)
	if result.Session == "" || result.User.Email != "social@example.com" || tokenCalls.Load() != 1 {
		t.Fatalf("bad social result: %+v tokenCalls=%d", result, tokenCalls.Load())
	}
	replay := call(t, r, http.MethodPost, "/api/auth/oauth/github/callback", callbackBody, "")
	if replay.Code != http.StatusBadRequest || tokenCalls.Load() != 1 {
		t.Fatalf("state replay was not rejected before provider exchange: %d %s", replay.Code, replay.Body.String())
	}
}

func TestSCIMMappedUsersGroupsAndLifecycle(t *testing.T) {
	deps := testDeps(t)
	deps.Edition = "saas"
	deps.MultiTenant = true
	var lifecycleMu sync.Mutex
	lifecycle := []string{}
	deps.AfterMemberRemoved = func(_ context.Context, tenantID, userID string) error {
		lifecycleMu.Lock()
		lifecycle = append(lifecycle, tenantID+":"+userID)
		lifecycleMu.Unlock()
		return nil
	}
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	ownerSession := setupUser(t, r, "scim-owner@example.com", "SCIM Team")
	var firstTenant string
	if err := deps.DB.QueryRow(`SELECT id FROM tenants WHERE name='SCIM Team'`).Scan(&firstTenant); err != nil {
		t.Fatal(err)
	}
	createToken := call(t, r, http.MethodPost, "/api/tenant/identity/scim/tokens", map[string]any{"name": "Directory", "groupRoleMap": map[string]string{"Admins": "admin"}}, ownerSession)
	if createToken.Code != http.StatusCreated {
		t.Fatalf("create SCIM token: %d %s", createToken.Code, createToken.Body.String())
	}
	var first struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	decode(t, createToken, &first)

	secondTenantResponse := call(t, r, http.MethodPost, "/api/tenants", map[string]any{"name": "Foreign Team"}, ownerSession)
	if secondTenantResponse.Code != http.StatusCreated {
		t.Fatalf("create foreign tenant: %d %s", secondTenantResponse.Code, secondTenantResponse.Body.String())
	}
	var foreign struct {
		Session string `json:"session"`
		Tenant  struct {
			ID string `json:"id"`
		} `json:"tenant"`
	}
	decode(t, secondTenantResponse, &foreign)
	secondTokenResponse := call(t, r, http.MethodPost, "/api/tenant/identity/scim/tokens", map[string]any{"name": "Foreign"}, foreign.Session)
	var second struct {
		Token string `json:"token"`
	}
	decode(t, secondTokenResponse, &second)

	config := call(t, r, http.MethodGet, "/scim/v2/ServiceProviderConfig", nil, "")
	if config.Code != http.StatusOK || !strings.HasPrefix(config.Header().Get("Content-Type"), "application/scim+json") {
		t.Fatalf("public SCIM config: %d type=%q %s", config.Code, config.Header().Get("Content-Type"), config.Body.String())
	}
	created := call(t, r, http.MethodPost, "/scim/v2/Users", map[string]any{"userName": "scim-user@example.test", "externalId": "ext-1", "displayName": "SCIM User"}, first.Token)
	if created.Code != http.StatusCreated {
		t.Fatalf("create SCIM user: %d %s", created.Code, created.Body.String())
	}
	var provisioned struct {
		ID, UserName, ExternalID string
		Active                   bool
	}
	decode(t, created, &provisioned)
	if provisioned.ID == "" || provisioned.UserName != "scim-user@example.test" || provisioned.ExternalID != "ext-1" || !provisioned.Active {
		t.Fatalf("bad SCIM user: %+v", provisioned)
	}
	var userID string
	var password sql.NullString
	if err := deps.DB.QueryRow(`SELECT sm.user_id,u.password_hash FROM scim_user_mappings sm JOIN users u ON u.id=sm.user_id WHERE sm.id=?`, provisioned.ID).Scan(&userID, &password); err != nil || password.Valid {
		t.Fatalf("SCIM passwordless mapping: id=%q password=%#v err=%v", userID, password, err)
	}
	foreignRead := call(t, r, http.MethodGet, "/scim/v2/Users/"+provisioned.ID, nil, second.Token)
	if foreignRead.Code != http.StatusNotFound {
		t.Fatalf("foreign SCIM read status=%d body=%s", foreignRead.Code, foreignRead.Body.String())
	}
	filtered := call(t, r, http.MethodGet, `/scim/v2/Users?filter=userName%20eq%20%22scim-user@example.test%22&startIndex=1&count=1`, nil, first.Token)
	var list struct {
		TotalResults, ItemsPerPage int
		Resources                  []map[string]any
	}
	decode(t, filtered, &list)
	if filtered.Code != http.StatusOK || list.TotalResults != 1 || list.ItemsPerPage != 1 || len(list.Resources) != 1 {
		t.Fatalf("SCIM filtered list: %d %+v", filtered.Code, list)
	}

	groupsResponse := call(t, r, http.MethodGet, "/scim/v2/Groups", nil, first.Token)
	var groups struct {
		Resources []struct {
			ID string `json:"id"`
		} `json:"Resources"`
	}
	decode(t, groupsResponse, &groups)
	if len(groups.Resources) != 1 {
		t.Fatalf("SCIM groups: %d %s", groupsResponse.Code, groupsResponse.Body.String())
	}
	groupID := groups.Resources[0].ID
	added := call(t, r, http.MethodPatch, "/scim/v2/Groups/"+groupID, map[string]any{"Operations": []any{map[string]any{"op": "add", "path": "members", "value": []any{map[string]any{"value": provisioned.ID}}}}}, first.Token)
	if added.Code != http.StatusOK {
		t.Fatalf("SCIM group add: %d %s", added.Code, added.Body.String())
	}
	var role string
	_ = deps.DB.QueryRow(`SELECT role FROM tenant_memberships WHERE tenant_id=? AND user_id=?`, firstTenant, userID).Scan(&role)
	if role != "admin" {
		t.Fatalf("SCIM group did not grant admin: %q", role)
	}
	invalid := call(t, r, http.MethodPatch, "/scim/v2/Groups/"+groupID, map[string]any{"Operations": []any{map[string]any{"op": "replace", "path": "members", "value": []any{}}, map[string]any{"op": map[string]any{"invalid": true}, "path": "members", "value": []any{}}}}, first.Token)
	_ = deps.DB.QueryRow(`SELECT role FROM tenant_memberships WHERE tenant_id=? AND user_id=?`, firstTenant, userID).Scan(&role)
	if invalid.Code != http.StatusBadRequest || role != "admin" {
		t.Fatalf("invalid group operation was not atomic: status=%d role=%q body=%s", invalid.Code, role, invalid.Body.String())
	}

	deactivated := call(t, r, http.MethodPatch, "/scim/v2/Users/"+provisioned.ID, map[string]any{"Operations": []any{map[string]any{"op": "replace", "path": "active", "value": false}}}, first.Token)
	if deactivated.Code != http.StatusOK {
		t.Fatalf("SCIM deactivate: %d %s", deactivated.Code, deactivated.Body.String())
	}
	lifecycleMu.Lock()
	gotLifecycle := append([]string(nil), lifecycle...)
	lifecycleMu.Unlock()
	if !slices.Contains(gotLifecycle, firstTenant+":"+userID) {
		t.Fatalf("missing SCIM lifecycle callback: %#v", gotLifecycle)
	}
	reactivated := call(t, r, http.MethodPatch, "/scim/v2/Users/"+provisioned.ID, map[string]any{"Operations": []any{map[string]any{"op": "replace", "path": "active", "value": true}}}, first.Token)
	if reactivated.Code != http.StatusOK {
		t.Fatalf("SCIM reactivate: %d %s", reactivated.Code, reactivated.Body.String())
	}
	if _, err := deps.DB.Exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, deps.NewID(), foreign.Tenant.ID, userID, "member", "active", deps.Clock().Format(time.RFC3339Nano), deps.Clock().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	profileChange := call(t, r, http.MethodPut, "/scim/v2/Users/"+provisioned.ID, map[string]any{"userName": "changed@example.test", "displayName": "Changed", "externalId": "ext-1", "active": true}, first.Token)
	if profileChange.Code != http.StatusConflict {
		t.Fatalf("shared profile mutation status=%d body=%s", profileChange.Code, profileChange.Body.String())
	}
	removed := call(t, r, http.MethodPatch, "/scim/v2/Groups/"+groupID, map[string]any{"Operations": []any{map[string]any{"op": "remove", "path": `members[value eq "` + provisioned.ID + `"]`}}}, first.Token)
	_ = deps.DB.QueryRow(`SELECT role FROM tenant_memberships WHERE tenant_id=? AND user_id=?`, firstTenant, userID).Scan(&role)
	if removed.Code != http.StatusOK || role != "member" {
		t.Fatalf("SCIM group remove: status=%d role=%q body=%s", removed.Code, role, removed.Body.String())
	}
	revoke := call(t, r, http.MethodDelete, "/api/tenant/identity/scim/tokens/"+first.ID, nil, ownerSession)
	if revoke.Code != http.StatusOK {
		t.Fatalf("revoke SCIM token: %d %s", revoke.Code, revoke.Body.String())
	}
	if revoked := call(t, r, http.MethodGet, "/scim/v2/Users", nil, first.Token); revoked.Code != http.StatusUnauthorized {
		t.Fatalf("revoked SCIM token status=%d", revoked.Code)
	}
	var audits int
	_ = deps.DB.QueryRow(`SELECT COUNT(*) FROM security_audit_logs WHERE tenant_id=? AND actor_type='scim'`, firstTenant).Scan(&audits)
	if audits < 4 {
		t.Fatalf("missing SCIM audits: %d", audits)
	}
}

func setupUser(t *testing.T, r http.Handler, email, tenant string) string {
	t.Helper()
	rr := call(t, r, http.MethodPost, "/api/setup", map[string]any{"adminEmail": email, "adminPassword": "setup-password-123", "tenantName": tenant}, "")
	if rr.Code != 200 {
		t.Fatalf("setup: %d %s", rr.Code, rr.Body.String())
	}
	var out struct {
		Session string `json:"session"`
	}
	decode(t, rr, &out)
	return out.Session
}

func testDeps(t *testing.T) *appdeps.Dependencies {
	t.Helper()
	c, err := platformdb.Open(context.Background(), "file:"+filepath.Join(t.TempDir(), "zakura.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.DB.Close() })
	if err := migrations.Apply(context.Background(), c.DB, c.Dialect, c.Rebind); err != nil {
		t.Fatal(err)
	}
	gormDB, err := c.Gorm()
	if err != nil {
		t.Fatal(err)
	}
	var seq atomic.Int64
	return &appdeps.Dependencies{DB: c.DB, Gorm: gormDB, Dialect: c.Dialect, Rebind: c.Rebind, Clock: func() time.Time { return time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC) }, NewID: func() string { return fmt.Sprintf("%026d", seq.Add(1)) }, Secret: []byte("0123456789abcdef0123456789abcdef"), PublicURL: "http://api.test", WebURL: "http://web.test", Edition: "self-hosted", MultiTenant: true}
}
func call(t *testing.T, h http.Handler, method, path string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}
func decode(t *testing.T, rr *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.Unmarshal(rr.Body.Bytes(), dst); err != nil {
		t.Fatalf("decode %s: %v", rr.Body.String(), err)
	}
}

func callForm(h http.Handler, path string, form url.Values) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func testTOTP(secret string, t time.Time) string {
	key, _ := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(t.Unix()/30))
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 15
	v := (uint32(sum[off])&0x7f)<<24 | uint32(sum[off+1])<<16 | uint32(sum[off+2])<<8 | uint32(sum[off+3])
	return fmt.Sprintf("%06d", v%1_000_000)
}
