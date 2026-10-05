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
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/appdeps"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

type mcpInstance struct {
	ID, Name, Ref, Status string
	TenantID              string
	AgentID               *string
	Config, Secret        json.RawMessage
}
type rpcEnvelope struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

func (h *handler) protectMCPConfig(id string, raw json.RawMessage) (string, string, error) {
	config := map[string]any{}
	if len(raw) > 0 && json.Unmarshal(raw, &config) != nil {
		return "", "", errors.New("invalid MCP config")
	}
	secret := map[string]any{}
	for _, key := range []string{"token", "apiKey", "accessToken", "headers", "credentials", "secret"} {
		if value, ok := config[key]; ok {
			secret[key] = value
			delete(config, key)
		}
	}
	configRaw, _ := json.Marshal(config)
	secretRaw, _ := json.Marshal(secret)
	enc, err := secretBox(h.deps.Secret, "mcp:"+id, secretRaw)
	if err != nil {
		return "", "", err
	}
	stored, _ := json.Marshal(map[string]any{"enc": enc, "configured": len(secret) > 0})
	return string(configRaw), string(stored), nil
}

func (h *handler) componentInstanceColumnExists(ctx context.Context, column string) bool {
	if h.deps.Dialect == "postgres" {
		var exists bool
		err := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema=current_schema() AND table_name=? AND column_name=?
		)`), "component_instances", column).Scan(&exists)
		return err == nil && exists
	}

	rows, err := h.deps.DB.QueryContext(ctx, `PRAGMA table_info(component_instances)`)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey) == nil && name == column {
			return true
		}
	}
	return false
}

// migrateLegacyComponentConfigs converts the pinned Drizzle config_enc payload
// into the native split representation. The compatibility column does not
// exist on fresh databases, so inspect schema metadata before preparing any
// statement that references it. Failed decryptions are deliberately untouched.
func (h *handler) migrateLegacyComponentConfigs(ctx context.Context) {
	if !h.componentInstanceColumnExists(ctx, "config_enc") {
		return
	}
	rows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT id,config_enc FROM component_instances WHERE config_enc IS NOT NULL AND config_enc<>'' AND (config_json IS NULL OR config_json='{}')`))
	if err != nil {
		return
	}
	type legacy struct{ id, encrypted string }
	items := []legacy{}
	for rows.Next() {
		var item legacy
		if rows.Scan(&item.id, &item.encrypted) == nil {
			items = append(items, item)
		}
	}
	rows.Close()
	for _, item := range items {
		plain, openErr := openSecretBox(h.deps.Secret, "component:"+item.id, item.encrypted)
		if openErr != nil || !json.Valid(plain) {
			continue
		}
		config, secret, protectErr := h.protectMCPConfig(item.id, plain)
		if protectErr != nil {
			continue
		}
		_, _ = h.deps.DB.ExecContext(ctx, h.store.q(`UPDATE component_instances SET config_json=?,secret_json=?,updated_at=? WHERE id=? AND (config_json IS NULL OR config_json='{}')`), config, secret, h.store.now(), item.id)
	}
}

func (h *handler) registerMCP(r chi.Router) {
	r.Get("/mcp/tools", h.listMCPTools)
	r.Get("/instances/{id}/tools", h.listInstanceTools)
	r.Get("/mcp/policies", h.listMCPPolicies)
	r.Post("/mcp/policies", h.createMCPPolicy)
	r.Put("/mcp/policies/{id}", h.updateMCPPolicy)
	r.Delete("/mcp/policies/{id}", h.deleteMCPPolicy)
	r.Post("/mcp/probe", h.probeMCP)
	r.Post("/mcp/import", h.importMCP)
	r.Post("/mcp/import-stdio", h.importMCP)
	r.Post("/mcp/call", h.mcpCall)
	r.Post("/mcp/resources/read", h.mcpResource)
	r.Post("/mcp/prompts/get", h.mcpPrompt)
	r.Post("/mcp/complete", h.mcpComplete)
	r.Get("/mcp/store/sources", h.listMCPSources)
	r.Post("/mcp/store/sources", h.createMCPSource)
	r.Delete("/mcp/store/sources/{id}", h.deleteMCPSource)
	r.Get("/mcp/store/search", h.searchMCPStore)
	r.Get("/mcp/store/servers/{name}", h.getMCPStoreEntry)
	r.Post("/mcp/store/install", h.installMCPStoreEntry)
	r.Get("/mcp/oauth-redirect-uri", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, map[string]any{"redirectUri": strings.TrimRight(h.deps.PublicURL, "/") + "/api/mcp/upstream-oauth/callback"})
	})
	r.Get("/mcp/policies/bootstrap", h.bootstrapMCPPolicies)
	r.Post("/mcp/import-vscode", h.importVSCodeMCP)
	r.Post("/mcp/parse-vscode", h.parseVSCodeMCP)
	r.Post("/mcp/store/sync", h.syncMCPStore)
	r.Post("/mcp/upstream-oauth/start", h.mcpOAuthStart)
	r.Post("/mcp/upstream-oauth/authorize", h.mcpOAuthStart)
	r.Post("/mcp/upstream-oauth/verify", h.mcpOAuthVerify)
	r.Get("/mcp/google/provision-guide", h.googleProvisionGuide)
	r.Post("/mcp/google/provision", h.googleProvision)
	r.Get("/integrations/packages", h.integrationPackages)
	r.Get("/integrations/packages/{slug}", h.integrationPackage)
}
func (h *handler) getMCPInstance(ctx context.Context, tenant, id string) (mcpInstance, error) {
	var x mcpInstance
	var cfg, sec string
	e := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT id,name,component_ref,status,agent_id,config_json,secret_json FROM component_instances WHERE tenant_id=? AND id=? AND component_type='mcp'`), tenant, id).Scan(&x.ID, &x.Name, &x.Ref, &x.Status, &x.AgentID, &cfg, &sec)
	if errors.Is(e, sql.ErrNoRows) {
		return x, ErrNotFound
	}
	x.Config = json.RawMessage(cfg)
	x.Secret = json.RawMessage(sec)
	x.TenantID = tenant
	return x, e
}
func (h *handler) mcpRPC(ctx context.Context, inst mcpInstance, method string, params any) (json.RawMessage, error) {
	var cfg struct {
		URL           string            `json:"url"`
		RuntimeNodeID string            `json:"runtimeNodeId"`
		Headers       map[string]string `json:"headers"`
	}
	var sec struct {
		Headers          map[string]string `json:"headers"`
		Token            string            `json:"token"`
		APIKey           string            `json:"apiKey"`
		AccessToken      string            `json:"access_token"`
		AccessTokenCamel string            `json:"accessToken"`
		Enc              string            `json:"enc"`
	}
	if json.Unmarshal(inst.Config, &cfg) != nil || cfg.URL == "" {
		return nil, errors.New("MCP instance has no HTTP URL")
	}
	_ = json.Unmarshal(inst.Secret, &sec)
	if sec.Enc != "" {
		if raw, err := openSecretBox(h.deps.Secret, "mcp:"+inst.ID, sec.Enc); err == nil {
			_ = json.Unmarshal(raw, &sec)
		}
	}
	u, e := url.Parse(cfg.URL)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("invalid MCP URL")
	}
	var safe *url.URL
	if cfg.RuntimeNodeID == "" {
		safe, e = safeProviderURL(cfg.URL, "")
		if e != nil {
			return nil, e
		}
	} else {
		// A provisioned stdio bridge intentionally lives on a runner address.
		// Require it to match the address reported by the tenant-owned node so a
		// modified instance cannot redirect a runtime-scoped credential elsewhere.
		if inst.TenantID == "" {
			return nil, errors.New("runtime-scoped MCP instance has no tenant")
		}
		var hostInfo string
		if e = h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT host_info_json FROM runtime_nodes WHERE tenant_id=? AND id=?`), inst.TenantID, cfg.RuntimeNodeID).Scan(&hostInfo); e != nil {
			return nil, errors.New("MCP runtime node is unavailable")
		}
		var reported map[string]any
		_ = json.Unmarshal([]byte(hostInfo), &reported)
		primary, _ := reported["primaryIp"].(string)
		hostname, _ := reported["hostname"].(string)
		if !strings.EqualFold(u.Hostname(), primary) && !strings.EqualFold(u.Hostname(), hostname) {
			return nil, errors.New("MCP URL does not match its runtime node")
		}
		safe = u
	}
	type callResult struct {
		result json.RawMessage
		sid    string
		status int
		body   []byte
	}
	call := func(callMethod string, callParams any, sid string, notification bool) (callResult, error) {
		requestID := any(h.store.id())
		if notification {
			requestID = nil
		}
		payload, _ := json.Marshal(rpcEnvelope{JSONRPC: "2.0", ID: requestID, Method: callMethod, Params: callParams})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, safe.String(), bytes.NewReader(payload))
		if err != nil {
			return callResult{}, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2025-06-18")
		if sid != "" {
			req.Header.Set("Mcp-Session-Id", sid)
		}
		for k, v := range cfg.Headers {
			req.Header.Set(k, v)
		}
		for k, v := range sec.Headers {
			req.Header.Set(k, v)
		}
		token := sec.Token
		if token == "" {
			token = sec.AccessToken
		}
		if token == "" {
			token = sec.AccessTokenCamel
		}
		if token == "" {
			token = sec.APIKey
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := h.service.gateway.client.Do(req)
		if err != nil {
			return callResult{}, err
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		_ = resp.Body.Close()
		result := callResult{sid: resp.Header.Get("Mcp-Session-Id"), status: resp.StatusCode, body: raw}
		if readErr != nil {
			return result, readErr
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return result, fmt.Errorf("MCP status %d: %s", resp.StatusCode, string(raw))
		}
		if notification || len(bytes.TrimSpace(raw)) == 0 {
			return result, nil
		}
		if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
			for _, line := range strings.Split(string(raw), "\n") {
				if strings.HasPrefix(line, "data:") {
					raw = []byte(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
					break
				}
			}
		}
		var out struct {
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &out) != nil {
			return result, errors.New("invalid MCP JSON-RPC response")
		}
		if out.Error != nil {
			return result, fmt.Errorf("MCP %d: %s", out.Error.Code, out.Error.Message)
		}
		result.result = out.Result
		return result, nil
	}
	direct, directErr := call(method, params, "", false)
	if directErr == nil || method == "initialize" {
		return direct.result, directErr
	}
	if direct.status != http.StatusBadRequest || !strings.Contains(strings.ToLower(string(direct.body)), "session") {
		return nil, directErr
	}
	initialized, initErr := call("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "zakura-go", "version": "1"}}, "", false)
	if initErr != nil || initialized.sid == "" {
		if initErr != nil {
			return nil, initErr
		}
		return nil, directErr
	}
	sid := initialized.sid
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(h.deps.RunContext(), 5*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(cleanupCtx, http.MethodDelete, safe.String(), nil)
		req.Header.Set("Mcp-Session-Id", sid)
		for k, v := range cfg.Headers {
			req.Header.Set(k, v)
		}
		for k, v := range sec.Headers {
			req.Header.Set(k, v)
		}
		token := sec.Token
		if token == "" {
			token = sec.AccessToken
		}
		if token == "" {
			token = sec.AccessTokenCamel
		}
		if token == "" {
			token = sec.APIKey
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if resp, err := h.service.gateway.client.Do(req); err == nil {
			_ = resp.Body.Close()
		}
	}()
	if _, err := call("notifications/initialized", map[string]any{}, sid, true); err != nil {
		return nil, err
	}
	result, err := call(method, params, sid, false)
	return result.result, err
}
func (h *handler) listInstanceTools(w http.ResponseWriter, r *http.Request) {
	inst, e := h.getMCPInstance(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	result, e := h.mcpRPC(r.Context(), inst, "tools/list", map[string]any{})
	if e != nil {
		statusErr(w, e)
		return
	}
	var v struct {
		Tools []map[string]any `json:"tools"`
	}
	_ = json.Unmarshal(result, &v)
	for _, tool := range v.Tools {
		name, _ := tool["name"].(string)
		tool["enabled"] = true
		if cfg := map[string]any{}; json.Unmarshal(inst.Config, &cfg) == nil {
			if overrides, ok := cfg["toolPermissions"].(map[string]any); ok {
				if enabled, ok := overrides[name].(bool); ok {
					tool["enabled"] = enabled
				}
			}
		}
	}
	httpx.JSON(w, http.StatusOK, v.Tools)
}
func (h *handler) listMCPTools(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,name,component_ref,status,agent_id FROM component_instances WHERE tenant_id=? AND component_type='mcp' AND status IN ('ready','running') ORDER BY name`), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	instances := []mcpInstance{}
	for rows.Next() {
		var id, name, ref, status string
		var agent *string
		if rows.Scan(&id, &name, &ref, &status, &agent) == nil {
			instances = append(instances, mcpInstance{ID: id, Name: name, Ref: ref, Status: status, TenantID: p.TenantID, AgentID: agent})
		}
	}
	rows.Close()
	out := []map[string]any{}
	for _, summary := range instances {
		instance, err := h.getMCPInstance(r.Context(), p.TenantID, summary.ID)
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		result, err := h.mcpRPC(ctx, instance, "tools/list", map[string]any{})
		cancel()
		if err != nil {
			continue
		}
		var listed struct {
			Tools []map[string]any `json:"tools"`
		}
		_ = json.Unmarshal(result, &listed)
		for _, tool := range listed.Tools {
			local, _ := tool["name"].(string)
			tool["qualifiedName"], tool["localName"], tool["instanceId"], tool["providerId"] = "re_"+slugify(summary.Ref)+"__"+local, local, summary.ID, summary.Ref
			out = append(out, tool)
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}
func (h *handler) listMCPPolicies(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,agent_id,name,policy_json,created_at,updated_at FROM mcp_policies WHERE tenant_id=? ORDER BY created_at`), principal(r).TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, name, policy string
		var agent *string
		var c, u flexibleTime
		if rows.Scan(&id, &agent, &name, &policy, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "agentId": agent, "name": name, "policy": json.RawMessage(policy), "createdAt": c.Time, "updatedAt": u.Time})
		}
	}
	httpx.JSON(w, 200, map[string]any{"policies": out})
}
func (h *handler) createMCPPolicy(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AgentID *string         `json:"agentId"`
		Name    string          `json:"name"`
		Policy  json.RawMessage `json:"policy"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Name == "" {
		httpx.Error(w, 400, "name required")
		return
	}
	now := h.store.now()
	id := h.store.id()
	_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO mcp_policies(id,tenant_id,agent_id,name,policy_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`), id, principal(r).TenantID, b.AgentID, b.Name, validJSON(b.Policy, "{}"), now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"policy": map[string]any{"id": id, "agentId": b.AgentID, "name": b.Name, "policy": b.Policy}})
}
func (h *handler) updateMCPPolicy(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name   string          `json:"name"`
		Policy json.RawMessage `json:"policy"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Name == "" {
		httpx.Error(w, 400, "name required")
		return
	}
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE mcp_policies SET name=?,policy_json=?,updated_at=? WHERE tenant_id=? AND id=?`), b.Name, validJSON(b.Policy, "{}"), h.store.now(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) deleteMCPPolicy(w http.ResponseWriter, r *http.Request) {
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM mcp_policies WHERE tenant_id=? AND id=?`), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) probeMCP(w http.ResponseWriter, r *http.Request) {
	var b struct {
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.URL == "" {
		httpx.Error(w, 400, "url required")
		return
	}
	cfg, _ := json.Marshal(map[string]any{"url": b.URL, "headers": b.Headers})
	result, e := h.mcpRPC(r.Context(), mcpInstance{ID: "probe", Config: cfg, Secret: json.RawMessage(`{}`)}, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "zakura", "version": "go-rewrite"}})
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "server": json.RawMessage(result)})
}

type stdioImportBody struct {
	Name, Slug, URL, Token, Command, PackageManager, Image, WorkingDir string
	AgentID                                                            *string           `json:"agentId"`
	AgentIDs                                                           []string          `json:"agentIds"`
	All                                                                bool              `json:"all"`
	Start                                                              *bool             `json:"start"`
	RuntimeNodeID                                                      *string           `json:"runtimeNodeId"`
	Headers                                                            map[string]string `json:"headers"`
	Args                                                               []string          `json:"args"`
	Env                                                                map[string]string `json:"env"`
}

func stdioBodyFromConfig(raw json.RawMessage) (stdioImportBody, bool) {
	var cfg struct {
		Command        string            `json:"command"`
		Args           []string          `json:"args"`
		Env            map[string]string `json:"env"`
		WorkingDir     string            `json:"workingDir"`
		PackageManager string            `json:"packageManager"`
		RuntimeNodeID  string            `json:"runtimeNodeId"`
		BridgeImage    string            `json:"bridgeImage"`
	}
	if json.Unmarshal(raw, &cfg) != nil || cfg.Command == "" {
		return stdioImportBody{}, false
	}
	node := cfg.RuntimeNodeID
	return stdioImportBody{Command: cfg.Command, Args: cfg.Args, Env: cfg.Env, WorkingDir: cfg.WorkingDir, PackageManager: cfg.PackageManager, RuntimeNodeID: &node, Image: cfg.BridgeImage}, true
}

func (h *handler) stdioBodyForInstance(instance mcpInstance) (stdioImportBody, bool, error) {
	body, ok := stdioBodyFromConfig(instance.Config)
	if !ok {
		return body, false, nil
	}
	var stored struct {
		Enc string `json:"enc"`
	}
	_ = json.Unmarshal(instance.Secret, &stored)
	if stored.Enc == "" {
		return body, true, nil
	}
	plain, err := openSecretBox(h.deps.Secret, "mcp:"+instance.ID, stored.Enc)
	if err != nil {
		return body, true, err
	}
	var secret struct {
		Env map[string]string `json:"env"`
	}
	if err = json.Unmarshal(plain, &secret); err != nil {
		return body, true, err
	}
	body.Env = secret.Env
	return body, true, nil
}

func (h *handler) importMCP(w http.ResponseWriter, r *http.Request) {
	var body stdioImportBody
	if httpx.DecodeJSON(r, &body) != nil || strings.TrimSpace(body.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	p := principal(r)
	if body.Command != "" && body.Image != "" && !p.IsPlatformAdmin && p.Role != "owner" && p.Role != "admin" {
		httpx.Error(w, http.StatusForbidden, "custom stdio images require an administrator")
		return
	}
	now := h.store.now()
	id := h.store.id()
	slug := slugify(body.Slug)
	if slug == "" {
		slug = slugify(body.Name)
	}
	if body.Command == "" && body.URL == "" {
		httpx.Error(w, http.StatusBadRequest, "command or url required")
		return
	}
	if body.AgentID != nil {
		body.AgentIDs = append(body.AgentIDs, *body.AgentID)
	}
	if body.All {
		rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id FROM agents WHERE tenant_id=?`), p.TenantID)
		if e == nil {
			for rows.Next() {
				var agent string
				if rows.Scan(&agent) == nil {
					body.AgentIDs = append(body.AgentIDs, agent)
				}
			}
			rows.Close()
		}
	}
	body.AgentIDs = uniqueStrings(body.AgentIDs)
	cfg := map[string]any{"url": body.URL}
	if body.Command != "" {
		envKeys := make([]string, 0, len(body.Env))
		for key := range body.Env {
			envKeys = append(envKeys, key)
		}
		slices.Sort(envKeys)
		cfg = map[string]any{"command": body.Command, "args": body.Args, "environmentVariables": envKeys, "workingDir": body.WorkingDir, "packageManager": body.PackageManager, "runtimeNodeId": body.RuntimeNodeID}
	}
	cfgRaw, _ := json.Marshal(cfg)
	secretPayload, _ := json.Marshal(map[string]any{"token": body.Token, "headers": body.Headers, "env": body.Env})
	enc, encErr := secretBox(h.deps.Secret, "mcp:"+id, secretPayload)
	if encErr != nil {
		statusErr(w, encErr)
		return
	}
	sec, _ := json.Marshal(map[string]any{"enc": enc, "hasToken": body.Token != "", "hasHeaders": len(body.Headers) > 0, "environmentVariables": cfg["environmentVariables"]})
	status := "ready"
	if body.Command != "" {
		status = "stopped"
	}
	_, err := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,last_error,created_at,updated_at) VALUES(?,?,NULL,'mcp',?,?,?, ?,?,NULL,?,?)`), id, p.TenantID, slug, body.Name, string(cfgRaw), string(sec), status, now, now)
	if err != nil {
		statusErr(w, err)
		return
	}
	for _, agent := range body.AgentIDs {
		var space string
		if h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT space_id FROM agents WHERE tenant_id=? AND id=?`), p.TenantID, agent).Scan(&space) == nil {
			_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO agent_bindings(id,tenant_id,space_id,agent_id,instance_id,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(space_id,instance_id) DO UPDATE SET agent_id=excluded.agent_id`), h.store.id(), p.TenantID, space, agent, id, now)
		}
	}
	started := body.Command == ""
	startError := ""
	start := body.Start == nil || *body.Start
	if body.Command != "" && start {
		if err = h.provisionStdioMCP(r.Context(), p.TenantID, id, body); err != nil {
			startError = err.Error()
			_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE component_instances SET status='error',last_error=?,updated_at=? WHERE id=?`), startError, h.store.now(), id)
		} else {
			started = true
		}
	}
	instance, _ := h.getInstance(r.Context(), p.TenantID, id)
	result := h.instanceDTO(r.Context(), p.TenantID, instance, false)
	result["slug"] = slug
	response := map[string]any{"instance": result, "started": started, "boundAgentIds": body.AgentIDs}
	if startError != "" {
		response["startError"] = startError
	}
	httpx.JSON(w, http.StatusCreated, response)
}
func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if value != "" && !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}
func (h *handler) provisionStdioMCP(ctx context.Context, tenant, instanceID string, body stdioImportBody) error {
	nodeID := ""
	if body.RuntimeNodeID != nil {
		nodeID = *body.RuntimeNodeID
	}
	if nodeID == "" && len(body.AgentIDs) > 0 {
		_ = h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT COALESCE(s.runtime_node_id,'') FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.id=?`), tenant, body.AgentIDs[0]).Scan(&nodeID)
	}
	if nodeID == "" {
		return errors.New("bind the agent to a runtime node before starting stdio MCP")
	}
	runner, err := h.hub.get(nodeID)
	if err != nil {
		return err
	}
	packageManager := strings.ToLower(strings.TrimSpace(body.PackageManager))
	if packageManager == "" {
		if body.Command == "docker" || body.Command == "podman" {
			packageManager = "oci"
		} else {
			packageManager = "npm"
		}
	}
	envName := map[string]string{"npm": "ZAKURA_STDIO_NODE_IMAGE", "pypi": "ZAKURA_STDIO_PYTHON_IMAGE", "oci": "ZAKURA_STDIO_OCI_IMAGE", "binary": "ZAKURA_STDIO_BINARY_IMAGE"}[packageManager]
	if envName == "" {
		return errors.New("packageManager must be npm, pypi, oci, or binary")
	}
	image := strings.TrimSpace(body.Image)
	if image == "" {
		image = strings.TrimSpace(os.Getenv("ZAKURA_STDIO_BRIDGE_IMAGE"))
	}
	if image == "" {
		image = strings.TrimSpace(os.Getenv(envName))
	}
	if image == "" {
		return fmt.Errorf("stdio bridge image is not configured for %s; set %s to a bridge-equipped image", packageManager, envName)
	}
	if body.WorkingDir == "" {
		body.WorkingDir = "/data"
	}
	var dataSpaceID string
	if err = h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT b.space_id FROM agent_bindings b JOIN spaces s ON s.id=b.space_id AND s.tenant_id=b.tenant_id WHERE b.tenant_id=? AND b.instance_id=? ORDER BY b.created_at LIMIT 1`), tenant, instanceID).Scan(&dataSpaceID); err != nil {
		return errors.New("bind the stdio MCP instance to an agent in the selected runtime node before starting")
	}
	dataPath := "/.zakura/components/" + instanceID
	var hostInfo, capabilitiesRaw string
	if err = h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT host_info_json,capabilities_json FROM runtime_nodes WHERE tenant_id=? AND id=?`), tenant, nodeID).Scan(&hostInfo, &capabilitiesRaw); err != nil {
		return err
	}
	host := map[string]any{}
	capabilities := map[string]any{}
	_ = json.Unmarshal([]byte(hostInfo), &host)
	_ = json.Unmarshal([]byte(capabilitiesRaw), &capabilities)
	if err = runner.call(ctx, "docker.pull", map[string]any{"image": image}, nil); err != nil {
		return err
	}
	env := map[string]string{"MCP_COMMAND": body.Command, "MCP_CWD": body.WorkingDir, "MCP_PORT": "3100", "MCP_PATH": "/mcp"}
	args, _ := json.Marshal(body.Args)
	env["MCP_ARGS"] = string(args)
	for key, value := range body.Env {
		env[key] = value
	}
	var dataRoot struct {
		Abs string `json:"abs"`
	}
	if err = runner.call(ctx, "host.fs.mkdir", map[string]any{"spaceId": dataSpaceID, "path": dataPath}, &dataRoot); err != nil {
		return fmt.Errorf("prepare stdio data directory: %w", err)
	}
	if dataRoot.Abs == "" {
		return errors.New("runner returned no stdio data directory")
	}
	volumes := []map[string]any{{"hostPath": dataRoot.Abs, "containerPath": "/data"}}
	if packageManager == "oci" {
		platform, _ := host["platform"].(string)
		dockerCap, _ := capabilities["docker"].(bool)
		if platform != "linux" || !dockerCap {
			return errors.New("OCI stdio MCP requires a Linux runner with Docker capability")
		}
		env["DOCKER_HOST"] = "unix:///var/run/docker.sock"
		volumes = append(volumes, map[string]any{"hostPath": "/var/run/docker.sock", "containerPath": "/var/run/docker.sock"})
	}
	var running struct {
		DockerID, Name, Image, Status string
		Ports                         []struct {
			ContainerPort, HostPort int
			Protocol                string
		} `json:"ports"`
	}
	err = runner.call(ctx, "docker.run", map[string]any{"name": "zakura-stdio-" + instanceID, "image": image, "command": []string{"/usr/local/bin/zakura-stdio-bridge"}, "env": env, "labels": map[string]string{"zakura.instance": instanceID, "zakura.purpose": "component"}, "ports": []map[string]any{{"containerPort": 3100, "protocol": "tcp"}}, "volumes": volumes, "workingDir": body.WorkingDir, "restart": "unless-stopped"}, &running)
	if err != nil {
		return err
	}
	cleanup := func() {
		_ = runner.call(context.WithoutCancel(ctx), "docker.stop", map[string]any{"id": running.DockerID, "remove": true}, nil)
	}
	if running.DockerID == "" {
		return errors.New("runner returned no stdio bridge container ID")
	}
	bridgeReady := false
	var inspected struct {
		Status string `json:"status"`
	}
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				cleanup()
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
		if inspectErr := runner.call(ctx, "docker.inspect", map[string]any{"id": running.DockerID}, &inspected); inspectErr == nil && strings.EqualFold(inspected.Status, "running") {
			bridgeReady = true
			break
		}
	}
	if !bridgeReady {
		var logs struct {
			Logs string `json:"logs"`
		}
		_ = runner.call(ctx, "docker.logs", map[string]any{"id": running.DockerID, "tail": 50}, &logs)
		cleanup()
		return fmt.Errorf("stdio bridge container did not stay running (image must contain /usr/local/bin/zakura-stdio-bridge and the requested runtime): %s", strings.TrimSpace(logs.Logs))
	}
	port := 0
	for _, candidate := range running.Ports {
		if candidate.ContainerPort == 3100 {
			port = candidate.HostPort
		}
	}
	if port == 0 {
		cleanup()
		return errors.New("runner did not publish stdio bridge port")
	}
	hostname, _ := host["primaryIp"].(string)
	if hostname == "" {
		hostname, _ = host["hostname"].(string)
	}
	if hostname == "" {
		cleanup()
		return errors.New("runtime node did not report an address")
	}
	endpoint := fmt.Sprintf("http://%s:%d/mcp", hostname, port)
	if err = h.probeStdioBridge(ctx, endpoint); err != nil {
		cleanup()
		return fmt.Errorf("stdio bridge readiness failed: %w", err)
	}
	envKeys := make([]string, 0, len(body.Env))
	for key := range body.Env {
		envKeys = append(envKeys, key)
	}
	slices.Sort(envKeys)
	cfg, _ := json.Marshal(map[string]any{"url": endpoint, "runtimeNodeId": nodeID, "dataSpaceId": dataSpaceID, "dataPath": dataPath, "command": body.Command, "args": body.Args, "environmentVariables": envKeys, "workingDir": body.WorkingDir, "packageManager": packageManager, "bridgeImage": image})
	now := h.store.now()
	labels, _ := json.Marshal(map[string]string{"zakura.instance": instanceID, "zakura.purpose": "component"})
	ports, _ := json.Marshal(running.Ports)
	err = appdeps.InTx(ctx, h.deps.DB, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, h.store.q(`UPDATE component_instances SET config_json=?,status='running',last_error=NULL,updated_at=? WHERE id=? AND tenant_id=?`), string(cfg), now, instanceID, tenant); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, h.store.q(`INSERT INTO managed_containers(id,tenant_id,instance_id,space_id,docker_id,name,image,purpose,status,labels_json,ports_json,runtime_node_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'component','running',?,?,?,?,?)`), h.store.id(), tenant, instanceID, dataSpaceID, running.DockerID, running.Name, image, string(labels), string(ports), nodeID, now, now)
		return e
	})
	if err != nil {
		cleanup()
	}
	return err
}

func (h *handler) probeStdioBridge(ctx context.Context, endpoint string) error {
	base := strings.TrimSuffix(endpoint, "/mcp")
	var last error
	for attempt := 0; attempt < 20; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
		callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		req, _ := http.NewRequestWithContext(callCtx, http.MethodGet, base+"/health", nil)
		resp, err := h.service.gateway.client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				cancel()
				last = nil
				break
			}
			err = fmt.Errorf("health status %d", resp.StatusCode)
		}
		cancel()
		last = err
	}
	if last != nil {
		return last
	}
	post := func(method string, params any, sid string, notification bool) (*http.Response, []byte, error) {
		id := any(h.store.id())
		if notification {
			id = nil
		}
		payload, _ := json.Marshal(rpcEnvelope{JSONRPC: "2.0", ID: id, Method: method, Params: params})
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2025-06-18")
		if sid != "" {
			req.Header.Set("Mcp-Session-Id", sid)
		}
		resp, err := h.service.gateway.client.Do(req)
		if err != nil {
			return nil, nil, err
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		_ = resp.Body.Close()
		return resp, raw, err
	}
	initResp, initRaw, err := post("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "zakura-go-probe", "version": "1"}}, "", false)
	if err != nil {
		return err
	}
	if initResp.StatusCode < 200 || initResp.StatusCode >= 300 || !bytes.Contains(initRaw, []byte(`"result"`)) {
		return fmt.Errorf("initialize status %d: %s", initResp.StatusCode, string(initRaw))
	}
	sid := initResp.Header.Get("Mcp-Session-Id")
	if sid != "" {
		if notifyResp, _, notifyErr := post("notifications/initialized", map[string]any{}, sid, true); notifyErr != nil || notifyResp.StatusCode < 200 || notifyResp.StatusCode >= 300 {
			if notifyErr != nil {
				return notifyErr
			}
			return fmt.Errorf("initialized notification status %d", notifyResp.StatusCode)
		}
		defer func() {
			cleanupCtx, cancel := context.WithTimeout(h.deps.RunContext(), 5*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(cleanupCtx, http.MethodDelete, endpoint, nil)
			req.Header.Set("Mcp-Session-Id", sid)
			if resp, err := h.service.gateway.client.Do(req); err == nil {
				_ = resp.Body.Close()
			}
		}()
	}
	listResp, listRaw, err := post("tools/list", map[string]any{}, sid, false)
	if err != nil {
		return err
	}
	if listResp.StatusCode < 200 || listResp.StatusCode >= 300 || !bytes.Contains(listRaw, []byte(`"result"`)) {
		return fmt.Errorf("tools/list status %d: %s", listResp.StatusCode, string(listRaw))
	}
	return nil
}
func (h *handler) mcpCall(w http.ResponseWriter, r *http.Request) {
	h.mcpOperation(w, r, "tools/call", func(b map[string]any) any { return map[string]any{"name": b["toolName"], "arguments": b["arguments"]} })
}
func (h *handler) mcpResource(w http.ResponseWriter, r *http.Request) {
	h.mcpOperation(w, r, "resources/read", func(b map[string]any) any { return map[string]any{"uri": b["uri"]} })
}
func (h *handler) mcpPrompt(w http.ResponseWriter, r *http.Request) {
	h.mcpOperation(w, r, "prompts/get", func(b map[string]any) any { return map[string]any{"name": b["name"], "arguments": b["arguments"]} })
}
func (h *handler) mcpComplete(w http.ResponseWriter, r *http.Request) {
	h.mcpOperation(w, r, "completion/complete", func(b map[string]any) any { return b["params"] })
}
func (h *handler) mcpOperation(w http.ResponseWriter, r *http.Request, method string, params func(map[string]any) any) {
	b, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	id, _ := b["instanceId"].(string)
	if id == "" {
		httpx.Error(w, 400, "instanceId required")
		return
	}
	inst, e := h.getMCPInstance(r.Context(), principal(r).TenantID, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	start := time.Now()
	result, e := h.mcpRPC(r.Context(), inst, method, params(b))
	status := "ok"
	errText := ""
	if e != nil {
		status = "error"
		errText = e.Error()
	}
	h.auditToolCall(r.Context(), principal(r), inst, method, b, status, errText, time.Since(start))
	if e != nil {
		statusErr(w, e)
		return
	}
	var v any
	_ = json.Unmarshal(result, &v)
	httpx.JSON(w, 200, map[string]any{"result": v})
}
func (h *handler) auditToolCall(ctx context.Context, p httpx.Principal, inst mcpInstance, method string, args map[string]any, status, errText string, d time.Duration) {
	raw, _ := json.Marshal(args)
	result := ""
	isError := status != "ok"
	if isError {
		result = errText
	}
	_, _ = h.deps.DB.ExecContext(ctx, h.store.q(`INSERT INTO tool_call_logs(id,tenant_id,api_key_id,agent_id,qualified_name,local_name,provider_id,instance_id,args_json,result_json,is_error,duration_ms,created_at) VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?)`), h.store.id(), p.TenantID, inst.AgentID, inst.Ref+":"+method, method, inst.Ref, inst.ID, string(raw), result, isError, d.Milliseconds(), h.store.now())
}

func (h *handler) listMCPSources(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,name,description,source_url,format,manifest_json,servers_json,enabled,fetched_at,created_at,updated_at FROM mcp_store_sources WHERE tenant_id=? ORDER BY created_at`), principal(r).TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, name, desc, urlv, format, manifest, servers string
		var enabled bool
		var fetched sql.NullString
		var c, u flexibleTime
		if rows.Scan(&id, &name, &desc, &urlv, &format, &manifest, &servers, &enabled, &fetched, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "name": name, "description": desc, "sourceUrl": urlv, "format": format, "manifest": json.RawMessage(manifest), "servers": json.RawMessage(servers), "enabled": enabled, "fetchedAt": fetched.String, "createdAt": c.Time, "updatedAt": u.Time})
		}
	}
	httpx.JSON(w, 200, map[string]any{"sources": out})
}
func (h *handler) createMCPSource(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name, Description, SourceURL, Format string
		Manifest, Servers                    json.RawMessage
	}
	if httpx.DecodeJSON(r, &b) != nil || b.SourceURL == "" {
		httpx.Error(w, 400, "sourceUrl required")
		return
	}
	if b.Name == "" {
		b.Name = b.SourceURL
	}
	if b.Format == "" {
		b.Format = "auto"
	}
	now := h.store.now()
	id := h.store.id()
	_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO mcp_store_sources(id,tenant_id,name,description,source_url,format,manifest_json,servers_json,enabled,fetched_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,true,?,?,?)`), id, principal(r).TenantID, b.Name, b.Description, b.SourceURL, b.Format, validJSON(b.Manifest, "{}"), validJSON(b.Servers, "[]"), now, now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"source": map[string]any{"id": id, "name": b.Name, "sourceUrl": b.SourceURL}})
}
func (h *handler) deleteMCPSource(w http.ResponseWriter, r *http.Request) {
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM mcp_store_sources WHERE tenant_id=? AND id=?`), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) searchMCPStore(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	term := "%" + r.URL.Query().Get("q") + "%"
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,source_id,kind,ref,name,description,meta_json,updated_at FROM store_catalog_entries WHERE (tenant_id IS NULL OR tenant_id=?) AND (LOWER(name) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?)) ORDER BY name LIMIT 100`), p.TenantID, term, term)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, source, kind, ref, name, desc, meta string
		var u flexibleTime
		if rows.Scan(&id, &source, &kind, &ref, &name, &desc, &meta, &u) == nil {
			out = append(out, map[string]any{"id": id, "sourceId": source, "kind": kind, "ref": ref, "name": name, "description": desc, "meta": json.RawMessage(meta), "updatedAt": u.Time})
		}
	}
	httpx.JSON(w, 200, map[string]any{"items": out})
}
func (h *handler) getMCPStoreEntry(w http.ResponseWriter, r *http.Request) {
	var id, source, kind, ref, name, desc, meta string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,source_id,kind,ref,name,description,meta_json FROM store_catalog_entries WHERE (tenant_id IS NULL OR tenant_id=?) AND (id=? OR name=?)`), principal(r).TenantID, chi.URLParam(r, "name"), chi.URLParam(r, "name")).Scan(&id, &source, &kind, &ref, &name, &desc, &meta)
	if errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"server": map[string]any{"id": id, "sourceId": source, "kind": kind, "ref": ref, "name": name, "description": desc, "meta": json.RawMessage(meta)}})
}
func (h *handler) installMCPStoreEntry(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ID      string          `json:"id"`
		AgentID *string         `json:"agentId"`
		Config  json.RawMessage `json:"config"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.ID == "" {
		httpx.Error(w, 400, "id required")
		return
	}
	var name, ref, meta string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT name,ref,meta_json FROM store_catalog_entries WHERE (tenant_id IS NULL OR tenant_id=?) AND id=?`), principal(r).TenantID, b.ID).Scan(&name, &ref, &meta)
	if errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	cfg := b.Config
	if len(cfg) == 0 {
		cfg = json.RawMessage(meta)
	}
	now := h.store.now()
	id := h.store.id()
	configStored, secretStored, protectErr := h.protectMCPConfig(id, cfg)
	if protectErr != nil {
		statusErr(w, protectErr)
		return
	}
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,last_error,created_at,updated_at) VALUES(?,?,?,'mcp',?,?,?,?,'ready',NULL,?,?)`), id, principal(r).TenantID, b.AgentID, ref, name, configStored, secretStored, now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"instance": map[string]any{"id": id, "name": name, "status": "ready"}})
}
