// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
)

var modelAuthPolls sync.Map
var modelAuthLogins sync.Map

type modelAuthLogin struct {
	TenantID, UpstreamID, DeviceCode, TokenURL, ClientID string
	ExpiresAt                                            time.Time
}

var otelRateBuckets = struct {
	sync.Mutex
	values map[string]struct {
		count   int
		resetAt time.Time
	}
}{values: map[string]struct {
	count   int
	resetAt time.Time
}{}}

func (h *handler) registerMisc(r chi.Router) {
	r.Get("/capabilities", h.capabilities)
	r.Get("/capabilities/web-fetch", h.getWebFetch)
	r.Put("/capabilities/web-fetch", h.putWebFetch)
	r.Get("/capabilities/web-search", h.getWebSearch)
	r.Put("/capabilities/web-search", h.putWebSearch)
	r.Patch("/instances/{id}/tools/{toolName}", h.patchInstanceTool)
	r.Post("/model-upstreams/{id}/auth/start", h.modelAuthStart)
	r.Post("/model-upstreams/{id}/auth/poll", h.modelAuthPoll)
	r.Post("/model-upstreams/{id}/auth/submit", h.modelAuthSubmit)
	r.Post("/model-upstreams/{id}/auth/cancel", h.modelAuthCancel)
	r.Post("/model-upstreams/{id}/auth/logout", h.modelAuthLogout)
	r.Get("/system/image-updates", h.imageUpdateList)
	r.Post("/system/image-updates/check", h.imageUpdateCheck)
	r.Post("/system/image-updates/check-all", h.imageUpdateCheckAll)
}
func (h *handler) getSetting(ctx context.Context, owner, key string) (map[string]any, error) {
	var enc string
	e := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT value FROM settings WHERE owner_key=? AND key=?`), owner, key).Scan(&enc)
	if e != nil {
		return map[string]any{}, e
	}
	raw, e := openSecretBox(h.deps.Secret, "setting:"+owner+":"+key, enc)
	if e != nil {
		return nil, e
	}
	var out map[string]any
	e = json.Unmarshal(raw, &out)
	return out, e
}
func (h *handler) putSetting(ctx context.Context, owner, key string, value map[string]any) error {
	raw, e := json.Marshal(value)
	if e != nil {
		return e
	}
	enc, e := secretBox(h.deps.Secret, "setting:"+owner+":"+key, raw)
	if e != nil {
		return e
	}
	_, e = h.deps.DB.ExecContext(ctx, h.store.q(`INSERT INTO settings(id,owner_key,key,value) VALUES(?,?,?,?) ON CONFLICT(owner_key,key) DO UPDATE SET value=?`), h.store.id(), owner, key, enc, enc)
	return e
}
func redactConfig(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		lower := strings.ToLower(k)
		if strings.Contains(lower, "key") || strings.Contains(lower, "token") || strings.Contains(lower, "secret") || strings.Contains(lower, "password") {
			if fmt.Sprint(v) != "" {
				out[k+"Configured"] = true
			}
			continue
		}
		out[k] = v
	}
	return out
}
func (h *handler) capabilities(w http.ResponseWriter, r *http.Request) {
	owner := "tenant:" + principal(r).TenantID
	fetch, _ := h.getSetting(r.Context(), owner, "web-fetch")
	search, _ := h.getSetting(r.Context(), owner, "web-search")
	if fetch["backends"] == nil {
		fetch["backends"] = map[string]any{}
	}
	if search["engines"] == nil {
		search["engines"] = map[string]any{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"webSearch":        map[string]any{"instance": capabilityInstance("web-search"), "engines": webSearchEngineMeta(), "config": redactConfig(search)},
		"webFetch":         map[string]any{"instance": capabilityInstance("web-fetch"), "backends": webFetchBackendMeta(), "config": redactConfig(fetch)},
		"platformServices": platformServiceCatalog, "platformDefaults": map[string]any{"autoManagedServices": []any{}, "multiTenant": h.deps.MultiTenant},
	})
}

func capabilityInstance(key string) map[string]any {
	return map[string]any{"id": "builtin:" + key, "status": "ready", "healthStatus": "healthy", "lastError": nil, "slug": key}
}

func webSearchEngineMeta() []map[string]any {
	return []map[string]any{
		{"id": "tavily", "name": "Tavily", "description": "Agent-focused search API", "requiresApiKey": true, "docsUrl": "https://tavily.com"},
		{"id": "serper", "name": "Serper", "description": "Google results through Serper.dev", "requiresApiKey": true, "docsUrl": "https://serper.dev"},
		{"id": "brave", "name": "Brave", "description": "Brave Search API", "requiresApiKey": true, "docsUrl": "https://brave.com/search/api/"},
		{"id": "jina", "name": "Jina Search", "description": "Jina search API", "requiresApiKey": false},
		{"id": "bing", "name": "Bing", "description": "Bing Web Search", "requiresApiKey": true},
		{"id": "searxng", "name": "SearXNG", "description": "Self-hosted metasearch", "requiresApiKey": false, "requiresBaseUrl": true},
	}
}
func webFetchBackendMeta() []map[string]any {
	return []map[string]any{
		{"id": "native", "name": "Native", "description": "Direct HTTP fetch", "requiresApiKey": false},
		{"id": "jina-reader", "name": "Jina Reader", "description": "Convert pages to Markdown", "requiresApiKey": false},
		{"id": "firecrawl", "name": "Firecrawl", "description": "Firecrawl extraction", "requiresApiKey": true},
		{"id": "crawl4ai", "name": "Crawl4AI", "description": "Self-hosted page extraction", "requiresApiKey": false, "requiresBaseUrl": true},
	}
}
func (h *handler) getCapability(w http.ResponseWriter, r *http.Request, key string) {
	cfg, e := h.getSetting(r.Context(), "tenant:"+principal(r).TenantID, key)
	if errors.Is(e, sql.ErrNoRows) {
		cfg = map[string]any{"enabled": false}
		e = nil
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	result := map[string]any{"instance": capabilityInstance(key), "config": redactConfig(cfg)}
	if key == "web-search" {
		result["engines"] = webSearchEngineMeta()
	} else {
		result["backends"] = webFetchBackendMeta()
	}
	httpx.JSON(w, http.StatusOK, result)
}
func (h *handler) putCapability(w http.ResponseWriter, r *http.Request, key string) {
	var cfg map[string]any
	if httpx.DecodeJSON(r, &cfg) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if endpoint, ok := cfg["endpoint"].(string); ok && endpoint != "" {
		if _, e := safeProviderURL(endpoint, ""); e != nil {
			statusErr(w, e)
			return
		}
	}
	e := h.putSetting(r.Context(), "tenant:"+principal(r).TenantID, key, cfg)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "instance": capabilityInstance(key), "config": redactConfig(cfg)})
}
func (h *handler) getWebFetch(w http.ResponseWriter, r *http.Request) {
	h.getCapability(w, r, "web-fetch")
}
func (h *handler) putWebFetch(w http.ResponseWriter, r *http.Request) {
	h.putCapability(w, r, "web-fetch")
}
func (h *handler) getWebSearch(w http.ResponseWriter, r *http.Request) {
	h.getCapability(w, r, "web-search")
}
func (h *handler) putWebSearch(w http.ResponseWriter, r *http.Request) {
	h.putCapability(w, r, "web-search")
}
func (h *handler) patchInstanceTool(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	inst, e := h.getInstance(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	var b struct {
		Enabled  bool   `json:"enabled"`
		Approval string `json:"approval"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(inst.Config, &cfg)
	tools, _ := cfg["tools"].(map[string]any)
	if tools == nil {
		tools = map[string]any{}
	}
	tools[chi.URLParam(r, "toolName")] = map[string]any{"enabled": b.Enabled, "approval": b.Approval}
	cfg["tools"] = tools
	raw, _ := json.Marshal(cfg)
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE component_instances SET config_json=?,updated_at=? WHERE tenant_id=? AND id=?`), string(raw), h.store.now(), p.TenantID, inst.ID)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"tool": tools[chi.URLParam(r, "toolName")]})
}

func (h *handler) protectUpstreamCredential(tenant, id string, cfg map[string]any) error {
	return protectModelConfig(h.deps.Secret, tenant, id, cfg)
}
func protectModelConfig(secret []byte, tenant, id string, cfg map[string]any) error {
	credentials := map[string]any{}
	for _, key := range []string{"apiKey", "accessToken", "refreshToken", "clientSecret"} {
		if v, ok := cfg[key]; ok {
			credentials[key] = v
			delete(cfg, key)
		}
	}
	if len(credentials) == 0 {
		return nil
	}
	raw, _ := json.Marshal(credentials)
	enc, e := secretBox(secret, "model:"+tenant+":"+id, raw)
	if e != nil {
		return e
	}
	cfg["credentialEnc"] = enc
	return nil
}
func (h *handler) modelAuthConfig(ctx context.Context, tenant, id string) (Upstream, map[string]any, error) {
	u, e := h.store.GetUpstream(ctx, tenant, id)
	if e != nil {
		return u, nil, e
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(u.Config, &cfg)
	return u, cfg, nil
}
func (h *handler) modelAuthStart(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	u, cfg, e := h.modelAuthConfig(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	deviceURL, _ := cfg["deviceAuthorizationUrl"].(string)
	clientID, _ := cfg["clientId"].(string)
	if deviceURL == "" || clientID == "" {
		httpx.Error(w, 400, "deviceAuthorizationUrl and clientId required in upstream config")
		return
	}
	form := url.Values{"client_id": []string{clientID}}
	if scope, _ := cfg["scope"].(string); scope != "" {
		form.Set("scope", scope)
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, deviceURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
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
	var device struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		Interval                int    `json:"interval"`
		ExpiresIn               int    `json:"expires_in"`
	}
	if json.Unmarshal(raw, &device) != nil || device.DeviceCode == "" {
		httpx.Error(w, http.StatusBadGateway, "invalid device authorization response")
		return
	}
	if device.Interval <= 0 {
		device.Interval = 5
	}
	if device.ExpiresIn <= 0 {
		device.ExpiresIn = 600
	}
	loginID := h.store.id()
	modelAuthLogins.Store(loginID, modelAuthLogin{TenantID: p.TenantID, UpstreamID: u.ID, DeviceCode: device.DeviceCode, TokenURL: fmt.Sprint(cfg["tokenUrl"]), ClientID: clientID, ExpiresAt: h.store.now().Add(time.Duration(device.ExpiresIn) * time.Second)})
	verification := device.VerificationURIComplete
	if verification == "" {
		verification = device.VerificationURI
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"loginId": loginID, "kind": "device", "status": "pending", "userCode": device.UserCode, "verificationUrl": verification, "interval": device.Interval, "expiresIn": device.ExpiresIn})
}
func (h *handler) modelAuthPoll(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	_, cfg, e := h.modelAuthConfig(r.Context(), p.TenantID, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	var b struct {
		LoginID string `json:"loginId"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.LoginID == "" {
		httpx.Error(w, 400, "loginId required")
		return
	}
	rawLogin, ok := modelAuthLogins.Load(b.LoginID)
	if !ok {
		httpx.Error(w, http.StatusNotFound, "login not found")
		return
	}
	login := rawLogin.(modelAuthLogin)
	if login.TenantID != p.TenantID || login.UpstreamID != id || h.store.now().After(login.ExpiresAt) {
		modelAuthLogins.Delete(b.LoginID)
		httpx.JSON(w, http.StatusOK, map[string]any{"loginId": b.LoginID, "kind": "device", "status": "error", "error": "login expired"})
		return
	}
	tokenURL, clientID := login.TokenURL, login.ClientID
	if tokenURL == "" || clientID == "" {
		httpx.Error(w, 400, "token endpoint is not configured")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	key := p.TenantID + ":" + id
	modelAuthPolls.Store(key, cancel)
	defer modelAuthPolls.Delete(key)
	form := url.Values{"grant_type": []string{"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": []string{login.DeviceCode}, "client_id": []string{clientID}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		if errors.Is(e, context.Canceled) {
			httpx.Error(w, 409, "poll cancelled")
			return
		}
		httpx.Error(w, 502, e.Error())
		return
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var oauthErr map[string]any
		_ = json.Unmarshal(raw, &oauthErr)
		errCode := fmt.Sprint(oauthErr["error"])
		if errCode == "authorization_pending" || errCode == "slow_down" {
			httpx.JSON(w, http.StatusOK, map[string]any{"loginId": b.LoginID, "kind": "device", "status": "pending", "interval": 5})
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"loginId": b.LoginID, "kind": "device", "status": "error", "error": errCode})
		return
	}
	var token map[string]any
	if json.Unmarshal(raw, &token) != nil {
		httpx.Error(w, 502, "invalid token response")
		return
	}
	for _, k := range []string{"access_token", "refresh_token"} {
		if v, ok := token[k]; ok {
			cfg[map[string]string{"access_token": "accessToken", "refresh_token": "refreshToken"}[k]] = v
		}
	}
	if e = h.protectUpstreamCredential(p.TenantID, id, cfg); e != nil {
		statusErr(w, e)
		return
	}
	cfgRaw, _ := json.Marshal(cfg)
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE model_upstreams SET config_json=?,status='ready',last_error=NULL,updated_at=? WHERE tenant_id=? AND id=?`), string(cfgRaw), h.store.now(), p.TenantID, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	modelAuthLogins.Delete(b.LoginID)
	httpx.JSON(w, http.StatusOK, map[string]any{"loginId": b.LoginID, "kind": "device", "status": "complete"})
}
func (h *handler) modelAuthSubmit(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	_, cfg, e := h.modelAuthConfig(r.Context(), p.TenantID, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	var b map[string]any
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if encoded, ok := b["credentialsJson"].(string); ok && strings.TrimSpace(encoded) != "" {
		var supplied map[string]any
		if json.Unmarshal([]byte(encoded), &supplied) != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid credentials JSON")
			return
		}
		for key, value := range supplied {
			b[key] = value
		}
	}
	if token, ok := b["setupToken"].(string); ok && token != "" {
		b["apiKey"] = token
	}
	if code, ok := b["code"].(string); ok && code != "" {
		b["accessToken"] = code
	}
	for _, k := range []string{"apiKey", "accessToken", "refreshToken", "clientSecret"} {
		if v, ok := b[k]; ok {
			cfg[k] = v
		}
	}
	if e = h.protectUpstreamCredential(p.TenantID, id, cfg); e != nil {
		statusErr(w, e)
		return
	}
	raw, _ := json.Marshal(cfg)
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE model_upstreams SET config_json=?,status='ready',last_error=NULL,updated_at=? WHERE tenant_id=? AND id=?`), string(raw), h.store.now(), p.TenantID, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	loginID, _ := b["loginId"].(string)
	kind := "paste"
	if loginID == "" {
		loginID = h.store.id()
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"loginId": loginID, "kind": kind, "status": "complete"})
}
func (h *handler) modelAuthCancel(w http.ResponseWriter, r *http.Request) {
	key := principal(r).TenantID + ":" + chi.URLParam(r, "id")
	var b struct {
		LoginID string `json:"loginId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&b)
	if b.LoginID != "" {
		modelAuthLogins.Delete(b.LoginID)
	}
	if v, ok := modelAuthPolls.Load(key); ok {
		v.(context.CancelFunc)()
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"loginId": b.LoginID, "kind": "device", "status": "cancelled"})
}
func (h *handler) modelAuthLogout(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	_, cfg, e := h.modelAuthConfig(r.Context(), p.TenantID, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	delete(cfg, "credentialEnc")
	raw, _ := json.Marshal(cfg)
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE model_upstreams SET config_json=?,status='auth_required',updated_at=? WHERE tenant_id=? AND id=?`), string(raw), h.store.now(), p.TenantID, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (h *handler) getOTelConfig(w http.ResponseWriter, r *http.Request) {
	endpoint := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"))
	destination := any(nil)
	if parsed, err := url.Parse(endpoint); err == nil && endpoint != "" {
		destination = parsed.Host
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"enabled": true, "ingest": "/api/otel/v1/logs", "collector": endpoint != "", "dest": destination,
	})
}
func (h *handler) ingestOTelLogs(w http.ResponseWriter, r *http.Request) {
	actor := httpx.Principal{UserID: "0", TenantID: "0"}
	if token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")); token != "" {
		if authenticated, err := h.authenticateRealtime(r.Context(), token); err == nil {
			actor = authenticated
		}
	}
	remote := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	if remote == "" {
		remote = r.RemoteAddr
	}
	if otelRateLimited(actor.UserID + ":" + actor.TenantID + ":" + remote) {
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<20))
	if err != nil {
		httpx.Error(w, 413, "payload too large")
		return
	}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		httpx.Error(w, 400, "invalid OTLP JSON")
		return
	}
	if !filterAndStampOTel(payload, actor.UserID, actor.TenantID) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	endpoint := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"))
	if endpoint != "" {
		stamped, _ := json.Marshal(payload)
		go h.forwardOTel(endpoint, stamped)
	}
	w.WriteHeader(http.StatusAccepted)
}

func otelRateLimited(key string) bool {
	now := time.Now()
	otelRateBuckets.Lock()
	defer otelRateBuckets.Unlock()
	bucket, ok := otelRateBuckets.values[key]
	if !ok || !now.Before(bucket.resetAt) {
		otelRateBuckets.values[key] = struct {
			count   int
			resetAt time.Time
		}{count: 1, resetAt: now.Add(time.Minute)}
		return false
	}
	bucket.count++
	otelRateBuckets.values[key] = bucket
	return bucket.count > 60
}

func filterAndStampOTel(payload map[string]any, userID, tenantID string) bool {
	resourceLogs, _ := payload["resourceLogs"].([]any)
	hasError := false
	for _, rawResource := range resourceLogs {
		resource, _ := rawResource.(map[string]any)
		if resource == nil {
			continue
		}
		resourceInfo, _ := resource["resource"].(map[string]any)
		if resourceInfo == nil {
			resourceInfo = map[string]any{}
			resource["resource"] = resourceInfo
		}
		resourceInfo["attributes"] = stampOTelAttributes(resourceInfo["attributes"], userID, tenantID)
		scopeLogs, _ := resource["scopeLogs"].([]any)
		for _, rawScope := range scopeLogs {
			scope, _ := rawScope.(map[string]any)
			records, _ := scope["logRecords"].([]any)
			filtered := make([]any, 0, len(records))
			for _, rawRecord := range records {
				record, _ := rawRecord.(map[string]any)
				severityText := strings.ToLower(fmt.Sprint(record["severityText"]))
				severityNumber, _ := record["severityNumber"].(float64)
				if severityNumber < 17 && severityText != "error" && severityText != "fatal" {
					continue
				}
				hasError = true
				record["attributes"] = stampOTelAttributes(record["attributes"], userID, tenantID)
				filtered = append(filtered, record)
			}
			scope["logRecords"] = filtered
		}
	}
	return hasError
}

func stampOTelAttributes(raw any, userID, tenantID string) []any {
	values, _ := raw.([]any)
	out := make([]any, 0, len(values)+2)
	for _, value := range values {
		entry, _ := value.(map[string]any)
		key, _ := entry["key"].(string)
		if key != "user.id" && key != "tenant.id" {
			out = append(out, value)
		}
	}
	out = append(out,
		map[string]any{"key": "user.id", "value": map[string]any{"stringValue": userID}},
		map[string]any{"key": "tenant.id", "value": map[string]any{"stringValue": tenantID}},
	)
	return out
}

func (h *handler) forwardOTel(endpoint string, body []byte) {
	ctx, cancel := context.WithTimeout(h.deps.RunContext(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	for _, pair := range strings.Split(os.Getenv("OTEL_EXPORTER_OTLP_HEADERS"), ",") {
		key, value, ok := strings.Cut(pair, "=")
		if ok && strings.TrimSpace(key) != "" {
			req.Header.Set(strings.TrimSpace(key), strings.TrimSpace(value))
		}
	}
	response, err := h.service.gateway.client.Do(req)
	if err == nil {
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	}
}

func (h *handler) imageUpdateList(w http.ResponseWriter, r *http.Request) {
	result := h.globalImageUpdates(r.Context(), principal(r).TenantID, false)
	httpx.JSON(w, http.StatusOK, result)
}
func (h *handler) imageUpdateCheck(w http.ResponseWriter, r *http.Request) {
	var body struct {
		NodeID            string `json:"nodeId"`
		AllowPullFallback bool   `json:"allowPullFallback"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.NodeID == "" {
		httpx.Error(w, http.StatusBadRequest, "nodeId required")
		return
	}
	result, err := h.checkNodeImages(r.Context(), principal(r).TenantID, body.NodeID, body.AllowPullFallback)
	if err != nil {
		httpx.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}
func (h *handler) imageUpdateCheckAll(w http.ResponseWriter, r *http.Request) {
	result := h.globalImageUpdates(r.Context(), principal(r).TenantID, true)
	httpx.JSON(w, http.StatusOK, result)
}
func (h *handler) globalImageUpdates(ctx context.Context, tenant string, pull bool) map[string]any {
	rows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT id FROM runtime_nodes WHERE (tenant_id=? OR is_shared=TRUE) AND status IN ('online','draining') ORDER BY name`), tenant)
	if err != nil {
		return map[string]any{"hasUpdates": false, "hasRunningStale": false, "hasErrors": true, "nodes": []any{}}
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	nodes := []map[string]any{}
	hasUpdates, hasStale, hasErrors := false, false, false
	for _, id := range ids {
		node, e := h.checkNodeImages(ctx, tenant, id, pull)
		if e != nil {
			hasErrors = true
			node = map[string]any{"nodeId": id, "error": e.Error(), "images": []any{}}
		}
		if v, _ := node["hasUpdates"].(bool); v {
			hasUpdates = true
		}
		if v, _ := node["hasRunningStale"].(bool); v {
			hasStale = true
		}
		if v, _ := node["hasErrors"].(bool); v {
			hasErrors = true
		}
		nodes = append(nodes, node)
	}
	return map[string]any{"hasUpdates": hasUpdates, "hasRunningStale": hasStale, "hasErrors": hasErrors, "nodes": nodes}
}
func (h *handler) checkNodeImages(ctx context.Context, tenant, nodeID string, pull bool) (map[string]any, error) {
	var name, status, kind string
	var shared bool
	if err := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT name,status,kind,is_shared FROM runtime_nodes WHERE (tenant_id=? OR is_shared=TRUE) AND id=?`), tenant, nodeID).Scan(&name, &status, &kind, &shared); err != nil {
		return nil, err
	}
	rows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT DISTINCT workspace_image FROM spaces WHERE tenant_id=? AND runtime_node_id=? AND workspace_image IS NOT NULL`), tenant, nodeID)
	if err != nil {
		return nil, err
	}
	images := []string{}
	for rows.Next() {
		var image string
		if rows.Scan(&image) == nil {
			images = append(images, image)
		}
	}
	rows.Close()
	session, err := h.hub.get(nodeID)
	if err != nil {
		return nil, err
	}
	if pull {
		for _, image := range images {
			_ = session.call(ctx, "docker.pull", map[string]any{"image": image}, nil)
		}
	}
	var entries []map[string]any
	if err = session.call(ctx, "docker.images", map[string]any{"images": images}, &entries); err != nil {
		return nil, err
	}
	updates, stale, errs := false, false, false
	for _, entry := range entries {
		entry["kind"] = "workspace"
		available, _ := entry["runningStale"].(bool)
		entry["updateAvailable"] = available
		if available {
			updates = true
			stale = true
		}
		if entry["error"] != nil && fmt.Sprint(entry["error"]) != "" {
			errs = true
		}
	}
	access := "owned"
	if shared {
		access = "shared"
	}
	return map[string]any{"nodeId": nodeID, "nodeName": name, "nodeStatus": status, "nodeKind": kind, "access": access, "images": entries, "checkedAt": h.store.now().UnixMilli(), "hasUpdates": updates, "hasRunningStale": stale, "hasErrors": errs}, nil
}
