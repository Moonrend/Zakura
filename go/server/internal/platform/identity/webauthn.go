package identity

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-webauthn/webauthn/protocol"
	wa "github.com/go-webauthn/webauthn/webauthn"
)

type webUser struct {
	ID, Email, Name string
	Credentials     []wa.Credential
}

func (u webUser) WebAuthnID() []byte   { return []byte(u.ID) }
func (u webUser) WebAuthnName() string { return u.Email }
func (u webUser) WebAuthnDisplayName() string {
	if u.Name != "" {
		return u.Name
	}
	return u.Email
}
func (u webUser) WebAuthnCredentials() []wa.Credential { return u.Credentials }
func (s *Service) webAuthn() (*wa.WebAuthn, error) {
	u, err := url.Parse(s.deps.WebURL)
	if err != nil || u.Hostname() == "" {
		return nil, errors.New("invalid Web URL")
	}
	origin := u.Scheme + "://" + u.Host
	if u.Scheme == "" {
		return nil, errors.New("Web URL must include scheme")
	}
	return wa.New(&wa.Config{RPDisplayName: "Zakura", RPID: u.Hostname(), RPOrigins: []string{origin}})
}
func (s *Service) loadWebUser(ctx context.Context, userID string) (webUser, error) {
	var u webUser
	var account models.User
	if err := s.gdb(ctx).Select("id,email,name").Where("id = ? AND status = 'active'", userID).Take(&account).Error; err != nil {
		return u, err
	}
	u.ID, u.Email, u.Name = derefString(account.ID), account.Email, derefString(account.Name)
	var stored []models.UserWebauthnCredential
	if err := s.gdb(ctx).Select("credential_id,public_key,counter,transports_json").Where("user_id = ?", userID).Order("created_at").Find(&stored).Error; err != nil {
		return u, err
	}
	for _, record := range stored {
		var cred wa.Credential
		if json.Unmarshal([]byte(record.PublicKey), &cred) != nil {
			cred.ID, _ = base64.RawURLEncoding.DecodeString(record.CredentialID)
			cred.PublicKey, _ = base64.RawURLEncoding.DecodeString(record.PublicKey)
			cred.Authenticator.SignCount = uint32(record.Counter)
			_ = json.Unmarshal([]byte(record.TransportsJSON), &cred.Transport)
		}
		u.Credentials = append(u.Credentials, cred)
	}
	return u, nil
}
func (s *Service) saveWebSession(ctx context.Context, userID, kind, parent string, session *wa.SessionData) error {
	raw, _ := json.Marshal(session)
	parentHash := ""
	if parent != "" {
		h := sha256.Sum256([]byte(parent))
		parentHash = hex.EncodeToString(h[:])
	}
	meta, _ := json.Marshal(map[string]any{"session": json.RawMessage(raw), "parentHash": parentHash})
	token := "wac_" + mustToken(24)
	h := sha256.Sum256([]byte(token))
	tokenID := s.deps.NewID()
	uid := userID
	return s.gdb(ctx).Create(&models.AuthToken{ID: &tokenID, UserID: &uid, Kind: kind, TokenHash: hex.EncodeToString(h[:]), MetaJSON: string(meta), ExpiresAt: s.deps.Clock().UTC().Add(10 * time.Minute).Format(time.RFC3339Nano), CreatedAt: s.now()}).Error
}
func (s *Service) takeWebSession(ctx context.Context, userID, kind, parent string) (wa.SessionData, error) {
	var tokens []models.AuthToken
	if err := s.gdb(ctx).Select("id,meta_json").Where("user_id = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?", userID, kind, s.now()).Order("created_at DESC").Find(&tokens).Error; err != nil {
		return wa.SessionData{}, err
	}
	parentHash := ""
	if parent != "" {
		h := sha256.Sum256([]byte(parent))
		parentHash = hex.EncodeToString(h[:])
	}
	for _, stored := range tokens {
		var meta struct {
			Session    json.RawMessage `json:"session"`
			ParentHash string          `json:"parentHash"`
		}
		if json.Unmarshal([]byte(stored.MetaJSON), &meta) != nil || meta.ParentHash != parentHash {
			continue
		}
		var session wa.SessionData
		if json.Unmarshal(meta.Session, &session) != nil {
			continue
		}
		res := s.gdb(ctx).Model(&models.AuthToken{}).Where("id = ? AND consumed_at IS NULL", derefString(stored.ID)).Update("consumed_at", s.now())
		if res.Error != nil {
			return wa.SessionData{}, res.Error
		}
		if res.RowsAffected == 1 {
			return session, nil
		}
	}
	return wa.SessionData{}, errors.New("WebAuthn challenge expired")
}

func (s *Service) beginWebAuthnRegistration(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	user, err := s.loadWebUser(r.Context(), p.UserID)
	if err != nil {
		httpx.Error(w, 404, "user not found")
		return
	}
	web, err := s.webAuthn()
	if err != nil {
		httpx.Error(w, 500, err.Error())
		return
	}
	options, session, err := web.BeginRegistration(user, wa.WithExclusions(wa.Credentials(user.Credentials).CredentialDescriptors()))
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if err = s.saveWebSession(r.Context(), user.ID, "webauthn_registration", "", session); err != nil {
		httpx.Error(w, 500, "challenge persistence failed")
		return
	}
	httpx.JSON(w, 200, options)
}
func (s *Service) finishWebAuthnRegistration(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var b struct {
		Response json.RawMessage `json:"response"`
		Name     string          `json:"name"`
	}
	if httpx.DecodeJSON(r, &b) != nil || len(b.Response) == 0 {
		httpx.Error(w, 400, "response required")
		return
	}
	user, err := s.loadWebUser(r.Context(), p.UserID)
	if err != nil {
		httpx.Error(w, 404, "user not found")
		return
	}
	session, err := s.takeWebSession(r.Context(), p.UserID, "webauthn_registration", "")
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	web, err := s.webAuthn()
	if err != nil {
		httpx.Error(w, 500, err.Error())
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, "/webauthn", bytes.NewReader(b.Response))
	req.Header.Set("Content-Type", "application/json")
	cred, err := web.FinishRegistration(user, session, req)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	stored, _ := json.Marshal(cred)
	transports, _ := json.Marshal(cred.Transport)
	id := s.deps.NewID()
	name := strings.TrimSpace(b.Name)
	if name == "" {
		name = "Passkey"
	}
	if len(name) > 40 {
		name = name[:40]
	}
	err = s.gdb(r.Context()).Create(&models.UserWebauthnCredential{ID: &id, UserID: p.UserID, CredentialID: base64.RawURLEncoding.EncodeToString(cred.ID), PublicKey: string(stored), Counter: int32(cred.Authenticator.SignCount), Name: &name, TransportsJSON: string(transports), CreatedAt: s.now()}).Error
	if err != nil {
		httpx.Error(w, 409, "credential already registered")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (s *Service) beginWebAuthnLogin(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Ticket string `json:"ticket"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "ticket required")
		return
	}
	ticket, err := s.loadTicket(r.Context(), b.Ticket, "mfa_login")
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	user, err := s.loadWebUser(r.Context(), ticket.UserID)
	if err != nil || len(user.Credentials) == 0 {
		httpx.Error(w, 400, "no passkey registered")
		return
	}
	web, err := s.webAuthn()
	if err != nil {
		httpx.Error(w, 500, err.Error())
		return
	}
	options, session, err := web.BeginLogin(user)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if err = s.saveWebSession(r.Context(), user.ID, "webauthn_login", b.Ticket, session); err != nil {
		httpx.Error(w, 500, "challenge persistence failed")
		return
	}
	httpx.JSON(w, 200, options)
}
func (s *Service) verifyWebAuthnLogin(ctx context.Context, userID, ticket string, response json.RawMessage) error {
	user, err := s.loadWebUser(ctx, userID)
	if err != nil {
		return err
	}
	session, err := s.takeWebSession(ctx, userID, "webauthn_login", ticket)
	if err != nil {
		return err
	}
	web, err := s.webAuthn()
	if err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/webauthn", bytes.NewReader(response))
	req.Header.Set("Content-Type", "application/json")
	credential, err := web.FinishLogin(user, session, req)
	if err != nil {
		return err
	}
	stored, _ := json.Marshal(credential)
	transports, _ := json.Marshal(credential.Transport)
	res := s.gdb(ctx).Model(&models.UserWebauthnCredential{}).Where("user_id = ? AND credential_id = ?", userID, base64.RawURLEncoding.EncodeToString(credential.ID)).Updates(map[string]any{"public_key": string(stored), "counter": int32(credential.Authenticator.SignCount), "transports_json": string(transports)})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected != 1 {
		return errors.New("credential not found")
	}
	return nil
}
func (s *Service) renameWebAuthnCredential(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var b struct {
		Name string `json:"name"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	name := strings.TrimSpace(b.Name)
	if name == "" {
		name = "Passkey"
	}
	if len(name) > 40 {
		name = name[:40]
	}
	res := s.gdb(r.Context()).Model(&models.UserWebauthnCredential{}).Where("id = ? AND user_id = ?", httpx.Param(r, "id"), p.UserID).Update("name", name)
	httpx.JSON(w, 200, map[string]any{"ok": res.RowsAffected == 1})
}
func (s *Service) deleteWebAuthnCredential(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var totpUser models.User
	var count, required int64
	_ = s.gdb(r.Context()).Select("totp_enabled_at").Where("id = ?", p.UserID).Take(&totpUser).Error
	_ = s.gdb(r.Context()).Model(&models.UserWebauthnCredential{}).Where("user_id = ?", p.UserID).Count(&count).Error
	_ = s.gdb(r.Context()).Table("tenant_memberships AS m").
		Joins("JOIN tenants t ON t.id = m.tenant_id").
		Where("m.user_id = ? AND m.status = 'active' AND (t.mfa_policy = 'all' OR (t.mfa_policy = 'admins' AND m.role IN ('owner','admin')))", p.UserID).
		Count(&required).Error
	if required > 0 && totpUser.TotpEnabledAt == nil && count <= 1 {
		httpx.Error(w, 409, "team policy requires at least one MFA method")
		return
	}
	res := s.gdb(r.Context()).Where("id = ? AND user_id = ?", httpx.Param(r, "id"), p.UserID).Delete(&models.UserWebauthnCredential{})
	httpx.JSON(w, 200, map[string]any{"ok": res.RowsAffected == 1})
}

var _ protocol.AuthenticatorTransport
