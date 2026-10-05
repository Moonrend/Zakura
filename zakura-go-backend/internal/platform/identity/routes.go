package identity

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/appdeps"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

var (
	errOwnerOnly  = errors.New("owner only")
	errLastOwner  = errors.New("last active owner")
	errSelfRemove = errors.New("cannot remove self")
)

func RegisterRoutes(r chi.Router, deps *appdeps.Dependencies) {
	s := New(deps)
	deps.OAuthPublicKey = func(ctx context.Context) (*rsa.PublicKey, error) {
		key, err := s.signingKey(ctx)
		if err != nil {
			return nil, err
		}
		return &key.Private.PublicKey, nil
	}
	r.Get("/api/info", infoHandler(s, deps))
	r.Post("/api/setup", setupHandler(s, deps))
	r.Post("/api/auth/login", loginHandler(s, deps))
	r.Post("/api/auth/register", registerHandler(s, deps))
	r.Get("/api/auth/oauth/{provider}", s.oauthLoginProvider)
	r.Post("/api/auth/oauth/{provider}/start", s.startOAuthLogin)
	r.Post("/api/auth/oauth/{provider}/callback", s.completeOAuthLogin)
	r.Post("/api/auth/forgot-password", forgotPasswordHandler(s))
	r.Post("/api/auth/reset-password", resetPasswordHandler(s))
	r.Post("/api/auth/verify-email", verifyEmailTokenHandler(s))
	r.Post("/api/auth/sso/discover", s.discoverSSO)
	r.Post("/api/auth/sso/{protocol}/start", s.startSSO)
	r.Post("/api/auth/sso/oidc/callback", s.oidcCallback)
	r.Post("/api/auth/sso/saml/{slug}/acs", s.samlACS)
	r.Get("/api/auth/sso/saml/{slug}/metadata", s.samlMetadata)
	r.Post("/api/auth/sso/ticket", s.exchangeSSOTicket)
	r.Post("/api/auth/mfa/complete", s.completeMFALogin)
	r.Post("/api/auth/mfa/webauthn/options", s.beginWebAuthnLogin)
	r.Post("/api/auth/mfa/enrollment/totp/start", s.startTicketTOTP)
	r.Post("/api/auth/mfa/enrollment/totp/complete", s.completeTicketTOTP)
	r.Group(func(pr chi.Router) {
		pr.Use(httpx.Auth(deps))
		pr.Get("/api/me", currentHandler(s, deps))
		pr.Get("/api/me/mfa", s.myMFA)
		pr.Post("/api/me/mfa/totp/start", s.startMyTOTP)
		pr.Post("/api/me/mfa/totp/cancel", s.cancelMyTOTP)
		pr.Post("/api/me/mfa/totp/enable", s.enableMyTOTP)
		pr.Post("/api/me/mfa/totp/disable", s.disableMyTOTP)
		pr.Post("/api/me/mfa/totp/recovery", s.rotateRecoveryCodes)
		pr.Post("/api/me/mfa/webauthn/register/options", s.beginWebAuthnRegistration)
		pr.Post("/api/me/mfa/webauthn/register", s.finishWebAuthnRegistration)
		pr.Patch("/api/me/mfa/webauthn/{id}", s.renameWebAuthnCredential)
		pr.Delete("/api/me/mfa/webauthn/{id}", s.deleteWebAuthnCredential)
		pr.Patch("/api/me", patchMeHandler(s))
		pr.Post("/api/me/password", changePasswordHandler(s))
		pr.Get("/api/me/sessions", listSessionsHandler(s))
		pr.Delete("/api/me/sessions/{id}", revokeSessionHandler(s))
		pr.Post("/api/me/sessions/revoke-others", revokeOtherSessionsHandler(s))
		pr.Get("/api/tenants", listTenantsHandler(s))
		pr.Post("/api/tenants", createTenantHandler(s))
		pr.Post("/api/auth/switch-tenant", switchTenantHandler(s))
		pr.Get("/api/tenant/current", currentTenantHandler(s))
		pr.Patch("/api/tenant/current", patchTenantHandler(s))
		pr.Delete("/api/tenant/current", deleteTenantHandler(s))
		pr.Get("/api/tenant/members", listMembersHandler(s))
		pr.Patch("/api/tenant/members/{id}", patchMemberHandler(s))
		pr.Delete("/api/tenant/members/{id}", deleteMemberHandler(s))
		pr.Post("/api/tenant/leave", leaveTenantHandler(s))
		pr.Get("/api/tenant/invites", listInvitesHandler(s))
		pr.Post("/api/tenant/invites", createInviteHandler(s))
		pr.Delete("/api/tenant/invites/{id}", revokeInviteHandler(s))
		pr.Get("/api/tenant/people", listPeopleHandler(s))
		pr.Get("/api/tenant/people/{id}", getPersonHandler(s))
		pr.Get("/api/tenant/onboarding", onboardingHandler(s))
		pr.Patch("/api/tenant/onboarding", patchOnboardingHandler(s))
		pr.Post("/api/tenant/onboarding/complete", completeOnboardingHandler(s))
	})
	r.Get("/api/invites/{token}", inspectInviteHandler(s))
	r.With(httpx.OptionalAuth(deps)).Post("/api/invites/{token}/accept", acceptInviteHandler(s, deps))
	registerEnterpriseRoutes(r, deps, s)
	registerOAuthRoutes(r, deps, s)
}

func infoHandler(s *Service, deps *appdeps.Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var setup bool
		version, mode := "go-rewrite", map[bool]string{true: "saas", false: "local"}[deps.MultiTenant]
		_ = deps.DB.QueryRowContext(r.Context(), `SELECT setup_completed,version,mode FROM platform_meta WHERE singleton=1`).Scan(&setup, &version, &mode)
		providers := []map[string]any{}
		ready := map[string]bool{}
		if deps.Edition == "saas" {
			for _, id := range []string{"zerocat", "google", "github", "microsoft"} {
				cfg, def, _ := s.loadLoginProvider(r.Context(), id)
				enabled := cfg.Enabled && cfg.ClientID != "" && cfg.ClientSecretEnc != ""
				ready[id] = enabled
				if enabled {
					providers = append(providers, map[string]any{"id": id, "name": def.Name, "enabled": true})
				}
			}
		}
		passwordEnabled := s.passwordLoginEnabled(r.Context())
		highlighted := "auto"
		var raw string
		if deps.DB.QueryRowContext(r.Context(), s.q(`SELECT value FROM settings WHERE owner_key='platform' AND key='auth.login'`)).Scan(&raw) == nil {
			var policy struct {
				Highlighted string `json:"highlightedMethod"`
			}
			_ = json.Unmarshal([]byte(raw), &policy)
			if policy.Highlighted != "" {
				highlighted = policy.Highlighted
			}
			if highlighted != "auto" && highlighted != "password" && !ready[highlighted] {
				highlighted = "auto"
			}
		}
		httpx.JSON(w, 200, map[string]any{"setupCompleted": setup, "version": version, "mode": mode, "multiTenant": deps.MultiTenant, "edition": deps.Edition, "registrationEnabled": deps.Edition == "saas" && passwordEnabled, "passwordLoginEnabled": passwordEnabled, "oauthProviders": providers, "highlightedLoginMethod": highlighted})
	}
}
func setupHandler(s *Service, deps *appdeps.Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			AdminEmail    string `json:"adminEmail"`
			AdminPassword string `json:"adminPassword"`
			AdminName     string `json:"adminName"`
			TenantName    string `json:"tenantName"`
		}
		if err := httpx.DecodeJSON(r, &b); err != nil {
			httpx.Error(w, 400, "invalid request")
			return
		}
		res, err := s.Setup(r.Context(), b.AdminEmail, b.AdminPassword, b.AdminName, b.TenantName, requestIP(r), r.UserAgent())
		if err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "session": res.Session, "tenant": res.Tenant, "next": "/onboarding"})
	}
}
func loginHandler(s *Service, deps *appdeps.Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.passwordLoginEnabled(r.Context()) {
			httpx.Error(w, 403, "Email/password login is disabled; use OAuth")
			return
		}
		var b struct {
			Email      string `json:"email"`
			Password   string `json:"password"`
			TenantSlug string `json:"tenantSlug"`
		}
		if httpx.DecodeJSON(r, &b) != nil || b.Email == "" || b.Password == "" {
			httpx.Error(w, 400, "email and password required")
			return
		}
		if s.passwordLoginBlockedBySSO(r.Context(), b.Email) {
			httpx.JSON(w, 403, map[string]any{"error": "This account requires company SSO", "code": "sso_required"})
			return
		}
		ip := requestIP(r)
		res, err := s.Login(r.Context(), b.Email, b.Password, b.TenantSlug, requestIP(r), r.UserAgent())
		if err != nil {
			var mfa *MFARequiredError
			if errors.As(err, &mfa) {
				s.clearLoginFailures(r.Context(), b.Email, ip)
				if mfa.Enrollment {
					httpx.JSON(w, 200, map[string]any{"mfaEnrollmentRequired": true, "mfaEnrollmentTicket": mfa.Ticket, "methods": mfa.Methods, "code": "mfa_enrollment_required"})
				} else {
					httpx.JSON(w, 200, map[string]any{"mfaRequired": true, "mfaTicket": mfa.Ticket, "methods": mfa.Methods})
				}
				return
			}
			if s.recordLoginFailure(r.Context(), b.Email, ip) {
				httpx.Error(w, 429, "Too many login attempts; try again later")
				return
			}
			httpx.Error(w, 401, "Invalid credentials")
			return
		}
		s.clearLoginFailures(r.Context(), b.Email, ip)
		httpx.JSON(w, 200, map[string]any{"session": res.Session, "user": res.User, "tenant": res.Tenant, "role": res.Role, "multiTenant": deps.MultiTenant, "edition": deps.Edition})
	}
}
func registerHandler(s *Service, deps *appdeps.Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.passwordLoginEnabled(r.Context()) {
			httpx.Error(w, 403, "Email/password registration is disabled; use OAuth")
			return
		}
		var b struct {
			Email      string `json:"email"`
			Password   string `json:"password"`
			Name       string `json:"name"`
			TenantName string `json:"tenantName"`
		}
		if httpx.DecodeJSON(r, &b) != nil || b.Email == "" || b.Password == "" {
			httpx.Error(w, 400, "email and password required")
			return
		}
		if s.registrationBlockedBySSO(r.Context(), b.Email) {
			httpx.JSON(w, 403, map[string]any{"error": "This email must use company SSO", "code": "sso_required"})
			return
		}
		res, err := s.Register(r.Context(), b.Email, b.Password, b.Name, b.TenantName, requestIP(r), r.UserAgent())
		if err != nil {
			status := 400
			if strings.Contains(err.Error(), "registered") {
				status = 409
			}
			if strings.Contains(err.Error(), "disabled") {
				status = 403
			}
			httpx.Error(w, status, err.Error())
			return
		}
		_, _ = s.sendVerificationEmail(r.Context(), res.User.ID, res.User.Email)
		httpx.JSON(w, 201, map[string]any{"session": res.Session, "user": res.User, "tenant": res.Tenant, "next": "/onboarding"})
	}
}
func currentHandler(s *Service, deps *appdeps.Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		var u User
		var t Tenant
		var err error
		if p.APIKey {
			var steps string
			err = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT id,slug,name,is_default,onboarding_completed,onboarding_steps FROM tenants WHERE id=?`), p.TenantID).Scan(&t.ID, &t.Slug, &t.Name, &t.IsDefault, &t.OnboardingCompleted, &steps)
			if err == nil {
				t.OnboardingSteps = decodeObject(steps)
			}
			u = User{ID: "api-key", Email: p.Email, CanUseLocalRunner: false}
		} else {
			u, t, err = s.Current(r.Context(), p)
		}
		if err != nil {
			httpx.Error(w, 404, "not found")
			return
		}
		platformAdmin := deps.MultiTenant && u.IsPlatformAdmin
		httpx.JSON(w, 200, map[string]any{"user": u, "tenant": t, "role": p.Role, "isPlatformAdmin": platformAdmin, "canUseLocalRunner": u.CanUseLocalRunner, "multiTenant": deps.MultiTenant, "edition": deps.Edition, "registrationEnabled": deps.Edition == "saas", "connect": map[string]any{"agentMcpPattern": deps.PublicURL + "/mcp/agents/{slug}", "authorizeUrl": deps.WebURL + "/console/oauth/authorize", "tokenUrl": deps.PublicURL + "/token", "registerUrl": deps.PublicURL + "/oauth/register", "oauthMetadataUrl": deps.PublicURL + "/.well-known/oauth-authorization-server", "resourceMetadataUrl": deps.PublicURL + "/.well-known/oauth-protected-resource", "webPublicUrl": deps.WebURL, "clientIdMetadataDocumentSupported": true}})
	}
}

func patchMeHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "API keys cannot update profile")
			return
		}
		var b struct {
			Name  *string `json:"name"`
			Title *string `json:"title"`
			Bio   *string `json:"bio"`
		}
		if httpx.DecodeJSON(r, &b) != nil {
			httpx.Error(w, 400, "invalid request")
			return
		}
		if b.Name == nil && b.Title == nil && b.Bio == nil {
			httpx.Error(w, 400, "no changes")
			return
		}
		var name, title, bio string
		if err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT COALESCE(name,''),COALESCE(title,''),COALESCE(bio,'') FROM users WHERE id=?`), p.UserID).Scan(&name, &title, &bio); err != nil {
			httpx.Error(w, 404, "not found")
			return
		}
		if b.Name != nil {
			name = strings.TrimSpace(*b.Name)
		}
		if b.Title != nil {
			title = strings.TrimSpace(*b.Title)
		}
		if b.Bio != nil {
			bio = strings.TrimSpace(*b.Bio)
		}
		if len(name) > 120 || len(title) > 160 || len(bio) > 2000 {
			httpx.Error(w, 400, "profile field too long")
			return
		}
		_, err := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE users SET name=?,title=?,bio=?,updated_at=? WHERE id=?`), name, title, bio, s.now(), p.UserID)
		if err != nil {
			httpx.Error(w, 500, "update failed")
			return
		}
		_ = s.Audit(r.Context(), p.TenantID, "profile.update", p.UserID, "user", p.UserID, nil)
		httpx.JSON(w, 200, map[string]any{"ok": true})
	}
}
func changePasswordHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "API keys cannot change password")
			return
		}
		var b struct {
			Current string `json:"currentPassword"`
			New     string `json:"newPassword"`
		}
		if httpx.DecodeJSON(r, &b) != nil || len(b.New) < 10 {
			httpx.Error(w, 400, "new password must contain at least 10 characters")
			return
		}
		var old string
		if s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT COALESCE(password_hash,'') FROM users WHERE id=?`), p.UserID).Scan(&old) != nil || bcrypt.CompareHashAndPassword([]byte(old), []byte(b.Current)) != nil {
			httpx.Error(w, 400, "current password is incorrect")
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(b.New), passwordBcryptCost)
		err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
			if _, e := tx.ExecContext(r.Context(), s.q(`UPDATE users SET password_hash=?,updated_at=? WHERE id=?`), string(hash), s.now(), p.UserID); e != nil {
				return e
			}
			_, e := tx.ExecContext(r.Context(), s.q(`UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL`), s.now(), p.UserID, p.SessionID)
			return e
		})
		if err != nil {
			httpx.Error(w, 500, "update failed")
			return
		}
		_ = s.Audit(r.Context(), p.TenantID, "auth.password_change", p.UserID, "user", p.UserID, nil)
		httpx.JSON(w, 200, map[string]any{"ok": true})
	}
}

func listSessionsHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		rows, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT id,COALESCE(ip,''),COALESCE(user_agent,''),COALESCE(CAST(last_seen_at AS TEXT),CAST(created_at AS TEXT)),CAST(created_at AS TEXT),CAST(expires_at AS TEXT) FROM user_sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC`), p.UserID)
		if err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id, ip, ua, last, created, expires string
			_ = rows.Scan(&id, &ip, &ua, &last, &created, &expires)
			items = append(items, map[string]any{"id": id, "ip": ip, "userAgent": ua, "lastSeenAt": last, "createdAt": created, "expiresAt": expires, "current": id == p.SessionID})
		}
		httpx.JSON(w, 200, map[string]any{"sessions": items})
	}
}
func revokeSessionHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "forbidden")
			return
		}
		res, _ := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE user_sessions SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL`), s.now(), httpx.Param(r, "id"), p.UserID)
		n, _ := res.RowsAffected()
		httpx.JSON(w, 200, map[string]any{"ok": n > 0})
	}
}
func revokeOtherSessionsHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "forbidden")
			return
		}
		res, _ := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL`), s.now(), p.UserID, p.SessionID)
		n, _ := res.RowsAffected()
		httpx.JSON(w, 200, map[string]any{"count": n})
	}
}

func listTenantsHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "API keys cannot list tenants")
			return
		}
		rows, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT m.id,m.role,m.status,t.id,t.slug,t.name,t.is_default,t.onboarding_completed,t.onboarding_steps FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id WHERE m.user_id=? AND m.status='active' ORDER BY t.created_at`), p.UserID)
		if err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var t Tenant
			var membershipID, role, status, steps string
			_ = rows.Scan(&membershipID, &role, &status, &t.ID, &t.Slug, &t.Name, &t.IsDefault, &t.OnboardingCompleted, &steps)
			items = append(items, map[string]any{"membershipId": membershipID, "role": role, "status": status, "tenant": map[string]any{"id": t.ID, "slug": t.Slug, "name": t.Name, "isDefault": t.IsDefault, "onboardingCompleted": t.OnboardingCompleted, "onboardingSteps": decodeObject(steps)}})
		}
		httpx.JSON(w, 200, map[string]any{"tenants": items, "currentTenantId": p.TenantID, "multiTenant": s.deps.MultiTenant, "edition": s.deps.Edition})
	}
}
func createTenantHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "API keys cannot create tenants")
			return
		}
		var b struct {
			Name string `json:"name"`
			Slug string `json:"slug"`
		}
		if httpx.DecodeJSON(r, &b) != nil {
			httpx.Error(w, 400, "invalid request")
			return
		}
		res, err := s.CreateTenant(r.Context(), p, b.Name, b.Slug, requestIP(r), r.UserAgent())
		if err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		httpx.JSON(w, 201, map[string]any{"tenant": res.Tenant, "session": res.Session})
	}
}
func switchTenantHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "API keys cannot switch tenants")
			return
		}
		var b struct {
			TenantID string `json:"tenantId"`
		}
		if httpx.DecodeJSON(r, &b) != nil || b.TenantID == "" {
			httpx.Error(w, 400, "tenantId required")
			return
		}
		res, err := s.SwitchTenant(r.Context(), p, b.TenantID, requestIP(r), r.UserAgent())
		if err != nil {
			httpx.Error(w, 403, err.Error())
			return
		}
		httpx.JSON(w, 200, map[string]any{"session": res.Session, "tenant": res.Tenant, "role": res.Role})
	}
}

func currentTenantHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		_, t, err := s.Current(r.Context(), p)
		if err != nil {
			httpx.Error(w, 404, "not found")
			return
		}
		httpx.JSON(w, 200, map[string]any{"id": t.ID, "slug": t.Slug, "name": t.Name, "isDefault": t.IsDefault, "onboardingCompleted": t.OnboardingCompleted, "onboardingSteps": t.OnboardingSteps, "role": p.Role})
	}
}
func patchTenantHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.Role != "owner" && p.Role != "admin" {
			httpx.Error(w, 403, "Admin only")
			return
		}
		var b struct {
			Name *string `json:"name"`
		}
		if httpx.DecodeJSON(r, &b) != nil || b.Name == nil || strings.TrimSpace(*b.Name) == "" {
			httpx.Error(w, 400, "name required")
			return
		}
		_, tenant, loadErr := s.Current(r.Context(), p)
		if loadErr != nil {
			httpx.Error(w, 404, "not found")
			return
		}
		_, err := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE tenants SET name=?,updated_at=? WHERE id=?`), strings.TrimSpace(*b.Name), s.now(), p.TenantID)
		if err != nil {
			httpx.Error(w, 500, "update failed")
			return
		}
		httpx.JSON(w, 200, map[string]any{"id": p.TenantID, "slug": tenant.Slug, "name": strings.TrimSpace(*b.Name)})
	}
}
func deleteTenantHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "Forbidden")
			return
		}
		if p.Role != "owner" {
			httpx.Error(w, 403, "Owner only")
			return
		}
		var isDefault bool
		if err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT is_default FROM tenants WHERE id=?`), p.TenantID).Scan(&isDefault); err != nil {
			httpx.Error(w, 404, "Team not found")
			return
		}
		if isDefault {
			httpx.Error(w, 400, "The default team cannot be deleted")
			return
		}

		var next Tenant
		var nextSteps string
		err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT t.id,t.slug,t.name,t.is_default,t.onboarding_completed,t.onboarding_steps
			FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id
			WHERE m.user_id=? AND m.status='active' AND t.id<>? ORDER BY t.created_at LIMIT 1`), p.UserID, p.TenantID).
			Scan(&next.ID, &next.Slug, &next.Name, &next.IsDefault, &next.OnboardingCompleted, &nextSteps)
		if err != nil {
			httpx.Error(w, 400, "You must keep at least one team")
			return
		}
		next.OnboardingSteps = decodeObject(nextSteps)
		// Issue the replacement session before deleting the current tenant, just as
		// the TypeScript service does, so a successful response can immediately be
		// used by the preserved frontend.
		switched, err := s.SwitchTenant(r.Context(), p, next.ID, requestIP(r), r.UserAgent())
		if err != nil {
			httpx.Error(w, 500, "Could not switch teams")
			return
		}
		if s.deps.BeforeTenantDelete != nil {
			if err = s.deps.BeforeTenantDelete(r.Context(), p.TenantID); err != nil {
				httpx.Error(w, 503, "runtime tenant cleanup failed")
				return
			}
		}
		err = appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
			// These platform-scoped tables intentionally have no tenant foreign key.
			for _, query := range []string{
				`DELETE FROM connector_auth_profiles WHERE scope_key=?`,
				`DELETE FROM connector_settings WHERE scope_key=?`,
				`DELETE FROM skill_source_tokens WHERE scope_key=?`,
				`DELETE FROM platform_service_quotas WHERE scope_key=?`,
				`DELETE FROM settings WHERE owner_key=? OR owner_key=?`,
			} {
				args := []any{p.TenantID}
				if strings.Contains(query, "owner_key") {
					args = append(args, "tenant:"+p.TenantID)
				}
				if _, e := tx.ExecContext(r.Context(), s.q(query), args...); e != nil {
					return e
				}
			}
			res, e := tx.ExecContext(r.Context(), s.q(`DELETE FROM tenants WHERE id=? AND is_default=FALSE`), p.TenantID)
			if e != nil {
				return e
			}
			n, _ := res.RowsAffected()
			if n != 1 {
				return errors.New("tenant cannot be deleted")
			}
			return nil
		})
		if err != nil {
			httpx.Error(w, 409, "tenant cannot be deleted")
			return
		}
		httpx.JSON(w, 200, map[string]any{
			"ok":      true,
			"session": switched.Session,
			"team": map[string]any{
				"id": next.ID, "name": next.Name,
				"onboardingCompleted": next.OnboardingCompleted,
			},
		})
	}
}

func listMembersHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.Role != "owner" && p.Role != "admin" {
			httpx.Error(w, 403, "Admin only")
			return
		}
		rows, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT m.id,u.id,u.email,u.name,m.role,m.status,m.created_at FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? ORDER BY m.created_at`), p.TenantID)
		if err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var mid, uid, email, role, status, created string
			var name sql.NullString
			_ = rows.Scan(&mid, &uid, &email, &name, &role, &status, &created)
			out = append(out, map[string]any{
				"id": mid, "role": role, "status": status, "createdAt": created,
				"user": map[string]any{"id": uid, "email": email, "name": nullString(name)},
			})
		}
		httpx.JSON(w, 200, map[string]any{"members": out})
	}
}
func patchMemberHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.Role != "owner" && p.Role != "admin" {
			httpx.Error(w, 403, "Admin only")
			return
		}
		var b struct {
			Role string `json:"role"`
		}
		if httpx.DecodeJSON(r, &b) != nil || (b.Role != "owner" && b.Role != "admin" && b.Role != "member") {
			httpx.Error(w, 400, "role must be owner, admin or member")
			return
		}
		var result map[string]any
		err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
			var targetUserID, oldRole, status, created string
			if e := tx.QueryRowContext(r.Context(), s.q(`SELECT user_id,role,status,created_at FROM tenant_memberships WHERE id=? AND tenant_id=?`), httpx.Param(r, "id"), p.TenantID).Scan(&targetUserID, &oldRole, &status, &created); e != nil {
				return e
			}
			if p.Role != "owner" && (oldRole == "owner" || b.Role == "owner") {
				return errOwnerOnly
			}
			if oldRole == "owner" && status == "active" && b.Role != "owner" {
				var other int
				if e := tx.QueryRowContext(r.Context(), s.q(`SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active' AND id<>?`), p.TenantID, httpx.Param(r, "id")).Scan(&other); e != nil {
					return e
				}
				if other == 0 {
					return errLastOwner
				}
			}
			if _, e := tx.ExecContext(r.Context(), s.q(`UPDATE tenant_memberships SET role=?,updated_at=? WHERE id=? AND tenant_id=?`), b.Role, s.now(), httpx.Param(r, "id"), p.TenantID); e != nil {
				return e
			}
			result = map[string]any{"id": httpx.Param(r, "id"), "tenantId": p.TenantID, "userId": targetUserID, "role": b.Role, "status": status, "createdAt": created, "updatedAt": s.now()}
			return nil
		})
		if err != nil {
			switch {
			case errors.Is(err, sql.ErrNoRows):
				httpx.Error(w, 404, "Member not found")
			case errors.Is(err, errOwnerOnly):
				httpx.Error(w, 403, "Owner only")
			case errors.Is(err, errLastOwner):
				httpx.Error(w, 400, "Tenant must retain an active owner")
			default:
				httpx.Error(w, 500, "update failed")
			}
			return
		}
		httpx.JSON(w, 200, result)
	}
}
func deleteMemberHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.Role != "owner" && p.Role != "admin" {
			httpx.Error(w, 403, "Admin only")
			return
		}
		var removedUserID string
		err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
			var targetRole, targetStatus string
			if e := tx.QueryRowContext(r.Context(), s.q(`SELECT user_id,role,status FROM tenant_memberships WHERE id=? AND tenant_id=?`), httpx.Param(r, "id"), p.TenantID).Scan(&removedUserID, &targetRole, &targetStatus); e != nil {
				return e
			}
			if removedUserID == p.UserID {
				return errSelfRemove
			}
			if targetRole == "owner" {
				if p.Role != "owner" {
					return errOwnerOnly
				}
				if targetStatus == "active" {
					var other int
					if e := tx.QueryRowContext(r.Context(), s.q(`SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active' AND id<>?`), p.TenantID, httpx.Param(r, "id")).Scan(&other); e != nil {
						return e
					}
					if other == 0 {
						return errLastOwner
					}
				}
			}
			res, e := tx.ExecContext(r.Context(), s.q(`DELETE FROM tenant_memberships WHERE id=? AND tenant_id=?`), httpx.Param(r, "id"), p.TenantID)
			if e != nil {
				return e
			}
			n, _ := res.RowsAffected()
			if n != 1 {
				return sql.ErrNoRows
			}
			// Durable sessions are explicitly revoked in addition to the membership
			// check performed by auth middleware, closing already-issued access at once.
			_, e = tx.ExecContext(r.Context(), s.q(`UPDATE user_sessions SET revoked_at=? WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL`), s.now(), p.TenantID, removedUserID)
			return e
		})
		if err != nil {
			switch {
			case errors.Is(err, sql.ErrNoRows):
				httpx.Error(w, 404, "Member not found")
			case errors.Is(err, errSelfRemove):
				httpx.Error(w, 400, "Cannot remove yourself; leave the tenant instead")
			case errors.Is(err, errOwnerOnly):
				httpx.Error(w, 403, "Owner only")
			case errors.Is(err, errLastOwner):
				httpx.Error(w, 400, "Tenant must retain an active owner")
			default:
				httpx.Error(w, 500, "remove failed")
			}
			return
		}
		if s.deps.AfterMemberRemoved != nil {
			if err = s.deps.AfterMemberRemoved(r.Context(), p.TenantID, removedUserID); err != nil {
				httpx.Error(w, 503, "member removed but runtime cleanup failed")
				return
			}
		}
		httpx.JSON(w, 200, map[string]any{"ok": true})
	}
}
func leaveTenantHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "Forbidden")
			return
		}
		err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
			var membershipID, role string
			if e := tx.QueryRowContext(r.Context(), s.q(`SELECT id,role FROM tenant_memberships WHERE tenant_id=? AND user_id=? AND status='active'`), p.TenantID, p.UserID).Scan(&membershipID, &role); e != nil {
				return e
			}
			if role == "owner" {
				var other int
				if e := tx.QueryRowContext(r.Context(), s.q(`SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active' AND id<>?`), p.TenantID, membershipID).Scan(&other); e != nil {
					return e
				}
				if other == 0 {
					return errLastOwner
				}
			}
			if _, e := tx.ExecContext(r.Context(), s.q(`DELETE FROM tenant_memberships WHERE id=? AND tenant_id=?`), membershipID, p.TenantID); e != nil {
				return e
			}
			_, e := tx.ExecContext(r.Context(), s.q(`UPDATE user_sessions SET revoked_at=? WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL`), s.now(), p.TenantID, p.UserID)
			return e
		})
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				httpx.Error(w, 404, "Not a member")
			} else if errors.Is(err, errLastOwner) {
				httpx.Error(w, 400, "Owner cannot leave; transfer ownership first")
			} else {
				httpx.Error(w, 500, "leave failed")
			}
			return
		}
		if s.deps.AfterMemberRemoved != nil {
			if err = s.deps.AfterMemberRemoved(r.Context(), p.TenantID, p.UserID); err != nil {
				httpx.Error(w, 503, "membership removed but runtime cleanup failed")
				return
			}
		}
		httpx.JSON(w, 200, map[string]any{"ok": true})
	}
}

func listInvitesHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.Role != "owner" && p.Role != "admin" {
			httpx.Error(w, 403, "Admin only")
			return
		}
		rows, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT id,email,role,expires_at,accepted_at,created_at FROM tenant_invites WHERE tenant_id=? ORDER BY created_at DESC`), p.TenantID)
		if err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var id, email, role, expires, created string
			var accepted sql.NullString
			_ = rows.Scan(&id, &email, &role, &expires, &accepted, &created)
			out = append(out, map[string]any{"id": id, "email": email, "role": role, "expiresAt": expires, "acceptedAt": nullString(accepted), "createdAt": created})
		}
		httpx.JSON(w, 200, map[string]any{"invites": out})
	}
}
func createInviteHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.Role != "owner" && p.Role != "admin" {
			httpx.Error(w, 403, "Admin only")
			return
		}
		var b struct {
			Email string `json:"email"`
			Role  string `json:"role"`
		}
		if httpx.DecodeJSON(r, &b) != nil || !validEmail(strings.ToLower(strings.TrimSpace(b.Email))) {
			httpx.Error(w, 400, "valid email required")
			return
		}
		if b.Role == "" {
			b.Role = "member"
		}
		if b.Role != "admin" && b.Role != "member" {
			httpx.Error(w, 400, "invalid role")
			return
		}
		token, _ := randomToken(32)
		h := sha256.Sum256([]byte(token))
		id := s.deps.NewID()
		expires := s.deps.Clock().UTC().Add(7 * 24 * time.Hour).Format(time.RFC3339Nano)
		_, err := s.deps.DB.ExecContext(r.Context(), s.q(`INSERT INTO tenant_invites(id,tenant_id,email,role,token_hash,expires_at,invited_by,created_at) VALUES(?,?,?,?,?,?,?,?)`), id, p.TenantID, strings.ToLower(strings.TrimSpace(b.Email)), b.Role, hex.EncodeToString(h[:]), expires, p.UserID, s.now())
		if err != nil {
			httpx.Error(w, 409, "invite exists")
			return
		}
		acceptURL := s.deps.WebURL + "/invite/" + url.PathEscape(token)
		tenantName := "Team"
		_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT name FROM tenants WHERE id=?`), p.TenantID).Scan(&tenantName)
		emailed := false
		if s.deps.SendTransactionalEmail != nil {
			safeTeam, safeURL := html.EscapeString(tenantName), html.EscapeString(acceptURL)
			htmlBody := `<p>You were invited to join ` + safeTeam + ` in Zakura.</p><p><a href="` + safeURL + `">Accept invitation</a></p>`
			textBody := "You were invited to join " + tenantName + " in Zakura.\n\n" + acceptURL
			emailed = s.deps.SendTransactionalEmail(r.Context(), strings.ToLower(strings.TrimSpace(b.Email)), "邀请加入 "+tenantName, htmlBody, textBody) == nil
		}
		httpx.JSON(w, 201, map[string]any{"invite": map[string]any{"id": id, "email": b.Email, "role": b.Role, "expiresAt": expires}, "token": token, "acceptUrl": acceptURL, "emailed": emailed})
	}
}
func revokeInviteHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.Role != "owner" && p.Role != "admin" {
			httpx.Error(w, 403, "Admin only")
			return
		}
		res, _ := s.deps.DB.ExecContext(r.Context(), s.q(`DELETE FROM tenant_invites WHERE id=? AND tenant_id=? AND accepted_at IS NULL`), httpx.Param(r, "id"), p.TenantID)
		n, _ := res.RowsAffected()
		httpx.JSON(w, 200, map[string]any{"ok": n > 0})
	}
}
func inspectInviteHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := sha256.Sum256([]byte(httpx.Param(r, "token")))
		var id, email, role, tenantID, tenantName, tenantSlug, expires string
		err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT i.id,i.email,i.role,t.id,t.name,t.slug,i.expires_at FROM tenant_invites i JOIN tenants t ON t.id=i.tenant_id WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.expires_at>?`), hex.EncodeToString(h[:]), s.now()).Scan(&id, &email, &role, &tenantID, &tenantName, &tenantSlug, &expires)
		if err != nil {
			httpx.Error(w, 404, "invite not found or expired")
			return
		}
		httpx.JSON(w, 200, map[string]any{"email": email, "role": role, "expiresAt": expires, "tenant": map[string]any{"name": tenantName, "slug": tenantSlug}})
	}
}
func acceptInviteHandler(s *Service, deps *appdeps.Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email    string `json:"email"`
			Password string `json:"password"`
			Name     string `json:"name"`
		}
		_ = httpx.DecodeJSON(r, &body)
		h := sha256.Sum256([]byte(httpx.Param(r, "token")))
		var inviteID, tenantID, email, role string
		err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT id,tenant_id,email,role FROM tenant_invites WHERE token_hash=? AND accepted_at IS NULL AND expires_at>?`), hex.EncodeToString(h[:]), s.now()).Scan(&inviteID, &tenantID, &email, &role)
		if err != nil {
			httpx.Error(w, 404, "invite not found or expired")
			return
		}
		p, ok := httpx.PrincipalFrom(r.Context())
		if !ok {
			if !strings.EqualFold(strings.TrimSpace(body.Email), email) || len(body.Password) < 8 {
				httpx.Error(w, 400, "email and password required")
				return
			}
			var existing string
			if e := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT id FROM users WHERE email=?`), strings.ToLower(email)).Scan(&existing); e == nil {
				httpx.Error(w, 401, "existing account must sign in first")
				return
			}
			hash, _ := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
			uid := s.deps.NewID()
			name := strings.TrimSpace(body.Name)
			if name == "" {
				name = strings.Split(email, "@")[0]
			}
			if _, e := s.deps.DB.ExecContext(r.Context(), s.q(`INSERT INTO users(id,email,password_hash,name,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?)`), uid, strings.ToLower(email), string(hash), name, s.now(), s.now()); e != nil {
				httpx.Error(w, 409, "account creation failed")
				return
			}
			p = httpx.Principal{UserID: uid, Email: strings.ToLower(email), Role: role, TenantID: tenantID}
		} else if p.APIKey {
			httpx.Error(w, 403, "API keys cannot accept invites")
			return
		}
		if !strings.EqualFold(p.Email, email) {
			httpx.Error(w, 403, "invite email does not match signed-in user")
			return
		}
		err = appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
			_, e := tx.ExecContext(r.Context(), s.q(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at`), s.deps.NewID(), tenantID, p.UserID, role, s.now(), s.now())
			if e != nil {
				return e
			}
			res, e := tx.ExecContext(r.Context(), s.q(`UPDATE tenant_invites SET accepted_at=? WHERE id=? AND accepted_at IS NULL`), s.now(), inviteID)
			if e != nil {
				return e
			}
			n, _ := res.RowsAffected()
			if n != 1 {
				return errors.New("invite already accepted")
			}
			return nil
		})
		if err != nil {
			httpx.Error(w, 409, err.Error())
			return
		}
		res, err := s.SwitchTenant(r.Context(), p, tenantID, requestIP(r), r.UserAgent())
		if err != nil {
			httpx.Error(w, 500, "session issue failed")
			return
		}
		httpx.JSON(w, 200, map[string]any{"session": res.Session, "tenant": res.Tenant, "role": res.Role})
	}
}

func listPeopleHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "forbidden")
			return
		}
		rows, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT u.id,u.email,COALESCE(u.name,''),COALESCE(u.title,''),COALESCE(u.bio,''),u.avatar_updated_at,u.last_login_at,u.created_at,m.role,m.created_at FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.status='active' ORDER BY m.created_at`), p.TenantID)
		if err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		defer rows.Close()
		people := []map[string]any{}
		for rows.Next() {
			var id, email, name, title, bio, created, role, joined string
			var avatar, last sql.NullString
			_ = rows.Scan(&id, &email, &name, &title, &bio, &avatar, &last, &created, &role, &joined)
			avatarRev := int64(0)
			if avatar.Valid {
				if t, e := time.Parse(time.RFC3339Nano, avatar.String); e == nil {
					avatarRev = t.UnixMilli()
				}
			}
			people = append(people, map[string]any{"id": id, "email": email, "name": name, "title": title, "bio": bio, "avatarRev": avatarRev, "lastLoginAt": nullString(last), "createdAt": created, "role": role, "joinedAt": joined})
		}
		httpx.JSON(w, 200, map[string]any{"people": people})
	}
}
func getPersonHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		var id, email, name, title, bio, role, created, joined string
		var avatar, last sql.NullString
		err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT u.id,u.email,COALESCE(u.name,''),COALESCE(u.title,''),COALESCE(u.bio,''),m.role,u.avatar_updated_at,u.last_login_at,u.created_at,m.created_at FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE u.id=? AND m.tenant_id=? AND m.status='active'`), httpx.Param(r, "id"), p.TenantID).Scan(&id, &email, &name, &title, &bio, &role, &avatar, &last, &created, &joined)
		if err != nil {
			httpx.Error(w, 404, "not found")
			return
		}
		avatarRev := int64(0)
		if avatar.Valid {
			if t, e := time.Parse(time.RFC3339Nano, avatar.String); e == nil {
				avatarRev = t.UnixMilli()
			}
		}
		httpx.JSON(w, 200, map[string]any{"person": map[string]any{"id": id, "email": email, "name": name, "title": title, "bio": bio, "role": role, "avatarRev": avatarRev, "lastLoginAt": nullString(last), "createdAt": created, "joinedAt": joined}})
	}
}
func onboardingHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		_, t, err := s.Current(r.Context(), p)
		if err != nil {
			httpx.Error(w, 404, "not found")
			return
		}
		httpx.JSON(w, 200, map[string]any{"completed": t.OnboardingCompleted, "steps": t.OnboardingSteps})
	}
}
func patchOnboardingHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "Forbidden")
			return
		}
		var body struct {
			Steps    map[string]any `json:"steps"`
			Complete *bool          `json:"complete"`
		}
		if httpx.DecodeJSON(r, &body) != nil {
			httpx.Error(w, 400, "invalid request")
			return
		}
		var currentRaw string
		var completed bool
		if s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT onboarding_steps,onboarding_completed FROM tenants WHERE id=?`), p.TenantID).Scan(&currentRaw, &completed) != nil {
			httpx.Error(w, 404, "not found")
			return
		}
		steps := decodeObject(currentRaw)
		for k, v := range body.Steps {
			steps[k] = v
		}
		if body.Complete != nil {
			completed = *body.Complete
		}
		raw, _ := json.Marshal(steps)
		_, err := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE tenants SET onboarding_steps=?,onboarding_completed=?,updated_at=? WHERE id=?`), string(raw), completed, s.now(), p.TenantID)
		if err != nil {
			httpx.Error(w, 500, "update failed")
			return
		}
		httpx.JSON(w, 200, map[string]any{"completed": completed, "steps": steps})
	}
}
func completeOnboardingHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey {
			httpx.Error(w, 403, "Forbidden")
			return
		}
		_, err := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE tenants SET onboarding_completed=TRUE,updated_at=? WHERE id=?`), s.now(), p.TenantID)
		if err != nil {
			httpx.Error(w, 500, "update failed")
			return
		}
		var stepsRaw string
		_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT onboarding_steps FROM tenants WHERE id=?`), p.TenantID).Scan(&stepsRaw)
		httpx.JSON(w, 200, map[string]any{"completed": true, "steps": decodeObject(stepsRaw)})
	}
}

func forgotPasswordHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Email string `json:"email"`
		}
		if httpx.DecodeJSON(r, &b) != nil {
			httpx.Error(w, 400, "invalid request")
			return
		}
		var uid, passwordHash, email string
		if s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT id,COALESCE(password_hash,''),email FROM users WHERE email=? AND status='active'`), strings.ToLower(strings.TrimSpace(b.Email))).Scan(&uid, &passwordHash, &email) == nil && passwordHash != "" {
			token, _ := randomToken(32)
			h := sha256.Sum256([]byte(token))
			_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`INSERT INTO auth_tokens(id,user_id,kind,token_hash,expires_at,created_at) VALUES(?,?,'password_reset',?,?,?)`), s.deps.NewID(), uid, hex.EncodeToString(h[:]), s.deps.Clock().UTC().Add(time.Hour).Format(time.RFC3339Nano), s.now())
			if s.deps.SendTransactionalEmail != nil {
				resetURL := s.deps.WebURL + "/reset-password?token=" + url.QueryEscape(token)
				htmlBody := `<p>Reset your Zakura password:</p><p><a href="` + html.EscapeString(resetURL) + `">Reset password</a></p>`
				_ = s.deps.SendTransactionalEmail(r.Context(), email, "重置 Zakura 密码", htmlBody, "Reset your Zakura password:\n\n"+resetURL)
			}
		}
		httpx.JSON(w, 200, map[string]any{"sent": true})
	}
}

func (s *Service) sendVerificationEmail(ctx context.Context, userID, email string) (bool, error) {
	if s.deps.SendTransactionalEmail == nil {
		return false, nil
	}
	var verified sql.NullString
	if err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT email_verified_at FROM users WHERE id=? AND status='active'`), userID).Scan(&verified); err != nil {
		return false, err
	}
	if verified.Valid {
		return true, nil
	}
	token, err := randomToken(32)
	if err != nil {
		return false, err
	}
	digest := sha256.Sum256([]byte(token))
	if _, err = s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO auth_tokens(id,user_id,kind,token_hash,expires_at,created_at) VALUES(?,?,'email_verify',?,?,?)`), s.deps.NewID(), userID, hex.EncodeToString(digest[:]), s.deps.Clock().UTC().Add(24*time.Hour).Format(time.RFC3339Nano), s.now()); err != nil {
		return false, err
	}
	verifyURL := s.deps.WebURL + "/verify-email?token=" + url.QueryEscape(token)
	htmlBody := `<p>Verify your Zakura email:</p><p><a href="` + html.EscapeString(verifyURL) + `">Verify email</a></p>`
	if err = s.deps.SendTransactionalEmail(ctx, email, "验证你的 Zakura 邮箱", htmlBody, "Verify your Zakura email:\n\n"+verifyURL); err != nil {
		return false, err
	}
	return true, nil
}
func resetPasswordHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Token    string `json:"token"`
			Password string `json:"password"`
		}
		if httpx.DecodeJSON(r, &b) != nil || len(b.Password) < 10 {
			httpx.Error(w, 400, "invalid token or password")
			return
		}
		h := sha256.Sum256([]byte(b.Token))
		hash, _ := bcrypt.GenerateFromPassword([]byte(b.Password), passwordBcryptCost)
		err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
			var id, uid string
			if e := tx.QueryRowContext(r.Context(), s.q(`SELECT id,user_id FROM auth_tokens WHERE token_hash=? AND kind='password_reset' AND consumed_at IS NULL AND expires_at>?`), hex.EncodeToString(h[:]), s.now()).Scan(&id, &uid); e != nil {
				return errors.New("invalid or expired token")
			}
			res, e := tx.ExecContext(r.Context(), s.q(`UPDATE auth_tokens SET consumed_at=? WHERE id=? AND consumed_at IS NULL`), s.now(), id)
			if e != nil {
				return e
			}
			n, _ := res.RowsAffected()
			if n != 1 {
				return errors.New("token already used")
			}
			if _, e = tx.ExecContext(r.Context(), s.q(`UPDATE users SET password_hash=?,updated_at=? WHERE id=?`), string(hash), s.now(), uid); e != nil {
				return e
			}
			_, e = tx.ExecContext(r.Context(), s.q(`UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`), s.now(), uid)
			return e
		})
		if err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true})
	}
}
func verifyEmailTokenHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Token string `json:"token"`
		}
		if httpx.DecodeJSON(r, &b) != nil {
			httpx.Error(w, 400, "invalid request")
			return
		}
		h := sha256.Sum256([]byte(b.Token))
		var verifiedUserID string
		err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
			var id, uid string
			if e := tx.QueryRowContext(r.Context(), s.q(`SELECT id,user_id FROM auth_tokens WHERE token_hash=? AND kind='email_verify' AND consumed_at IS NULL AND expires_at>?`), hex.EncodeToString(h[:]), s.now()).Scan(&id, &uid); e != nil {
				return errors.New("invalid or expired token")
			}
			res, e := tx.ExecContext(r.Context(), s.q(`UPDATE auth_tokens SET consumed_at=? WHERE id=? AND consumed_at IS NULL`), s.now(), id)
			if e != nil {
				return e
			}
			n, _ := res.RowsAffected()
			if n != 1 {
				return errors.New("token already used")
			}
			verifiedUserID = uid
			_, e = tx.ExecContext(r.Context(), s.q(`UPDATE users SET email_verified_at=?,updated_at=? WHERE id=?`), s.now(), s.now(), uid)
			return e
		})
		if err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		var email string
		if verifiedUserID != "" && s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT email FROM users WHERE id=?`), verifiedUserID).Scan(&email) == nil {
			_ = s.maybeAutoJoinTenant(r.Context(), verifiedUserID, email)
		}
		httpx.JSON(w, 200, map[string]any{"ok": true})
	}
}

func requestIP(r *http.Request) string {
	for _, key := range []string{"CF-Connecting-IP", "X-Real-IP"} {
		if v := strings.TrimSpace(r.Header.Get(key)); v != "" {
			return v
		}
	}
	if v := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); v != "" {
		return v
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}
func nullString(v sql.NullString) any {
	if v.Valid {
		return v.String
	}
	return nil
}
func parseInt(v string, fallback int) int {
	n, e := strconv.Atoi(v)
	if e != nil {
		return fallback
	}
	return n
}

var _ = context.Canceled
