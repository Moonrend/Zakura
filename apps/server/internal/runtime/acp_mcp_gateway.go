// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

const acpMCPGrantTTL = 10 * time.Minute

type acpMCPGrant struct {
	runtime                                *acpLiveRuntime
	process, tenant, space, agent, session string
	actor                                  httpx.Principal
	persistedActor                         bool
	expires                                time.Time
}

func acpMCPHash(raw string) string {
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])
}

// The original identity is checked again on every gateway request. Never turn
// an unknown background caller into a tenant owner or a broad API key.
func (rt *acpLiveRuntime) currentMCPActor(ctx context.Context, source httpx.Principal, persisted bool) (httpx.Principal, error) {
	actor, err := rt.currentACPActor(ctx, source, persisted, "mcp")
	if err != nil {
		return httpx.Principal{}, err
	}
	// This principal only enters the MCP handler, never ordinary API middleware.
	actor.APIKey, actor.OAuth = true, false
	actor.APIKeyScopes = `["mcp"]`
	actor.SpaceID, actor.AgentID = rt.spaceID, rt.agentID
	return actor, nil
}

func (rt *acpLiveRuntime) currentACPActor(ctx context.Context, source httpx.Principal, persisted bool, scope string) (httpx.Principal, error) {
	h := rt.manager.h
	invalid := errors.New("ACP MCP delegation requires a currently authorized original actor")
	if source.OAuth {
		allowed := false
		for _, granted := range strings.Fields(source.OAuthScope) {
			allowed = allowed || granted == scope || granted == "api"
		}
		if persisted || source.OAuthExpiresAt.IsZero() || !source.OAuthExpiresAt.After(h.store.now()) || !allowed {
			return httpx.Principal{}, errors.New("ACP MCP OAuth source expired or lacks MCP scope; reopen with valid authorization")
		}
	}
	if source.TenantID != rt.tenantID {
		return httpx.Principal{}, invalid
	}
	sess, err := h.store.GetSession(ctx, rt.tenantID, rt.agentID, rt.sid)
	if err != nil || sess.Kind != "acp" {
		return httpx.Principal{}, invalid
	}
	if source.APIKey {
		if source.APIKeyID == "" || persisted {
			return httpx.Principal{}, invalid
		}
		var owner string
		current := httpx.Principal{TenantID: rt.tenantID, APIKey: true, APIKeyID: source.APIKeyID}
		err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COALESCE(k.user_id,''),COALESCE(k.space_id,''),COALESCE(k.agent_id,''),k.scopes FROM api_keys k JOIN tenants t ON t.id=k.tenant_id WHERE k.id=? AND k.tenant_id=? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>?) AND t.status='active'`), source.APIKeyID, rt.tenantID, runtimeTimeString(h.store.now())).Scan(&owner, &current.SpaceID, &current.AgentID, &current.APIKeyScopes)
		if err != nil || current.SpaceID != source.SpaceID || current.AgentID != source.AgentID || !apiKeyScopeAllows(current, scope) {
			return httpx.Principal{}, invalid
		}
		if err := httpx.AuthorizeResource(ctx, h.deps, current, rt.spaceID, rt.agentID); err != nil {
			return httpx.Principal{}, invalid
		}
		source = current
		source.UserID = owner
	} else {
		if source.UserID == "" || persisted && (sess.CreatedByUserID == nil || *sess.CreatedByUserID != source.UserID) {
			return httpx.Principal{}, invalid
		}
		if !persisted && source.SessionID != "" {
			var valid int
			if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT 1 FROM user_sessions WHERE id=? AND user_id=? AND tenant_id=? AND revoked_at IS NULL AND expires_at>?`), source.SessionID, source.UserID, rt.tenantID, runtimeTimeString(h.store.now())).Scan(&valid); err != nil {
				return httpx.Principal{}, invalid
			}
		}
		if err := httpx.AuthorizeResource(ctx, h.deps, source, rt.spaceID, rt.agentID); err != nil {
			return httpx.Principal{}, invalid
		}
	}
	if source.UserID != "" {
		if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT m.role,u.email,u.is_platform_admin FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND u.status='active' AND t.status='active'`), rt.tenantID, source.UserID).Scan(&source.Role, &source.Email, &source.IsPlatformAdmin); err != nil {
			return httpx.Principal{}, invalid
		}
	}
	a, err := h.store.GetAgent(ctx, rt.tenantID, rt.agentID)
	if err != nil || a.SpaceID != rt.spaceID {
		return httpx.Principal{}, invalid
	}
	return source, nil
}

func sameACPMCPActor(a, b httpx.Principal) bool {
	return a.TenantID == b.TenantID && a.UserID == b.UserID && a.APIKey == b.APIKey && a.APIKeyID == b.APIKeyID && a.OAuth == b.OAuth && a.SessionID == b.SessionID && a.SpaceID == b.SpaceID && a.AgentID == b.AgentID && a.OAuthExpiresAt.Equal(b.OAuthExpiresAt)
}

// Cache and in-flight reuse must not lend the original actor's tools to another
// caller. Missing background identity can only revalidate this grant's source.
func (rt *acpLiveRuntime) validateMCPCaller(ctx context.Context) error {
	m := rt.manager
	m.mu.Lock()
	hash := rt.mcpGrantHash
	grant := m.mcpGrants[hash]
	m.mu.Unlock()
	if hash == "" {
		return nil // no MCP was attached: retain existing adapter behavior
	}
	if grant == nil || !grant.expires.After(m.h.store.now()) {
		return errors.New("ACP MCP grant expired; reopen the ACP session to reconnect tools")
	}
	if caller, exists := httpx.PrincipalFrom(ctx); exists && !sameACPMCPActor(caller, grant.actor) {
		return errors.New("ACP MCP original actor changed; reopen the runtime")
	}
	_, err := rt.currentMCPActor(ctx, grant.actor, grant.persistedActor)
	return err
}

func (rt *acpLiveRuntime) revokeMCPGrant() {
	m := rt.manager
	m.mu.Lock()
	delete(m.mcpGrants, rt.mcpGrantHash)
	rt.mcpGrantHash = ""
	m.mu.Unlock()
}

func (rt *acpLiveRuntime) mcpSessionServers(ctx context.Context) ([]any, error) {
	h := rt.manager.h
	rt.revokeMCPGrant()
	// Preserve no-MCP adapters and tests, without requiring an invented actor.
	var count int
	if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COUNT(*) FROM component_instances i JOIN agent_bindings b ON b.tenant_id=i.tenant_id AND b.instance_id=i.id WHERE i.tenant_id=? AND b.space_id=? AND b.agent_id IS NULL AND i.component_type='mcp' AND i.status IN ('ready','running')`), rt.tenantID, rt.spaceID).Scan(&count); err != nil {
		return nil, err
	}
	if count == 0 {
		return []any{}, nil
	}
	var actor httpx.Principal
	persisted := false
	if current, exists := httpx.PrincipalFrom(ctx); exists {
		// Never borrow the creator/previous actor when an explicit caller fails.
		actor = current
		if rt.mcpActor != nil && !sameACPMCPActor(current, *rt.mcpActor) {
			return nil, errors.New("ACP MCP original actor changed; reopen the runtime")
		}
	} else if rt.mcpActor != nil {
		actor = *rt.mcpActor
	} else {
		sess, err := h.store.GetSession(ctx, rt.tenantID, rt.agentID, rt.sid)
		if err != nil || sess.CreatedByUserID == nil || *sess.CreatedByUserID == "" {
			return nil, errors.New("ACP Space MCP unavailable: background session has no reliable actor")
		}
		actor = httpx.Principal{TenantID: rt.tenantID, UserID: *sess.CreatedByUserID}
		persisted = true
	}
	principal, err := rt.currentMCPActor(ctx, actor, persisted)
	if err != nil {
		return nil, err
	}
	req, _ := http.NewRequestWithContext(httpx.WithPrincipal(ctx, principal), http.MethodPost, "/internal/acp/mcp", nil)
	instances, err := h.accessibleMCPInstances(req, principal, rt.spaceID)
	if err != nil {
		return nil, err
	}
	if len(instances) == 0 {
		return []any{}, nil
	}
	if !rt.mcpHTTP {
		return nil, errors.New("ACP adapter lacks HTTP MCP capability; configured Space MCP cannot be attached")
	}
	base, err := url.Parse(h.deps.PublicURL)
	if err != nil || !base.IsAbs() || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || (base.Scheme != "https" && base.Scheme != "http") {
		return nil, errors.New("ACP MCP requires a configured runner-reachable PublicURL")
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, errors.New("ACP MCP grant creation failed")
	}
	raw := "acpm_" + base64.RawURLEncoding.EncodeToString(secret[:])
	hash := acpMCPHash(raw)
	expires := h.store.now().Add(acpMCPGrantTTL)
	if actor.OAuth && actor.OAuthExpiresAt.Before(expires) {
		expires = actor.OAuthExpiresAt
	}
	grant := &acpMCPGrant{runtime: rt, process: rt.processID, tenant: rt.tenantID, space: rt.spaceID, agent: rt.agentID, session: rt.sid, actor: actor, persistedActor: persisted, expires: expires}
	m := rt.manager
	m.mu.Lock()
	select {
	case <-rt.done:
		m.mu.Unlock()
		return nil, errors.New("ACP runtime closed")
	default:
	}
	if m.mcpGrants == nil {
		m.mcpGrants = map[string]*acpMCPGrant{}
	}
	for key, old := range m.mcpGrants {
		if !old.expires.After(h.store.now()) {
			delete(m.mcpGrants, key)
		}
	}
	m.mcpGrants[hash], rt.mcpGrantHash = grant, hash
	m.mu.Unlock()
	gateway := strings.TrimRight(h.deps.PublicURL, "/") + "/mcp/acp/" + url.PathEscape(rt.sid)
	return []any{map[string]any{"type": "http", "name": "zakura", "url": gateway, "headers": []any{map[string]any{"name": "Authorization", "value": "Bearer " + raw}}}}, nil
}

func (h *handler) acpMCPGateway(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	deny := func() {
		httpx.Error(w, http.StatusUnauthorized, "invalid or expired ACP MCP grant; reopen the ACP session to reconnect tools")
	}
	parts := strings.Fields(r.Header.Get("Authorization"))
	if h.acp == nil || len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || !strings.HasPrefix(parts[1], "acpm_") || len(parts[1]) > 128 {
		deny()
		return
	}
	m := h.acp
	m.mu.Lock()
	grant := m.mcpGrants[acpMCPHash(parts[1])]
	m.mu.Unlock()
	if grant == nil || !grant.expires.After(h.store.now()) || chi.URLParam(r, "sessionId") != grant.session {
		deny()
		return
	}
	// Check map ownership again after DB revalidation below: close/rotation may
	// revoke this grant while an authorization query is in flight.
	rt := grant.runtime
	if rt.manager != m || rt.processID != grant.process || rt.tenantID != grant.tenant || rt.spaceID != grant.space || rt.agentID != grant.agent || rt.sid != grant.session {
		deny()
		return
	}
	select {
	case <-rt.done:
		deny()
		return
	default:
	}
	actor, err := rt.currentMCPActor(r.Context(), grant.actor, grant.persistedActor)
	if err != nil {
		deny()
		return
	}
	space, err := h.store.GetSpace(r.Context(), grant.tenant, grant.space)
	if err != nil {
		deny()
		return
	}
	m.mu.Lock()
	stillValid := m.mcpGrants[acpMCPHash(parts[1])] == grant && grant.expires.After(h.store.now())
	m.mu.Unlock()
	if !stillValid {
		deny()
		return
	}
	// Only this exact route recognizes acpm_ grants. Forward in-process to the
	// SAME handler; current policies, bindings, encrypted credentials and audit
	// remain owned by the existing MCP path. No upstream secret reaches ACP.
	forward := r.Clone(httpx.WithPrincipal(r.Context(), actor))
	u := *r.URL
	u.Path, u.RawPath = "/mcp/spaces/"+space.Slug, ""
	forward.URL = &u
	forward.Header = r.Header.Clone()
	forward.Header.Del("Authorization")
	h.mcpServer(w, forward)
}
