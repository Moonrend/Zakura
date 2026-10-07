package identity

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

const (
	emailCodeTTL      = 10 * time.Minute
	emailCodeCooldown = 60 * time.Second
	emailCodeMaxTries = 3
)

var errEmailCooldown = errors.New("verification code already sent; try again later")

func emailCodeHash(code string) string {
	h := sha256.Sum256([]byte(strings.TrimSpace(code)))
	return hex.EncodeToString(h[:])
}

func randomEmailCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func intAny(v any) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	case int64:
		return int(x)
	case json.Number:
		n, _ := x.Int64()
		return int(n)
	case string:
		n, _ := strconv.Atoi(x)
		return n
	}
	return 0
}

func (s *Service) sendEmailCode(ctx context.Context, email, code string) error {
	if s.deps.SendTransactionalEmail == nil {
		return errors.New("email delivery is not configured")
	}
	subject := "Zakura 登录验证码"
	htmlBody := `<p>你的 Zakura 验证码是 <strong>` + code + `</strong>。</p><p>该验证码 10 分钟内有效，请勿泄露给他人。</p>`
	textBody := "你的 Zakura 验证码是 " + code + "。\n该验证码 10 分钟内有效，请勿泄露给他人。"
	return s.deps.SendTransactionalEmail(ctx, email, subject, htmlBody, textBody)
}

func (s *Service) issueEmailCode(ctx context.Context, userID, email, kind string) error {
	var last models.AuthToken
	if err := s.gdb(ctx).Select("created_at").Where("user_id = ? AND kind = ?", userID, kind).Order("created_at DESC").Take(&last).Error; err == nil {
		if ts, perr := time.Parse(time.RFC3339Nano, last.CreatedAt); perr == nil && s.deps.Clock().UTC().Sub(ts) < emailCodeCooldown {
			return errEmailCooldown
		}
	}
	_ = s.gdb(ctx).Where("user_id = ? AND kind = ?", userID, kind).Delete(&models.AuthToken{}).Error
	code, err := randomEmailCode()
	if err != nil {
		return err
	}
	raw := "emc_" + mustToken(24)
	tokenHash := sha256.Sum256([]byte(raw))
	codeHash := sha256.Sum256([]byte(code))
	id := s.deps.NewID()
	uid := userID
	meta := map[string]any{"codeHash": hex.EncodeToString(codeHash[:]), "attempts": 0}
	now := s.deps.Clock().UTC()
	if err = s.gdb(ctx).Create(&models.AuthToken{ID: &id, UserID: &uid, Kind: kind, TokenHash: hex.EncodeToString(tokenHash[:]), MetaJSON: encodeJSON(meta), ExpiresAt: now.Add(emailCodeTTL).Format(time.RFC3339Nano), CreatedAt: s.now()}).Error; err != nil {
		return err
	}
	return s.sendEmailCode(ctx, email, code)
}

func (s *Service) verifyEmailCodeMeta(ctx context.Context, tokenID string, meta map[string]any, hashKey, expiryKey, code string) error {
	expected, _ := meta[hashKey].(string)
	if expected == "" {
		return errors.New("未发送验证码")
	}
	if expiryKey != "" {
		if exp, _ := meta[expiryKey].(string); exp != "" {
			if t, e := time.Parse(time.RFC3339Nano, exp); e == nil && s.deps.Clock().UTC().After(t) {
				return errors.New("verification code expired")
			}
		}
	}
	if strings.TrimSpace(code) != "" && subtleString(emailCodeHash(code), expected) {
		return nil
	}
	attempts := intAny(meta["attempts"]) + 1
	if attempts >= emailCodeMaxTries {
		_ = s.gdb(ctx).Model(&models.AuthToken{}).Where("id = ?", tokenID).Update("consumed_at", s.now()).Error
		return errors.New("too many incorrect attempts")
	}
	meta["attempts"] = attempts
	_ = s.gdb(ctx).Model(&models.AuthToken{}).Where("id = ?", tokenID).Update("meta_json", encodeJSON(meta)).Error
	return errors.New("invalid verification code")
}

func (s *Service) verifyChallengeEmailCode(ctx context.Context, userID, code string) error {
	var token models.AuthToken
	if err := s.gdb(ctx).Where("user_id = ? AND kind = 'mfa_email_challenge' AND consumed_at IS NULL AND expires_at > ?", userID, s.now()).Order("created_at DESC").Take(&token).Error; err != nil {
		return errors.New("未发送验证码")
	}
	meta := decodeObject(token.MetaJSON)
	if err := s.verifyEmailCodeMeta(ctx, derefString(token.ID), meta, "codeHash", "", code); err != nil {
		return err
	}
	return s.consumeTicket(ctx, derefString(token.ID))
}

func (s *Service) startMyEmailMFA(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var account models.User
	if err := s.gdb(r.Context()).Select("email,email_mfa_enabled_at").Where("id = ? AND status = 'active'", p.UserID).Take(&account).Error; err != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	if account.EmailMfaEnabledAt != nil {
		httpx.Error(w, 409, "email MFA is already enabled")
		return
	}
	if s.deps.SendTransactionalEmail == nil {
		httpx.Error(w, 503, "邮件发送未配置")
		return
	}
	if err := s.issueEmailCode(r.Context(), p.UserID, account.Email, "email_mfa_enroll"); err != nil {
		if errors.Is(err, errEmailCooldown) {
			httpx.Error(w, 429, err.Error())
			return
		}
		httpx.Error(w, 500, "failed to send verification code")
		return
	}
	httpx.JSON(w, 200, map[string]any{"sent": true})
}

func (s *Service) enableMyEmailMFA(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var b struct {
		Code string `json:"code"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "code required")
		return
	}
	var token models.AuthToken
	if err := s.gdb(r.Context()).Where("user_id = ? AND kind = 'email_mfa_enroll' AND consumed_at IS NULL AND expires_at > ?", p.UserID, s.now()).Order("created_at DESC").Take(&token).Error; err != nil {
		httpx.Error(w, 400, "未发送验证码")
		return
	}
	meta := decodeObject(token.MetaJSON)
	if err := s.verifyEmailCodeMeta(r.Context(), derefString(token.ID), meta, "codeHash", "", b.Code); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if err := s.consumeTicket(r.Context(), derefString(token.ID)); err != nil {
		httpx.Error(w, 409, err.Error())
		return
	}
	_ = s.gdb(r.Context()).Model(&models.User{}).Where("id = ?", p.UserID).Updates(map[string]any{"email_mfa_enabled_at": s.now(), "updated_at": s.now()}).Error
	_ = s.Audit(r.Context(), p.TenantID, "auth.mfa_email_enabled", p.UserID, "user", p.UserID, nil)
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (s *Service) challengeMyEmailMFA(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var account models.User
	if err := s.gdb(r.Context()).Select("email").Where("id = ? AND status = 'active'", p.UserID).Take(&account).Error; err != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	if s.deps.SendTransactionalEmail == nil {
		httpx.Error(w, 503, "邮件发送未配置")
		return
	}
	if err := s.issueEmailCode(r.Context(), p.UserID, account.Email, "mfa_email_challenge"); err != nil {
		if errors.Is(err, errEmailCooldown) {
			httpx.Error(w, 429, err.Error())
			return
		}
		httpx.Error(w, 500, "failed to send verification code")
		return
	}
	httpx.JSON(w, 200, map[string]any{"sent": true})
}

func (s *Service) disableMyEmailMFA(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var b struct {
		TOTP         string `json:"totp"`
		RecoveryCode string `json:"recoveryCode"`
		EmailCode    string `json:"emailCode"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "verification required")
		return
	}
	methods, enabled, required, err := s.mfaDecision(r.Context(), p.UserID, p.Role)
	if err != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	if required {
		httpx.Error(w, 409, "team policy requires MFA")
		return
	}
	if enabled && len(methods) == 1 && methods[0] == "email" {
		httpx.Error(w, 409, "请先关闭两步验证")
		return
	}
	if methodsIncludes(methods, "totp") {
		if err := s.verifySecondFactor(r.Context(), p.UserID, b.TOTP, b.RecoveryCode); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
	} else if b.EmailCode != "" {
		if err := s.verifyChallengeEmailCode(r.Context(), p.UserID, b.EmailCode); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
	}
	_ = s.gdb(r.Context()).Model(&models.User{}).Where("id = ?", p.UserID).Updates(map[string]any{"email_mfa_enabled_at": nil, "updated_at": s.now()}).Error
	_ = s.Audit(r.Context(), p.TenantID, "auth.mfa_email_disabled", p.UserID, "user", p.UserID, nil)
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (s *Service) sendLoginEmailCode(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Ticket string `json:"ticket"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Ticket == "" {
		httpx.Error(w, 400, "ticket required")
		return
	}
	t, err := s.loadTicket(r.Context(), b.Ticket, "mfa_login")
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if s.deps.SendTransactionalEmail == nil {
		httpx.Error(w, 503, "邮件发送未配置")
		return
	}
	var token models.AuthToken
	if err := s.gdb(r.Context()).Where("id = ?", t.ID).Take(&token).Error; err != nil {
		httpx.Error(w, 400, "invalid or expired ticket")
		return
	}
	meta := decodeObject(token.MetaJSON)
	if sentAt, _ := meta["emailSentAt"].(string); sentAt != "" {
		if ts, e := time.Parse(time.RFC3339Nano, sentAt); e == nil && s.deps.Clock().UTC().Sub(ts) < emailCodeCooldown {
			httpx.Error(w, 429, errEmailCooldown.Error())
			return
		}
	}
	var account models.User
	if err := s.gdb(r.Context()).Select("email").Where("id = ? AND status = 'active'", t.UserID).Take(&account).Error; err != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	code, err := randomEmailCode()
	if err != nil {
		httpx.Error(w, 500, "failed to generate verification code")
		return
	}
	now := s.deps.Clock().UTC()
	codeHash := sha256.Sum256([]byte(code))
	meta["emailCodeHash"] = hex.EncodeToString(codeHash[:])
	meta["emailCodeExpiresAt"] = now.Add(emailCodeTTL).Format(time.RFC3339Nano)
	meta["attempts"] = 0
	meta["emailSentAt"] = now.Format(time.RFC3339Nano)
	if err = s.gdb(r.Context()).Model(&models.AuthToken{}).Where("id = ?", t.ID).Update("meta_json", encodeJSON(meta)).Error; err != nil {
		httpx.Error(w, 500, "failed to store verification code")
		return
	}
	if err = s.sendEmailCode(r.Context(), account.Email, code); err != nil {
		httpx.Error(w, 500, "failed to send verification code")
		return
	}
	httpx.JSON(w, 200, map[string]any{"sent": true})
}
