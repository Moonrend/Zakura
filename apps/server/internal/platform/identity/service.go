package identity

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

type Service struct {
	deps         *appdeps.Dependencies
	oauthKeyOnce sync.Once
	oauthKey     *oauthSigningKey
	oauthKeyErr  error
	cimdMu       sync.Mutex
	cimdCache    map[string]cimdCacheEntry
}

const passwordBcryptCost = 12

func New(deps *appdeps.Dependencies) *Service {
	return &Service{deps: deps, cimdCache: map[string]cimdCacheEntry{}}
}

type LoginResult struct {
	Session string `json:"session"`
	User    User   `json:"user"`
	Tenant  Tenant `json:"tenant"`
	Role    string `json:"role"`
}

type MFARequiredError struct {
	Enrollment bool
	Ticket     string
	Methods    []string
}

func (e *MFARequiredError) Error() string {
	if e.Enrollment {
		return "mfa enrollment required"
	}
	return "mfa required"
}

type User struct {
	ID                string `json:"id"`
	Email             string `json:"email"`
	Name              string `json:"name,omitempty"`
	IsPlatformAdmin   bool   `json:"isPlatformAdmin"`
	EmailVerified     bool   `json:"emailVerified,omitempty"`
	Title             string `json:"title,omitempty"`
	Bio               string `json:"bio,omitempty"`
	HasPassword       bool   `json:"hasPassword,omitempty"`
	TotpEnabled       bool   `json:"totpEnabled,omitempty"`
	CanUseLocalRunner bool   `json:"canUseLocalRunner"`
	AvatarRev         int64  `json:"avatarRev"`
}
type Tenant struct {
	ID                  string         `json:"id"`
	Slug                string         `json:"slug"`
	Name                string         `json:"name"`
	IsDefault           bool           `json:"isDefault,omitempty"`
	OnboardingCompleted bool           `json:"onboardingCompleted"`
	OnboardingSteps     map[string]any `json:"onboardingSteps,omitempty"`
}

func (s *Service) Setup(ctx context.Context, email, password, name, tenantName, ip, ua string) (LoginResult, error) {
	var count int64
	if err := s.gdb(ctx).Model(&models.PlatformMetum{}).Where("singleton = ? AND setup_completed = ?", 1, true).Count(&count).Error; err != nil {
		return LoginResult{}, err
	}
	if count > 0 {
		return LoginResult{}, errors.New("setup already completed")
	}
	if tenantName == "" {
		tenantName = "Zakura"
	}
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	return s.createAccount(ctx, email, password, name, tenantName, true, true, ip, ua)
}

func (s *Service) Register(ctx context.Context, email, password, name, tenantName, ip, ua string) (LoginResult, error) {
	if s.deps.Edition != "saas" {
		return LoginResult{}, errors.New("registration disabled")
	}
	if tenantName == "" {
		tenantName = "My Workspace"
	}
	return s.createAccount(ctx, email, password, name, tenantName, false, false, ip, ua)
}

func (s *Service) createAccount(ctx context.Context, email, password, name, tenantName string, platformAdmin, isDefault bool, ip, ua string) (LoginResult, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !validEmail(email) {
		return LoginResult{}, errors.New("invalid email")
	}
	if len(password) < 10 {
		return LoginResult{}, errors.New("password must contain at least 10 characters")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), passwordBcryptCost)
	if err != nil {
		return LoginResult{}, err
	}
	now := s.now()
	uid, tid, mid := s.deps.NewID(), s.deps.NewID(), s.deps.NewID()
	slug := slugify(tenantName)
	if slug == "" {
		slug = "workspace"
	}
	slug = slug + "-" + strings.ToLower(tid[:6])
	err = appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
		if platformAdmin {
			if _, e := tx.ExecContext(ctx, s.q(`INSERT INTO platform_meta(singleton,setup_completed,version,mode,settings_json,created_at,updated_at) VALUES(1,FALSE,'go-rewrite',?,'{}',?,?) ON CONFLICT(singleton) DO NOTHING`), map[bool]string{true: "saas", false: "local"}[s.deps.MultiTenant], now, now); e != nil {
				return e
			}
			claim, e := tx.ExecContext(ctx, s.q(`UPDATE platform_meta SET setup_completed=TRUE,version='go-rewrite',mode=?,updated_at=? WHERE singleton=1 AND setup_completed=FALSE`), map[bool]string{true: "saas", false: "local"}[s.deps.MultiTenant], now)
			if e != nil {
				return e
			}
			claimed, _ := claim.RowsAffected()
			if claimed != 1 {
				return errors.New("setup already completed")
			}
		}
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO users(id,email,password_hash,name,is_platform_admin,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)`), uid, email, string(hash), strings.TrimSpace(name), boolInt(platformAdmin), now, now); err != nil {
			return classifyUnique(err, "email already registered")
		}
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO tenants(id,slug,name,is_default,onboarding_completed,onboarding_steps,created_at,updated_at) VALUES(?,?,?,?,FALSE,'{}',?,?)`), tid, slug, tenantName, boolInt(isDefault), now, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'owner','active',?,?)`), mid, tid, uid, now, now); err != nil {
			return err
		}
		return s.appendAuditTx(ctx, tx, tid, "auth.register", uid, "user", uid, map[string]any{"email": email})
	})
	if err != nil {
		return LoginResult{}, err
	}
	u := User{ID: uid, Email: email, Name: name, IsPlatformAdmin: platformAdmin, HasPassword: true}
	t := Tenant{ID: tid, Slug: slug, Name: tenantName, IsDefault: isDefault, OnboardingSteps: map[string]any{}}
	token, err := s.issueSession(ctx, u, t, "owner", ip, ua)
	if err != nil {
		return LoginResult{}, err
	}
	return LoginResult{Session: token, User: u, Tenant: t, Role: "owner"}, nil
}

func (s *Service) Login(ctx context.Context, email, password, tenantSlug, ip, ua string) (LoginResult, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	var u User
	var dbUser models.User
	if err := s.gdb(ctx).Where("email = ?", email).Take(&dbUser).Error; err != nil {
		return LoginResult{}, errors.New("invalid credentials")
	}
	passwordHash := ""
	if dbUser.PasswordHash != nil {
		passwordHash = *dbUser.PasswordHash
	}
	if dbUser.Status != "active" || bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password)) != nil {
		return LoginResult{}, errors.New("invalid credentials")
	}
	u.ID, u.Email, u.IsPlatformAdmin = derefString(dbUser.ID), dbUser.Email, dbUser.IsPlatformAdmin
	if dbUser.Name != nil {
		u.Name = *dbUser.Name
	}
	u.EmailVerified = dbUser.EmailVerifiedAt != nil
	if u.EmailVerified {
		_ = s.maybeAutoJoinTenant(ctx, u.ID, u.Email)
	}
	tenantQuery := s.gdb(ctx).Table("tenants AS t").
		Select("t.id,t.slug,t.name,t.is_default,t.onboarding_completed,m.role").
		Joins("JOIN tenant_memberships m ON m.tenant_id = t.id").
		Where("m.user_id = ? AND m.status = 'active' AND t.status = 'active'", u.ID)
	if tenantSlug != "" {
		tenantQuery = tenantQuery.Where("t.slug = ?", tenantSlug)
	}
	var membershipRow struct {
		ID                  string `gorm:"column:id"`
		Slug                string `gorm:"column:slug"`
		Name                string `gorm:"column:name"`
		IsDefault           bool   `gorm:"column:is_default"`
		OnboardingCompleted bool   `gorm:"column:onboarding_completed"`
		Role                string `gorm:"column:role"`
	}
	err := tenantQuery.Order("t.is_default DESC, m.created_at ASC").Take(&membershipRow).Error
	if err != nil {
		return LoginResult{}, errors.New("no active tenant membership")
	}
	t := Tenant{ID: membershipRow.ID, Slug: membershipRow.Slug, Name: membershipRow.Name, IsDefault: membershipRow.IsDefault, OnboardingCompleted: membershipRow.OnboardingCompleted}
	role := membershipRow.Role
	var totpUser models.User
	var policyTenant models.Tenant
	_ = s.gdb(ctx).Select("totp_enabled_at").Where("id = ?", u.ID).Take(&totpUser).Error
	_ = s.gdb(ctx).Select("mfa_policy").Where("id = ?", t.ID).Take(&policyTenant).Error
	totpEnabled := totpUser.TotpEnabledAt
	policy := policyTenant.MfaPolicy
	if totpEnabled != nil {
		ticket, tokenErr := s.issueAuthToken(ctx, "mfa_login", u.ID, map[string]any{"tenantId": t.ID, "role": role})
		if tokenErr != nil {
			return LoginResult{}, tokenErr
		}
		return LoginResult{}, &MFARequiredError{Ticket: ticket, Methods: []string{"totp", "recovery"}}
	}
	if policy == "all" || (policy == "admins" && (role == "owner" || role == "admin")) {
		ticket, tokenErr := s.issueAuthToken(ctx, "mfa_enrollment", u.ID, map[string]any{"tenantId": t.ID, "role": role})
		if tokenErr != nil {
			return LoginResult{}, tokenErr
		}
		return LoginResult{}, &MFARequiredError{Enrollment: true, Ticket: ticket, Methods: []string{"totp"}}
	}
	token, err := s.issueSession(ctx, u, t, role, ip, ua)
	if err != nil {
		return LoginResult{}, err
	}
	now := s.now()
	_ = s.gdb(ctx).Model(&models.User{}).Where("id = ?", u.ID).Updates(map[string]any{"last_login_at": now, "updated_at": now}).Error
	_ = s.Audit(ctx, t.ID, "auth.login", u.ID, "user", u.ID, map[string]any{"method": "password", "ip": ip})
	s.recordLoginUsage(ctx, t.ID, u.ID, "password")
	return LoginResult{Session: token, User: u, Tenant: t, Role: role}, nil
}

func (s *Service) recordLoginUsage(ctx context.Context, tenantID, userID, method string) {
	if s.deps.RecordUsage != nil {
		_ = s.deps.RecordUsage(ctx, appdeps.UsageRecord{TenantID: tenantID, UserID: userID, Category: "auth", Action: "login", Summary: method})
	}
}

func (s *Service) maybeAutoJoinTenant(ctx context.Context, userID, email string) error {
	parts := strings.SplitN(strings.ToLower(strings.TrimSpace(email)), "@", 2)
	if len(parts) != 2 {
		return nil
	}
	var row struct {
		TenantID string `gorm:"column:tenant_id"`
	}
	err := s.gdb(ctx).Table("tenant_domains AS d").
		Select("d.tenant_id AS tenant_id").
		Joins("JOIN tenants t ON t.id = d.tenant_id").
		Where("d.domain = ? AND d.verified_at IS NOT NULL AND d.join_mode = 'auto_join' AND t.status = 'active'", parts[1]).
		Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	tenantID := row.TenantID
	now := s.now()
	err = s.gdb(ctx).Exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'member','active',?,?) ON CONFLICT(tenant_id,user_id) DO NOTHING`, s.deps.NewID(), tenantID, userID, now, now).Error
	return err
}

func (s *Service) issueAuthToken(ctx context.Context, kind, userID string, meta map[string]any) (string, error) {
	raw := "zat_" + mustToken(32)
	h := sha256.Sum256([]byte(raw))
	id := s.deps.NewID()
	uid := userID
	err := s.gdb(ctx).Create(&models.AuthToken{ID: &id, UserID: &uid, Kind: kind, TokenHash: hex.EncodeToString(h[:]), MetaJSON: encodeJSON(meta), ExpiresAt: s.deps.Clock().UTC().Add(10 * time.Minute).Format(time.RFC3339Nano), CreatedAt: s.now()}).Error
	return raw, err
}

func (s *Service) issueSession(ctx context.Context, u User, t Tenant, role, ip, ua string) (string, error) {
	sid := s.deps.NewID()
	now := s.deps.Clock().UTC()
	exp := now.Add(30 * 24 * time.Hour)
	claims := jwt.MapClaims{"sub": u.ID, "tenantId": t.ID, "email": u.Email, "role": role, "sid": sid, "isPlatformAdmin": u.IsPlatformAdmin, "iat": now.Unix(), "exp": exp.Unix()}
	raw, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.deps.Secret)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256([]byte(raw))
	ipValue, uaValue := ip, ua
	err = s.gdb(ctx).Create(&models.UserSession{ID: &sid, UserID: u.ID, TenantID: t.ID, Email: u.Email, Role: role, IsPlatformAdmin: u.IsPlatformAdmin, TokenHash: hex.EncodeToString(hash[:]), IP: &ipValue, UserAgent: &uaValue, ExpiresAt: exp.Format(time.RFC3339Nano), LastSeenAt: now.Format(time.RFC3339Nano), CreatedAt: now.Format(time.RFC3339Nano)}).Error
	return raw, err
}

func (s *Service) SwitchTenant(ctx context.Context, p httpx.Principal, tenantID, ip, ua string) (LoginResult, error) {
	var membershipRow struct {
		ID                  string `gorm:"column:id"`
		Slug                string `gorm:"column:slug"`
		Name                string `gorm:"column:name"`
		IsDefault           bool   `gorm:"column:is_default"`
		OnboardingCompleted bool   `gorm:"column:onboarding_completed"`
		Role                string `gorm:"column:role"`
	}
	err := s.gdb(ctx).Table("tenants AS t").
		Select("t.id,t.slug,t.name,t.is_default,t.onboarding_completed,m.role").
		Joins("JOIN tenant_memberships m ON m.tenant_id = t.id").
		Where("t.id = ? AND m.user_id = ? AND m.status = 'active' AND t.status = 'active'", tenantID, p.UserID).
		Take(&membershipRow).Error
	if err != nil {
		return LoginResult{}, errors.New("not a member of this tenant")
	}
	t := Tenant{ID: membershipRow.ID, Slug: membershipRow.Slug, Name: membershipRow.Name, IsDefault: membershipRow.IsDefault, OnboardingCompleted: membershipRow.OnboardingCompleted}
	role := membershipRow.Role
	var u User
	var dbUser models.User
	err = s.gdb(ctx).Where("id = ? AND status = 'active'", p.UserID).Take(&dbUser).Error
	if err != nil {
		return LoginResult{}, err
	}
	u.ID, u.Email, u.IsPlatformAdmin = derefString(dbUser.ID), dbUser.Email, dbUser.IsPlatformAdmin
	if dbUser.Name != nil {
		u.Name = *dbUser.Name
	}
	token, err := s.issueSession(ctx, u, t, role, ip, ua)
	return LoginResult{Session: token, User: u, Tenant: t, Role: role}, err
}

func (s *Service) CreateTenant(ctx context.Context, p httpx.Principal, name, requestedSlug, ip, ua string) (LoginResult, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return LoginResult{}, errors.New("name required")
	}
	slug := slugify(requestedSlug)
	if slug == "" {
		slug = slugify(name)
	}
	if slug == "" {
		return LoginResult{}, errors.New("invalid slug")
	}
	t := Tenant{ID: s.deps.NewID(), Slug: slug, Name: name, OnboardingSteps: map[string]any{}}
	now := s.now()
	err := appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, s.q(`INSERT INTO tenants(id,slug,name,onboarding_steps,created_at,updated_at) VALUES(?,?,?,'{}',?,?)`), t.ID, t.Slug, t.Name, now, now); e != nil {
			return classifyUnique(e, "slug already exists")
		}
		_, e := tx.ExecContext(ctx, s.q(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'owner','active',?,?)`), s.deps.NewID(), t.ID, p.UserID, now, now)
		return e
	})
	if err != nil {
		return LoginResult{}, err
	}
	u := User{ID: p.UserID, Email: p.Email, IsPlatformAdmin: p.IsPlatformAdmin}
	token, err := s.issueSession(ctx, u, t, "owner", ip, ua)
	return LoginResult{Session: token, User: u, Tenant: t, Role: "owner"}, err
}

func (s *Service) Current(ctx context.Context, p httpx.Principal) (User, Tenant, error) {
	var u User
	var dbUser models.User
	err := s.gdb(ctx).Where("id = ?", p.UserID).Take(&dbUser).Error
	if err != nil {
		return u, Tenant{}, err
	}
	u.ID, u.Email, u.IsPlatformAdmin, u.CanUseLocalRunner = derefString(dbUser.ID), dbUser.Email, dbUser.IsPlatformAdmin, dbUser.CanUseLocalRunner
	u.Name, u.Title, u.Bio = derefString(dbUser.Name), derefString(dbUser.Title), derefString(dbUser.Bio)
	u.HasPassword = dbUser.PasswordHash != nil && *dbUser.PasswordHash != ""
	u.EmailVerified = dbUser.EmailVerifiedAt != nil
	u.TotpEnabled = dbUser.TotpEnabledAt != nil
	u.CanUseLocalRunner = u.CanUseLocalRunner || u.IsPlatformAdmin || !s.deps.MultiTenant
	if dbUser.AvatarUpdatedAt != nil {
		if parsed, parseErr := time.Parse(time.RFC3339Nano, *dbUser.AvatarUpdatedAt); parseErr == nil {
			u.AvatarRev = parsed.UnixMilli()
		}
	}
	var t Tenant
	var dbTenant models.Tenant
	err = s.gdb(ctx).Where("id = ?", p.TenantID).Take(&dbTenant).Error
	if err == nil {
		t.ID, t.Slug, t.Name, t.IsDefault, t.OnboardingCompleted = derefString(dbTenant.ID), dbTenant.Slug, dbTenant.Name, dbTenant.IsDefault, dbTenant.OnboardingCompleted
		t.OnboardingSteps = decodeObject(dbTenant.OnboardingSteps)
	}
	return u, t, err
}

func (s *Service) Audit(ctx context.Context, tenantID, action, actorID, targetType, targetID string, detail map[string]any) error {
	return appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
		return s.appendAuditTx(ctx, tx, tenantID, action, actorID, targetType, targetID, detail)
	})
}

func (s *Service) passwordLoginBlockedBySSO(ctx context.Context, email string) bool {
	parts := strings.SplitN(strings.ToLower(strings.TrimSpace(email)), "@", 2)
	if len(parts) != 2 {
		return false
	}
	var required bool
	err := s.gdb(ctx).Raw(`SELECT (c.enforce_sso OR d.join_mode='sso_required') FROM tenant_domains d JOIN tenants t ON t.id=d.tenant_id JOIN tenant_sso_configs c ON c.tenant_id=t.id WHERE d.domain=? AND d.verified_at IS NOT NULL AND t.status='active' AND c.enabled=TRUE ORDER BY c.enforce_sso DESC LIMIT 1`, parts[1]).Scan(&required).Error
	return err == nil && required
}

func (s *Service) registrationBlockedBySSO(ctx context.Context, email string) bool {
	parts := strings.SplitN(strings.ToLower(strings.TrimSpace(email)), "@", 2)
	if len(parts) != 2 {
		return false
	}
	var count int64
	err := s.gdb(ctx).Table("tenant_domains AS d").
		Joins("JOIN tenants t ON t.id = d.tenant_id").
		Where("d.domain = ? AND d.verified_at IS NOT NULL AND d.join_mode = 'sso_required' AND t.status = 'active'", parts[1]).
		Count(&count).Error
	return err == nil && count > 0
}

func (s *Service) recordLoginFailure(ctx context.Context, email, ip string) bool {
	key := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email)) + "|" + ip))
	now := s.deps.Clock().UTC()
	_ = s.gdb(ctx).Where("reset_at <= ?", now.Format(time.RFC3339Nano)).Delete(&models.AuthLoginFailure{}).Error
	reset := now.Add(15 * time.Minute).Format(time.RFC3339Nano)
	var count int
	err := s.gdb(ctx).Raw(`INSERT INTO auth_login_failures(key_hash,count,reset_at,updated_at) VALUES(?,1,?,?) ON CONFLICT(key_hash) DO UPDATE SET count=CASE WHEN auth_login_failures.reset_at<=excluded.updated_at THEN 1 ELSE auth_login_failures.count+1 END,reset_at=CASE WHEN auth_login_failures.reset_at<=excluded.updated_at THEN excluded.reset_at ELSE auth_login_failures.reset_at END,updated_at=excluded.updated_at RETURNING count`, hex.EncodeToString(key[:]), reset, now.Format(time.RFC3339Nano)).Scan(&count).Error
	return err == nil && count > 8
}
func (s *Service) clearLoginFailures(ctx context.Context, email, ip string) {
	key := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email)) + "|" + ip))
	_ = s.gdb(ctx).Where("key_hash = ?", hex.EncodeToString(key[:])).Delete(&models.AuthLoginFailure{}).Error
}
func (s *Service) appendAuditTx(ctx context.Context, tx *sql.Tx, tenantID, action, actorID, targetType, targetID string, detail map[string]any) error {
	_, err := tx.ExecContext(ctx, s.q(`INSERT INTO security_audit_logs(id,tenant_id,action,actor_type,actor_id,target_type,target_id,detail_json,created_at) VALUES(?,?,?,'user',?,?,?,?,?)`), s.deps.NewID(), tenantID, action, actorID, targetType, targetID, encodeJSON(detail), s.now())
	return err
}
func (s *Service) q(v string) string { return s.deps.Rebind(v) }
func (s *Service) now() string       { return s.deps.Clock().UTC().Format(time.RFC3339Nano) }
func (s *Service) gdb(ctx context.Context) *gorm.DB {
	return s.deps.Gorm.WithContext(ctx)
}
func derefString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
func boolInt(v bool) bool { return v }
func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

var emailRx = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

func validEmail(v string) bool { return len(v) <= 320 && emailRx.MatchString(v) }

var slugRx = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(v string) string {
	return strings.Trim(slugRx.ReplaceAllString(strings.ToLower(strings.TrimSpace(v)), "-"), "-")
}
func classifyUnique(err error, message string) error {
	if err == nil {
		return nil
	}
	lower := strings.ToLower(err.Error())
	if strings.Contains(lower, "unique") || strings.Contains(lower, "duplicate") {
		return errors.New(message)
	}
	return err
}
func encodeJSON(v any) string { b, _ := jsonMarshal(v); return string(b) }
func decodeObject(v string) map[string]any {
	out := map[string]any{}
	_ = jsonUnmarshal([]byte(v), &out)
	return out
}

// Kept as variables to make fuzzing these serialization boundaries possible
// without reflection-heavy helpers in the service's hot path.
var jsonMarshal = func(v any) ([]byte, error) { return marshalJSON(v) }
var jsonUnmarshal = func(b []byte, v any) error { return unmarshalJSON(b, v) }

func clientIP(rHeader func(string) string, remote string) string {
	for _, k := range []string{"CF-Connecting-IP", "X-Real-IP", "X-Forwarded-For"} {
		if v := strings.TrimSpace(strings.Split(rHeader(k), ",")[0]); v != "" {
			return v
		}
	}
	return strings.Split(remote, ":")[0]
}
func _unusedFmt() { _ = fmt.Sprintf("") }
