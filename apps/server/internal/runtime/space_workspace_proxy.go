// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

type spaceWorkspaceTarget struct {
	ticket    acpLoginTicket
	space     Space
	runner    *runnerSession
	container string
	remote    *remoteWorkspace
}

// Resolve the canonical workspace, never a selected execution computer or the
// first container matching a label. A server computer has no provider runtime.
func (h *handler) resolveSpaceWorkspaceTarget(ctx context.Context, tenant, space, kind string) (*spaceWorkspaceTarget, error) {
	s, err := h.store.GetSpace(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	if accepted, ok := ctx.Value(workspaceRequestTargetKey{}).(Space); ok && accepted.TenantID == tenant && accepted.ID == space && !sameWorkspaceInstance(accepted, s) {
		return nil, errors.New("workspace connection target changed")
	}
	ctx = context.WithValue(ctx, workspaceRequestTargetKey{}, s)
	if s.RuntimeNodeID == nil || *s.RuntimeNodeID == "" {
		return nil, errors.New("workspace is not configured")
	}
	if err = h.authorizeContextLocalNode(ctx, tenant, *s.RuntimeNodeID); err != nil {
		return nil, err
	}
	if kind != "terminal" && kind != "desktop" {
		return nil, errors.New("invalid workspace connection")
	}
	if kind == "desktop" && (!s.EnableComputer || s.WorkspaceKind == "host") {
		return nil, errors.New("desktop is not available")
	}
	exec, err := h.resolveServerComputer(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	if exec.nodeID != *s.RuntimeNodeID {
		return nil, errors.New("workspace computer binding is inconsistent")
	}
	runner, err := h.hub.get(exec.nodeID)
	if err != nil {
		return nil, err
	}
	container := ""
	if s.WorkspaceKind != "host" {
		obs, err := h.observeSpaceWorkspace(ctx, s)
		if err != nil {
			return nil, err
		}
		if obs.Container.DockerID == "" || obs.Container.Status != "running" {
			return nil, errors.New("workspace is not running")
		}
		container = obs.Container.DockerID
	}
	var remote *remoteWorkspace
	if exec.workspace != nil {
		remote = &remoteWorkspace{runner: runner, spaceID: space, workspace: exec.workspace, validate: func(ctx context.Context) error { return h.validateWorkspaceExecution(ctx, exec) }}
	}
	raw := rawJSON([]any{s.ID, exec.computer.ID, exec.nodeID, s.WorkspaceKind, s.WorkspaceImage, s.EnableComputer, container, exec.workspace})
	return &spaceWorkspaceTarget{space: s, runner: runner, container: container, remote: remote, ticket: acpLoginTicket{Tenant: tenant, Space: space, Profile: "workspace-" + kind, Node: exec.nodeID, Computer: exec.computer.ID, ConfigHash: acpLoginDigest(raw)}}, nil
}

func (h *handler) workspaceTicketPrincipal(ctx context.Context, identity, tenant, space string) (httpx.Principal, error) {
	p := httpx.Principal{TenantID: tenant}
	if err := h.validateACPLoginPrincipal(ctx, identity, tenant, space); err != nil {
		return p, err
	}
	if key, ok := strings.CutPrefix(identity, "key:"); ok {
		p.APIKey, p.APIKeyID = true, key
		err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COALESCE(space_id,''),COALESCE(agent_id,''),scopes FROM api_keys WHERE id=? AND tenant_id=?`), key, tenant).Scan(&p.SpaceID, &p.AgentID, &p.APIKeyScopes)
		return p, err
	}
	p.UserID = strings.TrimPrefix(identity, "user:")
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT u.is_platform_admin,m.role FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE u.id=? AND m.tenant_id=? AND u.status='active' AND m.status='active'`), p.UserID, tenant).Scan(&p.IsPlatformAdmin, &p.Role)
	return p, err
}

func (h *handler) workspaceTicketActor(ctx context.Context, ticket acpLoginTicket) (httpx.Principal, error) {
	p, err := h.workspaceTicketPrincipal(ctx, ticket.Principal, ticket.Tenant, ticket.Space)
	if err != nil {
		return p, err
	}
	if !p.APIKey {
		p.SpaceID, p.AgentID = ticket.ActorSpace, ticket.ActorAgent
		if ticket.OAuth {
			allowed := false
			for _, scope := range strings.Fields(ticket.OAuthScope) {
				allowed = allowed || scope == "api"
			}
			if !allowed || ticket.OAuthExpiry <= h.store.now().UnixMilli() {
				return p, errors.New("workspace authorization scope denied")
			}
			p.OAuth, p.OAuthScope = true, ticket.OAuthScope
			p.OAuthExpiresAt = time.UnixMilli(ticket.OAuthExpiry)
		} else {
			var active int
			if ticket.AuthSession == "" {
				return p, errors.New("workspace session required")
			}
			if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT 1 FROM user_sessions WHERE id=? AND user_id=? AND tenant_id=? AND revoked_at IS NULL AND expires_at>?`), ticket.AuthSession, p.UserID, p.TenantID, runtimeTimeString(h.store.now())).Scan(&active); err != nil {
				return p, errors.New("workspace session is no longer active")
			}
			p.SessionID = ticket.AuthSession
		}
	}
	if !computerScopeAllowed(p, ticket.Space, "") {
		return p, errors.New("workspace scope denied")
	}
	return p, httpx.AuthorizeResource(ctx, h.deps, p, ticket.Space, "")
}

func (h *handler) spaceDesktopTicket(w http.ResponseWriter, r *http.Request) {
	h.issueSpaceWorkspaceTicket(w, r, "desktop")
}

func (h *handler) issueSpaceWorkspaceTicket(w http.ResponseWriter, r *http.Request, kind string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	p := principal(r)
	space := chi.URLParam(r, "id")
	if !computerScopeAllowed(p, space, "") || httpx.AuthorizeResource(r.Context(), h.deps, p, space, "") != nil {
		httpx.Error(w, 403, "workspace scope denied")
		return
	}
	identity := "user:" + p.UserID
	if p.APIKey {
		identity = "key:" + p.APIKeyID
	}
	expires := h.store.now().Add(45 * time.Second)
	if p.OAuth {
		if p.OAuthExpiresAt.IsZero() || !p.OAuthExpiresAt.After(h.store.now()) {
			httpx.Error(w, 403, "workspace principal required")
			return
		}
		if p.OAuthExpiresAt.Before(expires) {
			expires = p.OAuthExpiresAt
		}
	}
	ticket := acpLoginTicket{Principal: identity, Tenant: p.TenantID, Space: space, AuthSession: p.SessionID, ActorSpace: p.SpaceID, ActorAgent: p.AgentID, OAuth: p.OAuth, OAuthScope: p.OAuthScope, Expires: expires.UnixMilli()}
	if p.OAuth {
		ticket.OAuthExpiry = p.OAuthExpiresAt.UnixMilli()
	}
	current, err := h.workspaceTicketActor(r.Context(), ticket)
	if err != nil {
		httpx.Error(w, 403, "workspace principal required")
		return
	}
	ctx := httpx.WithPrincipal(r.Context(), current)
	lease, err := h.acquireSpaceInfrastructure(ctx, p.TenantID, space)
	if err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	defer lease.release()
	ctx = context.WithValue(ctx, workspaceRequestTargetKey{}, lease.Space)
	target, err := h.resolveSpaceWorkspaceTarget(ctx, p.TenantID, space, kind)
	if err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	var nonce [32]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		statusErr(w, err)
		return
	}
	binding := target.ticket
	ticket.Profile, ticket.Node, ticket.Computer, ticket.ConfigHash = binding.Profile, binding.Node, binding.Computer, binding.ConfigHash
	ticket.Nonce = base64.RawURLEncoding.EncodeToString(nonce[:])
	body := base64.RawURLEncoding.EncodeToString(rawJSON(ticket))
	mac := hmac.New(sha256.New, h.deps.Secret)
	_, _ = mac.Write([]byte("space-workspace:" + body))
	token := body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	_, err = h.deps.DB.ExecContext(ctx, h.deps.Rebind(`INSERT INTO runtime_connection_tickets(token_hash,principal_id,tenant_id,space_id,profile_id,node_id,computer_id,config_hash,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`), acpLoginDigest([]byte(token)), identity, p.TenantID, space, ticket.Profile, ticket.Node, ticket.Computer, ticket.ConfigHash, ticket.Expires)
	if err != nil {
		statusErr(w, err)
		return
	}
	path := "/api/spaces/" + url.PathEscape(space) + "/desktop-proxy"
	if kind == "terminal" {
		path = "/api/spaces/" + url.PathEscape(space) + "/workspace-terminal-proxy"
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ticket": token, "url": strings.TrimRight(h.deps.PublicURL, "/") + path + "?token=" + url.QueryEscape(token)})
}

// The lease spans verification, the single-use CAS, registration and stream
// allocation. Migration cannot miss an attachment which starts after shutdown.
func (h *handler) consumeSpaceWorkspaceTicket(ctx context.Context, token, space, kind string) (*spaceWorkspaceTarget, *workspaceLease, context.Context, error) {
	invalid := errors.New("invalid or expired workspace ticket")
	if len(token) > 4096 {
		return nil, nil, ctx, invalid
	}
	body, signature, ok := strings.Cut(token, ".")
	if !ok {
		return nil, nil, ctx, invalid
	}
	given, err := base64.RawURLEncoding.DecodeString(signature)
	mac := hmac.New(sha256.New, h.deps.Secret)
	_, _ = mac.Write([]byte("space-workspace:" + body))
	if err != nil || !hmac.Equal(given, mac.Sum(nil)) {
		return nil, nil, ctx, invalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	var ticket acpLoginTicket
	if err != nil || json.Unmarshal(raw, &ticket) != nil || ticket.Space != space || ticket.Profile != "workspace-"+kind || ticket.Nonce == "" || ticket.Expires <= h.store.now().UnixMilli() {
		return nil, nil, ctx, invalid
	}
	p, err := h.workspaceTicketActor(ctx, ticket)
	if err != nil {
		return nil, nil, ctx, invalid
	}
	ctx = httpx.WithPrincipal(ctx, p)
	lease, err := h.acquireSpaceInfrastructure(ctx, ticket.Tenant, space)
	if err != nil {
		return nil, nil, ctx, invalid
	}
	fail := func() (*spaceWorkspaceTarget, *workspaceLease, context.Context, error) {
		lease.release()
		return nil, nil, ctx, invalid
	}
	ctx = context.WithValue(ctx, workspaceRequestTargetKey{}, lease.Space)
	target, err := h.resolveSpaceWorkspaceTarget(ctx, ticket.Tenant, space, kind)
	if err != nil || target.ticket.Node != ticket.Node || target.ticket.Computer != ticket.Computer || target.ticket.ConfigHash != ticket.ConfigHash {
		return fail()
	}
	result, err := h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE runtime_connection_tickets SET used_at=? WHERE token_hash=? AND principal_id=? AND tenant_id=? AND space_id=? AND profile_id=? AND node_id=? AND computer_id=? AND config_hash=? AND expires_at=? AND expires_at>? AND used_at IS NULL`), h.store.now().UnixMilli(), acpLoginDigest([]byte(token)), ticket.Principal, ticket.Tenant, space, ticket.Profile, ticket.Node, ticket.Computer, ticket.ConfigHash, ticket.Expires, h.store.now().UnixMilli())
	if err != nil {
		return fail()
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return fail()
	}
	target.ticket = ticket
	return target, lease, ctx, nil
}

func (h *handler) spaceDesktopProxy(w http.ResponseWriter, r *http.Request) {
	h.spaceWorkspaceProxy(w, r, "desktop")
}
func (h *handler) spaceTerminalProxy(w http.ResponseWriter, r *http.Request) {
	h.spaceWorkspaceProxy(w, r, "terminal")
}

func (h *handler) recheckSpaceWorkspaceConnection(ctx context.Context, target *spaceWorkspaceTarget, kind string) error {
	actor, err := h.workspaceTicketActor(ctx, target.ticket)
	if err != nil {
		return err
	}
	ctx = httpx.WithPrincipal(ctx, actor)
	if err := h.requireSpaceInfrastructureAvailable(ctx, target.ticket.Tenant, target.ticket.Space); err != nil {
		return err
	}
	current, err := h.resolveSpaceWorkspaceTarget(ctx, target.ticket.Tenant, target.ticket.Space, kind)
	if err != nil {
		return err
	}
	if current.ticket.Node != target.ticket.Node || current.ticket.Computer != target.ticket.Computer || current.ticket.ConfigHash != target.ticket.ConfigHash || current.runner != target.runner {
		return errors.New("workspace connection target changed")
	}
	return nil
}

func (h *handler) watchSpaceWorkspaceConnection(ctx context.Context, bridge *workspaceBridge, target *spaceWorkspaceTarget, kind string, ticks <-chan time.Time) {
	for {
		select {
		case <-ctx.Done():
			_ = bridge.conn.Close()
			return
		case <-bridge.done:
			return
		case <-ticks:
			check, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := h.recheckSpaceWorkspaceConnection(check, target, kind)
			cancel()
			if err != nil {
				_ = bridge.conn.Close()
				return
			}
		}
	}
}

func (h *handler) spaceWorkspaceProxy(w http.ResponseWriter, r *http.Request, kind string) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		httpx.Error(w, 426, "websocket upgrade required")
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	keyBytes, err := base64.StdEncoding.DecodeString(key)
	hijacker, ok := w.(http.Hijacker)
	if !ok || err != nil || len(keyBytes) != 16 || r.Header.Get("Sec-WebSocket-Version") != "13" {
		httpx.Error(w, 400, "invalid websocket handshake")
		return
	}
	target, lease, actorCtx, err := h.consumeSpaceWorkspaceTicket(r.Context(), r.URL.Query().Get("token"), chi.URLParam(r, "id"), kind)
	if err != nil {
		httpx.Error(w, 401, "invalid ticket")
		return
	}
	defer lease.release()
	row, err := h.beginWorkspaceConnection(actorCtx, lease, target, kind)
	if err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	var bridge *workspaceBridge
	allocationAttempted := false
	defer func() {
		confirmed := !allocationAttempted || (bridge != nil && bridge.remoteClosed)
		err := h.finishWorkspaceConnection(row, confirmed)
		if bridge != nil {
			bridge.cleanupErr = errors.Join(bridge.cleanupErr, err)
			liveWorkspaceBridges.Lock()
			delete(liveWorkspaceBridges.items, bridge)
			close(bridge.done)
			liveWorkspaceBridges.Unlock()
		}
	}()
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	acceptHash := sha1.Sum([]byte(key + wsGUID))
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(acceptHash[:]) + "\r\n\r\n")
	if rw.Flush() != nil {
		return
	}
	bridge = &workspaceBridge{conn: conn, rw: rw, done: make(chan struct{}), journalID: row.ID, streamOwner: row.StreamOwner, remote: target.remote, ready: func(id, method string) error {
		if err := h.activateWorkspaceConnection(actorCtx, lease, row, id, method); err != nil {
			return err
		}
		lease.release()
		return nil
	}}
	binding := workspaceConnectionTicket{TenantID: target.ticket.Tenant, SpaceID: target.ticket.Space, ComputerID: target.ticket.Computer, NodeID: target.ticket.Node}
	if target.remote != nil {
		binding.WorkspaceInstanceID = target.remote.workspace.Target.InstanceID
	}
	liveWorkspaceBridges.Lock()
	liveWorkspaceBridges.items[bridge] = binding
	liveWorkspaceBridges.Unlock()
	p, _ := httpx.PrincipalFrom(actorCtx)
	ctx, cancel := context.WithCancel(httpx.WithPrincipal(h.deps.RunContext(), p))
	defer cancel()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		h.watchSpaceWorkspaceConnection(ctx, bridge, target, kind, ticker.C)
	}()
	allocationAttempted = true
	if kind == "desktop" {
		h.bridgeDesktopContainer(ctx, bridge, target.runner, target.container)
	} else {
		h.bridgeTerminalContainer(ctx, bridge, target.runner, target.space.ID, target.space.WorkspaceKind, "", target.container)
	}
}
