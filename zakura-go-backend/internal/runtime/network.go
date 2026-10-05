// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

func (h *handler) registerNetwork(r chi.Router) {
	r.Get("/settings/network/security", h.getNetworkSecurity)
	r.Put("/settings/network/security", h.putNetworkSecurity)
	r.Get("/settings/network/audit", h.networkAudit)
	r.Get("/settings/network/exposure/providers", h.listExposureProviders)
	r.Patch("/settings/network/exposure/providers/{id}", h.patchExposureProvider)
	r.Post("/settings/network/exposure/providers/{id}/test", h.testExposureProvider)
	r.Post("/settings/network/exposure/providers/cloudflare-named/create-tunnel", h.createCloudflareTunnel)
	r.Get("/settings/network/active-exposures", h.activeExposures)
	r.Post("/settings/network/active-exposures/stop-all", h.stopAllExposures)
	r.Get("/agents/{id}/exposures", h.agentExposures)
	r.Post("/agents/{id}/exposures", h.createExposure)
	r.Delete("/exposures/{id}", h.deleteExposure)
	r.Get("/settings/network/overview", h.networkOverview)
	r.Get("/settings/network/mesh", h.networkMesh)
	r.Get("/settings/network/headscale", h.getHeadscale)
	r.Put("/settings/network/headscale", h.putHeadscale)
	r.Post("/settings/network/mesh/sync", h.syncMesh)
	r.Post("/settings/network/mesh/disconnect", h.disconnectMesh)
	r.Post("/settings/network/mesh/platform/enable", h.enablePlatformMesh)
	r.Post("/settings/network/mesh/auth-key", h.createMeshAuthKey)
	r.Post("/settings/network/mesh/auth-key/generate", h.createMeshAuthKey)
	r.Post("/settings/network/mesh/acl/ensure-tags", h.ensureMeshACL)
	r.Post("/settings/network/mesh/oauth/start", h.meshOAuthStart)
	r.Post("/settings/network/mesh/oauth/connect", h.meshOAuthConnect)
	r.Patch("/settings/network/mesh/oauth/tags", h.meshOAuthTags)
}
func defaultPolicy() map[string]any {
	return map[string]any{"enabled": true, "exposureEnabled": true, "defaultTtlMinutes": 60, "maxTtlMinutes": 1440, "maxActivePerAgent": 3, "maxActivePerTenant": 50, "deniedPorts": []int{22, 2375, 2376, 5432, 6379, 27017, 5900, 6080, 9222, 8787, 7443}, "allowDesktopExposure": false, "allowPublicExposure": true, "allowTcpExposure": false, "agentsCanExpose": true, "requireUserApproval": false, "requireTailscaleForRemoteRunners": false, "auditRetentionDays": 90}
}
func (h *handler) readPolicy(r *http.Request) (map[string]any, error) {
	p := principal(r)
	var enabled, exposure bool
	var def, max, perAgent, perTenant, retention int
	var denied string
	var desktop, pub, tcp, agents, approval, tailscale bool
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT enabled,exposure_enabled,default_ttl_minutes,max_ttl_minutes,max_active_per_agent,max_active_per_tenant,denied_ports_json,allow_desktop_exposure,allow_public_exposure,allow_tcp_exposure,agents_can_expose,require_user_approval,require_tailscale_for_remote_runners,audit_retention_days FROM network_security_policies WHERE tenant_id=? AND scope='tenant'`), p.TenantID).Scan(&enabled, &exposure, &def, &max, &perAgent, &perTenant, &denied, &desktop, &pub, &tcp, &agents, &approval, &tailscale, &retention)
	if errors.Is(e, sql.ErrNoRows) {
		return defaultPolicy(), nil
	}
	if e != nil {
		return nil, e
	}
	return map[string]any{"enabled": enabled, "exposureEnabled": exposure, "defaultTtlMinutes": def, "maxTtlMinutes": max, "maxActivePerAgent": perAgent, "maxActivePerTenant": perTenant, "deniedPorts": json.RawMessage(denied), "allowDesktopExposure": desktop, "allowPublicExposure": pub, "allowTcpExposure": tcp, "agentsCanExpose": agents, "requireUserApproval": approval, "requireTailscaleForRemoteRunners": tailscale, "auditRetentionDays": retention}, nil
}
func (h *handler) getNetworkSecurity(w http.ResponseWriter, r *http.Request) {
	x, e := h.readPolicy(r)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"policy": x})
}
func (h *handler) putNetworkSecurity(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Enabled, ExposureEnabled                                                                                                            bool
		DefaultTtlMinutes, MaxTtlMinutes, MaxActivePerAgent, MaxActivePerTenant                                                             int
		DeniedPorts                                                                                                                         []int
		AllowDesktopExposure, AllowPublicExposure, AllowTcpExposure, AgentsCanExpose, RequireUserApproval, RequireTailscaleForRemoteRunners bool
		AuditRetentionDays                                                                                                                  int
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if b.DefaultTtlMinutes < 1 {
		b.DefaultTtlMinutes = 60
	}
	if b.MaxTtlMinutes < b.DefaultTtlMinutes {
		b.MaxTtlMinutes = 1440
	}
	if b.MaxActivePerAgent < 1 {
		b.MaxActivePerAgent = 3
	}
	if b.MaxActivePerTenant < 1 {
		b.MaxActivePerTenant = 50
	}
	if b.AuditRetentionDays < 1 {
		b.AuditRetentionDays = 90
	}
	denied, _ := json.Marshal(b.DeniedPorts)
	p := principal(r)
	now := h.store.now()
	_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO network_security_policies(id,tenant_id,scope,enabled,exposure_enabled,default_ttl_minutes,max_ttl_minutes,max_active_per_agent,max_active_per_tenant,denied_ports_json,allow_desktop_exposure,allow_public_exposure,allow_tcp_exposure,agents_can_expose,require_user_approval,require_tailscale_for_remote_runners,audit_retention_days,updated_by,created_at,updated_at) VALUES(?,?,'tenant',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,scope) DO UPDATE SET enabled=?,exposure_enabled=?,default_ttl_minutes=?,max_ttl_minutes=?,max_active_per_agent=?,max_active_per_tenant=?,denied_ports_json=?,allow_desktop_exposure=?,allow_public_exposure=?,allow_tcp_exposure=?,agents_can_expose=?,require_user_approval=?,require_tailscale_for_remote_runners=?,audit_retention_days=?,updated_by=?,updated_at=?`), h.store.id(), p.TenantID, b.Enabled, b.ExposureEnabled, b.DefaultTtlMinutes, b.MaxTtlMinutes, b.MaxActivePerAgent, b.MaxActivePerTenant, string(denied), b.AllowDesktopExposure, b.AllowPublicExposure, b.AllowTcpExposure, b.AgentsCanExpose, b.RequireUserApproval, b.RequireTailscaleForRemoteRunners, b.AuditRetentionDays, p.UserID, now, now, b.Enabled, b.ExposureEnabled, b.DefaultTtlMinutes, b.MaxTtlMinutes, b.MaxActivePerAgent, b.MaxActivePerTenant, string(denied), b.AllowDesktopExposure, b.AllowPublicExposure, b.AllowTcpExposure, b.AgentsCanExpose, b.RequireUserApproval, b.RequireTailscaleForRemoteRunners, b.AuditRetentionDays, p.UserID, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	h.auditNetwork(r, "security.update", "policy", "tenant", map[string]any{"deniedPorts": b.DeniedPorts})
	h.getNetworkSecurity(w, r)
}
func (h *handler) auditNetwork(r *http.Request, action, targetType, targetID string, detail any) {
	raw, _ := json.Marshal(detail)
	p := principal(r)
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO network_audit_logs(id,tenant_id,actor_type,actor_id,action,target_type,target_id,detail_json,ip,created_at) VALUES(?,?,'user',?,?,?,?,?,?,?)`), h.store.id(), p.TenantID, p.UserID, action, targetType, targetID, string(raw), r.RemoteAddr, h.store.now())
}
func (h *handler) networkAudit(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,actor_type,actor_id,action,target_type,target_id,detail_json,ip,created_at FROM network_audit_logs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 500`), principal(r).TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, actorType, action, detail, created string
		var actor, targetType, target, ip *string
		if rows.Scan(&id, &actorType, &actor, &action, &targetType, &target, &detail, &ip, &created) == nil {
			out = append(out, map[string]any{"id": id, "actorType": actorType, "actorId": actor, "action": action, "targetType": targetType, "targetId": target, "detail": json.RawMessage(detail), "ip": ip, "createdAt": created})
		}
	}
	httpx.JSON(w, 200, map[string]any{"items": out})
}
func (h *handler) listExposureProviders(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,provider,enabled,is_default,last_test_at,last_test_ok,last_error,created_at,updated_at FROM tunnel_provider_settings WHERE tenant_id=? ORDER BY provider`), principal(r).TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, provider, c, u string
		var enabled, def bool
		var testAt, lastErr *string
		var testOK *bool
		if rows.Scan(&id, &provider, &enabled, &def, &testAt, &testOK, &lastErr, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "provider": provider, "enabled": enabled, "isDefault": def, "lastTestAt": testAt, "lastTestOk": testOK, "lastError": lastErr, "createdAt": c, "updatedAt": u})
		}
	}
	httpx.JSON(w, 200, map[string]any{"providers": out})
}
func (h *handler) patchExposureProvider(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	provider := chi.URLParam(r, "id")
	var b struct {
		Enabled, IsDefault bool
		Config             json.RawMessage
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	enc, e := secretBox(h.deps.Secret, "tunnel:"+p.TenantID+":"+provider, b.Config)
	if e != nil {
		statusErr(w, e)
		return
	}
	now := h.store.now()
	if b.IsDefault {
		_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE tunnel_provider_settings SET is_default=false,updated_at=? WHERE tenant_id=?`), now, p.TenantID)
	}
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO tunnel_provider_settings(id,tenant_id,provider,enabled,is_default,config_enc,last_test_at,last_test_ok,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?) ON CONFLICT(tenant_id,provider) DO UPDATE SET enabled=?,is_default=?,config_enc=?,updated_at=?`), h.store.id(), p.TenantID, provider, b.Enabled, b.IsDefault, enc, now, now, b.Enabled, b.IsDefault, enc, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	h.auditNetwork(r, "provider.update", "tunnel_provider", provider, map[string]any{"enabled": b.Enabled, "isDefault": b.IsDefault})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) providerConfig(r *http.Request, provider string) (map[string]any, error) {
	p := principal(r)
	var enc string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT config_enc FROM tunnel_provider_settings WHERE tenant_id=? AND provider=? AND enabled=true`), p.TenantID, provider).Scan(&enc)
	if e != nil {
		return nil, e
	}
	raw, e := openSecretBox(h.deps.Secret, "tunnel:"+p.TenantID+":"+provider, enc)
	if e != nil {
		return nil, e
	}
	var cfg map[string]any
	e = json.Unmarshal(raw, &cfg)
	return cfg, e
}
func (h *handler) testExposureProvider(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "id")
	cfg, e := h.providerConfig(r, provider)
	if e != nil {
		statusErr(w, e)
		return
	}
	endpoint, _ := cfg["testUrl"].(string)
	if endpoint == "" {
		endpoint, _ = cfg["controlUrl"].(string)
	}
	if endpoint == "" {
		httpx.Error(w, 400, "provider testUrl required")
		return
	}
	u, e := safeProviderURL(endpoint, "")
	if e != nil {
		statusErr(w, e)
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if token, _ := cfg["token"].(string); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, e := h.service.gateway.client.Do(req)
	ok := e == nil && resp.StatusCode >= 200 && resp.StatusCode < 400
	var errText any
	if e != nil {
		errText = e.Error()
	} else {
		resp.Body.Close()
		if !ok {
			errText = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
	}
	p := principal(r)
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE tunnel_provider_settings SET last_test_at=?,last_test_ok=?,last_error=?,updated_at=? WHERE tenant_id=? AND provider=?`), h.store.now(), ok, errText, h.store.now(), p.TenantID, provider)
	httpx.JSON(w, 200, map[string]any{"ok": ok, "error": errText})
}
func (h *handler) createCloudflareTunnel(w http.ResponseWriter, r *http.Request) {
	cfg, e := h.providerConfig(r, "cloudflare-named")
	if e != nil {
		statusErr(w, e)
		return
	}
	account, _ := cfg["accountId"].(string)
	token, _ := cfg["token"].(string)
	var b struct {
		Name string `json:"name"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Name == "" || account == "" || token == "" {
		httpx.Error(w, 400, "name and configured accountId/token required")
		return
	}
	endpoint := "https://api.cloudflare.com/client/v4/accounts/" + url.PathEscape(account) + "/cfd_tunnel"
	payload, _ := json.Marshal(map[string]any{"name": b.Name, "config_src": "cloudflare"})
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		httpx.Error(w, 502, string(raw))
		return
	}
	var result any
	_ = json.Unmarshal(raw, &result)
	httpx.JSON(w, 201, map[string]any{"tunnel": result})
}
func (h *handler) queryExposures(w http.ResponseWriter, r *http.Request, agent string) {
	q := `SELECT id,agent_id,runtime_node_id,name,port,protocol,provider,status,public_url,relay_host,relay_port,ttl_minutes,expires_at,last_error,created_at,updated_at FROM port_exposures WHERE tenant_id=? AND status NOT IN ('stopped','expired')`
	args := []any{principal(r).TenantID}
	if agent != "" {
		q += ` AND agent_id=?`
		args = append(args, agent)
	}
	q += ` ORDER BY created_at DESC`
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(q), args...)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, agent, protocol, provider, status, c, u string
		var node, name, urlv, relay, expires, lastErr *string
		var port int
		var relayPort, ttl *int
		if rows.Scan(&id, &agent, &node, &name, &port, &protocol, &provider, &status, &urlv, &relay, &relayPort, &ttl, &expires, &lastErr, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "agentId": agent, "runtimeNodeId": node, "name": name, "port": port, "protocol": protocol, "provider": provider, "status": status, "publicUrl": urlv, "relayHost": relay, "relayPort": relayPort, "ttlMinutes": ttl, "expiresAt": expires, "lastError": lastErr, "createdAt": c, "updatedAt": u})
		}
	}
	httpx.JSON(w, 200, map[string]any{"exposures": out})
}
func (h *handler) activeExposures(w http.ResponseWriter, r *http.Request) { h.queryExposures(w, r, "") }
func (h *handler) agentExposures(w http.ResponseWriter, r *http.Request) {
	h.queryExposures(w, r, chi.URLParam(r, "id"))
}
func (h *handler) createExposure(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	if _, e := h.store.GetAgent(r.Context(), p.TenantID, agent); e != nil {
		statusErr(w, e)
		return
	}
	var b struct {
		Name, Protocol, Provider string
		Port, TTLMinutes         int
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Port < 1 || b.Port > 65535 {
		httpx.Error(w, 400, "valid port required")
		return
	}
	if b.Protocol == "" {
		b.Protocol = "http"
	}
	policy, e := h.readPolicy(r)
	if e != nil {
		statusErr(w, e)
		return
	}
	if enabled, ok := policy["exposureEnabled"].(bool); ok && !enabled {
		httpx.Error(w, 403, "exposures disabled by policy")
		return
	}
	var denied []int
	raw, _ := json.Marshal(policy["deniedPorts"])
	_ = json.Unmarshal(raw, &denied)
	for _, port := range denied {
		if port == b.Port {
			httpx.Error(w, 403, "port denied by policy")
			return
		}
	}
	maxTTL := int(policy["maxTtlMinutes"].(int))
	_ = maxTTL
	if b.TTLMinutes <= 0 {
		b.TTLMinutes = 60
	}
	provider := b.Provider
	if provider == "" {
		var x string
		_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT provider FROM tunnel_provider_settings WHERE tenant_id=? AND enabled=true ORDER BY is_default DESC LIMIT 1`), p.TenantID).Scan(&x)
		provider = x
	}
	if provider == "" {
		httpx.Error(w, 409, "no enabled exposure provider")
		return
	}
	cfg, e := h.providerConfig(r, provider)
	if e != nil {
		statusErr(w, e)
		return
	}
	control, _ := cfg["controlUrl"].(string)
	if control == "" {
		httpx.Error(w, 400, "provider controlUrl required")
		return
	}
	u, e := safeProviderURL(control, "")
	if e != nil {
		statusErr(w, e)
		return
	}
	payload, _ := json.Marshal(map[string]any{"tenantId": p.TenantID, "agentId": agent, "port": b.Port, "protocol": b.Protocol, "ttlMinutes": b.TTLMinutes, "name": b.Name})
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, u.String(), bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	if token, _ := cfg["token"].(string); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	defer resp.Body.Close()
	respRaw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		httpx.Error(w, 502, string(respRaw))
		return
	}
	var remote struct {
		URL       string `json:"url"`
		RelayHost string `json:"relayHost"`
		RelayPort int    `json:"relayPort"`
	}
	_ = json.Unmarshal(respRaw, &remote)
	now := h.store.now()
	expires := now.Add(time.Duration(b.TTLMinutes) * time.Minute)
	id := h.store.id()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO port_exposures(id,tenant_id,agent_id,runtime_node_id,name,port,protocol,provider,status,public_url,relay_host,relay_port,integration_id,ttl_minutes,expires_at,last_error,created_by_type,created_by_id,stopped_at,created_at,updated_at) VALUES(?,?,?,NULL,?,?,?,?,'active',?,?,?,NULL,?,?,NULL,'user',?,NULL,?,?)`), id, p.TenantID, agent, nullString(b.Name), b.Port, b.Protocol, provider, nullString(remote.URL), nullString(remote.RelayHost), remote.RelayPort, b.TTLMinutes, expires, p.UserID, now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	h.auditNetwork(r, "exposure.create", "exposure", id, map[string]any{"port": b.Port, "provider": provider})
	httpx.JSON(w, 201, map[string]any{"exposure": map[string]any{"id": id, "port": b.Port, "protocol": b.Protocol, "provider": provider, "status": "active", "publicUrl": remote.URL, "expiresAt": expires}})
}
func (h *handler) deleteExposure(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE port_exposures SET status='stopped',stopped_at=?,updated_at=? WHERE tenant_id=? AND id=? AND status NOT IN ('stopped','expired')`), h.store.now(), h.store.now(), p.TenantID, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.auditNetwork(r, "exposure.stop", "exposure", id, map[string]any{})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) stopAllExposures(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE port_exposures SET status='stopped',stopped_at=?,updated_at=? WHERE tenant_id=? AND status NOT IN ('stopped','expired')`), h.store.now(), h.store.now(), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	httpx.JSON(w, 200, map[string]any{"stopped": n})
}
func (h *handler) networkOverview(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var meshKind, meshStatus string
	var display *string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT kind,status,display_name FROM network_integrations WHERE tenant_id=? ORDER BY CASE WHEN status='connected' THEN 0 ELSE 1 END LIMIT 1`), p.TenantID).Scan(&meshKind, &meshStatus, &display)
	if errors.Is(e, sql.ErrNoRows) {
		meshStatus = "disconnected"
		e = nil
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	var defaultProvider *string
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT provider FROM tunnel_provider_settings WHERE tenant_id=? AND enabled=true ORDER BY is_default DESC LIMIT 1`), p.TenantID).Scan(&defaultProvider)
	var total, online, active, today, audit int
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*),COALESCE(SUM(CASE WHEN status='online' OR kind='local' THEN 1 ELSE 0 END),0) FROM runtime_nodes WHERE tenant_id=?`), p.TenantID).Scan(&total, &online)
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM port_exposures WHERE tenant_id=? AND status='active'`), p.TenantID).Scan(&active)
	start := time.Now().UTC().Truncate(24 * time.Hour)
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM port_exposures WHERE tenant_id=? AND created_at>=?`), p.TenantID, start).Scan(&today)
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM network_audit_logs WHERE tenant_id=? AND created_at>=?`), p.TenantID, start).Scan(&audit)
	policy, e := h.readPolicy(r)
	if e != nil {
		statusErr(w, e)
		return
	}
	enabled, _ := policy["enabled"].(bool)
	exposure, _ := policy["exposureEnabled"].(bool)
	connected := meshStatus == "connected"
	var provider any
	if meshKind != "" {
		provider = meshKind
	}
	httpx.JSON(w, 200, map[string]any{"mesh": map[string]any{"connected": connected, "displayName": display, "status": meshStatus}, "meshProvider": provider, "defaultProvider": defaultProvider, "exposureEnabled": enabled && exposure, "runners": map[string]any{"online": online, "total": total}, "activeExposures": active, "exposuresToday": today, "auditEventsToday": audit, "hostJoinsTailscale": connected || !h.deps.MultiTenant})
}
func (h *handler) networkMesh(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,kind,status,display_name,meta_json,last_sync_at,last_error,created_at,updated_at FROM network_integrations WHERE tenant_id=? ORDER BY kind`), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, kind, status, meta, c, u string
		var name, lastSync, lastErr *string
		if rows.Scan(&id, &kind, &status, &name, &meta, &lastSync, &lastErr, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "kind": kind, "status": status, "displayName": name, "meta": json.RawMessage(meta), "lastSyncAt": lastSync, "lastError": lastErr, "createdAt": c, "updatedAt": u})
		}
	}
	httpx.JSON(w, 200, map[string]any{"integrations": out})
}
func (h *handler) getHeadscale(w http.ResponseWriter, r *http.Request) {
	var status string
	var meta string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT status,meta_json FROM network_integrations WHERE tenant_id=? AND kind='headscale'`), principal(r).TenantID).Scan(&status, &meta)
	if errors.Is(e, sql.ErrNoRows) {
		httpx.JSON(w, 200, map[string]any{"status": "disconnected", "config": map[string]any{}})
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"status": status, "config": json.RawMessage(meta)})
}
func (h *handler) putHeadscale(w http.ResponseWriter, r *http.Request) {
	var b struct{ URL, Token, DisplayName string }
	if httpx.DecodeJSON(r, &b) != nil || b.URL == "" {
		httpx.Error(w, 400, "url required")
		return
	}
	if _, e := safeProviderURL(b.URL, ""); e != nil {
		statusErr(w, e)
		return
	}
	p := principal(r)
	raw, _ := json.Marshal(map[string]any{"url": b.URL, "token": b.Token})
	enc, e := secretBox(h.deps.Secret, "network:"+p.TenantID+":headscale", raw)
	if e != nil {
		statusErr(w, e)
		return
	}
	meta, _ := json.Marshal(map[string]any{"url": b.URL})
	now := h.store.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO network_integrations(id,tenant_id,kind,status,display_name,credentials_enc,meta_json,last_sync_at,last_error,created_at,updated_at) VALUES(?,?,'headscale','connected',?,?,?,NULL,NULL,?,?) ON CONFLICT(tenant_id,kind) DO UPDATE SET status='connected',display_name=?,credentials_enc=?,meta_json=?,updated_at=?`), h.store.id(), p.TenantID, b.DisplayName, enc, string(meta), now, now, b.DisplayName, enc, string(meta), now)
	if e != nil {
		statusErr(w, e)
		return
	}
	h.getHeadscale(w, r)
}
func (h *handler) syncMesh(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE network_integrations SET last_sync_at=?,updated_at=? WHERE tenant_id=? AND status='connected'`), h.store.now(), h.store.now(), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	httpx.JSON(w, 200, map[string]any{"synced": n})
}
func (h *handler) disconnectMesh(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct {
		Kind string `json:"kind"`
	}
	_ = httpx.DecodeJSON(r, &b)
	if b.Kind == "" {
		b.Kind = "tailscale"
	}
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE network_integrations SET status='disconnected',credentials_enc='{}',updated_at=? WHERE tenant_id=? AND kind=?`), h.store.now(), p.TenantID, b.Kind)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	httpx.JSON(w, 200, map[string]any{"disconnected": n})
}
func (h *handler) enablePlatformMesh(w http.ResponseWriter, r *http.Request) { h.putHeadscale(w, r) }
func (h *handler) meshCredentials(r *http.Request, kind string) (map[string]any, error) {
	p := principal(r)
	var enc string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT credentials_enc FROM network_integrations WHERE tenant_id=? AND kind=? AND status='connected'`), p.TenantID, kind).Scan(&enc)
	if e != nil {
		return nil, e
	}
	raw, e := openSecretBox(h.deps.Secret, "network:"+p.TenantID+":"+kind, enc)
	if e != nil {
		return nil, e
	}
	var cfg map[string]any
	e = json.Unmarshal(raw, &cfg)
	return cfg, e
}
func (h *handler) createMeshAuthKey(w http.ResponseWriter, r *http.Request) {
	cfg, e := h.meshCredentials(r, "headscale")
	if e != nil {
		statusErr(w, e)
		return
	}
	base, _ := cfg["url"].(string)
	token, _ := cfg["token"].(string)
	u, e := safeProviderURL(strings.TrimRight(base, "/")+"/api/v1/preauthkey", "")
	if e != nil {
		statusErr(w, e)
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, u.String(), bytes.NewReader([]byte(`{"reusable":false,"ephemeral":true}`)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		httpx.Error(w, 502, string(raw))
		return
	}
	var result any
	_ = json.Unmarshal(raw, &result)
	httpx.JSON(w, 200, map[string]any{"authKey": result})
}
func (h *handler) ensureMeshACL(w http.ResponseWriter, r *http.Request) {
	cfg, e := h.meshCredentials(r, "headscale")
	if e != nil {
		statusErr(w, e)
		return
	}
	base, _ := cfg["url"].(string)
	token, _ := cfg["token"].(string)
	var policy any
	if json.NewDecoder(r.Body).Decode(&policy) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	raw, _ := json.Marshal(policy)
	u, e := safeProviderURL(strings.TrimRight(base, "/")+"/api/v1/policy", "")
	if e != nil {
		statusErr(w, e)
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPut, u.String(), bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	resp.Body.Close()
	httpx.JSON(w, resp.StatusCode, map[string]any{"ok": resp.StatusCode < 300})
}
func (h *handler) meshOAuthStart(w http.ResponseWriter, r *http.Request) {
	httpx.Error(w, 400, "configure a Headscale URL and token, or complete OAuth in the network provider's official client")
}
func (h *handler) meshOAuthConnect(w http.ResponseWriter, r *http.Request) { h.putHeadscale(w, r) }
func (h *handler) meshOAuthTags(w http.ResponseWriter, r *http.Request)    { h.ensureMeshACL(w, r) }

var _ = strconv.Itoa
