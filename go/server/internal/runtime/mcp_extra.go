// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
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

func (h *handler) bootstrapMCPPolicies(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var count int
	if e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM mcp_policies WHERE tenant_id=?`), p.TenantID).Scan(&count); e != nil {
		statusErr(w, e)
		return
	}
	if count == 0 {
		now := h.store.now()
		_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO mcp_policies(id,tenant_id,agent_id,name,policy_json,created_at,updated_at) VALUES(?,?,NULL,'Default','{"includeBuiltin":true,"toolAllowlist":null,"toolDenylist":[]}',?,?)`), h.store.id(), p.TenantID, now, now)
		if e != nil {
			statusErr(w, e)
			return
		}
	}
	policies := []map[string]any{}
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,agent_id,name,policy_json,created_at,updated_at FROM mcp_policies WHERE tenant_id=? ORDER BY created_at DESC`), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	for rows.Next() {
		var id, name, policy, c, u string
		var agent *string
		if rows.Scan(&id, &agent, &name, &policy, &c, &u) == nil {
			x := map[string]any{"id": id, "agentId": agent, "name": name, "apiKeyId": nil, "apiKey": nil, "createdAt": c, "updatedAt": u}
			var fields map[string]any
			if json.Unmarshal([]byte(policy), &fields) == nil {
				for k, v := range fields {
					x[k] = v
				}
			}
			policies = append(policies, x)
		}
	}
	rows.Close()
	apiKeys := []map[string]any{}
	rows, e = h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,name,key_prefix FROM api_keys WHERE tenant_id=? AND revoked_at IS NULL ORDER BY created_at DESC`), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	for rows.Next() {
		var id, name, prefix string
		if rows.Scan(&id, &name, &prefix) == nil {
			apiKeys = append(apiKeys, map[string]any{"id": id, "name": name, "keyPrefix": prefix})
		}
	}
	rows.Close()
	instances := []map[string]any{}
	rows, e = h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,name,component_ref FROM component_instances WHERE tenant_id=? ORDER BY created_at DESC`), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	for rows.Next() {
		var id, name, slug string
		if rows.Scan(&id, &name, &slug) == nil {
			instances = append(instances, map[string]any{"id": id, "name": name, "slug": slug})
		}
	}
	rows.Close()
	httpx.JSON(w, 200, map[string]any{"policies": policies, "apiKeys": apiKeys, "instances": instances})
}
func parseVSCode(raw json.RawMessage) ([]map[string]any, error) {
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil {
		return nil, errors.New("invalid JSON")
	}
	serversRaw := root["servers"]
	if serversRaw == nil {
		if mcp, ok := root["mcp"].(map[string]any); ok {
			serversRaw = mcp["servers"]
		}
	}
	servers, ok := serversRaw.(map[string]any)
	if !ok {
		return nil, errors.New("servers object not found")
	}
	out := make([]map[string]any, 0, len(servers))
	for name, value := range servers {
		cfg, ok := value.(map[string]any)
		if !ok {
			continue
		}
		entry := map[string]any{"name": name}
		if u, ok := cfg["url"].(string); ok {
			entry["url"] = u
		}
		if command, ok := cfg["command"].(string); ok {
			entry["command"] = command
		}
		entry["config"] = cfg
		out = append(out, entry)
	}
	return out, nil
}
func (h *handler) parseVSCodeMCP(w http.ResponseWriter, r *http.Request) {
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if e != nil {
		httpx.Error(w, 413, "body too large")
		return
	}
	items, e := parseVSCode(raw)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"servers": items})
}
func (h *handler) importVSCodeMCP(w http.ResponseWriter, r *http.Request) {
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if e != nil {
		httpx.Error(w, 413, "body too large")
		return
	}
	items, e := parseVSCode(raw)
	if e != nil {
		statusErr(w, e)
		return
	}
	p := principal(r)
	created := []map[string]any{}
	for _, item := range items {
		name, _ := item["name"].(string)
		u, _ := item["url"].(string)
		if u == "" {
			continue
		}
		cfg, _ := json.Marshal(item["config"])
		now := h.store.now()
		id := h.store.id()
		configStored, secretStored, protectErr := h.protectMCPConfig(id, cfg)
		if protectErr != nil {
			continue
		}
		_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,last_error,created_at,updated_at) VALUES(?,?,NULL,'mcp',?,?,?,?, 'ready',NULL,?,?)`), id, p.TenantID, slugify(name), name, configStored, secretStored, now, now)
		if e == nil {
			created = append(created, map[string]any{"id": id, "name": name, "url": u})
		}
	}
	httpx.JSON(w, 201, map[string]any{"instances": created, "skipped": len(items) - len(created)})
}
func (h *handler) syncMCPStore(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,source_url,format FROM mcp_store_sources WHERE tenant_id=? AND enabled=true`), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	type source struct{ id, url, format string }
	sources := []source{}
	for rows.Next() {
		var x source
		if rows.Scan(&x.id, &x.url, &x.format) == nil {
			sources = append(sources, x)
		}
	}
	rows.Close()
	synced := 0
	failed := map[string]string{}
	for _, s := range sources {
		target, e := safeProviderURL(s.url, "")
		if e != nil {
			failed[s.id] = e.Error()
			continue
		}
		req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
		resp, e := h.service.gateway.client.Do(req)
		if e != nil {
			failed[s.id] = e.Error()
			continue
		}
		raw, e := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if e != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			failed[s.id] = fmt.Sprintf("HTTP %d", resp.StatusCode)
			continue
		}
		var manifest map[string]any
		if json.Unmarshal(raw, &manifest) != nil {
			failed[s.id] = "invalid JSON"
			continue
		}
		servers := manifest["servers"]
		if servers == nil {
			servers = manifest["mcpServers"]
		}
		serverRaw, _ := json.Marshal(servers)
		now := h.store.now()
		_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE mcp_store_sources SET manifest_json=?,servers_json=?,fetched_at=?,updated_at=? WHERE tenant_id=? AND id=?`), string(raw), string(serverRaw), now, now, p.TenantID, s.id)
		if e != nil {
			failed[s.id] = e.Error()
			continue
		}
		if object, ok := servers.(map[string]any); ok {
			for name, meta := range object {
				metaRaw, _ := json.Marshal(meta)
				_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO store_catalog_entries(id,tenant_id,source_id,kind,ref,name,description,meta_json,updated_at) VALUES(?,? ,?,'mcp',?,?, '',?,?)`), h.store.id(), p.TenantID, s.id, name, name, string(metaRaw), now)
			}
		}
		synced++
	}
	httpx.JSON(w, 200, map[string]any{"synced": synced, "failed": failed})
}

type oauthState struct {
	TenantID, UserID, InstanceID, MCPURL, TokenEndpoint, ClientID, ClientSecret, RedirectURI string
	Expires                                                                                  int64
}

func (h *handler) signOAuthState(state oauthState) string {
	raw, _ := json.Marshal(state)
	mac := hmac.New(sha256.New, h.deps.Secret)
	mac.Write(raw)
	return base64.RawURLEncoding.EncodeToString(raw) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (h *handler) parseOAuthState(value string) (oauthState, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return oauthState{}, errors.New("invalid state")
	}
	raw, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return oauthState{}, e
	}
	sig, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return oauthState{}, e
	}
	mac := hmac.New(sha256.New, h.deps.Secret)
	mac.Write(raw)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return oauthState{}, errors.New("invalid state signature")
	}
	var state oauthState
	if json.Unmarshal(raw, &state) != nil || state.Expires < h.store.now().Unix() {
		return oauthState{}, errors.New("expired state")
	}
	return state, nil
}
func (h *handler) mcpOAuthStart(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct{ MCPURL, InstanceID, AuthorizationEndpoint, TokenEndpoint, ClientID, ClientSecret, Scope string }
	if httpx.DecodeJSON(r, &b) != nil || b.MCPURL == "" {
		httpx.Error(w, 400, "mcpUrl required")
		return
	}
	mcpURL, e := safeProviderURL(b.MCPURL, "")
	if e != nil {
		statusErr(w, e)
		return
	}
	if b.AuthorizationEndpoint == "" || b.TokenEndpoint == "" {
		u, _ := url.Parse(mcpURL.String())
		metadataURL := u.Scheme + "://" + u.Host + "/.well-known/oauth-authorization-server"
		req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, metadataURL, nil)
		resp, e := h.service.gateway.client.Do(req)
		if e != nil {
			httpx.Error(w, 502, e.Error())
			return
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		var meta struct {
			AuthorizationEndpoint string `json:"authorization_endpoint"`
			TokenEndpoint         string `json:"token_endpoint"`
		}
		if json.Unmarshal(raw, &meta) != nil {
			httpx.Error(w, 502, "invalid OAuth metadata")
			return
		}
		b.AuthorizationEndpoint, b.TokenEndpoint = meta.AuthorizationEndpoint, meta.TokenEndpoint
	}
	if b.ClientID == "" {
		httpx.Error(w, 400, "clientId required")
		return
	}
	redirect := strings.TrimRight(h.deps.PublicURL, "/") + "/api/mcp/upstream-oauth/callback"
	state := h.signOAuthState(oauthState{TenantID: p.TenantID, UserID: p.UserID, InstanceID: b.InstanceID, MCPURL: b.MCPURL, TokenEndpoint: b.TokenEndpoint, ClientID: b.ClientID, ClientSecret: b.ClientSecret, RedirectURI: redirect, Expires: h.store.now().Add(10 * time.Minute).Unix()})
	auth, e := url.Parse(b.AuthorizationEndpoint)
	if e != nil {
		statusErr(w, e)
		return
	}
	q := auth.Query()
	q.Set("response_type", "code")
	q.Set("client_id", b.ClientID)
	q.Set("redirect_uri", redirect)
	q.Set("state", state)
	if b.Scope != "" {
		q.Set("scope", b.Scope)
	}
	auth.RawQuery = q.Encode()
	httpx.JSON(w, 200, map[string]any{"authorizeUrl": auth.String(), "state": state, "redirectUri": redirect})
}
func (h *handler) mcpOAuthCallback(w http.ResponseWriter, r *http.Request) {
	state, e := h.parseOAuthState(r.URL.Query().Get("state"))
	if e != nil {
		httpx.Error(w, 400, e.Error())
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		httpx.Error(w, 400, "code required")
		return
	}
	form := url.Values{"grant_type": []string{"authorization_code"}, "code": []string{code}, "redirect_uri": []string{state.RedirectURI}, "client_id": []string{state.ClientID}}
	if state.ClientSecret != "" {
		form.Set("client_secret", state.ClientSecret)
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, state.TokenEndpoint, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		httpx.Error(w, 502, string(raw))
		return
	}
	var token map[string]any
	if json.Unmarshal(raw, &token) != nil {
		httpx.Error(w, 502, "invalid token response")
		return
	}
	if state.InstanceID != "" {
		enc, e := secretBox(h.deps.Secret, "mcp:"+state.InstanceID, raw)
		if e != nil {
			statusErr(w, e)
			return
		}
		secret, _ := json.Marshal(map[string]any{"enc": enc})
		_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE component_instances SET secret_json=?,updated_at=? WHERE tenant_id=? AND id=?`), string(secret), h.store.now(), state.TenantID, state.InstanceID)
		if e != nil {
			statusErr(w, e)
			return
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.WriteString(w, "<!doctype html><title>Zakura OAuth</title><p>Authorization completed. You may close this window.</p>")
}
func (h *handler) mcpOAuthVerify(w http.ResponseWriter, r *http.Request) {
	var b struct {
		InstanceID string `json:"instanceId"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.InstanceID == "" {
		httpx.Error(w, 400, "instanceId required")
		return
	}
	inst, e := h.getMCPInstance(r.Context(), principal(r).TenantID, b.InstanceID)
	if e != nil {
		statusErr(w, e)
		return
	}
	result, e := h.mcpRPC(r.Context(), inst, "tools/list", map[string]any{})
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "tools": json.RawMessage(result)})
}

type exposedMCPTool struct {
	Instance  mcpInstance
	LocalName string
	Name      string
	Tool      map[string]any
}

type agentMCPSession struct {
	TenantID string
	AgentID  string
	Expires  time.Time
}

func (h *handler) createAgentMCPSession(tenant, agent string) string {
	h.mcpMu.Lock()
	defer h.mcpMu.Unlock()
	if h.mcpSessions == nil {
		h.mcpSessions = map[string]agentMCPSession{}
	}
	now := h.store.now()
	for id, session := range h.mcpSessions {
		if session.Expires.Before(now) {
			delete(h.mcpSessions, id)
		}
	}
	id := h.store.id()
	h.mcpSessions[id] = agentMCPSession{TenantID: tenant, AgentID: agent, Expires: now.Add(30 * time.Minute)}
	return id
}

func (h *handler) validateAgentMCPSession(id, tenant, agent string) bool {
	if id == "" {
		return false
	}
	h.mcpMu.Lock()
	defer h.mcpMu.Unlock()
	session, ok := h.mcpSessions[id]
	if !ok || session.TenantID != tenant || session.AgentID != agent || session.Expires.Before(h.store.now()) {
		delete(h.mcpSessions, id)
		return false
	}
	session.Expires = h.store.now().Add(30 * time.Minute)
	h.mcpSessions[id] = session
	return true
}

func (h *handler) deleteAgentMCPSession(id string) {
	h.mcpMu.Lock()
	delete(h.mcpSessions, id)
	h.mcpMu.Unlock()
}

func (h *handler) mcpAgentForRequest(r *http.Request, p httpx.Principal) (string, string, error) {
	prefix := "/mcp/agents/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		return "", "", ErrNotFound
	}
	slug, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, prefix))
	if err != nil || slug == "" || strings.Contains(slug, "/") {
		return "", "", ErrNotFound
	}
	var id string
	err = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id FROM agents WHERE tenant_id=? AND slug=?`), p.TenantID, slug).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if p.AgentID != "" && p.AgentID != id {
		return "", "", errors.New("token is bound to a different agent")
	}
	return id, slug, nil
}

func mcpStringList(value any) []string {
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func listContains(list []string, values ...string) bool {
	for _, item := range list {
		for _, value := range values {
			if item == value {
				return true
			}
		}
	}
	return false
}

func (h *handler) exposedMCPTools(r *http.Request, p httpx.Principal, agentID string) ([]exposedMCPTool, error) {
	rows, err := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT DISTINCT i.id,i.name,i.component_ref FROM component_instances i LEFT JOIN agent_bindings b ON b.instance_id=i.id AND b.tenant_id=i.tenant_id WHERE i.tenant_id=? AND i.component_type='mcp' AND i.status IN ('ready','running') AND (i.agent_id=? OR b.agent_id=?) ORDER BY i.name,i.id`), p.TenantID, agentID, agentID)
	if err != nil {
		return nil, err
	}
	type summary struct{ id, name, ref string }
	instances := []summary{}
	for rows.Next() {
		var item summary
		if rows.Scan(&item.id, &item.name, &item.ref) == nil {
			instances = append(instances, item)
		}
	}
	rows.Close()
	var policyRaw string
	policy := map[string]any{}
	if h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT policy_json FROM mcp_policies WHERE tenant_id=? AND (agent_id=? OR agent_id IS NULL) ORDER BY CASE WHEN agent_id=? THEN 0 ELSE 1 END,created_at LIMIT 1`), p.TenantID, agentID, agentID).Scan(&policyRaw) == nil {
		_ = json.Unmarshal([]byte(policyRaw), &policy)
	}
	instanceAllow := mcpStringList(policy["instanceIds"])
	allow := mcpStringList(policy["toolAllowlist"])
	deny := mcpStringList(policy["toolDenylist"])
	out := []exposedMCPTool{}
	for _, summary := range instances {
		if len(instanceAllow) > 0 && !listContains(instanceAllow, summary.id) {
			continue
		}
		instance, err := h.getMCPInstance(r.Context(), p.TenantID, summary.id)
		if err != nil {
			continue
		}
		result, err := h.mcpRPC(r.Context(), instance, "tools/list", map[string]any{})
		if err != nil {
			continue
		}
		var listed struct {
			Tools []map[string]any `json:"tools"`
		}
		_ = json.Unmarshal(result, &listed)
		for _, tool := range listed.Tools {
			local, _ := tool["name"].(string)
			if local == "" {
				continue
			}
			rawQualified := slugify(summary.ref) + "__" + local
			qualified := "re_" + rawQualified
			if len(allow) > 0 && !listContains(allow, qualified, rawQualified, "re_"+local, local) {
				continue
			}
			if listContains(deny, qualified, rawQualified, "re_"+local, local) {
				continue
			}
			out = append(out, exposedMCPTool{Instance: instance, LocalName: local, Name: qualified, Tool: tool})
		}
	}
	return out, nil
}

func (h *handler) accessibleMCPInstances(r *http.Request, p httpx.Principal, agentID string) ([]mcpInstance, error) {
	rows, err := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT DISTINCT i.id FROM component_instances i LEFT JOIN agent_bindings b ON b.instance_id=i.id AND b.tenant_id=i.tenant_id WHERE i.tenant_id=? AND i.component_type='mcp' AND i.status IN ('ready','running') AND (i.agent_id=? OR b.agent_id=?) ORDER BY i.id`), p.TenantID, agentID, agentID)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	out := make([]mcpInstance, 0, len(ids))
	for _, id := range ids {
		if instance, err := h.getMCPInstance(r.Context(), p.TenantID, id); err == nil {
			out = append(out, instance)
		}
	}
	return out, nil
}

func encodeMCPResourceURI(instanceID, upstream string) string {
	return "zakura-mcp://" + url.PathEscape(instanceID) + "/" + base64.RawURLEncoding.EncodeToString([]byte(upstream))
}

// qualifyMCPResourceTemplate keeps RFC 6570 variables visible to MCP clients
// while carrying the exact upstream template in an opaque, reversible path.
// All variables are collected into the query expansion of the qualified URI;
// resources/read expands them back into the upstream operator/explode form.
// This avoids the old behaviour of base64-encoding braces, which advertised a
// string no URI-template client could expand.
func qualifyMCPResourceTemplate(instanceID, upstream string) string {
	variables := uriTemplateVariables(upstream)
	if len(variables) == 0 {
		return encodeMCPResourceURI(instanceID, upstream)
	}
	return "zakura-mcp://" + url.PathEscape(instanceID) + "/template/" + base64.RawURLEncoding.EncodeToString([]byte(upstream)) + "{?" + strings.Join(variables, ",") + "}"
}

func uriTemplateVariables(template string) []string {
	seen := map[string]bool{}
	var out []string
	for start := 0; ; {
		i := strings.IndexByte(template[start:], '{')
		if i < 0 {
			break
		}
		i += start
		j := strings.IndexByte(template[i+1:], '}')
		if j < 0 {
			break
		}
		j += i + 1
		expr := template[i+1 : j]
		if len(expr) > 0 && strings.ContainsRune("+#./;?&", rune(expr[0])) {
			expr = expr[1:]
		}
		for _, spec := range strings.Split(expr, ",") {
			name := strings.TrimSuffix(strings.SplitN(spec, ":", 2)[0], "*")
			if name != "" && !seen[name] {
				seen[name] = true
				out = append(out, name)
			}
		}
		start = j + 1
	}
	return out
}

func rfc3986Escape(value string, allowReserved bool) string {
	const hexChars = "0123456789ABCDEF"
	var b strings.Builder
	for _, c := range []byte(value) {
		unreserved := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", rune(c))
		reserved := strings.ContainsRune(":/?#[]@!$&'()*+,;=", rune(c))
		if unreserved || allowReserved && reserved {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hexChars[c>>4])
			b.WriteByte(hexChars[c&15])
		}
	}
	return b.String()
}

func expandURITemplate(template string, values url.Values) (string, error) {
	var out strings.Builder
	for offset := 0; offset < len(template); {
		i := strings.IndexByte(template[offset:], '{')
		if i < 0 {
			out.WriteString(template[offset:])
			break
		}
		i += offset
		out.WriteString(template[offset:i])
		j := strings.IndexByte(template[i+1:], '}')
		if j < 0 {
			return "", errors.New("invalid upstream URI template")
		}
		j += i + 1
		expr := template[i+1 : j]
		op := byte(0)
		if len(expr) > 0 && strings.ContainsRune("+#./;?&", rune(expr[0])) {
			op, expr = expr[0], expr[1:]
		}
		var parts []string
		for _, rawSpec := range strings.Split(expr, ",") {
			explode := strings.HasSuffix(rawSpec, "*")
			spec := strings.TrimSuffix(rawSpec, "*")
			prefix := 0
			if colon := strings.IndexByte(spec, ':'); colon >= 0 {
				_, _ = fmt.Sscanf(spec[colon+1:], "%d", &prefix)
				spec = spec[:colon]
			}
			all, ok := values[spec]
			if !ok {
				continue
			}
			if len(all) == 0 {
				all = []string{""}
			}
			encoded := make([]string, 0, len(all))
			for _, value := range all {
				if prefix > 0 && len([]rune(value)) > prefix {
					value = string([]rune(value)[:prefix])
				}
				encoded = append(encoded, rfc3986Escape(value, op == '+' || op == '#'))
			}
			switch op {
			case ';':
				if explode {
					for _, value := range encoded {
						parts = append(parts, spec+func() string {
							if value == "" {
								return ""
							}
							return "=" + value
						}())
					}
				} else {
					parts = append(parts, spec+func() string {
						if len(encoded) == 1 && encoded[0] == "" {
							return ""
						}
						return "=" + strings.Join(encoded, ",")
					}())
				}
			case '?', '&':
				if explode {
					for _, value := range encoded {
						parts = append(parts, spec+"="+value)
					}
				} else {
					parts = append(parts, spec+"="+strings.Join(encoded, ","))
				}
			default:
				if explode {
					parts = append(parts, encoded...)
				} else {
					parts = append(parts, strings.Join(encoded, ","))
				}
			}
		}
		separator, prefixText := ",", ""
		switch op {
		case '#':
			prefixText = "#"
		case '.':
			prefixText, separator = ".", "."
		case '/':
			prefixText, separator = "/", "/"
		case ';':
			prefixText, separator = ";", ";"
		case '?':
			prefixText, separator = "?", "&"
		case '&':
			prefixText, separator = "&", "&"
		}
		if len(parts) > 0 {
			out.WriteString(prefixText)
			out.WriteString(strings.Join(parts, separator))
		}
		offset = j + 1
	}
	return out.String(), nil
}

func decodeMCPResourceURI(value string) (string, string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "zakura-mcp" || u.Host == "" {
		return "", "", errors.New("invalid Zakura resource URI")
	}
	encoded := strings.TrimPrefix(u.Path, "/")
	isTemplate := strings.HasPrefix(encoded, "template/")
	if isTemplate {
		encoded = strings.TrimPrefix(encoded, "template/")
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", errors.New("invalid Zakura resource URI")
	}
	upstream := string(raw)
	if isTemplate {
		upstream, err = expandURITemplate(upstream, u.Query())
		if err != nil {
			return "", "", err
		}
	}
	return u.Host, upstream, nil
}

func (h *handler) accessibleMCPInstance(r *http.Request, p httpx.Principal, agentID, instanceID string) (mcpInstance, error) {
	instances, err := h.accessibleMCPInstances(r, p, agentID)
	if err != nil {
		return mcpInstance{}, err
	}
	for _, instance := range instances {
		if instance.ID == instanceID {
			return instance, nil
		}
	}
	return mcpInstance{}, ErrNotFound
}

func (h *handler) mcpEntry(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/mcp/agents/") {
		httpx.JSON(w, http.StatusNotFound, map[string]any{"error": "tenant_mcp_removed", "message": "Zakura only supports Agent-scoped MCP. Use /mcp/agents/{slug} and bind upstream servers to that Agent.", "agentMcpPattern": strings.TrimRight(h.deps.PublicURL, "/") + "/mcp/agents/{slug}"})
		return
	}
	if r.Method == http.MethodGet && strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html") && strings.HasPrefix(r.URL.Path, "/mcp/agents/") {
		slug, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/mcp/agents/"))
		if err == nil && slug != "" && !strings.Contains(slug, "/") {
			httpx.JSON(w, http.StatusOK, map[string]any{"name": "Zakura Agent MCP (" + slug + ")", "transport": "streamable-http", "auth": map[string]any{"methods": []string{"oauth2.1", "api_key"}}, "agentSlug": slug})
			return
		}
	}
	if r.Header.Get("Authorization") == "" {
		if key := strings.TrimSpace(r.Header.Get("X-API-Key")); key != "" {
			clone := r.Clone(r.Context())
			clone.Header = r.Header.Clone()
			clone.Header.Set("Authorization", "Bearer "+key)
			r = clone
		}
	}
	httpx.Auth(h.deps)(http.HandlerFunc(h.mcpServer)).ServeHTTP(w, r)
}

func (h *handler) mcpServer(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if p.APIKey && !apiKeyScopeAllows(p, "mcp") {
		httpx.Error(w, http.StatusForbidden, "insufficient_scope")
		return
	}
	agentID, _, agentErr := h.mcpAgentForRequest(r, p)
	if agentErr != nil {
		if agentErr.Error() == "token is bound to a different agent" {
			httpx.JSON(w, http.StatusForbidden, map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32001, "message": agentErr.Error()}})
			return
		}
		if errors.Is(agentErr, ErrNotFound) {
			httpx.JSON(w, http.StatusNotFound, map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32004, "message": "Unknown agent"}})
			return
		}
		statusErr(w, agentErr)
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	sessionID := strings.TrimSpace(r.Header.Get("Mcp-Session-Id"))
	if r.Method == http.MethodGet {
		if !h.validateAgentMCPSession(sessionID, p.TenantID, agentID) {
			httpx.Error(w, http.StatusBadRequest, "Invalid or missing session ID")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, ": connected\n\n")
		return
	}
	if r.Method == http.MethodDelete {
		if !h.validateAgentMCPSession(sessionID, p.TenantID, agentID) {
			httpx.Error(w, http.StatusBadRequest, "Invalid or missing session ID")
			return
		}
		h.deleteAgentMCPSession(sessionID)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, GET, OPTIONS")
		httpx.Error(w, 405, "method not allowed")
		return
	}
	var req rpcEnvelope
	if httpx.DecodeJSON(r, &req) != nil || req.Method == "" {
		httpx.Error(w, 400, "invalid JSON-RPC request")
		return
	}
	if req.Method == "initialize" {
		if sessionID != "" {
			httpx.JSON(w, http.StatusBadRequest, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": "initialize must not reuse a session"}})
			return
		}
		sessionID = h.createAgentMCPSession(p.TenantID, agentID)
		w.Header().Set("Mcp-Session-Id", sessionID)
	} else if req.Method != "ping" && !h.validateAgentMCPSession(sessionID, p.TenantID, agentID) {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": "Invalid or missing session ID"}})
		return
	}
	if req.Method == "notifications/initialized" {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	reply := func(result any, rpcErr any) {
		response := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		if rpcErr != nil {
			response["error"] = rpcErr
		} else {
			response["result"] = result
		}
		httpx.JSON(w, 200, response)
	}
	switch req.Method {
	case "initialize":
		reply(map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{"listChanged": false}, "resources": map[string]any{"subscribe": false, "listChanged": false}, "prompts": map[string]any{"listChanged": false}, "completions": map[string]any{}}, "serverInfo": map[string]any{"name": "zakura", "version": "go-rewrite"}}, nil)
	case "ping":
		reply(map[string]any{}, nil)
	case "tools/list":
		exposed, e := h.exposedMCPTools(r, p, agentID)
		if e != nil {
			reply(nil, map[string]any{"code": -32603, "message": e.Error()})
			return
		}
		tools := make([]map[string]any, 0, len(exposed))
		for _, item := range exposed {
			tool := map[string]any{"name": item.Name, "description": item.Tool["description"], "inputSchema": item.Tool["inputSchema"]}
			if tool["inputSchema"] == nil {
				tool["inputSchema"] = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			tools = append(tools, tool)
		}
		reply(map[string]any{"tools": tools}, nil)
	case "tools/call":
		raw, _ := json.Marshal(req.Params)
		var pms struct {
			Name      string `json:"name"`
			Arguments any    `json:"arguments"`
		}
		_ = json.Unmarshal(raw, &pms)
		exposed, e := h.exposedMCPTools(r, p, agentID)
		if e != nil {
			reply(nil, map[string]any{"code": -32603, "message": e.Error()})
			return
		}
		var selected *exposedMCPTool
		for i := range exposed {
			if exposed[i].Name == pms.Name || exposed[i].Instance.ID+":"+exposed[i].LocalName == pms.Name {
				selected = &exposed[i]
				break
			}
		}
		if selected == nil {
			reply(nil, map[string]any{"code": -32602, "message": "Unknown tool: " + pms.Name})
			return
		}
		result, e := h.mcpRPC(r.Context(), selected.Instance, "tools/call", map[string]any{"name": selected.LocalName, "arguments": pms.Arguments})
		if e != nil {
			reply(nil, map[string]any{"code": -32000, "message": e.Error()})
			return
		}
		reply(json.RawMessage(result), nil)
	case "resources/list", "resources/templates/list":
		instances, e := h.accessibleMCPInstances(r, p, agentID)
		if e != nil {
			reply(nil, map[string]any{"code": -32603, "message": e.Error()})
			return
		}
		field := "resources"
		if req.Method == "resources/templates/list" {
			field = "resourceTemplates"
		}
		items := []map[string]any{}
		for _, instance := range instances {
			result, err := h.mcpRPC(r.Context(), instance, req.Method, map[string]any{})
			if err != nil {
				continue
			}
			var response map[string]json.RawMessage
			_ = json.Unmarshal(result, &response)
			var listed []map[string]any
			_ = json.Unmarshal(response[field], &listed)
			for _, item := range listed {
				if uri, _ := item["uri"].(string); uri != "" {
					item["uri"] = encodeMCPResourceURI(instance.ID, uri)
				}
				if template, _ := item["uriTemplate"].(string); template != "" {
					item["uriTemplate"] = qualifyMCPResourceTemplate(instance.ID, template)
				}
				item["_meta"] = map[string]any{"instanceId": instance.ID, "providerId": instance.Ref}
				items = append(items, item)
			}
		}
		reply(map[string]any{field: items}, nil)
	case "resources/read":
		raw, _ := json.Marshal(req.Params)
		var params struct {
			URI string `json:"uri"`
		}
		_ = json.Unmarshal(raw, &params)
		instanceID, upstreamURI, err := decodeMCPResourceURI(params.URI)
		if err != nil {
			reply(nil, map[string]any{"code": -32602, "message": err.Error()})
			return
		}
		instance, err := h.accessibleMCPInstance(r, p, agentID, instanceID)
		if err != nil {
			reply(nil, map[string]any{"code": -32602, "message": "Unknown resource"})
			return
		}
		result, err := h.mcpRPC(r.Context(), instance, "resources/read", map[string]any{"uri": upstreamURI})
		if err != nil {
			reply(nil, map[string]any{"code": -32000, "message": err.Error()})
			return
		}
		reply(json.RawMessage(result), nil)
	case "prompts/list":
		instances, e := h.accessibleMCPInstances(r, p, agentID)
		if e != nil {
			reply(nil, map[string]any{"code": -32603, "message": e.Error()})
			return
		}
		items := []map[string]any{}
		for _, instance := range instances {
			result, err := h.mcpRPC(r.Context(), instance, "prompts/list", map[string]any{})
			if err != nil {
				continue
			}
			var response struct {
				Prompts []map[string]any `json:"prompts"`
			}
			_ = json.Unmarshal(result, &response)
			for _, item := range response.Prompts {
				if local, _ := item["name"].(string); local != "" {
					item["name"] = "re_" + slugify(instance.Ref) + "__" + local
					item["_meta"] = map[string]any{"instanceId": instance.ID, "localName": local}
					items = append(items, item)
				}
			}
		}
		reply(map[string]any{"prompts": items}, nil)
	case "prompts/get":
		raw, _ := json.Marshal(req.Params)
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		_ = json.Unmarshal(raw, &params)
		instances, _ := h.accessibleMCPInstances(r, p, agentID)
		for _, instance := range instances {
			prefix := "re_" + slugify(instance.Ref) + "__"
			if strings.HasPrefix(params.Name, prefix) {
				result, err := h.mcpRPC(r.Context(), instance, "prompts/get", map[string]any{"name": strings.TrimPrefix(params.Name, prefix), "arguments": params.Arguments})
				if err != nil {
					reply(nil, map[string]any{"code": -32000, "message": err.Error()})
					return
				}
				reply(json.RawMessage(result), nil)
				return
			}
		}
		reply(nil, map[string]any{"code": -32602, "message": "Unknown prompt"})
	case "completion/complete":
		raw, _ := json.Marshal(req.Params)
		var params map[string]any
		_ = json.Unmarshal(raw, &params)
		ref, _ := params["ref"].(map[string]any)
		name, _ := ref["name"].(string)
		instances, _ := h.accessibleMCPInstances(r, p, agentID)
		for _, instance := range instances {
			prefix := "re_" + slugify(instance.Ref) + "__"
			if strings.HasPrefix(name, prefix) {
				ref["name"] = strings.TrimPrefix(name, prefix)
				result, err := h.mcpRPC(r.Context(), instance, "completion/complete", params)
				if err != nil {
					reply(nil, map[string]any{"code": -32000, "message": err.Error()})
					return
				}
				reply(json.RawMessage(result), nil)
				return
			}
		}
		reply(nil, map[string]any{"code": -32602, "message": "Unknown completion reference"})
	default:
		reply(nil, map[string]any{"code": -32601, "message": "method not found"})
	}
}

func (h *handler) googleProvisionGuide(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, map[string]any{"steps": []string{"Create a Google Cloud project", "Enable the required Workspace APIs", "Create OAuth credentials with the displayed redirect URI", "Authorize the connector for an agent"}, "redirectUri": strings.TrimRight(h.deps.PublicURL, "/") + "/api/mcp/upstream-oauth/callback"})
}
func (h *handler) googleProvision(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name                string  `json:"name"`
		AgentID             *string `json:"agentId"`
		URL                 string  `json:"url"`
		Config, Credentials json.RawMessage
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Name == "" || b.URL == "" {
		httpx.Error(w, 400, "name and url required")
		return
	}
	if _, e := safeProviderURL(b.URL, ""); e != nil {
		statusErr(w, e)
		return
	}
	now := h.store.now()
	id := h.store.id()
	enc, e := secretBox(h.deps.Secret, "mcp:"+id, b.Credentials)
	if e != nil {
		statusErr(w, e)
		return
	}
	cfg := map[string]any{"url": b.URL}
	if len(b.Config) > 0 {
		_ = json.Unmarshal(b.Config, &cfg)
		cfg["url"] = b.URL
	}
	cfgRaw, _ := json.Marshal(cfg)
	secret, _ := json.Marshal(map[string]any{"enc": enc})
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,last_error,created_at,updated_at) VALUES(?,?,?,'mcp','google-workspace',?,?,?,'ready',NULL,?,?)`), id, principal(r).TenantID, b.AgentID, b.Name, string(cfgRaw), string(secret), now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"instance": map[string]any{"id": id, "name": b.Name, "status": "ready"}})
}
func (h *handler) integrationPackages(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), `SELECT id,slug,name,description,manifest_json,created_at,updated_at FROM integration_packages ORDER BY name`)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, slug, name, description, manifest, c, u string
		if rows.Scan(&id, &slug, &name, &description, &manifest, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "slug": slug, "name": name, "description": description, "manifest": json.RawMessage(manifest), "createdAt": c, "updatedAt": u})
		}
	}
	httpx.JSON(w, 200, map[string]any{"packages": out})
}
func (h *handler) integrationPackage(w http.ResponseWriter, r *http.Request) {
	var id, slug, name, description, manifest string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,slug,name,description,manifest_json FROM integration_packages WHERE slug=?`), chi.URLParam(r, "slug")).Scan(&id, &slug, &name, &description, &manifest)
	if errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"package": map[string]any{"id": id, "slug": slug, "name": name, "description": description, "manifest": json.RawMessage(manifest)}})
}

var _ = bytes.NewBuffer
