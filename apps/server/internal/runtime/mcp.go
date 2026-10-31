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

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
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
	for _, key := range []string{"token", "apiKey", "accessToken", "access_token", "headers", "credentials", "secret", "env", "clientSecret"} {
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
		_ = h.deps.Gorm.WithContext(ctx).Model(&models.ComponentInstance{}).Where("id=? AND (config_json IS NULL OR config_json='{}')", item.ID).Updates(map[string]any{"config_json": config, "secret_json": secret, "updated_at": runtimeTimeString(h.store.now())}).Error
	}
}

func (h *handler) registerMCP(r chi.Router) {
	h.registerSpaceMCP(r)
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
		URL             string            `json:"url"`
		RuntimeNodeID   string            `json:"runtimeNodeId"`
		Headers         map[string]string `json:"headers"`
		WorkspaceTarget *protocol.Target  `json:"workspaceTarget"`
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
	if cfg.WorkspaceTarget != nil {
		if cfg.WorkspaceTarget.TenantID != inst.TenantID || cfg.WorkspaceTarget.NodeID != cfg.RuntimeNodeID {
			return nil, errors.New("MCP workspace identity mismatch")
		}
		if _, _, err := h.workspaceStore().Resolve(ctx, *cfg.WorkspaceTarget); err != nil {
			return nil, err
		}
		run, _ := ctx.Value(computerRunKey{}).(string)
		accepted, hasAccepted := ctx.Value(workspaceRequestTargetKey{}).(Space)
		if run != "" || hasAccepted && accepted.TenantID == inst.TenantID && accepted.ID == cfg.WorkspaceTarget.SpaceID {
			computer, err := h.serverComputerRecord(ctx, inst.TenantID, cfg.WorkspaceTarget.SpaceID)
			if err != nil {
				return nil, err
			}
			exec, err := h.resolveWorkspaceExecution(ctx, computer, run)
			if err != nil {
				return nil, err
			}
			if exec.workspace == nil || exec.workspace.Target != *cfg.WorkspaceTarget {
				return nil, errors.New("MCP run workspace changed")
			}
		}
	}
	_ = json.Unmarshal(inst.Secret, &sec)
	if sec.Enc != "" {
		raw, err := openSecretBox(h.deps.Secret, "mcp:"+inst.ID, sec.Enc)
		if err != nil {
			return nil, errors.New("MCP credentials could not be decrypted")
		}
		if json.Unmarshal(raw, &sec) != nil {
			return nil, errors.New("invalid MCP credential payload")
		}
	}
	u, e := url.Parse(cfg.URL)
	relayed := isMCPRelayEndpoint(cfg.URL)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https" && !relayed) {
		return nil, errors.New("invalid MCP URL")
	}
	var safe *url.URL
	if relayed {
		// A relay endpoint is pinned to its node; it is only valid for the
		// tenant-owned node recorded on the instance.
		if cfg.RuntimeNodeID == "" || u.Host != cfg.RuntimeNodeID || inst.TenantID == "" {
			return nil, errors.New("MCP relay endpoint does not match its runtime node")
		}
		var owned int64
		if e = h.deps.Gorm.WithContext(ctx).Table("runtime_nodes").Where("id=? AND (tenant_id=? OR is_shared=TRUE)", cfg.RuntimeNodeID, inst.TenantID).Count(&owned).Error; e != nil || owned != 1 {
			return nil, errors.New("MCP runtime node is unavailable")
		}
		safe = u
	} else if cfg.RuntimeNodeID == "" {
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
	client := h.mcpHTTPClient(cfg.URL)
	type callResult struct {
		result json.RawMessage
		sid    string
		status int
		body   []byte
	}
	call := func(callMethod string, callParams any, sid string, notification bool) (callResult, error) {
		if cfg.WorkspaceTarget != nil {
			if _, _, err := h.workspaceStore().Resolve(ctx, *cfg.WorkspaceTarget); err != nil {
				return callResult{}, err
			}
		}
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
		resp, err := client.Do(req)
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
		if resp, err := client.Do(req); err == nil {
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
	p := principal(r)
	space, agent, e := h.authorizeMCPScope(r.Context(), p, r.URL.Query().Get("spaceId"), r.URL.Query().Get("agentId"))
	if e != nil {
		statusErr(w, e)
		return
	}
	p = mcpScopedPrincipal(p, space, agent)
	inst, e := h.accessibleMCPInstance(r, p, space, chi.URLParam(r, "id"))
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
	space, agent, e := h.authorizeMCPScope(r.Context(), p, r.URL.Query().Get("spaceId"), r.URL.Query().Get("agentId"))
	if e != nil {
		statusErr(w, e)
		return
	}
	tools, e := h.exposedMCPTools(r, p, agent, space)
	if e != nil {
		statusErr(w, e)
		return
	}
	out := []map[string]any{}
	for _, tool := range tools {
		item := tool.Tool
		item["qualifiedName"] = tool.Name
		item["localName"] = tool.LocalName
		item["instanceId"] = tool.Instance.ID
		item["providerId"] = tool.Instance.Ref
		out = append(out, item)
	}
	httpx.JSON(w, 200, out)
}

func (h *handler) listMCPPolicies(w http.ResponseWriter, r *http.Request) {
	type policyRow struct {
		ID         string  `gorm:"column:id"`
		AgentID    *string `gorm:"column:agent_id"`
		SpaceID    *string `gorm:"column:space_id"`
		Name       string  `gorm:"column:name"`
		PolicyJSON string  `gorm:"column:policy_json"`
		CreatedAt  string  `gorm:"column:created_at"`
		UpdatedAt  string  `gorm:"column:updated_at"`
	}
	var policyRows []policyRow
	query := h.deps.Gorm.WithContext(r.Context()).Table("mcp_policies").Select("id,agent_id,space_id,name,policy_json,created_at,updated_at").Where("tenant_id=?", principal(r).TenantID)
	p := principal(r)
	if p.APIKey && p.AgentID != "" {
		query = query.Where("agent_id=?", p.AgentID)
	} else if p.APIKey && p.SpaceID != "" {
		query = query.Where("space_id=?", p.SpaceID)
	}
	if e := query.Order("created_at").Find(&policyRows).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0)
	for _, row := range policyRows {
		out = append(out, map[string]any{"id": row.ID, "agentId": row.AgentID, "spaceId": row.SpaceID, "name": row.Name, "policy": json.RawMessage(row.PolicyJSON), "createdAt": parseTime(row.CreatedAt), "updatedAt": parseTime(row.UpdatedAt)})
	}
	httpx.JSON(w, 200, map[string]any{"policies": out})
}
func (h *handler) createMCPPolicy(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AgentID *string         `json:"agentId"`
		SpaceID *string         `json:"spaceId"`
		Name    string          `json:"name"`
		Policy  json.RawMessage `json:"policy"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Name == "" {
		httpx.Error(w, 400, "name required")
		return
	}
	if err := h.authorizeMCPPolicy(r.Context(), principal(r), b.SpaceID, b.AgentID); err != nil {
		statusErr(w, err)
		return
	}
	if err := validateMCPPolicy(b.Policy); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	now := h.store.now()
	id := h.store.id()
	e := h.deps.Gorm.WithContext(r.Context()).Table("mcp_policies").Create(map[string]any{"id": id, "tenant_id": principal(r).TenantID, "agent_id": b.AgentID, "space_id": b.SpaceID, "name": b.Name, "policy_json": validJSON(b.Policy, "{}"), "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"policy": map[string]any{"id": id, "agentId": b.AgentID, "spaceId": b.SpaceID, "name": b.Name, "policy": b.Policy}})
}
func (h *handler) updateMCPPolicy(w http.ResponseWriter, r *http.Request) {
	var b struct {
		SpaceID *string         `json:"spaceId"`
		Name    string          `json:"name"`
		Policy  json.RawMessage `json:"policy"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Name == "" {
		httpx.Error(w, 400, "name required")
		return
	}
	space, agent, err := h.authorizeMCPPolicyID(r.Context(), principal(r), chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	if b.SpaceID != nil {
		space = b.SpaceID
	}
	if err = h.authorizeMCPPolicy(r.Context(), principal(r), space, agent); err != nil {
		statusErr(w, err)
		return
	}
	if err = validateMCPPolicy(b.Policy); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	updates := map[string]any{"name": b.Name, "policy_json": validJSON(b.Policy, "{}"), "updated_at": runtimeTimeString(h.store.now())}
	if b.SpaceID != nil {
		updates["space_id"] = b.SpaceID
	}
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.McpPolicy{}).Where("tenant_id=? AND id=?", principal(r).TenantID, chi.URLParam(r, "id")).Updates(updates)
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
	if _, _, err := h.authorizeMCPPolicyID(r.Context(), principal(r), chi.URLParam(r, "id")); err != nil {
		statusErr(w, err)
		return
	}
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
	MCPURL                                                             string            `json:"mcpUrl"`
	APIKey                                                             string            `json:"apiKey"`
	HeaderName                                                         string            `json:"headerName"`
	AuthMode                                                           string            `json:"authMode"`
	ClientID                                                           string            `json:"clientId"`
	ClientSecret                                                       string            `json:"clientSecret"`
	AgentID                                                            *string           `json:"agentId"`
	AgentIDs                                                           []string          `json:"agentIds"`
	SpaceID                                                            *string           `json:"spaceId"`
	SpaceIDs                                                           []string          `json:"spaceIds"`
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
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "invalid MCP import")
		return
	}
	result, err := h.installMCP(r.Context(), principal(r), body)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, result)
}

// All installers share validation, encryption, ownership, provisioning and probe.
func (h *handler) installMCP(ctx context.Context, p httpx.Principal, body stdioImportBody) (map[string]any, error) {
	body.Name = strings.TrimSpace(body.Name)
	if body.URL == "" {
		body.URL = body.MCPURL
	}
	if body.APIKey != "" {
		if body.HeaderName == "" || strings.EqualFold(body.HeaderName, "Authorization") {
			body.Token = body.APIKey
		} else {
			if body.Headers == nil {
				body.Headers = map[string]string{}
			}
			body.Headers[body.HeaderName] = body.APIKey
		}
	}
	if body.AuthMode == "oauth" {
		stopped := false
		body.Start = &stopped
	}
	if body.Name == "" || body.Command == "" && body.URL == "" {
		return nil, errors.New("name and command or url required")
	}
	if body.Command != "" && body.URL != "" {
		return nil, errors.New("choose command or url, not both")
	}
	if body.Command != "" && body.Image != "" && !p.IsPlatformAdmin && p.Role != "owner" && p.Role != "admin" {
		return nil, errors.New("custom stdio images require an administrator")
	}
	if body.All {
		return nil, errors.New("explicit Space bindings required; all is not supported")
	}
	agents := append([]string{}, body.AgentIDs...)
	if body.AgentID != nil {
		agents = append(agents, *body.AgentID)
	}
	agents = uniqueStrings(agents)
	spaces := append([]string{}, body.SpaceIDs...)
	if body.SpaceID != nil {
		spaces = append(spaces, *body.SpaceID)
	}
	for _, id := range agents {
		a, err := h.store.GetAgent(ctx, p.TenantID, id)
		if err != nil {
			return nil, ErrNotFound
		}
		if _, _, err = h.authorizeMCPScope(ctx, p, a.SpaceID, id); err != nil {
			return nil, err
		}
		spaces = append(spaces, a.SpaceID)
	}
	spaces = uniqueStrings(spaces)
	if len(spaces) == 0 && p.SpaceID != "" {
		spaces = append(spaces, p.SpaceID)
	}
	if len(spaces) == 0 {
		return nil, errors.New("owning Space required")
	}
	for _, space := range spaces {
		if _, _, err := h.authorizeMCPScope(ctx, p, space, p.AgentID); err != nil {
			return nil, err
		}
	}
	if body.Command != "" && len(spaces) != 1 {
		return nil, errors.New("stdio MCP requires exactly one owning Space")
	}
	if body.URL != "" {
		if _, err := safeProviderURL(body.URL, ""); err != nil {
			return nil, err
		}
	}
	body.SpaceIDs = spaces
	id := h.store.id()
	slug := slugify(body.Slug)
	if slug == "" {
		slug = slugify(body.Name)
	}
	ownerSpace := spaces[0]
	if body.SpaceID != nil && *body.SpaceID != "" {
		ownerSpace = *body.SpaceID
	}
	if body.Command == "" && len(spaces) > 1 && (body.SpaceID == nil || *body.SpaceID == "") {
		return nil, errors.New("remote MCP with multiple consumers requires an explicit owning spaceId")
	}
	cfg := map[string]any{"url": body.URL, "transport": "http", "ownerSpaceId": ownerSpace}
	if body.Command != "" {
		exec, err := h.resolveServerComputer(ctx, p.TenantID, spaces[0])
		if err != nil {
			return nil, err
		}
		if body.RuntimeNodeID != nil && *body.RuntimeNodeID != "" && *body.RuntimeNodeID != exec.nodeID {
			return nil, errors.New("stdio runtime node must be the owning Space server computer")
		}
		cfg = map[string]any{"ownerSpaceId": spaces[0], "serverComputerId": exec.computer.ID, "command": body.Command, "args": body.Args, "workingDir": body.WorkingDir, "packageManager": body.PackageManager, "bridgeImage": body.Image}
	}
	envKeys := make([]string, 0, len(body.Env))
	for key := range body.Env {
		envKeys = append(envKeys, key)
	}
	slices.Sort(envKeys)
	cfg["environmentVariables"] = envKeys
	cfgRaw, _ := json.Marshal(cfg)
	secretPayload, _ := json.Marshal(map[string]any{"token": body.Token, "headers": body.Headers, "env": body.Env})
	enc, err := secretBox(h.deps.Secret, "mcp:"+id, secretPayload)
	if err != nil {
		return nil, err
	}
	sec, _ := json.Marshal(map[string]any{"enc": enc, "hasToken": body.Token != "", "hasHeaders": len(body.Headers) > 0, "environmentVariables": envKeys})
	now := runtimeTimeString(h.store.now())
	err = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if e := tx.Table("component_instances").Create(map[string]any{"id": id, "tenant_id": p.TenantID, "agent_id": nil, "component_type": "mcp", "component_ref": slug, "name": body.Name, "config_json": string(cfgRaw), "secret_json": string(sec), "status": "stopped", "last_error": nil, "created_at": now, "updated_at": now}).Error; e != nil {
			return e
		}
		for _, space := range spaces {
			if e := tx.Table("agent_bindings").Create(map[string]any{"id": h.store.id(), "tenant_id": p.TenantID, "space_id": space, "agent_id": nil, "instance_id": id, "created_at": now}).Error; e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	started := false
	startError := ""
	if body.Start == nil || *body.Start {
		if err = h.startMCPInstance(ctx, p.TenantID, id); err != nil {
			startError = err.Error()
		} else {
			started = true
		}
	}
	instance, err := h.getInstance(ctx, p.TenantID, id)
	if err != nil {
		return nil, err
	}
	result := h.instanceDTO(ctx, p.TenantID, instance, false)
	result["slug"] = slug
	out := map[string]any{"instance": result, "started": started, "boundAgentIds": agents, "boundSpaceIds": spaces}
	if body.AuthMode == "oauth" {
		out["authRequired"] = true
		out["oauth"] = map[string]any{"ok": false, "needsByoClient": true, "error": "Install saved. Authorize this instance before starting."}
	}
	if startError != "" {
		out["startError"] = startError
	}
	return out, nil
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
	inst, err := h.getMCPInstance(ctx, tenant, instanceID)
	if err != nil {
		return err
	}
	owner, err := h.mcpOwnerSpace(ctx, inst)
	if err != nil {
		return err
	}
	if err = h.requireSpaceInfrastructureAvailable(ctx, tenant, owner); err != nil {
		return err
	}
	lease, err := h.acquireSpaceInfrastructure(ctx, tenant, owner)
	if err != nil {
		return err
	}
	defer lease.release()
	return h.provisionStdioMCPWithLease(ctx, tenant, instanceID, body, owner, lease)
}

func (h *handler) provisionStdioMCPWithLease(ctx context.Context, tenant, instanceID string, body stdioImportBody, owner string, lease *workspaceLease) error {
	if err := lease.check(ctx); err != nil {
		return err
	}
	ctx = context.WithValue(ctx, workspaceRequestTargetKey{}, lease.Space)
	exec, err := h.resolveServerComputer(ctx, tenant, owner)
	if err != nil {
		return err
	}
	nodeID := exec.nodeID
	if nodeID == "" {
		return errors.New("bind the owning Space server computer to a runtime node before starting stdio MCP")
	}
	if body.RuntimeNodeID != nil && *body.RuntimeNodeID != "" && *body.RuntimeNodeID != nodeID {
		return errors.New("stdio runtime node must match the owning Space server computer")
	}
	runner, err := h.hub.get(nodeID)
	if err != nil {
		return err
	}
	remote := h.executionRemote(runner, exec)
	packageManager := strings.ToLower(strings.TrimSpace(body.PackageManager))
	if packageManager == "" {
		if body.Command == "docker" || body.Command == "podman" {
			packageManager = "oci"
		} else {
			packageManager = "npm"
		}
	}
	var oci ociMCPSpec
	if packageManager == "oci" {
		if exec.workspace != nil {
			return errors.New("OCI stdio MCP is unavailable on managed disks; use an npm, pypi or binary MCP")
		}
		if oci, err = parseOCIMCPCommand(body.Command, body.Args); err != nil {
			return err
		}
	}
	envName := map[string]string{"npm": "ZAKURA_STDIO_NODE_IMAGE", "pypi": "ZAKURA_STDIO_PYTHON_IMAGE", "oci": "ZAKURA_STDIO_OCI_IMAGE", "binary": "ZAKURA_STDIO_BINARY_IMAGE"}[packageManager]
	if envName == "" {
		return errors.New("packageManager must be npm, pypi, oci, or binary")
	}
	image := strings.TrimSpace(body.Image)
	if packageManager == "oci" {
		image = oci.Image
	}
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
	dataSpaceID := owner
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
	if packageManager != "oci" {
		if err = runner.call(ctx, "docker.pull", map[string]any{"image": image}, nil); err != nil {
			return err
		}
	}
	env := map[string]string{"MCP_COMMAND": body.Command, "MCP_CWD": body.WorkingDir, "MCP_PORT": "3100", "MCP_PATH": "/mcp"}
	args, _ := json.Marshal(body.Args)
	env["MCP_ARGS"] = string(args)
	for key, value := range body.Env {
		if strings.HasPrefix(key, "MCP_") || key == "DOCKER_HOST" {
			return errors.New("stdio environment cannot override bridge control variables")
		}
		env[key] = value
	}
	ociEnv := map[string]string{}
	if packageManager == "oci" {
		// Only what the docker run line declared reaches the MCP container:
		// literal -e values, and -e NAME passthroughs filled from the MCP env.
		for key, value := range oci.Env {
			ociEnv[key] = value
		}
		for _, key := range oci.EnvPass {
			if value, ok := body.Env[key]; ok {
				ociEnv[key] = value
			}
		}
	}
	var dataRoot struct {
		Abs string `json:"abs"`
	}
	var volumes []map[string]any
	if exec.workspace == nil {
		if err = remote.call(ctx, "host.fs.mkdir", map[string]any{"spaceId": dataSpaceID, "path": dataPath}, &dataRoot); err != nil {
			return fmt.Errorf("prepare stdio data directory: %w", err)
		}
		if dataRoot.Abs == "" {
			return errors.New("runner returned no stdio data directory")
		}
		volumes = []map[string]any{{"hostPath": dataRoot.Abs, "containerPath": "/data"}}
	}
	if packageManager == "oci" {
		platform, _ := host["platform"].(string)
		dockerCap, _ := capabilities["docker"].(bool)
		direct, _ := capabilities["mcpOCIDirect"].(bool)
		if platform != "linux" || !dockerCap {
			return errors.New("OCI stdio MCP requires a Linux runner with Docker capability")
		}
		if !direct {
			// Older nodes would need the Docker socket mounted into the bridge,
			// which hands the node to the MCP configuration. Never fall back.
			return errors.New("OCI stdio MCP requires an upgraded node; older nodes would need Docker socket access")
		}
	}
	var running struct {
		DockerID, Name, Image, Status string
		Ports                         []struct {
			ContainerPort, HostPort int
			Protocol                string
		} `json:"ports"`
	}
	if err = lease.check(ctx); err != nil {
		return err
	}
	relay, _ := capabilities["mcpRelay"].(bool)
	createParams := map[string]any{"name": "zakura-stdio-" + instanceID, "image": image, "command": []string{"/usr/local/bin/zakura-stdio-bridge"}, "env": env, "labels": map[string]string{"zakura.instance": instanceID, "zakura.purpose": "component", "zakura.space": owner, "zakura.computer": exec.computer.ID, "zakura.tenant": tenant}, "ports": []map[string]any{{"containerPort": 3100, "protocol": "tcp"}}, "volumes": volumes, "workingDir": body.WorkingDir, "restart": "unless-stopped"}
	if relay {
		delete(createParams, "ports")
	}
	switch {
	case packageManager == "oci":
		arch, _ := host["arch"].(string)
		bridgeURL, bridgeSHA, bridgeErr := stdioBridgeArtifact(arch)
		if bridgeErr != nil {
			return bridgeErr
		}
		err = runner.call(ctx, "mcp.oci.create", map[string]any{"name": createParams["name"], "image": image, "args": oci.Args, "env": ociEnv, "labels": createParams["labels"], "dataDir": dataRoot.Abs, "port": 3100, "publish": !relay, "bridgeUrl": bridgeURL, "bridgeSha256": bridgeSHA}, &running)
	case exec.workspace != nil:
		createParams["name"] = "zakura-stdio-" + h.store.id()
		err = h.createWorkspaceSidecar(ctx, runner, exec, createParams, &running)
	default:
		err = runner.call(ctx, "docker.create", createParams, &running)
	}
	if err != nil {
		// A failed RPC may have created the process before its response was lost.
		// Retain the durable intent until recovery observes the remote state.
		return lease.uncertain(fmt.Errorf("create stdio bridge: %w", err))
	}
	if running.DockerID == "" {
		return lease.uncertain(errors.New("runner returned no stdio bridge container ID"))
	}
	cleanup := func(cause error) error {
		cleanupCtx, cancel := mcpCleanupContext(ctx)
		defer cancel()
		if stopErr := cleanupWorkspaceContainer(cleanupCtx, runner, remote, running.DockerID); stopErr != nil {
			return lease.uncertain(fmt.Errorf("%w; stdio bridge cleanup failed: %v", cause, stopErr))
		}
		return cause
	}
	bridgeReady := false
	var inspected struct {
		Status string `json:"status"`
	}
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return cleanup(ctx.Err())
			case <-time.After(250 * time.Millisecond):
			}
		}
		if inspectErr := remote.call(ctx, "docker.inspect", map[string]any{"id": running.DockerID}, &inspected); inspectErr == nil && strings.EqualFold(inspected.Status, "running") {
			bridgeReady = true
			break
		}
	}
	if !bridgeReady {
		var logs struct {
			Logs string `json:"logs"`
		}
		_ = remote.call(ctx, "docker.logs", map[string]any{"id": running.DockerID, "tail": 50}, &logs)
		return cleanup(fmt.Errorf("stdio bridge container did not stay running (image must contain /usr/local/bin/zakura-stdio-bridge and the requested runtime): %s", strings.TrimSpace(logs.Logs)))
	}
	var endpoint string
	if relay {
		endpoint = mcpRelayEndpoint(nodeID, running.DockerID, 3100)
	} else {
		port := 0
		for _, candidate := range running.Ports {
			if candidate.ContainerPort == 3100 {
				port = candidate.HostPort
			}
		}
		if port == 0 {
			return cleanup(errors.New("runner did not publish stdio bridge port"))
		}
		hostname, _ := host["primaryIp"].(string)
		if hostname == "" {
			hostname, _ = host["hostname"].(string)
		}
		if hostname == "" {
			return cleanup(errors.New("runtime node did not report an address"))
		}
		endpoint = fmt.Sprintf("http://%s:%d/mcp", hostname, port)
	}
	if err = h.probeStdioBridge(ctx, endpoint); err != nil {
		return cleanup(fmt.Errorf("stdio bridge readiness failed: %w", err))
	}
	envKeys := make([]string, 0, len(body.Env))
	for key := range body.Env {
		envKeys = append(envKeys, key)
	}
	slices.Sort(envKeys)
	config := map[string]any{"url": endpoint, "ownerSpaceId": owner, "serverComputerId": exec.computer.ID, "runtimeNodeId": nodeID, "dataSpaceId": dataSpaceID, "dataPath": dataPath, "command": body.Command, "args": body.Args, "environmentVariables": envKeys, "workingDir": body.WorkingDir, "packageManager": packageManager, "bridgeImage": image}
	if exec.workspace != nil {
		config["workspaceTarget"] = exec.workspace.Target
	}
	cfg, _ := json.Marshal(config)
	now := h.store.now()
	labels, _ := json.Marshal(map[string]string{"zakura.instance": instanceID, "zakura.purpose": "component"})
	ports, _ := json.Marshal(running.Ports)
	err = lease.fenced(ctx, func(tx *gorm.DB) error {
		if e := tx.Exec(`UPDATE component_instances SET config_json=?,status='running',last_error=NULL,updated_at=? WHERE id=? AND tenant_id=?`, string(cfg), runtimeTimeString(now), instanceID, tenant).Error; e != nil {
			return e
		}
		row := map[string]any{"id": h.store.id(), "tenant_id": tenant, "instance_id": instanceID, "space_id": dataSpaceID, "docker_id": running.DockerID, "name": running.Name, "image": image, "purpose": "component", "status": "running", "labels_json": string(labels), "ports_json": string(ports), "runtime_node_id": nodeID, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}
		if exec.workspace != nil {
			row["workspace_instance_id"] = exec.workspace.Target.InstanceID
		}
		return tx.Table("managed_containers").Create(row).Error
	})
	if err != nil {
		return cleanup(err)
	}
	return nil
}

func (h *handler) probeStdioBridge(ctx context.Context, endpoint string) error {
	base := strings.TrimSuffix(endpoint, "/mcp")
	client := h.mcpHTTPClient(endpoint)
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
		resp, err := client.Do(req)
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
		resp, err := client.Do(req)
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
	if initResp.StatusCode < 200 || initResp.StatusCode >= 300 {
		return fmt.Errorf("initialize status %d", initResp.StatusCode)
	}
	initResult, decodeErr := decodeMCPProbeResult(initRaw)
	var initialized struct {
		ProtocolVersion string         `json:"protocolVersion"`
		Capabilities    map[string]any `json:"capabilities"`
	}
	if decodeErr != nil || json.Unmarshal(initResult, &initialized) != nil || initialized.ProtocolVersion == "" || initialized.Capabilities == nil {
		return errors.New("invalid stdio MCP initialize result")
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
			if resp, err := client.Do(req); err == nil {
				_ = resp.Body.Close()
			}
		}()
	}
	listResp, listRaw, err := post("tools/list", map[string]any{}, sid, false)
	if err != nil {
		return err
	}
	if listResp.StatusCode < 200 || listResp.StatusCode >= 300 {
		return fmt.Errorf("tools/list status %d", listResp.StatusCode)
	}
	listResult, decodeErr := decodeMCPProbeResult(listRaw)
	var listed struct {
		Tools json.RawMessage `json:"tools"`
	}
	if decodeErr != nil || json.Unmarshal(listResult, &listed) != nil || len(listed.Tools) == 0 || listed.Tools[0] != '[' {
		return errors.New("invalid stdio MCP tools/list result")
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
	p := principal(r)
	space, _ := b["spaceId"].(string)
	agent, _ := b["agentId"].(string)
	space, agent, e = h.authorizeMCPScope(r.Context(), p, space, agent)
	if e != nil {
		statusErr(w, e)
		return
	}
	p = mcpScopedPrincipal(p, space, agent)
	r = r.WithContext(httpx.WithPrincipal(r.Context(), p))
	id, _ := b["instanceId"].(string)
	callParams, _ := params(b).(map[string]any)
	if callParams == nil {
		httpx.Error(w, 400, "operation params required")
		return
	}
	if method == "tools/call" {
		name, _ := callParams["name"].(string)
		if name == "" {
			callParams["name"] = b["qualifiedName"]
		}
	}
	if method == "resources/read" {
		uri, _ := callParams["uri"].(string)
		if strings.HasPrefix(uri, "zakura-mcp:") {
			resourceID, upstream, err := decodeMCPResourceURI(uri)
			if err != nil || id != "" && id != resourceID {
				httpx.Error(w, 400, "invalid resource instance")
				return
			}
			id = resourceID
			callParams["uri"] = upstream
		}
	}
	if id == "" && method == "tools/call" {
		name, _ := callParams["name"].(string)
		tools, err := h.exposedMCPTools(r, p, agent, space)
		if err != nil {
			statusErr(w, err)
			return
		}
		for _, tool := range tools {
			if name == tool.Name || name == "re_"+tool.Name || name == tool.Instance.ID+":"+tool.LocalName {
				id = tool.Instance.ID
				callParams["name"] = tool.LocalName
				break
			}
		}
	}
	if id == "" {
		httpx.Error(w, 400, "instanceId required")
		return
	}
	inst, e := h.accessibleMCPInstance(r, p, space, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	if method == "tools/call" || method == "prompts/get" {
		name, _ := callParams["name"].(string)
		callParams["name"] = localMCPName(inst, name)
	}
	if method == "completion/complete" {
		ref, _ := callParams["ref"].(map[string]any)
		if ref == nil {
			httpx.Error(w, 400, "completion ref required")
			return
		}
		if name, ok := ref["name"].(string); ok {
			ref["name"] = localMCPName(inst, name)
		}
		if uri, ok := ref["uri"].(string); ok && strings.HasPrefix(uri, "zakura-mcp:") {
			resourceID, upstream, err := decodeMCPResourceURI(uri)
			if err != nil || resourceID != inst.ID {
				httpx.Error(w, 400, "invalid completion resource")
				return
			}
			ref["uri"] = upstream
		}
	}
	result, e := h.authorizedMCPRPC(r, p, space, inst, method, callParams)
	if e != nil {
		statusErr(w, e)
		return
	}
	var v any
	_ = json.Unmarshal(result, &v)
	httpx.JSON(w, 200, map[string]any{"ok": true, "result": v})
}
func (h *handler) authorizedMCPRPC(r *http.Request, p httpx.Principal, space string, inst mcpInstance, method string, params map[string]any) (json.RawMessage, error) {
	start := time.Now()
	policies, e := h.effectiveMCPPolicies(r.Context(), p.TenantID, p.AgentID, space)
	policyMethod, name := mcpOperationName(method, params)
	if policyMethod == "tools/call" {
		cfg := map[string]any{}
		_ = json.Unmarshal(inst.Config, &cfg)
		if toolExposureOf(cfg, name) == "hidden" {
			e = ErrNotFound
		}
	}
	if e == nil && !policies.operationAllowed(inst, policyMethod, name) {
		e = ErrNotFound
	}
	var result json.RawMessage
	if e == nil {
		result, e = h.mcpRPC(r.Context(), inst, method, params)
	}
	status, errText := "ok", ""
	if e != nil {
		status = "error"
		errText = e.Error()
	}
	h.auditToolCall(r.Context(), mcpScopedPrincipal(p, space, p.AgentID), inst, method, params, status, errText, time.Since(start))
	return result, e
}

func (h *handler) auditToolCall(ctx context.Context, p httpx.Principal, inst mcpInstance, method string, args map[string]any, status, errText string, d time.Duration) {
	raw, _ := json.Marshal(args)
	result := ""
	isError := status != "ok"
	if isError {
		result = errText
	}
	_ = h.deps.Gorm.WithContext(ctx).Table("tool_call_logs").Create(map[string]any{"id": h.store.id(), "tenant_id": p.TenantID, "api_key_id": nullString(p.APIKeyID), "actor_user_id": nullString(p.UserID), "space_id": nullString(p.SpaceID), "agent_id": nullString(p.AgentID), "qualified_name": inst.Ref + ":" + method, "local_name": method, "provider_id": inst.Ref, "instance_id": nullString(inst.ID), "args_json": string(raw), "result_json": result, "is_error": isError, "duration_ms": d.Milliseconds(), "created_at": runtimeTimeString(h.store.now())}).Error
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
	e := h.deps.Gorm.WithContext(r.Context()).Table("mcp_store_sources").Create(map[string]any{"id": id, "tenant_id": principal(r).TenantID, "name": b.Name, "description": b.Description, "source_url": b.SourceURL, "format": b.Format, "manifest_json": validJSON(b.Manifest, "{}"), "servers_json": validJSON(b.Servers, "[]"), "enabled": true, "fetched_at": runtimeTimeString(now), "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error
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
		ID           string            `json:"id"`
		Name         string            `json:"name"`
		Store        string            `json:"store"`
		Prefer       string            `json:"prefer"`
		RemoteURL    string            `json:"remoteUrl"`
		PackageIndex *int              `json:"packageIndex"`
		DisplayName  string            `json:"displayName"`
		SpaceID      *string           `json:"spaceId"`
		SpaceIDs     []string          `json:"spaceIds"`
		AgentID      *string           `json:"agentId"`
		AgentIDs     []string          `json:"agentIds"`
		All          bool              `json:"all"`
		Start        *bool             `json:"start"`
		Config       json.RawMessage   `json:"config"`
		Env          map[string]string `json:"env"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.ID == "" && b.Name == "" {
		httpx.Error(w, 400, "id or name required")
		return
	}
	var entry struct {
		Name     string `gorm:"column:name"`
		Ref      string `gorm:"column:ref"`
		MetaJSON string `gorm:"column:meta_json"`
	}
	query := h.deps.Gorm.WithContext(r.Context()).Table("store_catalog_entries").Select("name,ref,meta_json").Where("(tenant_id IS NULL OR tenant_id=?) AND kind='mcp'", principal(r).TenantID)
	if b.ID != "" {
		query = query.Where("id=?", b.ID)
	} else {
		query = query.Where("name=?", b.Name)
		if b.Store != "" {
			query = query.Where("source_id=?", b.Store)
		}
	}
	e := query.Take(&entry).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = ErrNotFound
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	cfg := map[string]any{}
	if json.Unmarshal([]byte(entry.MetaJSON), &cfg) != nil {
		httpx.Error(w, 400, "invalid store entry")
		return
	}
	if len(b.Config) > 0 {
		var overrides map[string]any
		if json.Unmarshal(b.Config, &overrides) != nil {
			httpx.Error(w, 400, "invalid config")
			return
		}
		for k, v := range overrides {
			cfg[k] = v
		}
	}
	body, e := mcpStoreInstallBody(cfg, b.Prefer, b.RemoteURL, b.PackageIndex)
	if e != nil {
		httpx.Error(w, 400, e.Error())
		return
	}
	body.Name = entry.Name
	if b.DisplayName != "" {
		body.Name = b.DisplayName
	}
	body.Slug = entry.Ref
	body.SpaceID = b.SpaceID
	body.SpaceIDs = b.SpaceIDs
	body.AgentID = b.AgentID
	body.AgentIDs = b.AgentIDs
	body.All = b.All
	body.Start = b.Start
	if body.Env == nil {
		body.Env = map[string]string{}
	}
	for k, v := range b.Env {
		body.Env[k] = v
	}
	result, e := h.installMCP(r.Context(), principal(r), body)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, result)
}
