package identity_test

import (
	"database/sql"
	"net/http"
	"testing"
	"time"

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
