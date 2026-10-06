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

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
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
		setup := false
		version, mode := "go-rewrite", map[bool]string{true: "saas", false: "local"}[deps.MultiTenant]
		var meta models.PlatformMetum
		if s.gdb(r.Context()).Where("singleton = ?", 1).Take(&meta).Error == nil {
			setup, version, mode = meta.SetupCompleted, meta.Version, meta.Mode
		}
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
		var loginSetting models.Setting
		if s.gdb(r.Context()).Where("owner_key = ? AND key = ?", "platform", "auth.login").Take(&loginSetting).Error == nil {
			var policy struct {
				Highlighted string `json:"highlightedMethod"`
			}
			_ = json.Unmarshal([]byte(loginSetting.Value), &policy)
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
			var dbTenant models.Tenant
			err = s.gdb(r.Context()).Where("id = ?", p.TenantID).Take(&dbTenant).Error
			if err == nil {
				t.ID, t.Slug, t.Name, t.IsDefault, t.OnboardingCompleted = derefString(dbTenant.ID), dbTenant.Slug, dbTenant.Name, dbTenant.IsDefault, dbTenant.OnboardingCompleted
				t.OnboardingSteps = decodeObject(dbTenant.OnboardingSteps)
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
		var dbUser models.User
		if err := s.gdb(r.Context()).Select("name,title,bio").Where("id = ?", p.UserID).Take(&dbUser).Error; err != nil {
			httpx.Error(w, 404, "not found")
			return
		}
		name, title, bio := derefString(dbUser.Name), derefString(dbUser.Title), derefString(dbUser.Bio)
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
		err := s.gdb(r.Context()).Model(&models.User{}).Where("id = ?", p.UserID).Updates(map[string]any{"name": name, "title": title, "bio": bio, "updated_at": s.now()}).Error
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
		var dbUser models.User
		old := ""
		if err := s.gdb(r.Context()).Select("password_hash").Where("id = ?", p.UserID).Take(&dbUser).Error; err != nil {
			httpx.Error(w, 400, "current password is incorrect")
			return
		}
		old = derefString(dbUser.PasswordHash)
		if bcrypt.CompareHashAndPassword([]byte(old), []byte(b.Current)) != nil {
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
		var sessions []struct {
			ID         string `gorm:"column:id"`
			IP         string `gorm:"column:ip"`
			UserAgent  string `gorm:"column:user_agent"`
			LastSeenAt string `gorm:"column:last_seen_at"`
			CreatedAt  string `gorm:"column:created_at"`
			ExpiresAt  string `gorm:"column:expires_at"`
		}
		if err := s.gdb(r.Context()).Table("user_sessions").
			Select("id,COALESCE(ip,'') AS ip,COALESCE(user_agent,'') AS user_agent,COALESCE(last_seen_at,created_at) AS last_seen_at,created_at,expires_at").
			Where("user_id = ? AND revoked_at IS NULL", p.UserID).
			Order("created_at DESC").Find(&sessions).Error; err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		items := []map[string]any{}
		for _, session := range sessions {
			items = append(items, map[string]any{"id": session.ID, "ip": session.IP, "userAgent": session.UserAgent, "lastSeenAt": session.LastSeenAt, "createdAt": session.CreatedAt, "expiresAt": session.ExpiresAt, "current": session.ID == p.SessionID})
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
		res := s.gdb(r.Context()).Model(&models.UserSession{}).Where("id = ? AND user_id = ? AND revoked_at IS NULL", httpx.Param(r, "id"), p.UserID).Update("revoked_at", s.now())
		n := res.RowsAffected
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
		res := s.gdb(r.Context()).Model(&models.UserSession{}).Where("user_id = ? AND id <> ? AND revoked_at IS NULL", p.UserID, p.SessionID).Update("revoked_at", s.now())
		n := res.RowsAffected
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
		var rows []struct {
			MembershipID        string `gorm:"column:membership_id"`
			Role                string `gorm:"column:role"`
			Status              string `gorm:"column:status"`
			ID                  string `gorm:"column:id"`
			Slug                string `gorm:"column:slug"`
			Name                string `gorm:"column:name"`
			IsDefault           bool   `gorm:"column:is_default"`
			OnboardingCompleted bool   `gorm:"column:onboarding_completed"`
			OnboardingSteps     string `gorm:"column:onboarding_steps"`
		}
		if err := s.gdb(r.Context()).Table("tenants AS t").
			Select("m.id AS membership_id,m.role,m.status,t.id,t.slug,t.name,t.is_default,t.onboarding_completed,t.onboarding_steps").
			Joins("JOIN tenant_memberships m ON m.tenant_id = t.id").
			Where("m.user_id = ? AND m.status = 'active'", p.UserID).
			Order("t.created_at").Find(&rows).Error; err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		items := []map[string]any{}
		for _, row := range rows {
			items = append(items, map[string]any{"membershipId": row.MembershipID, "role": row.Role, "status": row.Status, "tenant": map[string]any{"id": row.ID, "slug": row.Slug, "name": row.Name, "isDefault": row.IsDefault, "onboardingCompleted": row.OnboardingCompleted, "onboardingSteps": decodeObject(row.OnboardingSteps)}})
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
		err := s.gdb(r.Context()).Model(&models.Tenant{}).Where("id = ?", p.TenantID).Updates(map[string]any{"name": strings.TrimSpace(*b.Name), "updated_at": s.now()}).Error
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
		var defaultTenant models.Tenant
		if err := s.gdb(r.Context()).Select("is_default").Where("id = ?", p.TenantID).Take(&defaultTenant).Error; err != nil {
			httpx.Error(w, 404, "Team not found")
			return
		}
		if defaultTenant.IsDefault {
			httpx.Error(w, 400, "The default team cannot be deleted")
			return
		}

		var next Tenant
		var nextRow struct {
			ID                  string `gorm:"column:id"`
			Slug                string `gorm:"column:slug"`
			Name                string `gorm:"column:name"`
			IsDefault           bool   `gorm:"column:is_default"`
			OnboardingCompleted bool   `gorm:"column:onboarding_completed"`
			OnboardingSteps     string `gorm:"column:onboarding_steps"`
		}
		err := s.gdb(r.Context()).Table("tenants AS t").
			Select("t.id,t.slug,t.name,t.is_default,t.onboarding_completed,t.onboarding_steps").
			Joins("JOIN tenant_memberships m ON m.tenant_id = t.id").
			Where("m.user_id = ? AND m.status = 'active' AND t.id <> ?", p.UserID, p.TenantID).
			Order("t.created_at").Take(&nextRow).Error
		if err != nil {
			httpx.Error(w, 400, "You must keep at least one team")
			return
		}
		next = Tenant{ID: nextRow.ID, Slug: nextRow.Slug, Name: nextRow.Name, IsDefault: nextRow.IsDefault, OnboardingCompleted: nextRow.OnboardingCompleted}
		next.OnboardingSteps = decodeObject(nextRow.OnboardingSteps)
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
		var rows []struct {
			ID        string  `gorm:"column:id"`
			UserID    string  `gorm:"column:user_id"`
			Email     string  `gorm:"column:email"`
			Name      *string `gorm:"column:name"`
			Role      string  `gorm:"column:role"`
			Status    string  `gorm:"column:status"`
			CreatedAt string  `gorm:"column:created_at"`
		}
		if err := s.gdb(r.Context()).Table("tenant_memberships AS m").
			Select("m.id AS id,u.id AS user_id,u.email,u.name,m.role,m.status,m.created_at").
			Joins("JOIN users u ON u.id = m.user_id").
			Where("m.tenant_id = ?", p.TenantID).
			Order("m.created_at").Find(&rows).Error; err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		out := []map[string]any{}
		for _, row := range rows {
			out = append(out, map[string]any{
				"id": row.ID, "role": row.Role, "status": row.Status, "createdAt": row.CreatedAt,
				"user": map[string]any{"id": row.UserID, "email": row.Email, "name": nullableString(row.Name)},
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
		var invites []models.TenantInvite
		if err := s.gdb(r.Context()).Where("tenant_id = ?", p.TenantID).Order("created_at DESC").Find(&invites).Error; err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		out := []map[string]any{}
		for _, invite := range invites {
			out = append(out, map[string]any{"id": derefString(invite.ID), "email": invite.Email, "role": invite.Role, "expiresAt": invite.ExpiresAt, "acceptedAt": nullableString(invite.AcceptedAt), "createdAt": invite.CreatedAt})
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
		invitedBy := p.UserID
		err := s.gdb(r.Context()).Create(&models.TenantInvite{ID: &id, TenantID: p.TenantID, Email: strings.ToLower(strings.TrimSpace(b.Email)), Role: b.Role, TokenHash: hex.EncodeToString(h[:]), ExpiresAt: expires, InvitedBy: &invitedBy, CreatedAt: s.now()}).Error
		if err != nil {
			httpx.Error(w, 409, "invite exists")
			return
		}
		acceptURL := s.deps.WebURL + "/invite/" + url.PathEscape(token)
		tenantName := "Team"
		var tenantRow models.Tenant
		if s.gdb(r.Context()).Select("name").Where("id = ?", p.TenantID).Take(&tenantRow).Error == nil {
			tenantName = tenantRow.Name
		}
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
		res := s.gdb(r.Context()).Where("id = ? AND tenant_id = ? AND accepted_at IS NULL", httpx.Param(r, "id"), p.TenantID).Delete(&models.TenantInvite{})
		n := res.RowsAffected
		httpx.JSON(w, 200, map[string]any{"ok": n > 0})
	}
}
func inspectInviteHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := sha256.Sum256([]byte(httpx.Param(r, "token")))
		var row struct {
			Email      string `gorm:"column:email"`
			Role       string `gorm:"column:role"`
			TenantName string `gorm:"column:tenant_name"`
			TenantSlug string `gorm:"column:tenant_slug"`
			ExpiresAt  string `gorm:"column:expires_at"`
		}
		err := s.gdb(r.Context()).Table("tenant_invites AS i").
			Select("i.email,i.role,t.name AS tenant_name,t.slug AS tenant_slug,i.expires_at").
			Joins("JOIN tenants t ON t.id = i.tenant_id").
			Where("i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?", hex.EncodeToString(h[:]), s.now()).
			Take(&row).Error
		if err != nil {
			httpx.Error(w, 404, "invite not found or expired")
			return
		}
		httpx.JSON(w, 200, map[string]any{"email": row.Email, "role": row.Role, "expiresAt": row.ExpiresAt, "tenant": map[string]any{"name": row.TenantName, "slug": row.TenantSlug}})
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
		var invite models.TenantInvite
		err := s.gdb(r.Context()).Where("token_hash = ? AND accepted_at IS NULL AND expires_at > ?", hex.EncodeToString(h[:]), s.now()).Take(&invite).Error
		if err != nil {
			httpx.Error(w, 404, "invite not found or expired")
			return
		}
		inviteID, tenantID, email, role := derefString(invite.ID), invite.TenantID, invite.Email, invite.Role
		p, ok := httpx.PrincipalFrom(r.Context())
		if !ok {
			if !strings.EqualFold(strings.TrimSpace(body.Email), email) || len(body.Password) < 8 {
				httpx.Error(w, 400, "email and password required")
				return
			}
			var existing models.User
			if e := s.gdb(r.Context()).Select("id").Where("email = ?", strings.ToLower(email)).Take(&existing).Error; e == nil {
				httpx.Error(w, 401, "existing account must sign in first")
				return
			}
			hash, _ := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
			uid := s.deps.NewID()
			name := strings.TrimSpace(body.Name)
			if name == "" {
				name = strings.Split(email, "@")[0]
			}
			hashValue := string(hash)
			now := s.now()
			if e := s.gdb(r.Context()).Create(&models.User{ID: &uid, Email: strings.ToLower(email), PasswordHash: &hashValue, Name: &name, Status: "active", CreatedAt: now, UpdatedAt: now}).Error; e != nil {
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
		var rows []struct {
			ID        string  `gorm:"column:id"`
			Email     string  `gorm:"column:email"`
			Name      string  `gorm:"column:name"`
			Title     string  `gorm:"column:title"`
			Bio       string  `gorm:"column:bio"`
			Avatar    *string `gorm:"column:avatar_updated_at"`
			Last      *string `gorm:"column:last_login_at"`
			CreatedAt string  `gorm:"column:created_at"`
			Role      string  `gorm:"column:role"`
			JoinedAt  string  `gorm:"column:joined_at"`
		}
		if err := s.gdb(r.Context()).Table("tenant_memberships AS m").
			Select("u.id,u.email,COALESCE(u.name,'') AS name,COALESCE(u.title,'') AS title,COALESCE(u.bio,'') AS bio,u.avatar_updated_at,u.last_login_at,u.created_at,m.role,m.created_at AS joined_at").
			Joins("JOIN users u ON u.id = m.user_id").
			Where("m.tenant_id = ? AND m.status = 'active'", p.TenantID).
			Order("m.created_at").Find(&rows).Error; err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		people := []map[string]any{}
		for _, row := range rows {
			avatarRev := int64(0)
			if row.Avatar != nil {
				if t, e := time.Parse(time.RFC3339Nano, *row.Avatar); e == nil {
					avatarRev = t.UnixMilli()
				}
			}
			people = append(people, map[string]any{"id": row.ID, "email": row.Email, "name": row.Name, "title": row.Title, "bio": row.Bio, "avatarRev": avatarRev, "lastLoginAt": nullableString(row.Last), "createdAt": row.CreatedAt, "role": row.Role, "joinedAt": row.JoinedAt})
		}
		httpx.JSON(w, 200, map[string]any{"people": people})
	}
}
func getPersonHandler(s *Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		var row struct {
			ID        string  `gorm:"column:id"`
			Email     string  `gorm:"column:email"`
			Name      string  `gorm:"column:name"`
			Title     string  `gorm:"column:title"`
			Bio       string  `gorm:"column:bio"`
			Role      string  `gorm:"column:role"`
			Avatar    *string `gorm:"column:avatar_updated_at"`
			Last      *string `gorm:"column:last_login_at"`
			CreatedAt string  `gorm:"column:created_at"`
			JoinedAt  string  `gorm:"column:joined_at"`
		}
		err := s.gdb(r.Context()).Table("users AS u").
			Select("u.id,u.email,COALESCE(u.name,'') AS name,COALESCE(u.title,'') AS title,COALESCE(u.bio,'') AS bio,m.role,u.avatar_updated_at,u.last_login_at,u.created_at,m.created_at AS joined_at").
			Joins("JOIN tenant_memberships m ON m.user_id = u.id").
			Where("u.id = ? AND m.tenant_id = ? AND m.status = 'active'", httpx.Param(r, "id"), p.TenantID).
			Take(&row).Error
		if err != nil {
			httpx.Error(w, 404, "not found")
			return
		}
		avatarRev := int64(0)
		if row.Avatar != nil {
			if t, e := time.Parse(time.RFC3339Nano, *row.Avatar); e == nil {
				avatarRev = t.UnixMilli()
			}
		}
		httpx.JSON(w, 200, map[string]any{"person": map[string]any{"id": row.ID, "email": row.Email, "name": row.Name, "title": row.Title, "bio": row.Bio, "role": row.Role, "avatarRev": avatarRev, "lastLoginAt": nullableString(row.Last), "createdAt": row.CreatedAt, "joinedAt": row.JoinedAt}})
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
		var dbTenant models.Tenant
		if err := s.gdb(r.Context()).Select("onboarding_steps,onboarding_completed").Where("id = ?", p.TenantID).Take(&dbTenant).Error; err != nil {
			httpx.Error(w, 404, "not found")
			return
		}
		completed := dbTenant.OnboardingCompleted
		steps := decodeObject(dbTenant.OnboardingSteps)
		for k, v := range body.Steps {
			steps[k] = v
		}
		if body.Complete != nil {
			completed = *body.Complete
		}
		raw, _ := json.Marshal(steps)
		err := s.gdb(r.Context()).Model(&models.Tenant{}).Where("id = ?", p.TenantID).Updates(map[string]any{"onboarding_steps": string(raw), "onboarding_completed": completed, "updated_at": s.now()}).Error
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
		err := s.gdb(r.Context()).Model(&models.Tenant{}).Where("id = ?", p.TenantID).Updates(map[string]any{"onboarding_completed": true, "updated_at": s.now()}).Error
		if err != nil {
			httpx.Error(w, 500, "update failed")
			return
		}
		var stepsTenant models.Tenant
		_ = s.gdb(r.Context()).Select("onboarding_steps").Where("id = ?", p.TenantID).Take(&stepsTenant).Error
		httpx.JSON(w, 200, map[string]any{"completed": true, "steps": decodeObject(stepsTenant.OnboardingSteps)})
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
		var dbUser models.User
		if s.gdb(r.Context()).Where("email = ? AND status = 'active'", strings.ToLower(strings.TrimSpace(b.Email))).Take(&dbUser).Error == nil && derefString(dbUser.PasswordHash) != "" {
			userID, email := derefString(dbUser.ID), dbUser.Email
			token, _ := randomToken(32)
			h := sha256.Sum256([]byte(token))
			tokenID := s.deps.NewID()
			_ = s.gdb(r.Context()).Create(&models.AuthToken{ID: &tokenID, UserID: &userID, Kind: "password_reset", TokenHash: hex.EncodeToString(h[:]), ExpiresAt: s.deps.Clock().UTC().Add(time.Hour).Format(time.RFC3339Nano), CreatedAt: s.now()}).Error
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
	var account models.User
	if err := s.gdb(ctx).Select("email_verified_at").Where("id = ? AND status = 'active'", userID).Take(&account).Error; err != nil {
		return false, err
	}
	if account.EmailVerifiedAt != nil {
		return true, nil
	}
	token, err := randomToken(32)
	if err != nil {
		return false, err
	}
	digest := sha256.Sum256([]byte(token))
	tokenID := s.deps.NewID()
	uid := userID
	if err = s.gdb(ctx).Create(&models.AuthToken{ID: &tokenID, UserID: &uid, Kind: "email_verify", TokenHash: hex.EncodeToString(digest[:]), ExpiresAt: s.deps.Clock().UTC().Add(24 * time.Hour).Format(time.RFC3339Nano), CreatedAt: s.now()}).Error; err != nil {
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
		if verifiedUserID != "" {
			var account models.User
			if s.gdb(r.Context()).Select("email").Where("id = ?", verifiedUserID).Take(&account).Error == nil {
				_ = s.maybeAutoJoinTenant(r.Context(), verifiedUserID, account.Email)
			}
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
func nullableString(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}
func nullableNullString(v *string) sql.NullString {
	if v == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *v, Valid: true}
}
func parseInt(v string, fallback int) int {
	n, e := strconv.Atoi(v)
	if e != nil {
		return fallback
	}
	return n
}

var _ = context.Canceled
