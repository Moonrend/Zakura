// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

type acpTerminalAuthDescriptor struct {
	Args []string          `json:"args,omitempty"`
	Env  map[string]string `json:"env,omitempty"`
}
type acpTerminalAuthTicket struct {
	acpLoginTicket
	Agent   string `json:"agent"`
	Session string `json:"session"`
	Method  string `json:"method"`
	Process string `json:"process"`
}
type acpTerminalAuthAttempt struct {
	ticket     acpTerminalAuthTicket
	descriptor acpTerminalAuthDescriptor
	target     *acpLoginTarget
	runtime    *acpLiveRuntime
	command    []string
	actor      httpx.Principal
}

var acpTerminalAuthPending = struct {
	sync.Mutex
	items map[string]*acpTerminalAuthAttempt
}{items: map[string]*acpTerminalAuthAttempt{}}

// Terminal auth is a distinct initialize descriptor: args append to the
// configured program argv, env is an object overlay, and no authenticate RPC
// may be issued for this method kind.
func acpReadTerminalAuthDescriptor(method map[string]any) (acpTerminalAuthDescriptor, error) {
	var out acpTerminalAuthDescriptor
	if method["type"] != "terminal" {
		return out, errors.New("not a terminal authentication method")
	}
	raw, err := json.Marshal(map[string]any{"args": method["args"], "env": method["env"]})
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(raw, &out); err != nil {
		return out, errors.New("invalid terminal authentication descriptor")
	}
	if len(out.Args) > 128 || len(out.Env) > 128 {
		return out, errors.New("terminal authentication descriptor exceeds limit")
	}
	for _, arg := range out.Args {
		if len(arg) > 8192 || strings.ContainsRune(arg, 0) {
			return out, errors.New("invalid terminal authentication argument")
		}
	}
	for k, v := range out.Env {
		if k == "" || len(k) > 256 || len(v) > 32768 || strings.ContainsAny(k, "=\x00") || strings.ContainsRune(v, 0) {
			return out, errors.New("invalid terminal authentication environment")
		}
	}
	return out, nil
}

func (rt *acpLiveRuntime) terminalAuthDescriptor(methodID string) (acpTerminalAuthDescriptor, error) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	select {
	case <-rt.done:
		return acpTerminalAuthDescriptor{}, errors.New("ACP runtime closed")
	default:
	}
	if rt.currentRunID != "" {
		return acpTerminalAuthDescriptor{}, errors.New("ACP runtime is active")
	}
	methods, _ := rt.state["authMethods"].([]any)
	for _, raw := range methods {
		method, _ := raw.(map[string]any)
		if method["id"] == methodID {
			return acpReadTerminalAuthDescriptor(method)
		}
	}
	return acpTerminalAuthDescriptor{}, errors.New("unsupported ACP authentication method")
}

func (h *handler) validateACPTerminalAuthPrincipal(ctx context.Context, identity, tenant, space, agent string) error {
	if !strings.HasPrefix(identity, "key:") {
		if err := h.validateACPLoginPrincipal(ctx, identity, tenant, space); err != nil {
			return err
		}
		return httpx.AuthorizeResource(ctx, h.deps, httpx.Principal{TenantID: tenant}, space, agent)
	}
	id := strings.TrimPrefix(identity, "key:")
	p := httpx.Principal{TenantID: tenant, APIKey: true, APIKeyID: id}
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
	for _, scope := range granted {
		if scope == "*" || scope == "api" {
			allowed = true
		}
	}
	if !allowed {
		return errors.New("terminal authorization is no longer valid")
	}
	if err := httpx.AuthorizeResource(ctx, h.deps, p, space, agent); err != nil {
		return err
	}
	// Login writes the shared Space profile HOME; an Agent-bound key cannot
	// elevate its session scope into shared credential mutation.
	return httpx.AuthorizeResource(ctx, h.deps, p, space, "")
}

func (h *handler) resolveACPTerminalAuth(ctx context.Context, tenant, agent, sid, method string) (*acpTerminalAuthAttempt, error) {
	if h.acp == nil {
		return nil, errors.New("ACP runtime unavailable")
	}
	sess, err := h.store.GetSession(ctx, tenant, agent, sid)
	if err != nil || sess.Kind != "acp" {
		return nil, ErrNotFound
	}
	h.acp.mu.Lock()
	rt := h.acp.runtimes[tenant+"\x00"+sid]
	h.acp.mu.Unlock()
	if rt == nil || rt.agentID != agent {
		return nil, errors.New("ACP runtime is not live")
	}
	descriptor, err := rt.terminalAuthDescriptor(method)
	if err != nil {
		return nil, err
	}
	a, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	_, cfg, err := h.acpSpace(ctx, tenant, agent, a.SpaceID)
	if err != nil {
		return nil, err
	}
	setup, ok := parseACPConfig(acpMap(cfg)).Agents[rt.profileID]
	if !ok || !setup.Enabled {
		return nil, ErrNotFound
	}
	image := acpAdapterImage(rt.profileID, setup.PinnedVersion)
	if image == "" {
		return nil, errors.New("terminal authentication requires a registry image")
	}
	runner, exec, err := h.acpSpaceRunner(ctx, tenant, a.SpaceID)
	if err != nil {
		return nil, err
	}
	if runner != rt.runner || exec.computer.ID != rt.computerID {
		return nil, errors.New("ACP runtime target changed")
	}
	launch := resolveACPLaunch(acpProfileForSetup(setup), setup)
	if strings.TrimSpace(launch.Command) == "" {
		return nil, errors.New("ACP profile command required")
	}
	baseRaw, _ := json.Marshal(struct {
		Setup acpSetup
		Image string
	}{setup, image})
	profileHash := acpLoginDigest(baseRaw)
	combined, _ := json.Marshal(struct {
		Profile, Agent, Session, Process, Method string
		Descriptor                               acpTerminalAuthDescriptor
	}{profileHash, agent, sid, rt.processID, method, descriptor})
	ticket := acpTerminalAuthTicket{acpLoginTicket: acpLoginTicket{Tenant: tenant, Space: a.SpaceID, Profile: rt.profileID, Node: exec.nodeID, Computer: exec.computer.ID, ConfigHash: acpLoginDigest(combined)}, Agent: agent, Session: sid, Method: method, Process: rt.processID}
	command := append([]string{launch.Command}, launch.Args...)
	command = append(command, descriptor.Args...)
	return &acpTerminalAuthAttempt{ticket: ticket, descriptor: descriptor, runtime: rt, command: command, target: &acpLoginTarget{ticket: ticket.acpLoginTicket, setup: setup, runner: runner, exec: exec, image: image}}, nil
}

func (h *handler) issueACPTerminalAuth(ctx context.Context, attempt *acpTerminalAuthAttempt, p httpx.Principal) (string, error) {
	ticket := attempt.ticket
	lease, err := h.acquireSpaceInfrastructure(ctx, ticket.Tenant, ticket.Space)
	if err != nil {
		return "", err
	}
	defer lease.release()
	current, err := h.resolveACPTerminalAuth(ctx, ticket.Tenant, ticket.Agent, ticket.Session, ticket.Method)
	if err != nil || current.runtime != attempt.runtime || current.ticket.ConfigHash != ticket.ConfigHash {
		return "", errors.New("ACP terminal target changed")
	}
	if p.APIKey {
		ticket.Principal = "key:" + p.APIKeyID
	} else {
		ticket.Principal = "user:" + p.UserID
	}
	if err := h.validateACPTerminalAuthPrincipal(ctx, ticket.Principal, ticket.Tenant, ticket.Space, ticket.Agent); err != nil {
		return "", err
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	ticket.Nonce = base64.RawURLEncoding.EncodeToString(nonce[:])
	ticket.Expires = h.store.now().Add(acpLoginTTL).UnixMilli()
	acpTerminalAuthPending.Lock()
	if len(acpTerminalAuthPending.items) >= 256 {
		acpTerminalAuthPending.Unlock()
		return "", errors.New("too many pending authentication terminals")
	}
	// Descriptor values stay server-side, never in tickets or API responses.
	attempt.ticket = ticket
	attempt.actor = p
	attempt.target.ticket = ticket.acpLoginTicket
	acpTerminalAuthPending.items[ticket.Nonce] = attempt
	acpTerminalAuthPending.Unlock()
	remove := func() {
		acpTerminalAuthPending.Lock()
		delete(acpTerminalAuthPending.items, ticket.Nonce)
		acpTerminalAuthPending.Unlock()
	}
	if err := h.acquireACPAuthLock(ctx, ticket.Tenant, ticket.Space, ticket.Profile, "terminal-pending", ticket.Nonce, acpLoginTTL, attempt.target.exec); err != nil {
		remove()
		return "", err
	}
	raw, _ := json.Marshal(ticket)
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, h.deps.Secret)
	_, _ = mac.Write([]byte("acp-terminal-auth:" + body))
	token := body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	_, err = h.deps.DB.ExecContext(ctx, h.deps.Rebind(`INSERT INTO runtime_connection_tickets(token_hash,principal_id,tenant_id,space_id,profile_id,node_id,computer_id,config_hash,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`), acpLoginDigest([]byte(token)), ticket.Principal, ticket.Tenant, ticket.Space, ticket.Profile, ticket.Node, ticket.Computer, ticket.ConfigHash, ticket.Expires)
	if err != nil {
		remove()
		_ = h.releaseACPAuthLock(context.WithoutCancel(ctx), ticket.Tenant, ticket.Space, ticket.Profile, ticket.Nonce)
		return "", err
	}
	// A never-attached ticket must not hold HOME for the entire shell lifetime.
	time.AfterFunc(acpLoginTTL, func() {
		acpTerminalAuthPending.Lock()
		old := acpTerminalAuthPending.items[ticket.Nonce]
		delete(acpTerminalAuthPending.items, ticket.Nonce)
		acpTerminalAuthPending.Unlock()
		if old != nil {
			releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = h.releaseACPAuthLock(releaseCtx, ticket.Tenant, ticket.Space, ticket.Profile, ticket.Nonce)
		}
	})
	return token, nil
}

func (h *handler) consumeACPTerminalAuth(ctx context.Context, token, agent, sid string) (*acpTerminalAuthAttempt, error) {
	invalid := errors.New("invalid terminal authentication ticket")
	if len(token) > 8192 {
		return nil, invalid
	}
	body, signature, ok := strings.Cut(token, ".")
	if !ok {
		return nil, invalid
	}
	given, err := base64.RawURLEncoding.DecodeString(signature)
	mac := hmac.New(sha256.New, h.deps.Secret)
	_, _ = mac.Write([]byte("acp-terminal-auth:" + body))
	if err != nil || !hmac.Equal(given, mac.Sum(nil)) {
		return nil, invalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	var ticket acpTerminalAuthTicket
	if err != nil || json.Unmarshal(raw, &ticket) != nil || ticket.Agent != agent || ticket.Session != sid || ticket.Expires <= h.store.now().UnixMilli() {
		return nil, invalid
	}
	acpTerminalAuthPending.Lock()
	attempt := acpTerminalAuthPending.items[ticket.Nonce]
	acpTerminalAuthPending.Unlock()
	if attempt == nil || attempt.ticket != ticket {
		return nil, invalid
	}
	if h.validateACPTerminalAuthPrincipal(ctx, ticket.Principal, ticket.Tenant, ticket.Space, agent) != nil {
		return nil, invalid
	}
	lease, err := h.acquireSpaceInfrastructure(ctx, ticket.Tenant, ticket.Space)
	if err != nil {
		return nil, invalid
	}
	defer lease.release()
	current, err := h.resolveACPTerminalAuth(ctx, ticket.Tenant, agent, sid, ticket.Method)
	if err != nil || current.runtime != attempt.runtime || current.ticket.ConfigHash != ticket.ConfigHash {
		return nil, invalid
	}
	// Serialize lease renewal/nonce consumption with pending-ticket expiry so
	// its timer cannot release an attached terminal's credential lease.
	acpTerminalAuthPending.Lock()
	defer acpTerminalAuthPending.Unlock()
	if acpTerminalAuthPending.items[ticket.Nonce] != attempt {
		return nil, invalid
	}
	result, err := h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE runtime_connection_tickets SET used_at=? WHERE token_hash=? AND principal_id=? AND tenant_id=? AND space_id=? AND profile_id=? AND node_id=? AND computer_id=? AND config_hash=? AND expires_at=? AND used_at IS NULL AND expires_at>?`), h.store.now().UnixMilli(), acpLoginDigest([]byte(token)), ticket.Principal, ticket.Tenant, ticket.Space, ticket.Profile, ticket.Node, ticket.Computer, ticket.ConfigHash, ticket.Expires, h.store.now().UnixMilli())
	if err != nil {
		return nil, invalid
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		return nil, invalid
	}
	delete(acpTerminalAuthPending.items, ticket.Nonce)
	if err = h.activateACPTerminalAuthLock(ctx, ticket.Tenant, ticket.Space, ticket.Profile, ticket.Nonce); err != nil {
		return nil, invalid
	}
	return attempt, nil
}

func (h *handler) acpTerminalAuthTicket(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	p := principal(r)
	agent, sid := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	var body struct {
		MethodID string `json:"methodId"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.MethodID == "" {
		httpx.Error(w, 400, "methodId required")
		return
	}
	if httpx.AuthorizeResource(r.Context(), h.deps, p, "", agent) != nil {
		httpx.Error(w, 404, "resource not found")
		return
	}
	attempt, err := h.resolveACPTerminalAuth(r.Context(), p.TenantID, agent, sid, body.MethodID)
	if err != nil {
		httpx.Error(w, 409, "terminal authentication is unavailable")
		return
	}
	token, err := h.issueACPTerminalAuth(r.Context(), attempt, p)
	if err != nil {
		httpx.Error(w, 409, "profile authentication is busy or unavailable")
		return
	}
	url := strings.TrimRight(h.deps.PublicURL, "/") + "/api/agents/" + agent + "/sessions/" + sid + "/acp/terminal-proxy?token=" + token
	if strings.HasPrefix(url, "https:") {
		url = "wss:" + strings.TrimPrefix(url, "https:")
	} else if strings.HasPrefix(url, "http:") {
		url = "ws:" + strings.TrimPrefix(url, "http:")
	}
	httpx.JSON(w, 200, map[string]any{"url": url, "ticket": token, "expiresAt": attempt.ticket.Expires})
}
