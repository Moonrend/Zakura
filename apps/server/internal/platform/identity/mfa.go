package identity

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"golang.org/x/crypto/scrypt"
)

func (s *Service) myMFA(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var totpUser models.User
	var policyTenant models.Tenant
	_ = s.gdb(r.Context()).Select("totp_enabled_at").Where("id = ?", p.UserID).Take(&totpUser).Error
	_ = s.gdb(r.Context()).Select("mfa_policy").Where("id = ?", p.TenantID).Take(&policyTenant).Error
	enabled := totpUser.TotpEnabledAt != nil
	policy := policyTenant.MfaPolicy
	methods := []string{}
	if enabled {
		methods = append(methods, "totp")
	}
	var credentials []models.UserWebauthnCredential
	_ = s.gdb(r.Context()).Select("id,name,created_at").Where("user_id = ?", p.UserID).Order("created_at").Find(&credentials).Error
	items := []map[string]any{}
	for _, credential := range credentials {
		name := "Passkey"
		if credential.Name != nil {
			name = *credential.Name
		}
		items = append(items, map[string]any{"id": derefString(credential.ID), "name": name, "createdAt": credential.CreatedAt})
	}
	if len(items) > 0 {
		methods = append(methods, "webauthn")
	}
	httpx.JSON(w, 200, map[string]any{"totp": enabled, "webauthn": len(items) > 0, "methods": methods, "credentials": items, "policy": policy, "required": policy == "all" || (policy == "admins" && (p.Role == "owner" || p.Role == "admin"))})
}
func (s *Service) startMyTOTP(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	s.startTOTPFor(w, r, p.UserID)
}
func (s *Service) startTOTPFor(w http.ResponseWriter, r *http.Request, userID string) {
	var account models.User
	if s.gdb(r.Context()).Select("email").Where("id = ? AND status = 'active'", userID).Take(&account).Error != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	email := account.Email
	secretBytes := make([]byte, 20)
	if _, err := rand.Read(secretBytes); err != nil {
		httpx.Error(w, 500, "random source unavailable")
		return
	}
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secretBytes)
	secretJSON, _ := json.Marshal(secret)
	enc, err := seal(s.deps.Secret, secretJSON)
	if err != nil {
		httpx.Error(w, 500, "secret encryption failed")
		return
	}
	err = s.gdb(r.Context()).Model(&models.User{}).Where("id = ?", userID).Updates(map[string]any{"totp_pending_secret": enc, "updated_at": s.now()}).Error
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	_ = s.gdb(r.Context()).Exec(`INSERT INTO user_totp(user_id,secret_enc,enabled_at,created_at) VALUES(?,?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET secret_enc=excluded.secret_enc,enabled_at=NULL`, userID, enc, s.now()).Error
	uri := "otpauth://totp/" + url.PathEscape("Zakura:"+email) + "?issuer=Zakura&algorithm=SHA1&digits=6&period=30&secret=" + url.QueryEscape(secret)
	httpx.JSON(w, 200, map[string]any{"secret": secret, "otpauthUrl": uri})
}
func (s *Service) cancelMyTOTP(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	_ = s.gdb(r.Context()).Model(&models.User{}).Where("id = ?", p.UserID).Updates(map[string]any{"totp_pending_secret": nil, "updated_at": s.now()}).Error
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (s *Service) enableMyTOTP(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var b struct {
		Code string `json:"code"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "code required")
		return
	}
	codes, err := s.enableTOTP(r.Context(), p.UserID, b.Code)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	_ = s.Audit(r.Context(), p.TenantID, "mfa.totp_enable", p.UserID, "user", p.UserID, nil)
	httpx.JSON(w, 200, map[string]any{"recoveryCodes": codes})
}
func (s *Service) enableTOTP(ctx context.Context, userID, code string) ([]string, error) {
	var pendingUser models.User
	if err := s.gdb(ctx).Select("totp_pending_secret").Where("id = ?", userID).Take(&pendingUser).Error; err != nil {
		return nil, errors.New("TOTP setup not started")
	}
	enc := derefString(pendingUser.TotpPendingSecret)
	if enc == "" {
		return nil, errors.New("TOTP setup not started")
	}
	plain, err := open(s.deps.Secret, enc)
	if err != nil {
		return nil, errors.New("invalid pending secret")
	}
	if !verifyTOTP(string(plain), code, s.deps.Clock()) {
		return nil, errors.New("invalid code")
	}
	codes, hashes := newRecoveryCodes()
	now := s.now()
	err = appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, s.q(`UPDATE users SET totp_secret=?,totp_pending_secret=NULL,totp_enabled_at=?,recovery_codes_json=?,updated_at=? WHERE id=?`), enc, now, encodeJSON(hashes), now, userID); e != nil {
			return e
		}
		if _, e := tx.ExecContext(ctx, s.q(`INSERT INTO user_totp(user_id,secret_enc,enabled_at,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET secret_enc=excluded.secret_enc,enabled_at=excluded.enabled_at`), userID, enc, now, now); e != nil {
			return e
		}
		if _, e := tx.ExecContext(ctx, s.q(`DELETE FROM user_recovery_codes WHERE user_id=?`), userID); e != nil {
			return e
		}
		for _, hash := range hashes {
			if _, e := tx.ExecContext(ctx, s.q(`INSERT INTO user_recovery_codes(id,user_id,code_hash,created_at) VALUES(?,?,?,?)`), s.deps.NewID(), userID, hash, now); e != nil {
				return e
			}
		}
		return nil
	})
	return codes, err
}
func (s *Service) disableMyTOTP(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var b struct {
		Code         string `json:"code"`
		RecoveryCode string `json:"recoveryCode"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "verification required")
		return
	}
	var required int64
	_ = s.gdb(r.Context()).Table("tenant_memberships AS m").
		Joins("JOIN tenants t ON t.id = m.tenant_id").
		Where("m.user_id = ? AND m.status = 'active' AND (t.mfa_policy = 'all' OR (t.mfa_policy = 'admins' AND m.role IN ('owner','admin')))", p.UserID).
		Count(&required).Error
	if required > 0 {
		httpx.Error(w, 409, "team policy requires MFA")
		return
	}
	if err := s.verifySecondFactor(r.Context(), p.UserID, b.Code, b.RecoveryCode); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	_ = s.gdb(r.Context()).Model(&models.User{}).Where("id = ?", p.UserID).Updates(map[string]any{"totp_secret": nil, "totp_pending_secret": nil, "totp_enabled_at": nil, "recovery_codes_json": "[]", "updated_at": s.now()}).Error
	_ = s.gdb(r.Context()).Where("user_id = ?", p.UserID).Delete(&models.UserTotp{}).Error
	_ = s.gdb(r.Context()).Where("user_id = ?", p.UserID).Delete(&models.UserRecoveryCode{}).Error
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (s *Service) rotateRecoveryCodes(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var b struct {
		Code string `json:"code"`
	}
	if httpx.DecodeJSON(r, &b) != nil || s.verifySecondFactor(r.Context(), p.UserID, b.Code, "") != nil {
		httpx.Error(w, 400, "invalid code")
		return
	}
	codes, hashes := newRecoveryCodes()
	_ = s.gdb(r.Context()).Model(&models.User{}).Where("id = ?", p.UserID).Updates(map[string]any{"recovery_codes_json": encodeJSON(hashes), "updated_at": s.now()}).Error
	_ = s.gdb(r.Context()).Where("user_id = ?", p.UserID).Delete(&models.UserRecoveryCode{}).Error
	recoveryCodes := make([]models.UserRecoveryCode, 0, len(hashes))
	for _, hash := range hashes {
		codeID := s.deps.NewID()
		recoveryCodes = append(recoveryCodes, models.UserRecoveryCode{ID: &codeID, UserID: p.UserID, CodeHash: hash, CreatedAt: s.now()})
	}
	if len(recoveryCodes) > 0 {
		_ = s.gdb(r.Context()).Create(&recoveryCodes).Error
	}
	httpx.JSON(w, 200, map[string]any{"recoveryCodes": codes})
}

type authTicket struct{ ID, UserID, Kind, TenantID, Role string }

func (s *Service) loadTicket(ctx context.Context, raw, kind string) (authTicket, error) {
	h := sha256.Sum256([]byte(raw))
	var t authTicket
	var token models.AuthToken
	err := s.gdb(ctx).Where("token_hash = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?", hex.EncodeToString(h[:]), kind, s.now()).Take(&token).Error
	if err != nil {
		return t, errors.New("invalid or expired ticket")
	}
	t.ID, t.UserID, t.Kind = derefString(token.ID), derefString(token.UserID), token.Kind
	meta := decodeObject(token.MetaJSON)
	t.TenantID, _ = meta["tenantId"].(string)
	t.Role, _ = meta["role"].(string)
	if t.TenantID == "" || t.Role == "" {
		return t, errors.New("invalid ticket metadata")
	}
	return t, nil
}
func (s *Service) consumeTicket(ctx context.Context, id string) error {
	res := s.gdb(ctx).Model(&models.AuthToken{}).Where("id = ? AND consumed_at IS NULL AND expires_at > ?", id, s.now()).Update("consumed_at", s.now())
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected != 1 {
		return errors.New("ticket already used")
	}
	return nil
}
func (s *Service) completeMFALogin(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Ticket       string          `json:"ticket"`
		Code         string          `json:"code"`
		TOTP         string          `json:"totp"`
		RecoveryCode string          `json:"recoveryCode"`
		WebAuthn     json.RawMessage `json:"webauthn"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	t, err := s.loadTicket(r.Context(), b.Ticket, "mfa_login")
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	code := b.TOTP
	if code == "" {
		code = b.Code
	}
	if len(b.WebAuthn) > 0 {
		err = s.verifyWebAuthnLogin(r.Context(), t.UserID, b.Ticket, b.WebAuthn)
	} else {
		err = s.verifySecondFactor(r.Context(), t.UserID, code, b.RecoveryCode)
	}
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if err = s.consumeTicket(r.Context(), t.ID); err != nil {
		httpx.Error(w, 409, err.Error())
		return
	}
	res, err := s.sessionForTicket(r.Context(), t, requestIP(r), r.UserAgent())
	if err != nil {
		httpx.Error(w, 500, "session issue failed: "+err.Error())
		return
	}
	httpx.JSON(w, 200, map[string]any{"session": res.Session, "user": res.User, "tenant": res.Tenant, "role": res.Role})
}
func (s *Service) startTicketTOTP(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Ticket string `json:"ticket"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "ticket required")
		return
	}
	t, err := s.loadTicket(r.Context(), b.Ticket, "mfa_enrollment")
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	s.startTOTPFor(w, r, t.UserID)
}
func (s *Service) completeTicketTOTP(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Ticket string `json:"ticket"`
		Code   string `json:"code"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	t, err := s.loadTicket(r.Context(), b.Ticket, "mfa_enrollment")
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	codes, err := s.enableTOTP(r.Context(), t.UserID, b.Code)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if err = s.consumeTicket(r.Context(), t.ID); err != nil {
		httpx.Error(w, 409, err.Error())
		return
	}
	res, err := s.sessionForTicket(r.Context(), t, requestIP(r), r.UserAgent())
	if err != nil {
		httpx.Error(w, 500, "session issue failed: "+err.Error())
		return
	}
	httpx.JSON(w, 200, map[string]any{"session": res.Session, "user": res.User, "tenant": res.Tenant, "role": res.Role, "recoveryCodes": codes})
}
func (s *Service) sessionForTicket(ctx context.Context, t authTicket, ip, ua string) (LoginResult, error) {
	var u User
	var tenant Tenant
	var dbUser models.User
	if err := s.gdb(ctx).Where("id = ? AND status = 'active'", t.UserID).Take(&dbUser).Error; err != nil {
		return LoginResult{}, err
	}
	u.ID, u.Email, u.IsPlatformAdmin = derefString(dbUser.ID), dbUser.Email, dbUser.IsPlatformAdmin
	u.Name = derefString(dbUser.Name)
	var dbTenant models.Tenant
	if err := s.gdb(ctx).Where("id = ? AND status = 'active'", t.TenantID).Take(&dbTenant).Error; err != nil {
		return LoginResult{}, err
	}
	tenant = Tenant{ID: derefString(dbTenant.ID), Slug: dbTenant.Slug, Name: dbTenant.Name, IsDefault: dbTenant.IsDefault, OnboardingCompleted: dbTenant.OnboardingCompleted}
	token, err := s.issueSession(ctx, u, tenant, t.Role, ip, ua)
	if err == nil {
		s.recordLoginUsage(ctx, tenant.ID, u.ID, "mfa")
	}
	return LoginResult{Session: token, User: u, Tenant: tenant, Role: t.Role}, err
}
func (s *Service) verifySecondFactor(ctx context.Context, userID, code, recovery string) error {
	var account models.User
	if err := s.gdb(ctx).Select("totp_secret,recovery_codes_json").Where("id = ?", userID).Take(&account).Error; err != nil {
		return errors.New("user not found")
	}
	enc, recoveryRaw := derefString(account.TotpSecret), account.RecoveryCodesJSON
	if enc == "" {
		var totp models.UserTotp
		if s.gdb(ctx).Select("secret_enc").Where("user_id = ? AND enabled_at IS NOT NULL", userID).Take(&totp).Error == nil {
			enc = totp.SecretEnc
		}
	}
	if code != "" && enc != "" {
		plain, err := open(s.deps.Secret, enc)
		if err == nil && verifyTOTP(string(plain), code, s.deps.Clock()) {
			return nil
		}
	}
	if recovery != "" {
		var hashes []string
		_ = json.Unmarshal([]byte(recoveryRaw), &hashes)
		h := sha256.Sum256([]byte(strings.ToUpper(strings.TrimSpace(recovery))))
		needle := hex.EncodeToString(h[:])
		for i, v := range hashes {
			if hmac.Equal([]byte(v), []byte(needle)) {
				hashes = append(hashes[:i], hashes[i+1:]...)
				_ = s.gdb(ctx).Model(&models.User{}).Where("id = ?", userID).Updates(map[string]any{"recovery_codes_json": encodeJSON(hashes), "updated_at": s.now()}).Error
				return nil
			}
		}
		normalized := strings.ToLower(strings.Map(func(r rune) rune {
			if r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F' || r >= '0' && r <= '9' {
				return r
			}
			return -1
		}, recovery))
		legacy := sha256.Sum256([]byte(normalized))
		res := s.gdb(ctx).Model(&models.UserRecoveryCode{}).Where("user_id = ? AND code_hash = ? AND used_at IS NULL", userID, hex.EncodeToString(legacy[:])).Update("used_at", s.now())
		if res.Error == nil && res.RowsAffected == 1 {
			return nil
		}
	}
	return errors.New("invalid MFA code")
}

func verifyTOTP(secret, code string, now time.Time) bool {
	code = strings.TrimSpace(code)
	if len(code) != 6 {
		return false
	}
	for delta := -1; delta <= 1; delta++ {
		if subtleString(totpCode(secret, now.Add(time.Duration(delta)*30*time.Second)), code) {
			return true
		}
	}
	return false
}
func totpCode(secret string, t time.Time) string {
	key, _ := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(secret))
	counter := uint64(t.Unix() / 30)
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(msg[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := (uint32(sum[offset])&0x7f)<<24 | (uint32(sum[offset+1])&0xff)<<16 | (uint32(sum[offset+2])&0xff)<<8 | (uint32(sum[offset+3]) & 0xff)
	return fmt.Sprintf("%06d", value%1_000_000)
}
func subtleString(a, b string) bool { return len(a) == len(b) && hmac.Equal([]byte(a), []byte(b)) }
func newRecoveryCodes() ([]string, []string) {
	codes := make([]string, 10)
	hashes := make([]string, 10)
	for i := range codes {
		raw, _ := randomToken(7)
		code := strings.ToUpper(raw[:4] + "-" + raw[4:8])
		codes[i] = code
		h := sha256.Sum256([]byte(code))
		hashes[i] = hex.EncodeToString(h[:])
	}
	return codes, hashes
}
func open(secret []byte, encoded string) ([]byte, error) {
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(data) < 28 {
		return nil, errors.New("invalid encrypted value")
	}
	legacyKey, err := scrypt.Key(secret, []byte("zakura-v1"), 16384, 8, 1, 32)
	if err == nil {
		if block, e := aes.NewCipher(legacyKey); e == nil {
			if gcm, e := cipher.NewGCM(block); e == nil {
				nonce, tag, ciphertext := data[:12], data[12:28], data[28:]
				if plain, e := gcm.Open(nil, nonce, append(append([]byte{}, ciphertext...), tag...), nil); e == nil {
					var text string
					if json.Unmarshal(plain, &text) == nil {
						return []byte(text), nil
					}
					return plain, nil
				}
			}
		}
	}
	// Read ciphertext produced by early native-Go prereleases so upgrades do
	// not strand secrets written before the pinned scrypt format was restored.
	key := sha256.Sum256(secret)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(data) < gcm.NonceSize() {
		return nil, errors.New("invalid encrypted value")
	}
	return gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
}

var _ = strconv.Itoa
