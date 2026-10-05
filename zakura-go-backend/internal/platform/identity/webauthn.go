package identity

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	wa "github.com/go-webauthn/webauthn/webauthn"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
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
	if err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,email,COALESCE(name,'') FROM users WHERE id=? AND status='active'`), userID).Scan(&u.ID, &u.Email, &u.Name); err != nil {
		return u, err
	}
	rows, err := s.deps.DB.QueryContext(ctx, s.q(`SELECT credential_id,public_key,counter,transports_json FROM user_webauthn_credentials WHERE user_id=? ORDER BY created_at`), userID)
	if err != nil {
		return u, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, stored, transports string
		var counter uint32
		if err = rows.Scan(&id, &stored, &counter, &transports); err != nil {
			return u, err
		}
		var cred wa.Credential
		if json.Unmarshal([]byte(stored), &cred) != nil {
			cred.ID, _ = base64.RawURLEncoding.DecodeString(id)
			cred.PublicKey, _ = base64.RawURLEncoding.DecodeString(stored)
			cred.Authenticator.SignCount = counter
			_ = json.Unmarshal([]byte(transports), &cred.Transport)
		}
		u.Credentials = append(u.Credentials, cred)
	}
	return u, rows.Err()
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
	_, err := s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO auth_tokens(id,user_id,kind,token_hash,meta_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?)`), s.deps.NewID(), userID, kind, hex.EncodeToString(h[:]), string(meta), s.deps.Clock().UTC().Add(10*time.Minute).Format(time.RFC3339Nano), s.now())
	return err
}
func (s *Service) takeWebSession(ctx context.Context, userID, kind, parent string) (wa.SessionData, error) {
	rows, err := s.deps.DB.QueryContext(ctx, s.q(`SELECT id,meta_json FROM auth_tokens WHERE user_id=? AND kind=? AND consumed_at IS NULL AND expires_at>? ORDER BY created_at DESC`), userID, kind, s.now())
	if err != nil {
		return wa.SessionData{}, err
	}
	defer rows.Close()
	parentHash := ""
	if parent != "" {
		h := sha256.Sum256([]byte(parent))
		parentHash = hex.EncodeToString(h[:])
	}
	for rows.Next() {
		var id, metaRaw string
		if rows.Scan(&id, &metaRaw) != nil {
			continue
		}
		var meta struct {
			Session    json.RawMessage `json:"session"`
			ParentHash string          `json:"parentHash"`
		}
		if json.Unmarshal([]byte(metaRaw), &meta) != nil || meta.ParentHash != parentHash {
			continue
		}
		var session wa.SessionData
		if json.Unmarshal(meta.Session, &session) != nil {
			continue
		}
		res, err := s.deps.DB.ExecContext(ctx, s.q(`UPDATE auth_tokens SET consumed_at=? WHERE id=? AND consumed_at IS NULL`), s.now(), id)
		if err != nil {
			return wa.SessionData{}, err
		}
		n, _ := res.RowsAffected()
		if n == 1 {
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
	_, err = s.deps.DB.ExecContext(r.Context(), s.q(`INSERT INTO user_webauthn_credentials(id,user_id,credential_id,public_key,counter,name,transports_json,created_at) VALUES(?,?,?,?,?,?,?,?)`), id, p.UserID, base64.RawURLEncoding.EncodeToString(cred.ID), string(stored), cred.Authenticator.SignCount, name, string(transports), s.now())
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
	res, err := s.deps.DB.ExecContext(ctx, s.q(`UPDATE user_webauthn_credentials SET public_key=?,counter=?,transports_json=? WHERE user_id=? AND credential_id=?`), string(stored), credential.Authenticator.SignCount, string(transports), userID, base64.RawURLEncoding.EncodeToString(credential.ID))
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n != 1 {
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
	res, _ := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE user_webauthn_credentials SET name=? WHERE id=? AND user_id=?`), name, httpx.Param(r, "id"), p.UserID)
	n, _ := res.RowsAffected()
	httpx.JSON(w, 200, map[string]any{"ok": n == 1})
}
func (s *Service) deleteWebAuthnCredential(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var totp sql.NullString
	var count, required int
	_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT totp_enabled_at FROM users WHERE id=?`), p.UserID).Scan(&totp)
	_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT COUNT(*) FROM user_webauthn_credentials WHERE user_id=?`), p.UserID).Scan(&count)
	_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT COUNT(*) FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.status='active' AND (t.mfa_policy='all' OR (t.mfa_policy='admins' AND m.role IN ('owner','admin')))`), p.UserID).Scan(&required)
	if required > 0 && !totp.Valid && count <= 1 {
		httpx.Error(w, 409, "team policy requires at least one MFA method")
		return
	}
	res, _ := s.deps.DB.ExecContext(r.Context(), s.q(`DELETE FROM user_webauthn_credentials WHERE id=? AND user_id=?`), httpx.Param(r, "id"), p.UserID)
	n, _ := res.RowsAffected()
	httpx.JSON(w, 200, map[string]any{"ok": n == 1})
}

var _ protocol.AuthenticatorTransport
