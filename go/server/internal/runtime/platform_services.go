// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (h *handler) registerPlatformServices(r chi.Router) {
	r.Get("/platform-services", h.listPlatformServices)
	r.Get("/platform-services/meta/quotas", h.listServiceQuotas)
	r.Put("/platform-services/meta/quotas", h.putServiceQuota)
	r.Get("/platform-services/meta/usage", h.serviceUsage)
	r.Get("/platform-services/{key}", h.getPlatformService)
	r.Patch("/platform-services/{key}", h.patchPlatformService)
	r.Post("/platform-services/{key}/deploy", h.deployPlatformService)
	r.Post("/platform-services/{key}/connect", h.connectPlatformService)
	r.Post("/platform-services/{key}/disable", h.disablePlatformService)
	r.Get("/platform-services/{key}/progress", h.platformServiceProgress)
	r.Get("/platform-services/{key}/logs", h.platformServiceLogs)
	r.Get("/platform-services/{key}/diagnostics", h.platformServiceDiagnostics)
	r.Post("/platform-services/{key}/start", h.platformServiceStart)
	r.Post("/platform-services/{key}/stop", h.disablePlatformService)
	r.Post("/platform-services/{key}/restart", h.platformServiceRestart)
	r.Post("/platform-services/{key}/health", h.platformServiceHealth)
}
func platformServiceFromModel(m models.PlatformService) map[string]any {
	id := ""
	if m.ID != nil {
		id = *m.ID
	}
	return map[string]any{"id": id, "key": m.ServiceKey, "mode": m.Mode, "desiredState": m.DesiredState, "status": m.Status, "healthStatus": m.HealthStatus, "endpointUrl": m.EndpointURL, "containers": json.RawMessage(m.ContainersJSON), "lastError": m.LastError, "createdAt": m.CreatedAt, "updatedAt": m.UpdatedAt}
}

var platformServiceCatalog = []map[string]any{
	{"key": "searxng", "name": "SearXNG", "description": "Self-hosted metasearch engine", "mapsTo": map[string]any{"kind": "search-engine", "id": "searxng"}, "defaultImage": "searxng/searxng:latest", "defaultHostPort": 18080},
	{"key": "jina-reader", "name": "Jina Reader", "description": "Self-hosted URL-to-Markdown reader", "mapsTo": map[string]any{"kind": "fetch-backend", "id": "jina-reader"}, "defaultImage": "ghcr.io/jina-ai/reader:oss", "defaultHostPort": 18081},
	{"key": "crawl4ai", "name": "Crawl4AI", "description": "Self-hosted Crawl4AI API", "mapsTo": map[string]any{"kind": "fetch-backend", "id": "crawl4ai"}, "defaultImage": "unclecode/crawl4ai:latest", "defaultHostPort": 11235},
	{"key": "firecrawl", "name": "Firecrawl", "description": "Self-hosted Firecrawl stack", "mapsTo": map[string]any{"kind": "fetch-backend", "id": "firecrawl"}, "defaultImage": "ghcr.io/firecrawl/firecrawl:latest", "defaultHostPort": 13002},
}

func catalogService(key string) map[string]any {
	for _, x := range platformServiceCatalog {
		if x["key"] == key {
			return x
		}
	}
	return map[string]any{"key": key, "name": key, "description": "", "mapsTo": map[string]any{"kind": "search-engine", "id": "searxng"}}
}
func platformServicePublic(raw map[string]any) map[string]any {
	key, _ := raw["key"].(string)
	meta := catalogService(key)
	out := map[string]any{}
	for k, v := range raw {
		out[k] = v
	}
	for _, k := range []string{"name", "description", "mapsTo"} {
		out[k] = meta[k]
	}
	out["catalogDefaultImage"] = meta["defaultImage"]
	out["catalogDefaultHostPort"] = meta["defaultHostPort"]
	out["config"] = map[string]any{"hasApiKey": false, "envKeys": []string{}}
	out["progress"] = map[string]any{"serviceKey": key, "phase": "idle", "percent": 0, "running": false, "done": false, "error": nil, "message": "", "events": []any{}, "updatedAt": time.Now().UnixMilli()}
	mode, _ := out["mode"].(string)
	state, label, tone, actions := "off", "Not enabled", "neutral", []string{"deploy"}
	if mode == "external" {
		state, label, tone, actions = "external_bad", "Not verified", "warn", []string{"connect", "configure", "disable"}
	} else if mode == "managed" {
		state, label, tone, actions = "ready", "Ready", "info", []string{"start", "configure", "disable"}
	}
	if out["healthStatus"] == "healthy" {
		state, label, tone, actions = "available", "Available", "success", []string{"stop", "restart", "health"}
	}
	out["lifecycle"] = map[string]any{"state": state, "label": label, "detail": out["endpointUrl"], "tone": tone, "busy": false, "actions": actions}
	return out
}
func (h *handler) listPlatformServices(w http.ResponseWriter, r *http.Request) {
	var ms []models.PlatformService
	if e := h.deps.Gorm.WithContext(r.Context()).Order("service_key").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	byKey := map[string]map[string]any{}
	for _, m := range ms {
		x := platformServiceFromModel(m)
		byKey[m.ServiceKey] = x
	}
	out := make([]map[string]any, 0, len(platformServiceCatalog))
	for _, meta := range platformServiceCatalog {
		key := meta["key"].(string)
		x := byKey[key]
		if x == nil {
			x = map[string]any{"key": key, "mode": "disabled", "desiredState": "stopped", "status": "stopped", "healthStatus": "unknown", "endpointUrl": nil, "lastError": nil, "containers": []any{}}
		}
		out = append(out, platformServicePublic(x))
	}
	p := principal(r)
	canManage := p.IsPlatformAdmin || (!h.deps.MultiTenant && (p.Role == "owner" || p.Role == "admin"))
	httpx.JSON(w, 200, map[string]any{"services": out, "catalog": platformServiceCatalog, "canManage": canManage, "multiTenant": h.deps.MultiTenant})
}
func (h *handler) getPlatformServiceRow(r *http.Request, key string) (map[string]any, error) {
	var m models.PlatformService
	e := h.deps.Gorm.WithContext(r.Context()).Where("service_key = ?", key).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = ErrNotFound
	}
	if e != nil {
		return nil, e
	}
	return platformServiceFromModel(m), nil
}
func (h *handler) getPlatformService(w http.ResponseWriter, r *http.Request) {
	x, e := h.getPlatformServiceRow(r, chi.URLParam(r, "key"))
	if e != nil {
		statusErr(w, e)
		return
	}
	p := principal(r)
	canManage := p.IsPlatformAdmin || (!h.deps.MultiTenant && (p.Role == "owner" || p.Role == "admin"))
	httpx.JSON(w, 200, map[string]any{"service": platformServicePublic(x), "canManage": canManage})
}
func (h *handler) patchPlatformService(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin {
		httpx.Error(w, 403, "platform admin required")
		return
	}
	key := chi.URLParam(r, "key")
	var b struct {
		Mode, DesiredState, EndpointURL string
		Config                          json.RawMessage
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if b.Mode == "" {
		b.Mode = "external"
	}
	if b.DesiredState == "" {
		b.DesiredState = "running"
	}
	if b.EndpointURL != "" {
		if _, e := safeProviderURL(b.EndpointURL, ""); e != nil {
			statusErr(w, e)
			return
		}
	}
	enc, e := secretBox(h.deps.Secret, "platform-service:"+key, b.Config)
	if e != nil {
		statusErr(w, e)
		return
	}
	now := runtimeTimeString(h.store.now())
	e = h.deps.Gorm.WithContext(r.Context()).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "service_key"}},
			DoUpdates: clause.AssignmentColumns([]string{"mode", "desired_state", "config_enc", "endpoint_url", "updated_at"}),
		}).
		Table("platform_services").
		Create(map[string]any{"id": h.store.id(), "service_key": key, "mode": b.Mode, "desired_state": b.DesiredState, "status": "stopped", "health_status": "unknown", "config_enc": enc, "endpoint_url": nullString(b.EndpointURL), "containers_json": "[]", "last_error": nil, "created_at": now, "updated_at": now}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	h.getPlatformService(w, r)
}
func (h *handler) serviceConfig(key string) (map[string]any, error) {
	var row struct {
		ConfigEnc string `gorm:"column:config_enc"`
	}
	e := h.deps.Gorm.WithContext(h.deps.RunContext()).Table("platform_services").Select("config_enc").Where("service_key = ?", key).Take(&row).Error
	if e != nil {
		return nil, e
	}
	raw, e := openSecretBox(h.deps.Secret, "platform-service:"+key, row.ConfigEnc)
	if e != nil {
		return nil, e
	}
	var cfg map[string]any
	e = json.Unmarshal(raw, &cfg)
	return cfg, e
}
func (h *handler) deployPlatformService(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin {
		httpx.Error(w, 403, "platform admin required")
		return
	}
	key := chi.URLParam(r, "key")
	cfg, e := h.serviceConfig(key)
	if e != nil {
		statusErr(w, e)
		return
	}
	image, _ := cfg["image"].(string)
	if image == "" {
		httpx.Error(w, 400, "service image required")
		return
	}
	name := "zakura-service-" + slugify(key)
	raw, _, e := dockerCall(r.Context(), http.MethodPost, "/v1.43/containers/create?name="+url.QueryEscape(name), map[string]any{"Image": image, "Env": stringList(cfg["env"]), "Labels": map[string]string{"com.zakura.platform-service": key}})
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	var created struct {
		ID string `json:"Id"`
	}
	if json.Unmarshal(raw, &created) != nil || created.ID == "" {
		httpx.Error(w, 502, "invalid Docker response")
		return
	}
	if _, _, e = dockerCall(r.Context(), http.MethodPost, "/v1.43/containers/"+created.ID+"/start", nil); e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	containers, _ := json.Marshal([]string{created.ID})
	e = h.deps.Gorm.WithContext(r.Context()).Model(&models.PlatformService{}).Where("service_key = ?", key).Updates(map[string]any{"desired_state": "running", "status": "running", "health_status": "unknown", "containers_json": string(containers), "last_error": nil, "updated_at": runtimeTimeString(h.store.now())}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	h.getPlatformService(w, r)
}
func stringList(v any) []string {
	raw, _ := json.Marshal(v)
	var out []string
	_ = json.Unmarshal(raw, &out)
	return out
}
func (h *handler) connectPlatformService(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin {
		httpx.Error(w, 403, "platform admin required")
		return
	}
	key := chi.URLParam(r, "key")
	var b struct {
		EndpointURL string          `json:"endpointUrl"`
		Config      json.RawMessage `json:"config"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.EndpointURL == "" {
		httpx.Error(w, 400, "endpointUrl required")
		return
	}
	u, e := safeProviderURL(b.EndpointURL, "")
	if e != nil {
		statusErr(w, e)
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		httpx.Error(w, 502, fmt.Sprintf("service HTTP %d", resp.StatusCode))
		return
	}
	enc, e := secretBox(h.deps.Secret, "platform-service:"+key, b.Config)
	if e != nil {
		statusErr(w, e)
		return
	}
	now := runtimeTimeString(h.store.now())
	e = h.deps.Gorm.WithContext(r.Context()).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "service_key"}},
			DoUpdates: clause.Assignments(map[string]any{
				"mode": "external", "desired_state": "running", "status": "running", "health_status": "healthy",
				"config_enc": enc, "endpoint_url": b.EndpointURL, "last_error": nil, "updated_at": now,
			}),
		}).
		Table("platform_services").
		Create(map[string]any{"id": h.store.id(), "service_key": key, "mode": "external", "desired_state": "running", "status": "running", "health_status": "healthy", "config_enc": enc, "endpoint_url": b.EndpointURL, "containers_json": "[]", "last_error": nil, "created_at": now, "updated_at": now}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	h.getPlatformService(w, r)
}
func (h *handler) disablePlatformService(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin {
		httpx.Error(w, 403, "platform admin required")
		return
	}
	key := chi.URLParam(r, "key")
	var row struct {
		ContainersJSON string `gorm:"column:containers_json"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("platform_services").Select("containers_json").Where("service_key = ?", key).Take(&row).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	var ids []string
	_ = json.Unmarshal([]byte(row.ContainersJSON), &ids)
	for _, id := range ids {
		_, _, _ = dockerCall(r.Context(), http.MethodPost, "/v1.43/containers/"+id+"/stop?t=10", nil)
	}
	e = h.deps.Gorm.WithContext(r.Context()).Model(&models.PlatformService{}).Where("service_key = ?", key).Updates(map[string]any{"mode": "disabled", "desired_state": "stopped", "status": "stopped", "health_status": "unknown", "updated_at": runtimeTimeString(h.store.now())}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	h.getPlatformService(w, r)
}
func (h *handler) platformServiceProgress(w http.ResponseWriter, r *http.Request) {
	x, e := h.getPlatformServiceRow(r, chi.URLParam(r, "key"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"progress": map[string]any{"status": x["status"], "desiredState": x["desiredState"], "healthStatus": x["healthStatus"], "error": x["lastError"]}})
}
func (h *handler) platformServiceLogs(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	var row struct {
		ContainersJSON string `gorm:"column:containers_json"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("platform_services").Select("containers_json").Where("service_key = ?", key).Take(&row).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	var ids []string
	_ = json.Unmarshal([]byte(row.ContainersJSON), &ids)
	logs := map[string]string{}
	for _, id := range ids {
		raw, _, e := dockerCall(r.Context(), http.MethodGet, "/v1.43/containers/"+id+"/logs?stdout=true&stderr=true&tail=500", nil)
		if e != nil {
			logs[id] = e.Error()
		} else {
			logs[id] = string(raw)
		}
	}
	httpx.JSON(w, 200, map[string]any{"logs": logs})
}
func (h *handler) platformServiceDiagnostics(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	x, e := h.getPlatformServiceRow(r, key)
	if e != nil {
		statusErr(w, e)
		return
	}
	endpoint, _ := x["endpointUrl"].(*string)
	diagnostics := map[string]any{"service": x, "checkedAt": h.store.now()}
	if endpoint != nil && *endpoint != "" {
		req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, *endpoint, nil)
		resp, e := h.service.gateway.client.Do(req)
		if e != nil {
			diagnostics["endpointError"] = e.Error()
		} else {
			diagnostics["endpointStatus"] = resp.StatusCode
			resp.Body.Close()
		}
	}
	httpx.JSON(w, 200, map[string]any{"diagnostics": diagnostics})
}
func (h *handler) platformServiceStart(w http.ResponseWriter, r *http.Request) {
	var row struct {
		Mode string `gorm:"column:mode"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("platform_services").Select("mode").Where("service_key = ?", chi.URLParam(r, "key")).Take(&row).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	if row.Mode == "managed" {
		h.deployPlatformService(w, r)
		return
	}
	var erow struct {
		EndpointURL *string `gorm:"column:endpoint_url"`
	}
	e = h.deps.Gorm.WithContext(r.Context()).Table("platform_services").Select("endpoint_url").Where("service_key = ?", chi.URLParam(r, "key")).Take(&erow).Error
	if e != nil || erow.EndpointURL == nil {
		httpx.Error(w, 409, "service endpoint is not configured")
		return
	}
	body, _ := json.Marshal(map[string]any{"endpointUrl": *erow.EndpointURL, "config": map[string]any{}})
	r.Body = io.NopCloser(bytes.NewReader(body))
	h.connectPlatformService(w, r)
}
func (h *handler) platformServiceRestart(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	var row struct {
		ContainersJSON string `gorm:"column:containers_json"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("platform_services").Select("containers_json").Where("service_key = ?", key).Take(&row).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	var ids []string
	_ = json.Unmarshal([]byte(row.ContainersJSON), &ids)
	for _, id := range ids {
		_, _, _ = dockerCall(r.Context(), http.MethodPost, "/v1.43/containers/"+id+"/restart?t=10", nil)
	}
	h.deps.Gorm.WithContext(r.Context()).Model(&models.PlatformService{}).Where("service_key = ?", key).Updates(map[string]any{"status": "running", "desired_state": "running", "updated_at": runtimeTimeString(h.store.now())})
	h.getPlatformService(w, r)
}
func (h *handler) platformServiceHealth(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	var erow struct {
		EndpointURL *string `gorm:"column:endpoint_url"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("platform_services").Select("endpoint_url").Where("service_key = ?", key).Take(&erow).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	endpoint := erow.EndpointURL
	healthy := false
	var detail any
	if endpoint != nil && *endpoint != "" {
		req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, *endpoint, nil)
		resp, e := h.service.gateway.client.Do(req)
		if e != nil {
			detail = e.Error()
		} else {
			healthy = resp.StatusCode < 500
			detail = resp.StatusCode
			resp.Body.Close()
		}
	}
	status := "unhealthy"
	if healthy {
		status = "healthy"
	}
	h.deps.Gorm.WithContext(r.Context()).Model(&models.PlatformService{}).Where("service_key = ?", key).Updates(map[string]any{"health_status": status, "last_error": func() any {
		if healthy {
			return nil
		}
		return fmt.Sprint(detail)
	}(), "updated_at": runtimeTimeString(h.store.now())})
	httpx.JSON(w, 200, map[string]any{"healthy": healthy, "detail": detail})
}
func (h *handler) listServiceQuotas(w http.ResponseWriter, r *http.Request) {
	var ms []models.PlatformServiceQuota
	if e := h.deps.Gorm.WithContext(r.Context()).Order("scope_key, service_key").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := []map[string]any{}
	for _, m := range ms {
		id := ""
		if m.ID != nil {
			id = *m.ID
		}
		out = append(out, map[string]any{"id": id, "scopeKey": m.ScopeKey, "serviceKey": m.ServiceKey, "monthlyLimit": m.MonthlyLimit, "dailyLimit": m.DailyLimit, "createdAt": m.CreatedAt, "updatedAt": m.UpdatedAt})
	}
	httpx.JSON(w, 200, map[string]any{"quotas": out})
}
func (h *handler) putServiceQuota(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin {
		httpx.Error(w, 403, "platform admin required")
		return
	}
	var b struct {
		ScopeKey, ServiceKey     string
		MonthlyLimit, DailyLimit *int64
	}
	if httpx.DecodeJSON(r, &b) != nil || b.ScopeKey == "" || b.ServiceKey == "" {
		httpx.Error(w, 400, "scopeKey and serviceKey required")
		return
	}
	now := runtimeTimeString(h.store.now())
	e := h.deps.Gorm.WithContext(r.Context()).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "scope_key"}, {Name: "service_key"}},
			DoUpdates: clause.AssignmentColumns([]string{"monthly_limit", "daily_limit", "updated_at"}),
		}).
		Table("platform_service_quotas").
		Create(map[string]any{"id": h.store.id(), "scope_key": b.ScopeKey, "service_key": b.ServiceKey, "monthly_limit": b.MonthlyLimit, "daily_limit": b.DailyLimit, "created_at": now, "updated_at": now}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) serviceUsage(w http.ResponseWriter, r *http.Request) {
	var ms []models.PlatformServiceUsage
	if e := h.deps.Gorm.WithContext(r.Context()).Order("period DESC, service_key").Limit(1000).Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := []map[string]any{}
	for _, m := range ms {
		out = append(out, map[string]any{"tenantId": m.TenantID, "userId": m.UserID, "serviceKey": m.ServiceKey, "period": m.Period, "requestCount": int64(m.RequestCount), "errorCount": int64(m.ErrorCount), "createdAt": m.CreatedAt, "updatedAt": m.UpdatedAt})
	}
	httpx.JSON(w, 200, map[string]any{"usage": out})
}
