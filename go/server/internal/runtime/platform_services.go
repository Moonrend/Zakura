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
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
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
func scanPlatformService(row interface{ Scan(...any) error }) (map[string]any, error) {
	var id, key, mode, desired, status, health, containers, c, u string
	var endpoint, lastErr *string
	var config string
	e := row.Scan(&id, &key, &mode, &desired, &status, &health, &config, &endpoint, &containers, &lastErr, &c, &u)
	return map[string]any{"id": id, "key": key, "mode": mode, "desiredState": desired, "status": status, "healthStatus": health, "endpointUrl": endpoint, "containers": json.RawMessage(containers), "lastError": lastErr, "createdAt": c, "updatedAt": u}, e
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
	rows, e := h.deps.DB.QueryContext(r.Context(), `SELECT id,service_key,mode,desired_state,status,health_status,config_enc,endpoint_url,containers_json,last_error,created_at,updated_at FROM platform_services ORDER BY service_key`)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	byKey := map[string]map[string]any{}
	for rows.Next() {
		x, e := scanPlatformService(rows)
		if e == nil {
			byKey[x["key"].(string)] = x
		}
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
	x, e := scanPlatformService(h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,service_key,mode,desired_state,status,health_status,config_enc,endpoint_url,containers_json,last_error,created_at,updated_at FROM platform_services WHERE service_key=?`), key))
	if errors.Is(e, sql.ErrNoRows) {
		e = ErrNotFound
	}
	return x, e
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
	now := h.store.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO platform_services(id,service_key,mode,desired_state,status,health_status,config_enc,endpoint_url,containers_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,'unknown',?,?,'[]',NULL,?,?) ON CONFLICT(service_key) DO UPDATE SET mode=?,desired_state=?,config_enc=?,endpoint_url=?,updated_at=?`), h.store.id(), key, b.Mode, b.DesiredState, "stopped", enc, nullString(b.EndpointURL), now, now, b.Mode, b.DesiredState, enc, nullString(b.EndpointURL), now)
	if e != nil {
		statusErr(w, e)
		return
	}
	h.getPlatformService(w, r)
}
func (h *handler) serviceConfig(key string) (map[string]any, error) {
	var enc string
	e := h.deps.DB.QueryRowContext(h.deps.RunContext(), h.store.q(`SELECT config_enc FROM platform_services WHERE service_key=?`), key).Scan(&enc)
	if e != nil {
		return nil, e
	}
	raw, e := openSecretBox(h.deps.Secret, "platform-service:"+key, enc)
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
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE platform_services SET desired_state='running',status='running',health_status='unknown',containers_json=?,last_error=NULL,updated_at=? WHERE service_key=?`), string(containers), h.store.now(), key)
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
	now := h.store.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO platform_services(id,service_key,mode,desired_state,status,health_status,config_enc,endpoint_url,containers_json,last_error,created_at,updated_at) VALUES(?,?,'external','running','running','healthy',?,?,'[]',NULL,?,?) ON CONFLICT(service_key) DO UPDATE SET mode='external',desired_state='running',status='running',health_status='healthy',config_enc=?,endpoint_url=?,last_error=NULL,updated_at=?`), h.store.id(), key, enc, b.EndpointURL, now, now, enc, b.EndpointURL, now)
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
	var containersRaw string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT containers_json FROM platform_services WHERE service_key=?`), key).Scan(&containersRaw)
	if e != nil {
		statusErr(w, e)
		return
	}
	var ids []string
	_ = json.Unmarshal([]byte(containersRaw), &ids)
	for _, id := range ids {
		_, _, _ = dockerCall(r.Context(), http.MethodPost, "/v1.43/containers/"+id+"/stop?t=10", nil)
	}
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE platform_services SET mode='disabled',desired_state='stopped',status='stopped',health_status='unknown',updated_at=? WHERE service_key=?`), h.store.now(), key)
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
	var containersRaw string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT containers_json FROM platform_services WHERE service_key=?`), key).Scan(&containersRaw)
	if e != nil {
		statusErr(w, e)
		return
	}
	var ids []string
	_ = json.Unmarshal([]byte(containersRaw), &ids)
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
	var mode string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT mode FROM platform_services WHERE service_key=?`), chi.URLParam(r, "key")).Scan(&mode)
	if e != nil {
		statusErr(w, e)
		return
	}
	if mode == "managed" {
		h.deployPlatformService(w, r)
		return
	}
	var endpoint *string
	e = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT endpoint_url FROM platform_services WHERE service_key=?`), chi.URLParam(r, "key")).Scan(&endpoint)
	if e != nil || endpoint == nil {
		httpx.Error(w, 409, "service endpoint is not configured")
		return
	}
	body, _ := json.Marshal(map[string]any{"endpointUrl": *endpoint, "config": map[string]any{}})
	r.Body = io.NopCloser(bytes.NewReader(body))
	h.connectPlatformService(w, r)
}
func (h *handler) platformServiceRestart(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	var containers string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT containers_json FROM platform_services WHERE service_key=?`), key).Scan(&containers)
	if e != nil {
		statusErr(w, e)
		return
	}
	var ids []string
	_ = json.Unmarshal([]byte(containers), &ids)
	for _, id := range ids {
		_, _, _ = dockerCall(r.Context(), http.MethodPost, "/v1.43/containers/"+id+"/restart?t=10", nil)
	}
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE platform_services SET status='running',desired_state='running',updated_at=? WHERE service_key=?`), h.store.now(), key)
	h.getPlatformService(w, r)
}
func (h *handler) platformServiceHealth(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	var endpoint *string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT endpoint_url FROM platform_services WHERE service_key=?`), key).Scan(&endpoint)
	if e != nil {
		statusErr(w, e)
		return
	}
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
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE platform_services SET health_status=?,last_error=?,updated_at=? WHERE service_key=?`), status, func() any {
		if healthy {
			return nil
		}
		return fmt.Sprint(detail)
	}(), h.store.now(), key)
	httpx.JSON(w, 200, map[string]any{"healthy": healthy, "detail": detail})
}
func (h *handler) listServiceQuotas(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), `SELECT id,scope_key,service_key,monthly_limit,daily_limit,created_at,updated_at FROM platform_service_quotas ORDER BY scope_key,service_key`)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, scope, key, c, u string
		var monthly, daily *int64
		if rows.Scan(&id, &scope, &key, &monthly, &daily, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "scopeKey": scope, "serviceKey": key, "monthlyLimit": monthly, "dailyLimit": daily, "createdAt": c, "updatedAt": u})
		}
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
	now := h.store.now()
	_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO platform_service_quotas(id,scope_key,service_key,monthly_limit,daily_limit,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_key,service_key) DO UPDATE SET monthly_limit=?,daily_limit=?,updated_at=?`), h.store.id(), b.ScopeKey, b.ServiceKey, b.MonthlyLimit, b.DailyLimit, now, now, b.MonthlyLimit, b.DailyLimit, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) serviceUsage(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), `SELECT tenant_id,user_id,service_key,period,request_count,error_count,created_at,updated_at FROM platform_service_usage ORDER BY period DESC,service_key LIMIT 1000`)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var tenant, user, key, period, c, u string
		var requests, errs int64
		if rows.Scan(&tenant, &user, &key, &period, &requests, &errs, &c, &u) == nil {
			out = append(out, map[string]any{"tenantId": tenant, "userId": user, "serviceKey": key, "period": period, "requestCount": requests, "errorCount": errs, "createdAt": c, "updatedAt": u})
		}
	}
	httpx.JSON(w, 200, map[string]any{"usage": out})
}

var _ = bytes.NewBuffer
var _ = io.Copy
var _ = strings.TrimSpace
