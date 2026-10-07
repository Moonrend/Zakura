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
	r.Post("/settings/network/mesh/auth-key", h.saveMeshAuthKey)
	r.Post("/settings/network/mesh/auth-key/generate", h.generateMeshAuthKey)
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
	resolved := h.loadPlatformHeadscaleResolved(r.Context())
	platformEnabled := resolved.Enabled
	platform := h.loadPlatformIntegration(r.Context(), p.TenantID)
	meshStatus := "disconnected"
	var display *string
	if platformEnabled {
		meshStatus = "connected"
		if platform != nil && platform.DisplayName != nil {
			display = platform.DisplayName
		} else {
			name := "平台托管网络"
			display = &name
		}
	} else {
		var mesh struct {
			Kind        string  `gorm:"column:kind"`
			Status      string  `gorm:"column:status"`
			DisplayName *string `gorm:"column:display_name"`
		}
		e := h.deps.Gorm.WithContext(r.Context()).Table("network_integrations").Select("kind, status, display_name").Where("tenant_id = ?", p.TenantID).Order("CASE WHEN status = 'connected' THEN 0 ELSE 1 END").Take(&mesh).Error
		if errors.Is(e, gorm.ErrRecordNotFound) {
			meshStatus = "disconnected"
		} else if e == nil {
			meshStatus, display = mesh.Status, mesh.DisplayName
		} else {
			statusErr(w, e)
			return
		}
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
	if mp := h.resolveMeshProvider(r.Context(), p.TenantID); mp != "" {
		provider = mp
	}
	hostJoins := connected || !h.deps.MultiTenant
	if platformEnabled {
		hostJoins = true
	}
	httpx.JSON(w, 200, map[string]any{"mesh": map[string]any{"connected": connected, "displayName": display, "status": meshStatus}, "meshProvider": provider, "defaultProvider": defaultProvider, "exposureEnabled": enabled && exposure, "runners": map[string]any{"online": online, "total": total}, "activeExposures": active, "exposuresToday": today, "auditEventsToday": audit, "hostJoinsTailscale": hostJoins})
}
func (h *handler) networkMesh(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	resolved := h.loadPlatformHeadscaleResolved(r.Context())
	if resolved.Enabled {
		_ = h.enablePlatformMeshFor(r.Context(), p.TenantID, false)
	}
	httpx.JSON(w, 200, h.buildMeshPayload(r.Context(), p.TenantID, resolved))
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
	url := strings.TrimRight(strings.TrimSpace(stored.URL), "/")
	return map[string]any{
		"enabled":            stored.Enabled,
		"url":                url,
		"hasApiKey":          stored.APIKeyEnc != "",
		"hasPlatformAuthKey": stored.PlatformKeyEnc != "",
		"ready":              stored.Enabled && url != "" && stored.APIKeyEnc != "",
	}
}

type platformHeadscaleResolved struct {
	Enabled         bool
	URL             string
	APIKey          string
	PlatformAuthKey string
}

func (h *handler) loadPlatformHeadscaleResolved(ctx context.Context) platformHeadscaleResolved {
	stored := h.loadPlatformHeadscale(ctx)
	url := strings.TrimRight(strings.TrimSpace(stored.URL), "/")
	apiKey := ""
	if stored.APIKeyEnc != "" {
		if raw, e := openSecretBox(h.deps.Secret, "platform:network:headscale:apikey", stored.APIKeyEnc); e == nil {
			apiKey = strings.TrimSpace(string(raw))
		}
	}
	platformKey := ""
	if stored.PlatformKeyEnc != "" {
		if raw, e := openSecretBox(h.deps.Secret, "platform:network:headscale:platformkey", stored.PlatformKeyEnc); e == nil {
			platformKey = strings.TrimSpace(string(raw))
		}
	}
	return platformHeadscaleResolved{Enabled: stored.Enabled && url != "" && apiKey != "", URL: url, APIKey: apiKey, PlatformAuthKey: platformKey}
}

func (h *handler) persistPlatformAuthKey(ctx context.Context, key string) error {
	stored := h.loadPlatformHeadscale(ctx)
	enc, e := secretBox(h.deps.Secret, "platform:network:headscale:platformkey", []byte(key))
	if e != nil {
		return e
	}
	stored.PlatformKeyEnc = enc
	return h.savePlatformHeadscale(ctx, stored)
}

func (h *handler) headscaleClientFor(resolved platformHeadscaleResolved) *headscaleAdminClient {
	if !resolved.Enabled {
		return nil
	}
	return newHeadscaleAdminClient(resolved.URL, resolved.APIKey)
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
		stored.URL = strings.TrimRight(strings.TrimSpace(*b.URL), "/")
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
func (h *handler) loadPlatformIntegration(ctx context.Context, tenantID string) *models.NetworkIntegration {
	var row models.NetworkIntegration
	if e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND kind = ?", tenantID, "headscale-platform").Take(&row).Error; e != nil {
		return nil
	}
	return &row
}

func (h *handler) saveManualAuthKey(ctx context.Context, tenantID, key string) error {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return errors.New("authKey is required")
	}
	creds, _ := json.Marshal(map[string]any{"authKey": trimmed})
	enc, e := secretBox(h.deps.Secret, "network:"+tenantID+":tailscale-authkey", creds)
	if e != nil {
		return e
	}
	now := runtimeTimeString(h.store.now())
	id := h.store.id()
	displayName := "Manual Auth Key"
	return h.deps.Gorm.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "tenant_id"}, {Name: "kind"}},
		DoUpdates: clause.AssignmentColumns([]string{"status", "credentials_enc", "display_name", "updated_at"}),
	}).Create(&models.NetworkIntegration{ID: &id, TenantID: tenantID, Kind: "tailscale-authkey", Status: "connected", DisplayName: &displayName, CredentialsEnc: enc, MetaJSON: "{}", CreatedAt: now, UpdatedAt: now}).Error
}

func (h *handler) meshDevices(ctx context.Context, tenantID string) []map[string]any {
	var rows []struct {
		ID           string  `gorm:"column:id"`
		Name         string  `gorm:"column:name"`
		Slug         string  `gorm:"column:slug"`
		Kind         string  `gorm:"column:kind"`
		Status       string  `gorm:"column:status"`
		Endpoint     *string `gorm:"column:endpoint"`
		HostInfoJSON string  `gorm:"column:host_info_json"`
	}
	if e := h.deps.Gorm.WithContext(ctx).Table("runtime_nodes").Select("id,name,slug,kind,status,endpoint,host_info_json").Where("tenant_id = ?", tenantID).Order("created_at").Find(&rows).Error; e != nil {
		return []map[string]any{}
	}
	out := []map[string]any{}
	for _, n := range rows {
		var host map[string]any
		_ = json.Unmarshal([]byte(n.HostInfoJSON), &host)
		var tailscale any
		if ts, ok := host["tailscale"].(map[string]any); ok {
			tailscale = map[string]any{"connected": mapBoolValue(ts["connected"]), "ip": nullString(mapStringValue(ts["ip"])), "magicDnsName": nullString(mapStringValue(ts["magicDnsName"])), "hostname": nullString(mapStringValue(ts["hostname"])), "tags": stringSlice(ts["tags"])}
		}
		out = append(out, map[string]any{"id": n.ID, "name": n.Name, "slug": n.Slug, "kind": n.Kind, "status": n.Status, "endpoint": n.Endpoint, "tailscale": tailscale})
	}
	return out
}

func headscaleNodesToDevices(nodes []headscaleNode) []map[string]any {
	out := []map[string]any{}
	for _, n := range nodes {
		out = append(out, map[string]any{"id": n.ID, "name": n.Name, "hostname": n.Hostname, "addresses": n.Addresses, "tags": n.Tags, "online": n.Online, "user": n.User, "os": n.OS, "lastSeen": n.LastSeen})
	}
	return out
}

func meshMapInt(value any) int {
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case float32:
		return int(v)
	}
	return 0
}

func (h *handler) resolveMeshProvider(ctx context.Context, tenantID string) string {
	if h.loadPlatformHeadscaleResolved(ctx).Enabled {
		return "headscale-platform"
	}
	var row models.NetworkIntegration
	if e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND kind = ? AND status = 'connected'", tenantID, "tailscale-oauth").Take(&row).Error; e == nil {
		return "tailscale-cloud"
	}
	if e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND kind = ? AND status = 'connected'", tenantID, "tailscale-authkey").Take(&row).Error; e == nil {
		return "tailscale-cloud"
	}
	return ""
}

func (h *handler) buildMeshPayload(ctx context.Context, tenantID string, resolved platformHeadscaleResolved) map[string]any {
	var oauth, authkey *models.NetworkIntegration
	var oauthRow, authkeyRow models.NetworkIntegration
	if e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND kind = ?", tenantID, "tailscale-oauth").Take(&oauthRow).Error; e == nil {
		oauth = &oauthRow
	}
	if e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND kind = ?", tenantID, "tailscale-authkey").Take(&authkeyRow).Error; e == nil {
		authkey = &authkeyRow
	}
	platform := h.loadPlatformIntegration(ctx, tenantID)
	platformMode := resolved.Enabled

	metaJSON := ""
	if platformMode {
		if platform != nil {
			metaJSON = platform.MetaJSON
		}
	} else if oauth != nil && oauth.Status == "connected" {
		metaJSON = oauth.MetaJSON
	} else if platform != nil {
		metaJSON = platform.MetaJSON
	} else if oauth != nil {
		metaJSON = oauth.MetaJSON
	}
	meta := map[string]any{}
	_ = json.Unmarshal([]byte(metaJSON), &meta)

	devices := h.meshDevices(ctx, tenantID)
	tailnetDevices := []any{}
	if value, ok := meta["devices"].([]any); ok {
		tailnetDevices = value
	}

	provider := h.resolveMeshProvider(ctx, tenantID)
	platformConnected := platformMode && platform != nil && platform.Status == "connected"
	cloudConnected := !platformMode && ((oauth != nil && oauth.Status == "connected") || (authkey != nil && authkey.Status == "connected"))
	connected := platformConnected || cloudConnected

	headscaleUser := ""
	if platformMode {
		if value, ok := meta["headscaleUser"].(string); ok && value != "" {
			headscaleUser = value
		} else {
			headscaleUser = headscaleTenantUserName(tenantID)
		}
	}
	deviceCount := len(tailnetDevices)
	if _, ok := meta["deviceCount"]; ok {
		deviceCount = meshMapInt(meta["deviceCount"])
	}

	var meshProvider any
	if platformMode {
		meshProvider = "headscale-platform"
	} else if provider != "" {
		meshProvider = provider
	}
	var loginServer any
	var headscaleUserValue any
	if platformMode {
		loginServer = resolved.URL
		headscaleUserValue = headscaleUser
	}

	createClientURL := "https://login.tailscale.com/admin/settings/oauth"
	var oauthPayload any
	if platformMode {
		oauthPayload = nil
	} else if oauth != nil {
		oauthPayload = map[string]any{"status": oauth.Status, "displayName": oauth.DisplayName, "lastSyncAt": oauth.LastSyncAt, "lastError": oauth.LastError, "tags": stringSlice(meta["tags"]), "deviceCount": deviceCount, "createClientUrl": createClientURL}
	} else {
		oauthPayload = map[string]any{"status": "disconnected", "displayName": nil, "lastSyncAt": nil, "lastError": nil, "tags": []string{}, "deviceCount": 0, "createClientUrl": createClientURL}
	}

	var platformPayload any
	if platformMode {
		status := "error"
		displayName := "Headscale"
		var lastSyncAt, lastError any
		if platform != nil {
			if platform.Status != "" {
				status = platform.Status
			}
			if platform.DisplayName != nil {
				displayName = *platform.DisplayName
			}
			lastSyncAt = platform.LastSyncAt
			lastError = platform.LastError
		}
		platformPayload = map[string]any{"status": status, "displayName": displayName, "lastSyncAt": lastSyncAt, "lastError": lastError, "deviceCount": deviceCount, "headscaleUser": headscaleUser}
	}

	hostJoins := !h.deps.MultiTenant
	note := "Tailscale 云组网：使用 OAuth Client Credentials；Runner 通过 sidecar 入网。"
	if platformMode {
		hostJoins = true
		note = "平台托管网络：主节点已入网，本租户设备仅能互访。注册 Runner 时自动加入。"
	}
	return map[string]any{
		"connected":          connected,
		"meshProvider":       meshProvider,
		"loginServer":        loginServer,
		"headscaleUser":      headscaleUserValue,
		"oauth":              oauthPayload,
		"platform":           platformPayload,
		"hasAuthKey":         authkey != nil && authkey.Status != "disconnected",
		"devices":            devices,
		"tailnetDevices":     tailnetDevices,
		"hostJoinsTailscale": hostJoins,
		"note":               note,
	}
}

func (h *handler) enablePlatformMeshFor(ctx context.Context, tenantID string, refreshDevices bool) error {
	resolved := h.loadPlatformHeadscaleResolved(ctx)
	if !resolved.Enabled {
		return errors.New("platform Headscale is not configured")
	}
	client := h.headscaleClientFor(resolved)
	if client == nil {
		return errors.New("platform Headscale is not configured")
	}
	now := runtimeTimeString(h.store.now())
	_ = h.deps.Gorm.WithContext(ctx).Model(&models.NetworkIntegration{}).Where("tenant_id = ? AND kind IN ('tailscale-oauth','tailscale-authkey') AND status != 'disconnected'", tenantID).Updates(map[string]any{"status": "disconnected", "last_error": nil, "updated_at": now}).Error

	existing := h.loadPlatformIntegration(ctx, tenantID)
	if existing != nil && existing.Status == "connected" {
		if refreshDevices {
			user, e := client.ensureTenantUser(ctx, tenantID)
			if e == nil {
				nodes, _ := client.listTenantNodes(ctx, tenantID)
				devices := headscaleNodesToDevices(nodes)
				prev := map[string]any{}
				_ = json.Unmarshal([]byte(existing.MetaJSON), &prev)
				prev["headscaleUser"] = user.Name
				prev["headscaleUserId"] = user.ID
				prev["deviceCount"] = len(devices)
				prev["devices"] = devices
				prev["loginServer"] = resolved.URL
				raw, _ := json.Marshal(prev)
				syncAt := runtimeTimeString(h.store.now())
				_ = h.deps.Gorm.WithContext(ctx).Model(&models.NetworkIntegration{}).Where("id = ?", existing.ID).Updates(map[string]any{"meta_json": string(raw), "last_sync_at": syncAt, "last_error": nil, "updated_at": syncAt}).Error
			}
		}
		return nil
	}

	user, e := client.ensureTenantUser(ctx, tenantID)
	if e != nil {
		return e
	}
	_, _ = client.ensurePlatformUser(ctx)
	if resolved.PlatformAuthKey == "" {
		if minted, mintErr := client.createPlatformPreAuthKey(ctx, true, 0); mintErr == nil {
			_ = h.persistPlatformAuthKey(ctx, minted.Key)
		}
	}
	nodes, e := client.listTenantNodes(ctx, tenantID)
	if e != nil {
		nodes = nil
	}
	devices := headscaleNodesToDevices(nodes)
	credsRaw, _ := json.Marshal(map[string]any{"headscaleUser": user.Name, "headscaleUserId": user.ID})
	credentialsEnc, e := secretBox(h.deps.Secret, "network:"+tenantID+":headscale-platform", credsRaw)
	if e != nil {
		return e
	}
	metaRaw, _ := json.Marshal(map[string]any{"headscaleUser": user.Name, "headscaleUserId": user.ID, "deviceCount": len(devices), "devices": devices, "loginServer": resolved.URL})
	syncAt := runtimeTimeString(h.store.now())
	id := h.store.id()
	displayName := "Headscale · " + user.Name
	return h.deps.Gorm.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "tenant_id"}, {Name: "kind"}},
		DoUpdates: clause.AssignmentColumns([]string{"status", "display_name", "credentials_enc", "meta_json", "last_sync_at", "last_error", "updated_at"}),
	}).Create(&models.NetworkIntegration{ID: &id, TenantID: tenantID, Kind: "headscale-platform", Status: "connected", DisplayName: &displayName, CredentialsEnc: credentialsEnc, MetaJSON: string(metaRaw), LastSyncAt: &syncAt, CreatedAt: syncAt, UpdatedAt: syncAt}).Error
}

func (h *handler) syncMesh(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	resolved := h.loadPlatformHeadscaleResolved(r.Context())
	if resolved.Enabled {
		_ = h.enablePlatformMeshFor(r.Context(), p.TenantID, true)
		httpx.JSON(w, 200, h.buildMeshPayload(r.Context(), p.TenantID, resolved))
		return
	}
	now := runtimeTimeString(h.store.now())
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.NetworkIntegration{}).Where("tenant_id = ? AND status = 'connected'", p.TenantID).Updates(map[string]any{"last_sync_at": now, "updated_at": now})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	payload := h.buildMeshPayload(r.Context(), p.TenantID, resolved)
	payload["synced"] = res.RowsAffected
	httpx.JSON(w, 200, payload)
}
func (h *handler) disconnectMesh(w http.ResponseWriter, r *http.Request) {
	if h.loadPlatformHeadscaleResolved(r.Context()).Enabled {
		httpx.Error(w, 400, "平台托管网络由部署配置决定，不能在控制台断开")
		return
	}
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
	p := principal(r)
	if !p.IsPlatformAdmin && p.Role != "owner" && p.Role != "admin" {
		httpx.Error(w, 403, "Admin only")
		return
	}
	resolved := h.loadPlatformHeadscaleResolved(r.Context())
	if e := h.enablePlatformMeshFor(r.Context(), p.TenantID, true); e != nil {
		httpx.Error(w, 400, e.Error())
		return
	}
	detail := map[string]any{"kind": "headscale-platform"}
	if platform := h.loadPlatformIntegration(r.Context(), p.TenantID); platform != nil {
		var meta map[string]any
		_ = json.Unmarshal([]byte(platform.MetaJSON), &meta)
		if u := mapStringValue(meta["headscaleUser"]); u != "" {
			detail["headscaleUser"] = u
		}
	}
	h.auditNetwork(r, "mesh.platform.enable", "network_integration", "headscale-platform", detail)
	httpx.JSON(w, 200, h.buildMeshPayload(r.Context(), p.TenantID, resolved))
}
func (h *handler) saveMeshAuthKey(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin && p.Role != "owner" && p.Role != "admin" {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var b struct {
		AuthKey string `json:"authKey"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if strings.TrimSpace(b.AuthKey) == "" {
		httpx.Error(w, 400, "authKey is required")
		return
	}
	if e := h.saveManualAuthKey(r.Context(), p.TenantID, b.AuthKey); e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, h.buildMeshPayload(r.Context(), p.TenantID, h.loadPlatformHeadscaleResolved(r.Context())))
}
func (h *handler) generateMeshAuthKey(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin && p.Role != "owner" && p.Role != "admin" {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var b struct {
		Tags          []string `json:"tags"`
		ExpirySeconds int      `json:"expirySeconds"`
		Description   string   `json:"description"`
	}
	_ = httpx.DecodeJSON(r, &b)
	resolved := h.loadPlatformHeadscaleResolved(r.Context())
	if !resolved.Enabled {
		httpx.Error(w, 400, "当前未启用平台托管组网")
		return
	}
	client := h.headscaleClientFor(resolved)
	platform := h.loadPlatformIntegration(r.Context(), p.TenantID)
	if client == nil || platform == nil || platform.Status != "connected" {
		httpx.Error(w, 400, "请先启用平台托管组网")
		return
	}
	created, e := client.createTenantPreAuthKey(r.Context(), p.TenantID, true, false, b.ExpirySeconds)
	if e != nil {
		httpx.Error(w, 400, e.Error())
		return
	}
	_ = h.saveManualAuthKey(r.Context(), p.TenantID, created.Key)
	payload := h.buildMeshPayload(r.Context(), p.TenantID, resolved)
	payload["generatedKey"] = created.Key
	payload["generatedKeyId"] = created.ID
	if created.Expiration != "" {
		payload["generatedKeyExpires"] = created.Expiration
	} else {
		payload["generatedKeyExpires"] = nil
	}
	payload["generatedKeyTags"] = []string{}
	httpx.JSON(w, 200, payload)
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
func (h *handler) meshOAuthTags(w http.ResponseWriter, r *http.Request) { h.ensureMeshACL(w, r) }
