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

	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/appdeps"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
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
	var count int
	if err := s.deps.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM platform_meta WHERE singleton=1 AND setup_completed=TRUE`).Scan(&count); err != nil {
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
	var passwordHash, status string
	var emailVerified sql.NullString
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,email,COALESCE(name,''),COALESCE(password_hash,''),is_platform_admin,status,email_verified_at FROM users WHERE email=?`), email).Scan(&u.ID, &u.Email, &u.Name, &passwordHash, &u.IsPlatformAdmin, &status, &emailVerified)
	if err != nil || status != "active" || bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password)) != nil {
		return LoginResult{}, errors.New("invalid credentials")
	}
	u.EmailVerified = emailVerified.Valid
	if emailVerified.Valid {
		_ = s.maybeAutoJoinTenant(ctx, u.ID, u.Email)
	}
	query := `SELECT t.id,t.slug,t.name,t.is_default,t.onboarding_completed,m.role FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id WHERE m.user_id=? AND m.status='active' AND t.status='active'`
	args := []any{u.ID}
	if tenantSlug != "" {
		query += ` AND t.slug=?`
		args = append(args, tenantSlug)
	}
	query += ` ORDER BY t.is_default DESC,m.created_at ASC LIMIT 1`
	var t Tenant
	var role string
	err = s.deps.DB.QueryRowContext(ctx, s.q(query), args...).Scan(&t.ID, &t.Slug, &t.Name, &t.IsDefault, &t.OnboardingCompleted, &role)
	if err != nil {
		return LoginResult{}, errors.New("no active tenant membership")
	}
	var totpEnabled sql.NullString
	var policy string
	_ = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT totp_enabled_at FROM users WHERE id=?`), u.ID).Scan(&totpEnabled)
	_ = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT mfa_policy FROM tenants WHERE id=?`), t.ID).Scan(&policy)
	if totpEnabled.Valid {
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
	_, _ = s.deps.DB.ExecContext(ctx, s.q(`UPDATE users SET last_login_at=?,updated_at=? WHERE id=?`), now, now, u.ID)
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
	var tenantID string
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT d.tenant_id FROM tenant_domains d JOIN tenants t ON t.id=d.tenant_id WHERE d.domain=? AND d.verified_at IS NOT NULL AND d.join_mode='auto_join' AND t.status='active' LIMIT 1`), parts[1]).Scan(&tenantID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'member','active',?,?) ON CONFLICT(tenant_id,user_id) DO NOTHING`), s.deps.NewID(), tenantID, userID, s.now(), s.now())
	return err
}

func (s *Service) issueAuthToken(ctx context.Context, kind, userID string, meta map[string]any) (string, error) {
	raw := "zat_" + mustToken(32)
	h := sha256.Sum256([]byte(raw))
	_, err := s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO auth_tokens(id,user_id,kind,token_hash,meta_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?)`), s.deps.NewID(), userID, kind, hex.EncodeToString(h[:]), encodeJSON(meta), s.deps.Clock().UTC().Add(10*time.Minute).Format(time.RFC3339Nano), s.now())
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
	_, err = s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO user_sessions(id,user_id,tenant_id,email,role,is_platform_admin,token_hash,ip,user_agent,expires_at,last_seen_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`), sid, u.ID, t.ID, u.Email, role, boolInt(u.IsPlatformAdmin), hex.EncodeToString(hash[:]), ip, ua, exp.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	return raw, err
}

func (s *Service) SwitchTenant(ctx context.Context, p httpx.Principal, tenantID, ip, ua string) (LoginResult, error) {
	var t Tenant
	var role string
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT t.id,t.slug,t.name,t.is_default,t.onboarding_completed,m.role FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id WHERE t.id=? AND m.user_id=? AND m.status='active' AND t.status='active'`), tenantID, p.UserID).Scan(&t.ID, &t.Slug, &t.Name, &t.IsDefault, &t.OnboardingCompleted, &role)
	if err != nil {
		return LoginResult{}, errors.New("not a member of this tenant")
	}
	var u User
	err = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,email,COALESCE(name,''),is_platform_admin FROM users WHERE id=? AND status='active'`), p.UserID).Scan(&u.ID, &u.Email, &u.Name, &u.IsPlatformAdmin)
	if err != nil {
		return LoginResult{}, err
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
	var passHash, verified, totp, avatar sql.NullString
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,email,COALESCE(name,''),is_platform_admin,can_use_local_runner,COALESCE(title,''),COALESCE(bio,''),password_hash,email_verified_at,totp_enabled_at,avatar_updated_at FROM users WHERE id=?`), p.UserID).Scan(&u.ID, &u.Email, &u.Name, &u.IsPlatformAdmin, &u.CanUseLocalRunner, &u.Title, &u.Bio, &passHash, &verified, &totp, &avatar)
	if err != nil {
		return u, Tenant{}, err
	}
	u.HasPassword = passHash.Valid && passHash.String != ""
	u.EmailVerified = verified.Valid
	u.TotpEnabled = totp.Valid
	u.CanUseLocalRunner = u.CanUseLocalRunner || u.IsPlatformAdmin || !s.deps.MultiTenant
	if avatar.Valid {
		if parsed, parseErr := time.Parse(time.RFC3339Nano, avatar.String); parseErr == nil {
			u.AvatarRev = parsed.UnixMilli()
		}
	}
	var t Tenant
	var steps string
	err = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,slug,name,is_default,onboarding_completed,onboarding_steps FROM tenants WHERE id=?`), p.TenantID).Scan(&t.ID, &t.Slug, &t.Name, &t.IsDefault, &t.OnboardingCompleted, &steps)
	if err == nil {
		t.OnboardingSteps = decodeObject(steps)
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
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT (c.enforce_sso OR d.join_mode='sso_required') FROM tenant_domains d JOIN tenants t ON t.id=d.tenant_id JOIN tenant_sso_configs c ON c.tenant_id=t.id WHERE d.domain=? AND d.verified_at IS NOT NULL AND t.status='active' AND c.enabled=TRUE ORDER BY c.enforce_sso DESC LIMIT 1`), parts[1]).Scan(&required)
	return err == nil && required
}

func (s *Service) registrationBlockedBySSO(ctx context.Context, email string) bool {
	parts := strings.SplitN(strings.ToLower(strings.TrimSpace(email)), "@", 2)
	if len(parts) != 2 {
		return false
	}
	var count int
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM tenant_domains d JOIN tenants t ON t.id=d.tenant_id WHERE d.domain=? AND d.verified_at IS NOT NULL AND d.join_mode='sso_required' AND t.status='active'`), parts[1]).Scan(&count)
	return err == nil && count > 0
}

func (s *Service) recordLoginFailure(ctx context.Context, email, ip string) bool {
	key := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email)) + "|" + ip))
	now := s.deps.Clock().UTC()
	_, _ = s.deps.DB.ExecContext(ctx, s.q(`DELETE FROM auth_login_failures WHERE reset_at<=?`), now.Format(time.RFC3339Nano))
	reset := now.Add(15 * time.Minute).Format(time.RFC3339Nano)
	var count int
	err := s.deps.DB.QueryRowContext(ctx, s.q(`INSERT INTO auth_login_failures(key_hash,count,reset_at,updated_at) VALUES(?,1,?,?) ON CONFLICT(key_hash) DO UPDATE SET count=CASE WHEN auth_login_failures.reset_at<=excluded.updated_at THEN 1 ELSE auth_login_failures.count+1 END,reset_at=CASE WHEN auth_login_failures.reset_at<=excluded.updated_at THEN excluded.reset_at ELSE auth_login_failures.reset_at END,updated_at=excluded.updated_at RETURNING count`), hex.EncodeToString(key[:]), reset, now.Format(time.RFC3339Nano)).Scan(&count)
	return err == nil && count > 8
}
func (s *Service) clearLoginFailures(ctx context.Context, email, ip string) {
	key := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email)) + "|" + ip))
	_, _ = s.deps.DB.ExecContext(ctx, s.q(`DELETE FROM auth_login_failures WHERE key_hash=?`), hex.EncodeToString(key[:]))
}
func (s *Service) appendAuditTx(ctx context.Context, tx *sql.Tx, tenantID, action, actorID, targetType, targetID string, detail map[string]any) error {
	_, err := tx.ExecContext(ctx, s.q(`INSERT INTO security_audit_logs(id,tenant_id,action,actor_type,actor_id,target_type,target_id,detail_json,created_at) VALUES(?,?,?,'user',?,?,?,?,?)`), s.deps.NewID(), tenantID, action, actorID, targetType, targetID, encodeJSON(detail), s.now())
	return err
}
func (s *Service) q(v string) string { return s.deps.Rebind(v) }
func (s *Service) now() string       { return s.deps.Clock().UTC().Format(time.RFC3339Nano) }
func boolInt(v bool) bool            { return v }
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
