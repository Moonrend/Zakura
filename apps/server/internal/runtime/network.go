// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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
	r.Get("/settings/network/headscale", h.getPlatformHeadscale)
	r.Put("/settings/network/headscale", h.putPlatformHeadscale)
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
	var m models.NetworkSecurityPolicy
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND scope = 'tenant'", p.TenantID).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return defaultPolicy(), nil
	}
	if e != nil {
		return nil, e
	}
	return map[string]any{"enabled": m.Enabled, "exposureEnabled": m.ExposureEnabled, "defaultTtlMinutes": int(m.DefaultTTLMinutes), "maxTtlMinutes": int(m.MaxTTLMinutes), "maxActivePerAgent": int(m.MaxActivePerAgent), "maxActivePerTenant": int(m.MaxActivePerTenant), "deniedPorts": json.RawMessage(m.DeniedPortsJSON), "allowDesktopExposure": m.AllowDesktopExposure, "allowPublicExposure": m.AllowPublicExposure, "allowTcpExposure": m.AllowTcpExposure, "agentsCanExpose": m.AgentsCanExpose, "requireUserApproval": m.RequireUserApproval, "requireTailscaleForRemoteRunners": m.RequireTailscaleForRemoteRunners, "auditRetentionDays": int(m.AuditRetentionDays)}, nil
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
	now := runtimeTimeString(h.store.now())
	e := h.deps.Gorm.WithContext(r.Context()).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "tenant_id"}, {Name: "scope"}},
			DoUpdates: clause.Assignments(map[string]any{
				"enabled": b.Enabled, "exposure_enabled": b.ExposureEnabled, "default_ttl_minutes": b.DefaultTtlMinutes,
				"max_ttl_minutes": b.MaxTtlMinutes, "max_active_per_agent": b.MaxActivePerAgent, "max_active_per_tenant": b.MaxActivePerTenant,
				"denied_ports_json": string(denied), "allow_desktop_exposure": b.AllowDesktopExposure, "allow_public_exposure": b.AllowPublicExposure,
				"allow_tcp_exposure": b.AllowTcpExposure, "agents_can_expose": b.AgentsCanExpose, "require_user_approval": b.RequireUserApproval,
				"require_tailscale_for_remote_runners": b.RequireTailscaleForRemoteRunners, "audit_retention_days": b.AuditRetentionDays,
				"updated_by": p.UserID, "updated_at": now,
			}),
		}).
		Table("network_security_policies").
		Create(map[string]any{"id": h.store.id(), "tenant_id": p.TenantID, "scope": "tenant", "enabled": b.Enabled, "exposure_enabled": b.ExposureEnabled, "default_ttl_minutes": b.DefaultTtlMinutes, "max_ttl_minutes": b.MaxTtlMinutes, "max_active_per_agent": b.MaxActivePerAgent, "max_active_per_tenant": b.MaxActivePerTenant, "denied_ports_json": string(denied), "allow_desktop_exposure": b.AllowDesktopExposure, "allow_public_exposure": b.AllowPublicExposure, "allow_tcp_exposure": b.AllowTcpExposure, "agents_can_expose": b.AgentsCanExpose, "require_user_approval": b.RequireUserApproval, "require_tailscale_for_remote_runners": b.RequireTailscaleForRemoteRunners, "audit_retention_days": b.AuditRetentionDays, "updated_by": p.UserID, "created_at": now, "updated_at": now}).Error
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
	id := h.store.id()
	_ = h.deps.Gorm.WithContext(r.Context()).Create(&models.NetworkAuditLog{ID: &id, TenantID: p.TenantID, ActorType: "user", ActorID: &p.UserID, Action: action, TargetType: &targetType, TargetID: &targetID, DetailJSON: string(raw), IP: &r.RemoteAddr, CreatedAt: runtimeTimeString(h.store.now())}).Error
}
func (h *handler) networkAudit(w http.ResponseWriter, r *http.Request) {
	var ms []models.NetworkAuditLog
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", principal(r).TenantID).Order("created_at DESC").Limit(500).Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := []map[string]any{}
	for _, m := range ms {
		id := ""
		if m.ID != nil {
			id = *m.ID
		}
		out = append(out, map[string]any{"id": id, "actorType": m.ActorType, "actorId": m.ActorID, "action": m.Action, "targetType": m.TargetType, "targetId": m.TargetID, "detail": json.RawMessage(m.DetailJSON), "ip": m.IP, "createdAt": m.CreatedAt})
	}
	httpx.JSON(w, 200, map[string]any{"items": out})
}
func (h *handler) listExposureProviders(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var ms []models.TunnelProviderSetting
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", p.TenantID).Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	byProvider := map[string]models.TunnelProviderSetting{}
	for _, m := range ms {
		byProvider[m.Provider] = m
	}
	out := []map[string]any{}
	for _, spec := range exposureProviderRegistry {
		item := map[string]any{
			"id":        spec.Provider,
			"tenantId":  p.TenantID,
			"provider":  spec.Provider,
			"enabled":   false,
			"isDefault": false,
			"config":    map[string]any{},
			"hasConfig": false,
			"meta": map[string]any{
				"name":           spec.Name,
				"description":    spec.Description,
				"requiresConfig": spec.RequiresConfig,
				"publicExposure": spec.PublicExposure,
			},
			"lastTestAt": nil,
			"lastTestOk": nil,
			"lastError":  nil,
			"createdAt":  "",
			"updatedAt":  "",
		}
		if m, ok := byProvider[spec.Provider]; ok {
			if m.ID != nil {
				item["id"] = *m.ID
			}
			item["enabled"] = m.Enabled
			item["isDefault"] = m.IsDefault
			cfg := h.tunnelProviderConfig(p.TenantID, spec.Provider, m.ConfigEnc)
			item["config"] = redactConfig(cfg)
			item["hasConfig"] = len(cfg) > 0
			item["lastTestAt"] = m.LastTestAt
			item["lastTestOk"] = m.LastTestOk
			item["lastError"] = m.LastError
			item["createdAt"] = m.CreatedAt
			item["updatedAt"] = m.UpdatedAt
		}
		out = append(out, item)
	}
	httpx.JSON(w, 200, map[string]any{"providers": out})
}
func (h *handler) patchExposureProvider(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	provider := chi.URLParam(r, "id")
	var b struct {
		Enabled   *bool
		IsDefault *bool
		Config    json.RawMessage
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	var existing struct {
		ConfigEnc string `gorm:"column:config_enc"`
		Enabled   bool   `gorm:"column:enabled"`
		IsDefault bool   `gorm:"column:is_default"`
	}
	existingEnc := ""
	existingEnabled := false
	existingIsDefault := false
	if e := h.deps.Gorm.WithContext(r.Context()).Table("tunnel_provider_settings").Select("config_enc, enabled, is_default").Where("tenant_id = ? AND provider = ?", p.TenantID, provider).Take(&existing).Error; e == nil {
		existingEnc = existing.ConfigEnc
		existingEnabled = existing.Enabled
		existingIsDefault = existing.IsDefault
	}
	enabled := existingEnabled
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	isDefault := existingIsDefault
	if b.IsDefault != nil {
		isDefault = *b.IsDefault
	}
	enc := existingEnc
	if b.Config != nil || existingEnc == "" {
		merged := h.tunnelProviderConfig(p.TenantID, provider, existingEnc)
		if b.Config != nil {
			var incoming map[string]any
			_ = json.Unmarshal(b.Config, &incoming)
			for k, v := range incoming {
				merged[k] = v
			}
		}
		raw, _ := json.Marshal(merged)
		v, e := secretBox(h.deps.Secret, "tunnel:"+p.TenantID+":"+provider, raw)
		if e != nil {
			statusErr(w, e)
			return
		}
		enc = v
	}
	now := runtimeTimeString(h.store.now())
	if isDefault {
		h.deps.Gorm.WithContext(r.Context()).Model(&models.TunnelProviderSetting{}).Where("tenant_id = ?", p.TenantID).Updates(map[string]any{"is_default": false, "updated_at": now})
	}
	e := h.deps.Gorm.WithContext(r.Context()).Exec(`INSERT INTO tunnel_provider_settings(id,tenant_id,provider,enabled,is_default,config_enc,last_test_at,last_test_ok,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?) ON CONFLICT(tenant_id,provider) DO UPDATE SET enabled=?,is_default=?,config_enc=?,updated_at=?`, h.store.id(), p.TenantID, provider, enabled, isDefault, enc, now, now, enabled, isDefault, enc, now).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	h.auditNetwork(r, "provider.update", "tunnel_provider", provider, map[string]any{"enabled": enabled, "isDefault": isDefault})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) providerConfig(r *http.Request, provider string) (map[string]any, error) {
	p := principal(r)
	var row struct {
		ConfigEnc string `gorm:"column:config_enc"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("tunnel_provider_settings").Select("config_enc").Where("tenant_id = ? AND provider = ? AND enabled = true", p.TenantID, provider).Take(&row).Error
	if e != nil {
		return nil, e
	}
	return h.tunnelProviderConfig(p.TenantID, provider, row.ConfigEnc), nil
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
	var ok bool
	var message string
	if endpoint != "" {
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
		ok = e == nil && resp.StatusCode >= 200 && resp.StatusCode < 400
		if e != nil {
			message = e.Error()
		} else {
			resp.Body.Close()
			if ok {
				message = "测试通过"
			} else {
				message = fmt.Sprintf("HTTP %d", resp.StatusCode)
			}
		}
	} else {
		ok, message = h.testProviderFallback(r, provider, cfg)
	}
	p := principal(r)
	now := runtimeTimeString(h.store.now())
	var errText any
	if !ok {
		errText = message
	}
	h.deps.Gorm.WithContext(r.Context()).Model(&models.TunnelProviderSetting{}).Where("tenant_id = ? AND provider = ?", p.TenantID, provider).Updates(map[string]any{"last_test_at": now, "last_test_ok": ok, "last_error": errText, "updated_at": now})
	httpx.JSON(w, 200, map[string]any{"ok": ok, "message": message})
}
func (h *handler) createCloudflareTunnel(w http.ResponseWriter, r *http.Request) {
	cfg, e := h.providerConfig(r, "cloudflare-named")
	if e != nil {
		statusErr(w, e)
		return
	}
	account, _ := cfg["accountId"].(string)
	token, _ := cfg["apiToken"].(string)
	if token == "" {
		token, _ = cfg["token"].(string)
	}
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
	var result struct {
		Result struct {
			ID    string `json:"id"`
			Name  string `json:"name"`
			Token string `json:"token"`
		} `json:"result"`
	}
	_ = json.Unmarshal(raw, &result)
	if result.Result.ID != "" {
		p := principal(r)
		cfg["tunnelId"] = result.Result.ID
		cfg["tunnelName"] = result.Result.Name
		if result.Result.Token != "" {
			cfg["tunnelToken"] = result.Result.Token
		}
		rawMerged, _ := json.Marshal(cfg)
		enc, e := secretBox(h.deps.Secret, "tunnel:"+p.TenantID+":cloudflare-named", rawMerged)
		if e != nil {
			statusErr(w, e)
			return
		}
		now := runtimeTimeString(h.store.now())
		if e := h.deps.Gorm.WithContext(r.Context()).Exec(`INSERT INTO tunnel_provider_settings(id,tenant_id,provider,enabled,is_default,config_enc,last_test_at,last_test_ok,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?) ON CONFLICT(tenant_id,provider) DO UPDATE SET config_enc=?,updated_at=?`, h.store.id(), p.TenantID, "cloudflare-named", true, false, enc, now, now, enc, now).Error; e != nil {
			statusErr(w, e)
			return
		}
	}
	httpx.JSON(w, 201, map[string]any{"tunnelId": result.Result.ID, "tunnelName": result.Result.Name, "hasToken": result.Result.Token != ""})
}
func (h *handler) queryExposures(w http.ResponseWriter, r *http.Request, agent string) {
	q := h.deps.Gorm.WithContext(r.Context()).Model(&models.PortExposure{}).Where("tenant_id = ? AND status NOT IN ('stopped','expired')", principal(r).TenantID)
	if agent != "" {
		q = q.Where("agent_id = ?", agent)
	}
	var ms []models.PortExposure
	if e := q.Order("created_at DESC").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := []map[string]any{}
	for _, m := range ms {
		id := ""
		if m.ID != nil {
			id = *m.ID
		}
		var relayPort, ttl *int
		if m.RelayPort != nil {
			v := int(*m.RelayPort)
			relayPort = &v
		}
		if m.TTLMinutes != nil {
			v := int(*m.TTLMinutes)
			ttl = &v
		}
		out = append(out, map[string]any{"id": id, "agentId": m.AgentID, "runtimeNodeId": m.RuntimeNodeID, "name": m.Name, "port": int(m.Port), "protocol": m.Protocol, "provider": m.Provider, "status": m.Status, "publicUrl": m.PublicURL, "relayHost": m.RelayHost, "relayPort": relayPort, "ttlMinutes": ttl, "expiresAt": m.ExpiresAt, "lastError": m.LastError, "createdAt": m.CreatedAt, "updatedAt": m.UpdatedAt})
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
		var row struct {
			Provider string `gorm:"column:provider"`
		}
		_ = h.deps.Gorm.WithContext(r.Context()).Table("tunnel_provider_settings").Select("provider").Where("tenant_id = ? AND enabled = true", p.TenantID).Order("is_default DESC").Take(&row).Error
		provider = row.Provider
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
	expStr := runtimeTimeString(expires)
	ttl := int32(b.TTLMinutes)
	createdByType := "user"
	pe := models.PortExposure{ID: &id, TenantID: p.TenantID, AgentID: agent, Port: int32(b.Port), Protocol: b.Protocol, Provider: provider, Status: "active", TTLMinutes: &ttl, ExpiresAt: &expStr, CreatedByType: &createdByType, CreatedByID: &p.UserID, CreatedAt: runtimeTimeString(now), UpdatedAt: runtimeTimeString(now)}
	if b.Name != "" {
		pe.Name = &b.Name
	}
	if remote.URL != "" {
		pe.PublicURL = &remote.URL
	}
	if remote.RelayHost != "" {
		pe.RelayHost = &remote.RelayHost
	}
	rp := int32(remote.RelayPort)
	pe.RelayPort = &rp
	if e = h.deps.Gorm.WithContext(r.Context()).Create(&pe).Error; e != nil {
		statusErr(w, e)
		return
	}
	h.auditNetwork(r, "exposure.create", "exposure", id, map[string]any{"port": b.Port, "provider": provider})
	httpx.JSON(w, 201, map[string]any{"exposure": map[string]any{"id": id, "port": b.Port, "protocol": b.Protocol, "provider": provider, "status": "active", "publicUrl": remote.URL, "expiresAt": expires}})
}
func (h *handler) deleteExposure(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	now := runtimeTimeString(h.store.now())
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.PortExposure{}).Where("tenant_id = ? AND id = ? AND status NOT IN ('stopped','expired')", p.TenantID, id).Updates(map[string]any{"status": "stopped", "stopped_at": now, "updated_at": now})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.auditNetwork(r, "exposure.stop", "exposure", id, map[string]any{})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) stopAllExposures(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	now := runtimeTimeString(h.store.now())
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.PortExposure{}).Where("tenant_id = ? AND status NOT IN ('stopped','expired')", p.TenantID).Updates(map[string]any{"status": "stopped", "stopped_at": now, "updated_at": now})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	httpx.JSON(w, 200, map[string]any{"stopped": res.RowsAffected})
}
func (h *handler) networkOverview(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var meshKind, meshStatus string
	var display *string
	var mesh struct {
		Kind        string  `gorm:"column:kind"`
		Status      string  `gorm:"column:status"`
		DisplayName *string `gorm:"column:display_name"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("network_integrations").Select("kind, status, display_name").Where("tenant_id = ?", p.TenantID).Order("CASE WHEN status = 'connected' THEN 0 ELSE 1 END").Take(&mesh).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		meshStatus = "disconnected"
		e = nil
	} else if e == nil {
		meshKind, meshStatus, display = mesh.Kind, mesh.Status, mesh.DisplayName
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	var defaultProvider *string
	var dp struct {
		Provider string `gorm:"column:provider"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("tunnel_provider_settings").Select("provider").Where("tenant_id = ? AND enabled = true", p.TenantID).Order("is_default DESC").Take(&dp).Error; e == nil {
		defaultProvider = &dp.Provider
	}
	var total, online, active, today, audit int
	var nodeAgg struct {
		Total  int64 `gorm:"column:total"`
		Online int64 `gorm:"column:online"`
	}
	_ = h.deps.Gorm.WithContext(r.Context()).Model(&models.RuntimeNode{}).Where("tenant_id = ?", p.TenantID).Select("COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'online' OR kind = 'local' THEN 1 ELSE 0 END),0) AS online").Scan(&nodeAgg).Error
	total, online = int(nodeAgg.Total), int(nodeAgg.Online)
	var activeCount int64
	_ = h.deps.Gorm.WithContext(r.Context()).Model(&models.PortExposure{}).Where("tenant_id = ? AND status = 'active'", p.TenantID).Count(&activeCount).Error
	active = int(activeCount)
	start := time.Now().UTC().Truncate(24 * time.Hour)
	var todayCount int64
	_ = h.deps.Gorm.WithContext(r.Context()).Model(&models.PortExposure{}).Where("tenant_id = ? AND created_at >= ?", p.TenantID, runtimeTimeString(start)).Count(&todayCount).Error
	today = int(todayCount)
	var auditCount int64
	_ = h.deps.Gorm.WithContext(r.Context()).Model(&models.NetworkAuditLog{}).Where("tenant_id = ? AND created_at >= ?", p.TenantID, runtimeTimeString(start)).Count(&auditCount).Error
	audit = int(auditCount)
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
	var ms []models.NetworkIntegration
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", p.TenantID).Order("kind").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := []map[string]any{}
	for _, m := range ms {
		id := ""
		if m.ID != nil {
			id = *m.ID
		}
		out = append(out, map[string]any{"id": id, "kind": m.Kind, "status": m.Status, "displayName": m.DisplayName, "meta": json.RawMessage(m.MetaJSON), "lastSyncAt": m.LastSyncAt, "lastError": m.LastError, "createdAt": m.CreatedAt, "updatedAt": m.UpdatedAt})
	}
	httpx.JSON(w, 200, map[string]any{"integrations": out})
}
type platformHeadscaleStored struct {
	Enabled        bool   `json:"enabled"`
	URL            string `json:"url"`
	APIKeyEnc      string `json:"apiKeyEnc"`
	PlatformKeyEnc string `json:"platformAuthKeyEnc"`
}

func (h *handler) loadPlatformHeadscale(ctx context.Context) platformHeadscaleStored {
	var stored platformHeadscaleStored
	var row models.Setting
	e := h.deps.Gorm.WithContext(ctx).Where("owner_key = ? AND key = ?", "platform", "network.headscale").Take(&row).Error
	if e != nil {
		return stored
	}
	_ = json.Unmarshal([]byte(row.Value), &stored)
	return stored
}

func (h *handler) savePlatformHeadscale(ctx context.Context, stored platformHeadscaleStored) error {
	raw, e := json.Marshal(stored)
	if e != nil {
		return e
	}
	id := h.deps.NewID()
	return h.deps.Gorm.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "owner_key"}, {Name: "key"}},
			DoUpdates: clause.AssignmentColumns([]string{"value"}),
		}).
		Create(&models.Setting{ID: &id, OwnerKey: "platform", Key: "network.headscale", Value: string(raw)}).Error
}

func (h *handler) publicPlatformHeadscale(stored platformHeadscaleStored) map[string]any {
	return map[string]any{
		"enabled":            stored.Enabled,
		"url":                strings.TrimSpace(stored.URL),
		"hasApiKey":          stored.APIKeyEnc != "",
		"hasPlatformAuthKey": stored.PlatformKeyEnc != "",
		"ready":              stored.Enabled && strings.TrimSpace(stored.URL) != "" && stored.APIKeyEnc != "",
	}
}

func (h *handler) getPlatformHeadscale(w http.ResponseWriter, r *http.Request) {
	if !principal(r).IsPlatformAdmin {
		httpx.Error(w, 403, "Admin only")
		return
	}
	httpx.JSON(w, 200, h.publicPlatformHeadscale(h.loadPlatformHeadscale(r.Context())))
}
func (h *handler) putPlatformHeadscale(w http.ResponseWriter, r *http.Request) {
	if !principal(r).IsPlatformAdmin {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var b struct {
		Enabled         *bool   `json:"enabled"`
		URL             *string `json:"url"`
		APIKey          *string `json:"apiKey"`
		PlatformAuthKey *string `json:"platformAuthKey"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	stored := h.loadPlatformHeadscale(r.Context())
	if b.Enabled != nil {
		stored.Enabled = *b.Enabled
	}
	if b.URL != nil {
		stored.URL = strings.TrimSpace(*b.URL)
	}
	if b.URL != nil && stored.URL != "" {
		if _, e := safeProviderURL(stored.URL, ""); e != nil {
			statusErr(w, e)
			return
		}
	}
	if b.APIKey != nil {
		stored.APIKeyEnc = ""
		if v := strings.TrimSpace(*b.APIKey); v != "" {
			enc, e := secretBox(h.deps.Secret, "platform:network:headscale:apikey", []byte(v))
			if e != nil {
				httpx.Error(w, 500, "encryption failed")
				return
			}
			stored.APIKeyEnc = enc
		}
	}
	if b.PlatformAuthKey != nil {
		stored.PlatformKeyEnc = ""
		if v := strings.TrimSpace(*b.PlatformAuthKey); v != "" {
			enc, e := secretBox(h.deps.Secret, "platform:network:headscale:platformkey", []byte(v))
			if e != nil {
				httpx.Error(w, 500, "encryption failed")
				return
			}
			stored.PlatformKeyEnc = enc
		}
	}
	if stored.Enabled && stored.URL == "" {
		httpx.Error(w, 400, "url required")
		return
	}
	if e := h.savePlatformHeadscale(r.Context(), stored); e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, h.publicPlatformHeadscale(stored))
}
func (h *handler) syncMesh(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	now := runtimeTimeString(h.store.now())
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.NetworkIntegration{}).Where("tenant_id = ? AND status = 'connected'", p.TenantID).Updates(map[string]any{"last_sync_at": now, "updated_at": now})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	httpx.JSON(w, 200, map[string]any{"synced": res.RowsAffected})
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
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.NetworkIntegration{}).Where("tenant_id = ? AND kind = ?", p.TenantID, b.Kind).Updates(map[string]any{"status": "disconnected", "credentials_enc": "{}", "updated_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	httpx.JSON(w, 200, map[string]any{"disconnected": res.RowsAffected})
}
func (h *handler) enablePlatformMesh(w http.ResponseWriter, r *http.Request) {
	if !principal(r).IsPlatformAdmin {
		httpx.Error(w, 403, "Admin only")
		return
	}
	stored := h.loadPlatformHeadscale(r.Context())
	if stored.URL == "" {
		httpx.Error(w, 400, "configure a Headscale URL first")
		return
	}
	stored.Enabled = true
	if e := h.savePlatformHeadscale(r.Context(), stored); e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, h.publicPlatformHeadscale(stored))
}
func (h *handler) meshCredentials(r *http.Request, kind string) (map[string]any, error) {
	p := principal(r)
	var row struct {
		CredentialsEnc string `gorm:"column:credentials_enc"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("network_integrations").Select("credentials_enc").Where("tenant_id = ? AND kind = ? AND status = 'connected'", p.TenantID, kind).Take(&row).Error
	if e != nil {
		return nil, e
	}
	raw, e := openSecretBox(h.deps.Secret, "network:"+p.TenantID+":"+kind, row.CredentialsEnc)
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
func (h *handler) meshOAuthConnect(w http.ResponseWriter, r *http.Request) {
	httpx.Error(w, 400, "configure a Headscale URL and token, or complete OAuth in the network provider's official client")
}
func (h *handler) meshOAuthTags(w http.ResponseWriter, r *http.Request)    { h.ensureMeshACL(w, r) }
