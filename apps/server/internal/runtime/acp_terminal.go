// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

const acpLoginTTL = time.Minute
const acpLoginSessionLimit = 30 * time.Minute

type acpLoginTicket struct {
	Nonce       string `json:"nonce"`
	Principal   string `json:"principal"`
	Tenant      string `json:"tenant"`
	Space       string `json:"space"`
	Profile     string `json:"profile"`
	Node        string `json:"node"`
	Computer    string `json:"computer"`
	ConfigHash  string `json:"configHash"`
	Expires     int64  `json:"exp"`
	AuthSession string `json:"authSession,omitempty"`
	ActorSpace  string `json:"actorSpace,omitempty"`
	ActorAgent  string `json:"actorAgent,omitempty"`
	OAuth       bool   `json:"oauth,omitempty"`
	OAuthScope  string `json:"oauthScope,omitempty"`
	OAuthExpiry int64  `json:"oauthExpiry,omitempty"`
}

type acpLoginTarget struct {
	ticket acpLoginTicket
	setup  acpSetup
	runner *runnerSession
	exec   *resolvedExecution
	image  string
}

func acpLoginDigest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// resolveACPLogin needs only a Space and profile. A chat, selected tool computer,
// enabled desktop, and a live ACP protocol process are intentionally irrelevant.
func (h *handler) resolveACPLogin(ctx context.Context, tenant, space, profile string) (*acpLoginTarget, error) {
	if !acpProfileIDPattern.MatchString(profile) {
		return nil, ErrNotFound
	}
	_, cfg, err := h.acpSpace(ctx, tenant, "", space)
	if err != nil {
		return nil, err
	}
	setup, ok := parseACPConfig(acpMap(cfg)).Agents[profile]
	if !ok || !setup.Enabled {
		return nil, ErrNotFound
	}
	image := acpAdapterImage(profile, setup.PinnedVersion)
	// Do not guess a workspace image for arbitrary commands. Login containers are
	// bounded to the registry's configured adapter image.
	if image == "" || setup.Command != "" {
		return nil, errors.New("interactive login requires a registry adapter image")
	}
	runner, exec, err := h.acpSpaceRunner(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(struct {
		Setup acpSetup
		Image string
	}{setup, image})
	if err != nil {
		return nil, err
	}
	return &acpLoginTarget{setup: setup, runner: runner, exec: exec, image: image, ticket: acpLoginTicket{Tenant: tenant, Space: space, Profile: profile, Node: exec.nodeID, Computer: exec.computer.ID, ConfigHash: acpLoginDigest(raw)}}, nil
}

func (h *handler) validateACPLoginPrincipal(ctx context.Context, identity, tenant, space string) error {
	p := httpx.Principal{TenantID: tenant}
	if id, ok := strings.CutPrefix(identity, "key:"); ok && id != "" {
		var scopes string
		err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COALESCE(k.space_id,''),COALESCE(k.agent_id,''),k.scopes FROM api_keys k JOIN tenants t ON t.id=k.tenant_id WHERE k.id=? AND k.tenant_id=? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>?) AND t.status='active'`), id, tenant, h.store.now().UTC().Format(time.RFC3339Nano)).Scan(&p.SpaceID, &p.AgentID, &scopes)
		if err != nil {
			return errors.New("terminal authorization is no longer valid")
		}
		var granted []string
		if json.Unmarshal([]byte(scopes), &granted) != nil {
			return errors.New("terminal authorization is no longer valid")
		}
		allowed := false
		for _, s := range granted {
			if s == "*" || s == "api" {
				allowed = true
			}
		}
		if !allowed {
			return errors.New("terminal authorization is no longer valid")
		}
		p.APIKey, p.APIKeyID = true, id
	} else if id, ok := strings.CutPrefix(identity, "user:"); ok && id != "" {
		var active int
		err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT 1 FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND u.status='active' AND t.status='active'`), tenant, id).Scan(&active)
		if err != nil {
			return errors.New("terminal authorization is no longer valid")
		}
		p.UserID = id
	} else {
		return errors.New("terminal principal required")
	}
	return httpx.AuthorizeResource(ctx, h.deps, p, space, "")
}

func (h *handler) issueACPLoginTicket(ctx context.Context, target *acpLoginTarget, p httpx.Principal) (string, error) {
	ticket := target.ticket
	if p.TenantID != ticket.Tenant {
		return "", errors.New("terminal authorization is no longer valid")
	}
	if p.APIKey {
		ticket.Principal = "key:" + p.APIKeyID
	} else {
		ticket.Principal = "user:" + p.UserID
	}
	ticket.AuthSession, ticket.ActorSpace, ticket.ActorAgent = p.SessionID, p.SpaceID, p.AgentID
	ticket.OAuth, ticket.OAuthScope = p.OAuth, p.OAuthScope
	expires := h.store.now().Add(acpLoginTTL)
	if p.OAuth {
		ticket.OAuthExpiry = p.OAuthExpiresAt.UnixMilli()
		if p.OAuthExpiresAt.Before(expires) {
			expires = p.OAuthExpiresAt
		}
	}
	ticket.Expires = expires.UnixMilli()
	actor, err := h.workspaceTicketActor(ctx, ticket)
	if err != nil {
		return "", err
	}
	ctx = httpx.WithPrincipal(ctx, actor)
	lease, err := h.acquireSpaceInfrastructure(ctx, ticket.Tenant, ticket.Space)
	if err != nil {
		return "", err
	}
	defer lease.release()
	current, err := h.resolveACPLogin(ctx, ticket.Tenant, ticket.Space, ticket.Profile)
	if err != nil || current.ticket != target.ticket {
		return "", errors.New("ACP login target changed")
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	ticket.Nonce = base64.RawURLEncoding.EncodeToString(nonce[:])
	raw, err := json.Marshal(ticket)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, h.deps.Secret)
	_, _ = mac.Write([]byte("acp-terminal:" + body))
	token := body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if err = h.acquireACPAuthLock(ctx, ticket.Tenant, ticket.Space, ticket.Profile, "terminal-pending", ticket.Nonce, acpLoginTTL, target.exec); err != nil {
		return "", err
	}
	_, err = h.deps.DB.ExecContext(ctx, h.deps.Rebind(`INSERT INTO runtime_connection_tickets(token_hash,principal_id,tenant_id,space_id,profile_id,node_id,computer_id,config_hash,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`), acpLoginDigest([]byte(token)), ticket.Principal, ticket.Tenant, ticket.Space, ticket.Profile, ticket.Node, ticket.Computer, ticket.ConfigHash, ticket.Expires)
	if err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.releaseACPAuthLock(cleanupCtx, ticket.Tenant, ticket.Space, ticket.Profile, ticket.Nonce)
		return "", err
	}
	// Opportunistic cleanup touches only expired nonce records, never containers.
	_, _ = h.deps.DB.ExecContext(ctx, h.deps.Rebind(`DELETE FROM runtime_connection_tickets WHERE expires_at<?`), h.store.now().Add(-time.Hour).UnixMilli())
	return token, nil
}

func (h *handler) consumeACPLoginTicket(ctx context.Context, token, space, profile string) (*acpLoginTarget, error) {
	invalid := errors.New("invalid or expired terminal ticket")
	if len(token) > 4096 {
		return nil, invalid
	}
	body, signature, ok := strings.Cut(token, ".")
	if !ok {
		return nil, invalid
	}
	given, err := base64.RawURLEncoding.DecodeString(signature)
	mac := hmac.New(sha256.New, h.deps.Secret)
	_, _ = mac.Write([]byte("acp-terminal:" + body))
	if err != nil || !hmac.Equal(given, mac.Sum(nil)) {
		return nil, invalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	var ticket acpLoginTicket
	if err != nil || json.Unmarshal(raw, &ticket) != nil || ticket.Space != space || ticket.Profile != profile || ticket.Nonce == "" || ticket.Expires <= h.store.now().UnixMilli() {
		return nil, invalid
	}
	actor, err := h.workspaceTicketActor(ctx, ticket)
	if err != nil {
		return nil, invalid
	}
	ctx = httpx.WithPrincipal(ctx, actor)
	lease, err := h.acquireSpaceInfrastructure(ctx, ticket.Tenant, space)
	if err != nil {
		return nil, invalid
	}
	defer lease.release()
	target, err := h.resolveACPLogin(ctx, ticket.Tenant, space, profile)
	if err != nil || target.ticket.Node != ticket.Node || target.ticket.Computer != ticket.Computer || target.ticket.ConfigHash != ticket.ConfigHash {
		return nil, invalid
	}
	result, err := h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE runtime_connection_tickets SET used_at=? WHERE token_hash=? AND principal_id=? AND tenant_id=? AND space_id=? AND profile_id=? AND node_id=? AND computer_id=? AND config_hash=? AND expires_at=? AND expires_at>? AND used_at IS NULL`), h.store.now().UnixMilli(), acpLoginDigest([]byte(token)), ticket.Principal, ticket.Tenant, space, profile, ticket.Node, ticket.Computer, ticket.ConfigHash, ticket.Expires, h.store.now().UnixMilli())
	if err != nil {
		return nil, invalid
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return nil, invalid
	}
	if err := h.activateACPTerminalAuthLock(ctx, ticket.Tenant, ticket.Space, ticket.Profile, ticket.Nonce); err != nil {
		return nil, invalid
	}
	target.ticket = ticket
	return target, nil
}

func (h *handler) acpTerminalTicket(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	p := principal(r)
	space, profile := chi.URLParam(r, "spaceId"), chi.URLParam(r, "profileId")
	if !computerScopeAllowed(p, space, "") || httpx.AuthorizeResource(r.Context(), h.deps, p, space, "") != nil {
		httpx.Error(w, http.StatusNotFound, "resource not found")
		return
	}
	target, err := h.resolveACPLogin(r.Context(), p.TenantID, space, profile)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "ACP login terminal is unavailable")
		return
	}
	token, err := h.issueACPLoginTicket(r.Context(), target, p)
	if err != nil {
		httpx.Error(w, http.StatusForbidden, "terminal authorization is unavailable")
		return
	}
	url := strings.TrimRight(h.deps.PublicURL, "/") + "/api/spaces/" + space + "/acp/agents/" + profile + "/terminal-proxy?token=" + token
	if strings.HasPrefix(url, "https:") {
		url = "wss:" + strings.TrimPrefix(url, "https:")
	} else if strings.HasPrefix(url, "http:") {
		url = "ws:" + strings.TrimPrefix(url, "http:")
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"url": url, "ticket": token, "expiresAt": h.store.now().Add(acpLoginTTL).UnixMilli()})
}

func (h *handler) acpTerminalProxy(w http.ResponseWriter, r *http.Request) {
	// Reject non-upgrades before consuming the single-use nonce.
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		httpx.Error(w, http.StatusUpgradeRequired, "websocket upgrade required")
		return
	}
	key, err := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	hijacker, ok := w.(http.Hijacker)
	if err != nil || len(key) != 16 || !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid websocket handshake")
		return
	}
	target, err := h.consumeACPLoginTicket(r.Context(), r.URL.Query().Get("token"), chi.URLParam(r, "spaceId"), chi.URLParam(r, "profileId"))
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid terminal ticket")
		return
	}
	bridgeStarted := false
	defer func() {
		if bridgeStarted {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.releaseACPAuthLock(cleanupCtx, target.ticket.Tenant, target.ticket.Space, target.ticket.Profile, target.ticket.Nonce)
	}()
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	acceptHash := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + wsGUID))
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(acceptHash[:]) + "\r\n\r\n")
	if rw.Flush() != nil {
		return
	}
	bridge := &workspaceBridge{conn: conn, rw: rw}
	ctx, cancel := context.WithTimeout(h.deps.RunContext(), acpLoginSessionLimit)
	defer cancel()
	go func() { <-ctx.Done(); _ = conn.Close() }()
	bridgeStarted = true
	h.bridgeACPLogin(ctx, bridge, target)
}
