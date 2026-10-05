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

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"golang.org/x/crypto/scrypt"
)

func (s *Service) myMFA(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var enabled sql.NullString
	var policy string
	_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT totp_enabled_at FROM users WHERE id=?`), p.UserID).Scan(&enabled)
	_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT mfa_policy FROM tenants WHERE id=?`), p.TenantID).Scan(&policy)
	methods := []string{}
	if enabled.Valid {
		methods = append(methods, "totp")
	}
	rows, _ := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT id,COALESCE(name,'Passkey'),created_at FROM user_webauthn_credentials WHERE user_id=? ORDER BY created_at`), p.UserID)
	credentials := []map[string]any{}
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var id, name, created string
			_ = rows.Scan(&id, &name, &created)
			credentials = append(credentials, map[string]any{"id": id, "name": name, "createdAt": created})
		}
	}
	if len(credentials) > 0 {
		methods = append(methods, "webauthn")
	}
	httpx.JSON(w, 200, map[string]any{"totp": enabled.Valid, "webauthn": len(credentials) > 0, "methods": methods, "credentials": credentials, "policy": policy, "required": policy == "all" || (policy == "admins" && (p.Role == "owner" || p.Role == "admin"))})
}
func (s *Service) startMyTOTP(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	s.startTOTPFor(w, r, p.UserID)
}
func (s *Service) startTOTPFor(w http.ResponseWriter, r *http.Request, userID string) {
	var email string
	if s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT email FROM users WHERE id=? AND status='active'`), userID).Scan(&email) != nil {
		httpx.Error(w, 404, "not found")
		return
	}
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
	_, err = s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE users SET totp_pending_secret=?,updated_at=? WHERE id=?`), enc, s.now(), userID)
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`INSERT INTO user_totp(user_id,secret_enc,enabled_at,created_at) VALUES(?,?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET secret_enc=excluded.secret_enc,enabled_at=NULL`), userID, enc, s.now())
	uri := "otpauth://totp/" + url.PathEscape("Zakura:"+email) + "?issuer=Zakura&algorithm=SHA1&digits=6&period=30&secret=" + url.QueryEscape(secret)
	httpx.JSON(w, 200, map[string]any{"secret": secret, "otpauthUrl": uri})
}
func (s *Service) cancelMyTOTP(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE users SET totp_pending_secret=NULL,updated_at=? WHERE id=?`), s.now(), p.UserID)
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
	var enc string
	if err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT COALESCE(totp_pending_secret,'') FROM users WHERE id=?`), userID).Scan(&enc); err != nil || enc == "" {
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
	var required int
	_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT COUNT(*) FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.status='active' AND (t.mfa_policy='all' OR (t.mfa_policy='admins' AND m.role IN ('owner','admin')))`), p.UserID).Scan(&required)
	if required > 0 {
		httpx.Error(w, 409, "team policy requires MFA")
		return
	}
	if err := s.verifySecondFactor(r.Context(), p.UserID, b.Code, b.RecoveryCode); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE users SET totp_secret=NULL,totp_pending_secret=NULL,totp_enabled_at=NULL,recovery_codes_json='[]',updated_at=? WHERE id=?`), s.now(), p.UserID)
	_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`DELETE FROM user_totp WHERE user_id=?`), p.UserID)
	_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`DELETE FROM user_recovery_codes WHERE user_id=?`), p.UserID)
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
	_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE users SET recovery_codes_json=?,updated_at=? WHERE id=?`), encodeJSON(hashes), s.now(), p.UserID)
	_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`DELETE FROM user_recovery_codes WHERE user_id=?`), p.UserID)
	for _, hash := range hashes {
		_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`INSERT INTO user_recovery_codes(id,user_id,code_hash,created_at) VALUES(?,?,?,?)`), s.deps.NewID(), p.UserID, hash, s.now())
	}
	httpx.JSON(w, 200, map[string]any{"recoveryCodes": codes})
}

type authTicket struct{ ID, UserID, Kind, TenantID, Role string }

func (s *Service) loadTicket(ctx context.Context, raw, kind string) (authTicket, error) {
	h := sha256.Sum256([]byte(raw))
	var t authTicket
	var metaRaw string
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,user_id,kind,meta_json FROM auth_tokens WHERE token_hash=? AND kind=? AND consumed_at IS NULL AND expires_at>?`), hex.EncodeToString(h[:]), kind, s.now()).Scan(&t.ID, &t.UserID, &t.Kind, &metaRaw)
	if err != nil {
		return t, errors.New("invalid or expired ticket")
	}
	meta := decodeObject(metaRaw)
	t.TenantID, _ = meta["tenantId"].(string)
	t.Role, _ = meta["role"].(string)
	if t.TenantID == "" || t.Role == "" {
		return t, errors.New("invalid ticket metadata")
	}
	return t, nil
}
func (s *Service) consumeTicket(ctx context.Context, id string) error {
	res, err := s.deps.DB.ExecContext(ctx, s.q(`UPDATE auth_tokens SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?`), s.now(), id, s.now())
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n != 1 {
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
	if err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,email,COALESCE(name,''),is_platform_admin FROM users WHERE id=? AND status='active'`), t.UserID).Scan(&u.ID, &u.Email, &u.Name, &u.IsPlatformAdmin); err != nil {
		return LoginResult{}, err
	}
	if err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,slug,name,is_default,onboarding_completed FROM tenants WHERE id=? AND status='active'`), t.TenantID).Scan(&tenant.ID, &tenant.Slug, &tenant.Name, &tenant.IsDefault, &tenant.OnboardingCompleted); err != nil {
		return LoginResult{}, err
	}
	token, err := s.issueSession(ctx, u, tenant, t.Role, ip, ua)
	if err == nil {
		s.recordLoginUsage(ctx, tenant.ID, u.ID, "mfa")
	}
	return LoginResult{Session: token, User: u, Tenant: tenant, Role: t.Role}, err
}
func (s *Service) verifySecondFactor(ctx context.Context, userID, code, recovery string) error {
	var enc, recoveryRaw string
	if err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT COALESCE(totp_secret,''),recovery_codes_json FROM users WHERE id=?`), userID).Scan(&enc, &recoveryRaw); err != nil {
		return errors.New("user not found")
	}
	if enc == "" {
		_ = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT secret_enc FROM user_totp WHERE user_id=? AND enabled_at IS NOT NULL`), userID).Scan(&enc)
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
				_, _ = s.deps.DB.ExecContext(ctx, s.q(`UPDATE users SET recovery_codes_json=?,updated_at=? WHERE id=?`), encodeJSON(hashes), s.now(), userID)
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
		res, _ := s.deps.DB.ExecContext(ctx, s.q(`UPDATE user_recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL`), s.now(), userID, hex.EncodeToString(legacy[:]))
		if res != nil {
			n, _ := res.RowsAffected()
			if n == 1 {
				return nil
			}
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
