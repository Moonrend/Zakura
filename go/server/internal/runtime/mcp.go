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

	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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
		// raw escape hatch: information_schema probe is PostgreSQL-specific
		err := h.deps.Gorm.WithContext(ctx).Raw(`SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema=current_schema() AND table_name=? AND column_name=?
		)`, "component_instances", column).Row().Scan(&exists)
		return err == nil && exists
	}

	// raw escape hatch: PRAGMA table_info is SQLite-specific
	rows, err := h.deps.Gorm.WithContext(ctx).Raw(`PRAGMA table_info(component_instances)`).Rows()
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
	type legacy struct {
		ID        string `gorm:"column:id"`
		Encrypted string `gorm:"column:config_enc"`
	}
	items := []legacy{}
	if err := h.deps.Gorm.WithContext(ctx).Table("component_instances").Select("id,config_enc").Where("config_enc IS NOT NULL AND config_enc<>'' AND (config_json IS NULL OR config_json='{}')").Find(&items).Error; err != nil {
		return
	}
	for _, item := range items {
		plain, openErr := openSecretBox(h.deps.Secret, "component:"+item.ID, item.Encrypted)
		if openErr != nil || !json.Valid(plain) {
			continue
		}
		config, secret, protectErr := h.protectMCPConfig(item.ID, plain)
		if protectErr != nil {
			continue
		}
		_ = h.deps.Gorm.WithContext(ctx).Model(&models.ComponentInstance{}).Where("id=? AND (config_json IS NULL OR config_json='{}')", item.ID).Updates(map[string]any{"config_json": config, "secret_json": secret, "updated_at": h.store.now()}).Error
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
	var row struct {
		ID           string  `gorm:"column:id"`
		Name         string  `gorm:"column:name"`
		ComponentRef string  `gorm:"column:component_ref"`
		Status       string  `gorm:"column:status"`
		AgentID      *string `gorm:"column:agent_id"`
		ConfigJSON   string  `gorm:"column:config_json"`
		SecretJSON   string  `gorm:"column:secret_json"`
	}
	e := h.deps.Gorm.WithContext(ctx).Table("component_instances").Select("id,name,component_ref,status,agent_id,config_json,secret_json").Where("tenant_id=? AND id=? AND component_type='mcp'", tenant, id).Take(&row).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return x, ErrNotFound
	}
	x.ID = row.ID
	x.Name = row.Name
	x.Ref = row.ComponentRef
	x.Status = row.Status
	x.AgentID = row.AgentID
	x.Config = json.RawMessage(row.ConfigJSON)
	x.Secret = json.RawMessage(row.SecretJSON)
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
		var nodeRow struct {
			HostInfoJSON string `gorm:"column:host_info_json"`
		}
		if e = h.deps.Gorm.WithContext(ctx).Table("runtime_nodes").Select("host_info_json").Where("tenant_id=? AND id=?", inst.TenantID, cfg.RuntimeNodeID).Take(&nodeRow).Error; e != nil {
			return nil, errors.New("MCP runtime node is unavailable")
		}
		hostInfo := nodeRow.HostInfoJSON
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
	type instanceRow struct {
		ID           string  `gorm:"column:id"`
		Name         string  `gorm:"column:name"`
		ComponentRef string  `gorm:"column:component_ref"`
		Status       string  `gorm:"column:status"`
		AgentID      *string `gorm:"column:agent_id"`
	}
	var instanceRows []instanceRow
	if e := h.deps.Gorm.WithContext(r.Context()).Table("component_instances").Select("id,name,component_ref,status,agent_id").Where("tenant_id=? AND component_type='mcp' AND status IN ('ready','running')", p.TenantID).Order("name").Find(&instanceRows).Error; e != nil {
		statusErr(w, e)
		return
	}
	instances := []mcpInstance{}
	for _, row := range instanceRows {
		instances = append(instances, mcpInstance{ID: row.ID, Name: row.Name, Ref: row.ComponentRef, Status: row.Status, TenantID: p.TenantID, AgentID: row.AgentID})
	}
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
	type policyRow struct {
		ID         string  `gorm:"column:id"`
		AgentID    *string `gorm:"column:agent_id"`
		Name       string  `gorm:"column:name"`
		PolicyJSON string  `gorm:"column:policy_json"`
		CreatedAt  string  `gorm:"column:created_at"`
		UpdatedAt  string  `gorm:"column:updated_at"`
	}
	var policyRows []policyRow
	if e := h.deps.Gorm.WithContext(r.Context()).Table("mcp_policies").Select("id,agent_id,name,policy_json,created_at,updated_at").Where("tenant_id=?", principal(r).TenantID).Order("created_at").Find(&policyRows).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0)
	for _, row := range policyRows {
		out = append(out, map[string]any{"id": row.ID, "agentId": row.AgentID, "name": row.Name, "policy": json.RawMessage(row.PolicyJSON), "createdAt": parseTime(row.CreatedAt), "updatedAt": parseTime(row.UpdatedAt)})
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
	e := h.deps.Gorm.WithContext(r.Context()).Table("mcp_policies").Create(map[string]any{"id": id, "tenant_id": principal(r).TenantID, "agent_id": b.AgentID, "name": b.Name, "policy_json": validJSON(b.Policy, "{}"), "created_at": now, "updated_at": now}).Error
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
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.McpPolicy{}).Where("tenant_id=? AND id=?", principal(r).TenantID, chi.URLParam(r, "id")).Updates(map[string]any{"name": b.Name, "policy_json": validJSON(b.Policy, "{}"), "updated_at": h.store.now()})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) deleteMCPPolicy(w http.ResponseWriter, r *http.Request) {
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND id=?", principal(r).TenantID, chi.URLParam(r, "id")).Delete(&models.McpPolicy{})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
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
		var agentIDs []string
		if e := h.deps.Gorm.WithContext(r.Context()).Model(&models.Agent{}).Where("tenant_id=?", p.TenantID).Pluck("id", &agentIDs).Error; e == nil {
			body.AgentIDs = append(body.AgentIDs, agentIDs...)
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
	err := h.deps.Gorm.WithContext(r.Context()).Table("component_instances").Create(map[string]any{"id": id, "tenant_id": p.TenantID, "agent_id": nil, "component_type": "mcp", "component_ref": slug, "name": body.Name, "config_json": string(cfgRaw), "secret_json": string(sec), "status": status, "last_error": nil, "created_at": now, "updated_at": now}).Error
	if err != nil {
		statusErr(w, err)
		return
	}
	for _, agent := range body.AgentIDs {
		var agentRow struct {
			SpaceID string `gorm:"column:space_id"`
		}
		if h.deps.Gorm.WithContext(r.Context()).Table("agents").Select("space_id").Where("tenant_id=? AND id=?", p.TenantID, agent).Take(&agentRow).Error == nil {
			_ = h.deps.Gorm.WithContext(r.Context()).
				Clauses(clause.OnConflict{
					Columns:   []clause.Column{{Name: "space_id"}, {Name: "instance_id"}},
					DoUpdates: clause.AssignmentColumns([]string{"agent_id"}),
				}).
				Table("agent_bindings").
				Create(map[string]any{"id": h.store.id(), "tenant_id": p.TenantID, "space_id": agentRow.SpaceID, "agent_id": agent, "instance_id": id, "created_at": now}).Error
		}
	}
	started := body.Command == ""
	startError := ""
	start := body.Start == nil || *body.Start
	if body.Command != "" && start {
		if err = h.provisionStdioMCP(r.Context(), p.TenantID, id, body); err != nil {
			startError = err.Error()
			_ = h.deps.Gorm.WithContext(r.Context()).Model(&models.ComponentInstance{}).Where("id=?", id).Updates(map[string]any{"status": "error", "last_error": startError, "updated_at": h.store.now()}).Error
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
		_ = h.deps.Gorm.WithContext(ctx).Raw(`SELECT COALESCE(s.runtime_node_id,'') AS runtime_node_id FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.id=?`, tenant, body.AgentIDs[0]).Scan(&nodeID).Error
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
	var dataSpaceRow struct {
		SpaceID string `gorm:"column:space_id"`
	}
	err = h.deps.Gorm.WithContext(ctx).
		Table("agent_bindings b").
		Select("b.space_id AS space_id").
		Joins("JOIN spaces s ON s.id=b.space_id AND s.tenant_id=b.tenant_id").
		Where("b.tenant_id = ? AND b.instance_id = ?", tenant, instanceID).
		Order("b.created_at").
		Limit(1).
		Take(&dataSpaceRow).Error
	if err != nil {
		return errors.New("bind the stdio MCP instance to an agent in the selected runtime node before starting")
	}
	dataSpaceID := dataSpaceRow.SpaceID
	dataPath := "/.zakura/components/" + instanceID
	var nodeRow struct {
		HostInfoJSON     string `gorm:"column:host_info_json"`
		CapabilitiesJSON string `gorm:"column:capabilities_json"`
	}
	if err = h.deps.Gorm.WithContext(ctx).Table("runtime_nodes").Select("host_info_json,capabilities_json").Where("tenant_id=? AND id=?", tenant, nodeID).Take(&nodeRow).Error; err != nil {
		return err
	}
	hostInfo, capabilitiesRaw := nodeRow.HostInfoJSON, nodeRow.CapabilitiesJSON
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
	err = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if e := tx.Exec(`UPDATE component_instances SET config_json=?,status='running',last_error=NULL,updated_at=? WHERE id=? AND tenant_id=?`, string(cfg), now, instanceID, tenant).Error; e != nil {
			return e
		}
		return tx.Table("managed_containers").Create(map[string]any{"id": h.store.id(), "tenant_id": tenant, "instance_id": instanceID, "space_id": dataSpaceID, "docker_id": running.DockerID, "name": running.Name, "image": image, "purpose": "component", "status": "running", "labels_json": string(labels), "ports_json": string(ports), "runtime_node_id": nodeID, "created_at": now, "updated_at": now}).Error
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
	_ = h.deps.Gorm.WithContext(ctx).Table("tool_call_logs").Create(map[string]any{"id": h.store.id(), "tenant_id": p.TenantID, "api_key_id": nil, "agent_id": inst.AgentID, "qualified_name": inst.Ref + ":" + method, "local_name": method, "provider_id": inst.Ref, "instance_id": inst.ID, "args_json": string(raw), "result_json": result, "is_error": isError, "duration_ms": d.Milliseconds(), "created_at": h.store.now()}).Error
}

func (h *handler) listMCPSources(w http.ResponseWriter, r *http.Request) {
	type sourceRow struct {
		ID           string         `gorm:"column:id"`
		Name         string         `gorm:"column:name"`
		Description  string         `gorm:"column:description"`
		SourceURL    string         `gorm:"column:source_url"`
		Format       string         `gorm:"column:format"`
		ManifestJSON string         `gorm:"column:manifest_json"`
		ServersJSON  string         `gorm:"column:servers_json"`
		Enabled      bool           `gorm:"column:enabled"`
		FetchedAt    sql.NullString `gorm:"column:fetched_at"`
		CreatedAt    string         `gorm:"column:created_at"`
		UpdatedAt    string         `gorm:"column:updated_at"`
	}
	var sourceRows []sourceRow
	if e := h.deps.Gorm.WithContext(r.Context()).Table("mcp_store_sources").Select("id,name,description,source_url,format,manifest_json,servers_json,enabled,fetched_at,created_at,updated_at").Where("tenant_id=?", principal(r).TenantID).Order("created_at").Find(&sourceRows).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0)
	for _, row := range sourceRows {
		out = append(out, map[string]any{"id": row.ID, "name": row.Name, "description": row.Description, "sourceUrl": row.SourceURL, "format": row.Format, "manifest": json.RawMessage(row.ManifestJSON), "servers": json.RawMessage(row.ServersJSON), "enabled": row.Enabled, "fetchedAt": row.FetchedAt.String, "createdAt": parseTime(row.CreatedAt), "updatedAt": parseTime(row.UpdatedAt)})
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
	e := h.deps.Gorm.WithContext(r.Context()).Table("mcp_store_sources").Create(map[string]any{"id": id, "tenant_id": principal(r).TenantID, "name": b.Name, "description": b.Description, "source_url": b.SourceURL, "format": b.Format, "manifest_json": validJSON(b.Manifest, "{}"), "servers_json": validJSON(b.Servers, "[]"), "enabled": true, "fetched_at": now, "created_at": now, "updated_at": now}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"source": map[string]any{"id": id, "name": b.Name, "sourceUrl": b.SourceURL}})
}
func (h *handler) deleteMCPSource(w http.ResponseWriter, r *http.Request) {
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND id=?", principal(r).TenantID, chi.URLParam(r, "id")).Delete(&models.McpStoreSource{})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) searchMCPStore(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	term := "%" + r.URL.Query().Get("q") + "%"
	type entryRow struct {
		ID          string `gorm:"column:id"`
		SourceID    string `gorm:"column:source_id"`
		Kind        string `gorm:"column:kind"`
		Ref         string `gorm:"column:ref"`
		Name        string `gorm:"column:name"`
		Description string `gorm:"column:description"`
		MetaJSON    string `gorm:"column:meta_json"`
		UpdatedAt   string `gorm:"column:updated_at"`
	}
	var entryRows []entryRow
	if e := h.deps.Gorm.WithContext(r.Context()).Table("store_catalog_entries").Select("id,source_id,kind,ref,name,description,meta_json,updated_at").Where("(tenant_id IS NULL OR tenant_id=?) AND (LOWER(name) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?))", p.TenantID, term, term).Order("name").Limit(100).Find(&entryRows).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0)
	for _, row := range entryRows {
		out = append(out, map[string]any{"id": row.ID, "sourceId": row.SourceID, "kind": row.Kind, "ref": row.Ref, "name": row.Name, "description": row.Description, "meta": json.RawMessage(row.MetaJSON), "updatedAt": parseTime(row.UpdatedAt)})
	}
	httpx.JSON(w, 200, map[string]any{"items": out})
}
func (h *handler) getMCPStoreEntry(w http.ResponseWriter, r *http.Request) {
	var entry struct {
		ID          string `gorm:"column:id"`
		SourceID    string `gorm:"column:source_id"`
		Kind        string `gorm:"column:kind"`
		Ref         string `gorm:"column:ref"`
		Name        string `gorm:"column:name"`
		Description string `gorm:"column:description"`
		MetaJSON    string `gorm:"column:meta_json"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("store_catalog_entries").Select("id,source_id,kind,ref,name,description,meta_json").Where("(tenant_id IS NULL OR tenant_id=?) AND (id=? OR name=?)", principal(r).TenantID, chi.URLParam(r, "name"), chi.URLParam(r, "name")).Take(&entry).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"server": map[string]any{"id": entry.ID, "sourceId": entry.SourceID, "kind": entry.Kind, "ref": entry.Ref, "name": entry.Name, "description": entry.Description, "meta": json.RawMessage(entry.MetaJSON)}})
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
	var entry struct {
		Name     string `gorm:"column:name"`
		Ref      string `gorm:"column:ref"`
		MetaJSON string `gorm:"column:meta_json"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("store_catalog_entries").Select("name,ref,meta_json").Where("(tenant_id IS NULL OR tenant_id=?) AND id=?", principal(r).TenantID, b.ID).Take(&entry).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	cfg := b.Config
	if len(cfg) == 0 {
		cfg = json.RawMessage(entry.MetaJSON)
	}
	now := h.store.now()
	id := h.store.id()
	configStored, secretStored, protectErr := h.protectMCPConfig(id, cfg)
	if protectErr != nil {
		statusErr(w, protectErr)
		return
	}
	e = h.deps.Gorm.WithContext(r.Context()).Table("component_instances").Create(map[string]any{"id": id, "tenant_id": principal(r).TenantID, "agent_id": b.AgentID, "component_type": "mcp", "component_ref": entry.Ref, "name": entry.Name, "config_json": configStored, "secret_json": secretStored, "status": "ready", "last_error": nil, "created_at": now, "updated_at": now}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"instance": map[string]any{"id": id, "name": entry.Name, "status": "ready"}})
}
