package identity_test

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/emailverify"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/identity"
	"github.com/go-chi/chi/v5"
)

func TestChangeMyEmailWrongPassword(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	session := setupUser(t, r, "email-wrong@example.com", "Email Team")

	rr := call(t, r, http.MethodPost, "/api/me/email", map[string]any{"newEmail": "email-wrong-new@example.com", "currentPassword": "not-the-password"}, session)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d %s", rr.Code, rr.Body.String())
	}
}

func TestChangeMyEmailSuccess(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	session := setupUser(t, r, "email-ok@example.com", "Email Team")

	var uid string
	if err := deps.DB.QueryRow(`SELECT id FROM users WHERE email=?`, "email-ok@example.com").Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := deps.DB.Exec(`UPDATE users SET email_verified_at=? WHERE id=?`, deps.Clock().Format(time.RFC3339Nano), uid); err != nil {
		t.Fatal(err)
	}

	rr := call(t, r, http.MethodPost, "/api/me/email", map[string]any{"newEmail": "email-new@example.com", "currentPassword": "setup-password-123"}, session)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d %s", rr.Code, rr.Body.String())
	}
	var body struct {
		OK   bool `json:"ok"`
		Sent bool `json:"sent"`
	}
	decode(t, rr, &body)
	if !body.OK || body.Sent {
		t.Fatalf("unexpected body: %s", rr.Body.String())
	}

	var newEmail string
	var verified sql.NullString
	if err := deps.DB.QueryRow(`SELECT email,email_verified_at FROM users WHERE id=?`, uid).Scan(&newEmail, &verified); err != nil {
		t.Fatal(err)
	}
	if newEmail != "email-new@example.com" {
		t.Fatalf("email not updated: %q", newEmail)
	}
	if verified.Valid {
		t.Fatalf("email_verified_at should be NULL, got %q", verified.String)
	}
}

func TestEmailVerificationRejectsStaleAddressBinding(t *testing.T) {
	deps := testDeps(t)
	tokens := map[string]string{}
	deps.SendTransactionalEmail = func(_ context.Context, recipient, _ string, _ string, text string) error {
		tokens[recipient] = verificationTokenFromEmail(t, text)
		return nil
	}
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	session := setupUser(t, r, "email-binding@example.com", "Email Binding Team")

	var uid string
	if err := deps.DB.QueryRow(`SELECT id FROM users WHERE email=?`, "email-binding@example.com").Scan(&uid); err != nil {
		t.Fatal(err)
	}
	now := deps.Clock().Format(time.RFC3339Nano)
	tenantID, domainID := deps.NewID(), deps.NewID()
	if _, err := deps.DB.Exec(`INSERT INTO tenants(id,slug,name,is_default,onboarding_completed,onboarding_steps,status,created_at,updated_at) VALUES(?,?,?,0,0,'{}','active',?,?)`, tenantID, "bound-domain", "Bound Domain", now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := deps.DB.Exec(`INSERT INTO tenant_domains(id,tenant_id,domain,join_mode,verification_token,verified_at,created_at,updated_at) VALUES(?,?,?,'auto_join','verified',?,?,?)`, domainID, tenantID, "target.example", now, now, now); err != nil {
		t.Fatal(err)
	}

	first := call(t, r, http.MethodPost, "/api/me/email", map[string]any{"newEmail": "controlled@example.com", "currentPassword": "setup-password-123"}, session)
	if first.Code != http.StatusOK {
		t.Fatalf("first email change: %d %s", first.Code, first.Body.String())
	}
	staleToken := tokens["controlled@example.com"]
	staleHash := sha256.Sum256([]byte(staleToken))
	var staleMeta string
	if err := deps.DB.QueryRow(`SELECT meta_json FROM auth_tokens WHERE token_hash=?`, hex.EncodeToString(staleHash[:])).Scan(&staleMeta); err != nil {
		t.Fatal(err)
	}
	staleBinding, err := emailverify.Decode(staleMeta)
	if err != nil || staleBinding.TargetEmail != "controlled@example.com" {
		t.Fatalf("unexpected stale token binding: %+v err=%v", staleBinding, err)
	}

	second := call(t, r, http.MethodPost, "/api/me/email", map[string]any{"newEmail": "member@target.example", "currentPassword": "setup-password-123"}, session)
	if second.Code != http.StatusOK {
		t.Fatalf("second email change: %d %s", second.Code, second.Body.String())
	}
	currentToken := tokens["member@target.example"]
	var currentVersion int64
	var staleConsumed sql.NullString
	if err := deps.DB.QueryRow(`SELECT u.email_version,t.consumed_at FROM users u JOIN auth_tokens t ON t.user_id=u.id WHERE u.id=? AND t.token_hash=?`, uid, hex.EncodeToString(staleHash[:])).Scan(&currentVersion, &staleConsumed); err != nil {
		t.Fatal(err)
	}
	if currentVersion != staleBinding.EmailVersion+1 || !staleConsumed.Valid {
		t.Fatalf("email change did not revoke stale token: version=%d binding=%d consumed=%v", currentVersion, staleBinding.EmailVersion, staleConsumed.Valid)
	}

	// Simulate an issuance racing after revocation: the address and version checks
	// must still reject a stale capability that remains marked unconsumed.
	if _, err := deps.DB.Exec(`UPDATE auth_tokens SET consumed_at=NULL WHERE token_hash=?`, hex.EncodeToString(staleHash[:])); err != nil {
		t.Fatal(err)
	}
	stale := call(t, r, http.MethodPost, "/api/auth/verify-email", map[string]any{"token": staleToken}, "")
	if stale.Code != http.StatusBadRequest {
		t.Fatalf("stale token status=%d body=%s", stale.Code, stale.Body.String())
	}
	var verified sql.NullString
	var memberships int
	if err := deps.DB.QueryRow(`SELECT email_verified_at FROM users WHERE id=?`, uid).Scan(&verified); err != nil {
		t.Fatal(err)
	}
	if err := deps.DB.QueryRow(`SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id=? AND user_id=?`, tenantID, uid).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if verified.Valid || memberships != 0 {
		t.Fatalf("stale token changed protected state: verified=%v memberships=%d", verified.Valid, memberships)
	}

	current := call(t, r, http.MethodPost, "/api/auth/verify-email", map[string]any{"token": currentToken}, "")
	if current.Code != http.StatusOK {
		t.Fatalf("current token status=%d body=%s", current.Code, current.Body.String())
	}
	if err := deps.DB.QueryRow(`SELECT email_verified_at FROM users WHERE id=?`, uid).Scan(&verified); err != nil {
		t.Fatal(err)
	}
	if err := deps.DB.QueryRow(`SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id=? AND user_id=?`, tenantID, uid).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if !verified.Valid || memberships != 1 {
		t.Fatalf("current token did not preserve verification behavior: verified=%v memberships=%d", verified.Valid, memberships)
	}
}

func verificationTokenFromEmail(t *testing.T, text string) string {
	t.Helper()
	const marker = "token="
	start := strings.Index(text, marker)
	if start < 0 {
		t.Fatalf("verification token missing from email: %q", text)
	}
	raw := text[start+len(marker):]
	if end := strings.IndexAny(raw, "\r\n \t"); end >= 0 {
		raw = raw[:end]
	}
	token, err := url.QueryUnescape(raw)
	if err != nil || token == "" {
		t.Fatalf("invalid verification token in email: %q", text)
	}
	return token
}

func TestChangeMyEmailDuplicate(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	session := setupUser(t, r, "email-dup-self@example.com", "Email Team")

	now := deps.Clock().Format(time.RFC3339Nano)
	if _, err := deps.DB.Exec(`INSERT INTO users(id,email,password_hash,name,is_platform_admin,status,created_at,updated_at) VALUES(?,?,?,?,0,'active',?,?)`, "dup-user-1", "taken@example.com", nil, "Taken", now, now); err != nil {
		t.Fatal(err)
	}
	rr := call(t, r, http.MethodPost, "/api/me/email", map[string]any{"newEmail": "taken@example.com", "currentPassword": "setup-password-123"}, session)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d %s", rr.Code, rr.Body.String())
	}
}

func TestListMyOAuthIdentities(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	session := setupUser(t, r, "oauth-list@example.com", "OAuth Team")

	var uid string
	if err := deps.DB.QueryRow(`SELECT id FROM users WHERE email=?`, "oauth-list@example.com").Scan(&uid); err != nil {
		t.Fatal(err)
	}
	now := deps.Clock().Format(time.RFC3339Nano)
	if _, err := deps.DB.Exec(`INSERT INTO oauth_identities(id,provider,provider_user_id,user_id,profile_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, "ident-list-1", "github", "gh-42", uid, `{"email":"octo@example.com","login":"octocat"}`, now, now); err != nil {
		t.Fatal(err)
	}

	rr := call(t, r, http.MethodGet, "/api/me/oauth-identities", nil, session)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d %s", rr.Code, rr.Body.String())
	}
	var body struct {
		Identities []struct {
			ID             string  `json:"id"`
			Provider       string  `json:"provider"`
			ProviderUserID string  `json:"providerUserId"`
			Email          *string `json:"email"`
			Name           *string `json:"name"`
			CreatedAt      string  `json:"createdAt"`
		} `json:"identities"`
	}
	decode(t, rr, &body)
	if len(body.Identities) != 1 {
		t.Fatalf("expected one identity: %s", rr.Body.String())
	}
	got := body.Identities[0]
	if got.ID != "ident-list-1" || got.Provider != "github" || got.ProviderUserID != "gh-42" {
		t.Fatalf("unexpected identity: %+v", got)
	}
	if got.Email == nil || *got.Email != "octo@example.com" {
		t.Fatalf("unexpected email: %+v", got.Email)
	}
	if got.Name == nil || *got.Name != "octocat" {
		t.Fatalf("unexpected name: %+v", got.Name)
	}
}

func TestUnlinkLastOAuthIdentityRequiresPassword(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	session := setupUser(t, r, "unlink-last@example.com", "Unlink Team")

	var uid string
	if err := deps.DB.QueryRow(`SELECT id FROM users WHERE email=?`, "unlink-last@example.com").Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := deps.DB.Exec(`UPDATE users SET password_hash=NULL WHERE id=?`, uid); err != nil {
		t.Fatal(err)
	}
	now := deps.Clock().Format(time.RFC3339Nano)
	if _, err := deps.DB.Exec(`INSERT INTO oauth_identities(id,provider,provider_user_id,user_id,profile_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, "ident-last-1", "google", "g-1", uid, `{"email":"g@example.com","name":"G"}`, now, now); err != nil {
		t.Fatal(err)
	}

	rr := call(t, r, http.MethodDelete, "/api/me/oauth-identities/ident-last-1", nil, session)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d %s", rr.Code, rr.Body.String())
	}
}

func TestUnlinkOAuthIdentityWithPassword(t *testing.T) {
	deps := testDeps(t)
	r := chi.NewRouter()
	identity.RegisterRoutes(r, deps)
	session := setupUser(t, r, "unlink-ok@example.com", "Unlink Team")

	var uid string
	if err := deps.DB.QueryRow(`SELECT id FROM users WHERE email=?`, "unlink-ok@example.com").Scan(&uid); err != nil {
		t.Fatal(err)
	}
	now := deps.Clock().Format(time.RFC3339Nano)
	if _, err := deps.DB.Exec(`INSERT INTO oauth_identities(id,provider,provider_user_id,user_id,profile_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, "ident-ok-1", "google", "g-2", uid, `{"email":"g2@example.com","name":"G2"}`, now, now); err != nil {
		t.Fatal(err)
	}

	rr := call(t, r, http.MethodDelete, "/api/me/oauth-identities/ident-ok-1", nil, session)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d %s", rr.Code, rr.Body.String())
	}
	var remaining int
	if err := deps.DB.QueryRow(`SELECT COUNT(*) FROM oauth_identities WHERE id=?`, "ident-ok-1").Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("identity not deleted")
	}
}
