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
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

type Instance struct {
	ID        string          `json:"id"`
	AgentID   *string         `json:"agentId"`
	Type      string          `json:"type"`
	Ref       string          `json:"ref"`
	Name      string          `json:"name"`
	Config    json.RawMessage `json:"config"`
	Status    string          `json:"status"`
	LastError *string         `json:"lastError"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

func (h *handler) registerInstances(r chi.Router) {
	r.Get("/instances", h.listInstances)
	r.Post("/instances", h.createInstance)
	r.Get("/instances/{id}", h.getInstanceHTTP)
	r.Patch("/instances/{id}", h.patchInstance)
	r.Delete("/instances/{id}", h.deleteInstance)
	r.Post("/instances/{id}/start", h.startInstance)
	r.Post("/instances/{id}/stop", h.stopInstance)
	r.Post("/instances/{id}/rebuild", h.rebuildInstance)
	r.Get("/instances/{id}/runtime", h.instanceRuntime)
	r.Get("/instances/reconcile", h.reconcileInstances)
	r.Post("/instances/reconcile", h.reconcileInstances)
	r.Get("/agents/{id}/bindings", h.listBindings)
	r.Post("/agents/{id}/bindings", h.createBinding)
	r.Delete("/agents/{id}/bindings/{instanceId}", h.deleteBinding)
	r.Get("/agents/{id}/providers", h.agentProviders)
	r.Put("/agents/{id}/providers", h.putAgentProviders)
	r.Post("/agents/{id}/start", h.startAgent)
	r.Post("/agents/{id}/stop", h.stopAgent)
	r.Get("/agents/{id}/progress", h.agentProgress)
	r.Get("/containers", h.listContainers)
	r.Post("/containers/allocate", h.allocateContainer)
	r.Post("/containers/{id}/stop", h.stopContainer)
	r.Get("/instances/{id}/containers/{containerId}/logs", h.containerLogs)
}
func scanInstance(row interface{ Scan(...any) error }) (Instance, error) {
	var x Instance
	var cfg string
	e := row.Scan(&x.ID, &x.AgentID, &x.Type, &x.Ref, &x.Name, &cfg, &x.Status, &x.LastError, &x.CreatedAt, &x.UpdatedAt)
	x.Config = json.RawMessage(cfg)
	return x, e
}
func (h *handler) getInstance(ctx context.Context, tenant, id string) (Instance, error) {
	x, e := scanInstance(h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT id,agent_id,component_type,component_ref,name,config_json,status,last_error,created_at,updated_at FROM component_instances WHERE tenant_id=? AND id=?`), tenant, id))
	if errors.Is(e, sql.ErrNoRows) {
		e = ErrNotFound
	}
	return x, e
}
func (h *handler) instanceDTO(ctx context.Context, tenant string, instance Instance, details bool) map[string]any {
	out := map[string]any{
		"id": instance.ID, "name": instance.Name, "slug": instance.Ref, "providerId": instance.Ref,
		"status": instance.Status, "healthStatus": func() string {
			if instance.Status == "running" || instance.Status == "ready" {
				return "healthy"
			}
			return "unknown"
		}(),
		"lastError": instance.LastError, "createdAt": instance.CreatedAt, "updatedAt": instance.UpdatedAt,
	}
	config := map[string]any{}
	_ = json.Unmarshal(instance.Config, &config)
	out["config"] = redactConfig(config)
	if endpoint, _ := config["url"].(string); endpoint != "" {
		out["endpointUrl"] = endpoint
	} else if endpoint, _ := config["mcpUrl"].(string); endpoint != "" {
		out["endpointUrl"] = endpoint
	} else {
		out["endpointUrl"] = nil
	}
	var providerName, providerKind string
	if h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT name,kind FROM provider_catalog WHERE id=?`), instance.Ref).Scan(&providerName, &providerKind) == nil {
		out["provider"] = map[string]any{"id": instance.Ref, "name": providerName, "category": providerKind}
	} else {
		out["provider"] = nil
	}
	containerRows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT id,name,image,status,docker_id,ports_json FROM managed_containers WHERE tenant_id=? AND instance_id=? ORDER BY created_at`), tenant, instance.ID)
	containers := []map[string]any{}
	if err == nil {
		for containerRows.Next() {
			var id, name, image, status, ports string
			var dockerID sql.NullString
			if containerRows.Scan(&id, &name, &image, &status, &dockerID, &ports) == nil {
				containers = append(containers, map[string]any{"id": id, "name": name, "image": image, "status": status, "dockerId": nullableString(dockerID), "portsJson": ports})
			}
		}
		containerRows.Close()
	}
	out["containers"] = containers
	if !details {
		return out
	}
	out["tools"], out["resources"], out["prompts"], out["resourceTemplates"] = []any{}, []any{}, []any{}, []any{}
	if instance.Type != "mcp" || (instance.Status != "running" && instance.Status != "ready") {
		return out
	}
	mcp, err := h.getMCPInstance(ctx, tenant, instance.ID)
	if err != nil {
		return out
	}
	call := func(method string, target any) {
		callCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if result, err := h.mcpRPC(callCtx, mcp, method, map[string]any{}); err == nil {
			_ = json.Unmarshal(result, target)
		}
	}
	var tools struct {
		Tools []map[string]any `json:"tools"`
	}
	call("tools/list", &tools)
	for _, tool := range tools.Tools {
		name, _ := tool["name"].(string)
		tool["localName"], tool["qualifiedName"], tool["instanceId"], tool["providerId"] = name, "re_"+slugify(instance.Ref)+"__"+name, instance.ID, instance.Ref
	}
	out["tools"] = tools.Tools
	var resources struct {
		Resources []map[string]any `json:"resources"`
	}
	call("resources/list", &resources)
	out["resources"] = resources.Resources
	var prompts struct {
		Prompts []map[string]any `json:"prompts"`
	}
	call("prompts/list", &prompts)
	out["prompts"] = prompts.Prompts
	var templates struct {
		ResourceTemplates []map[string]any `json:"resourceTemplates"`
	}
	call("resources/templates/list", &templates)
	out["resourceTemplates"] = templates.ResourceTemplates
	return out
}

func (h *handler) listInstances(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,agent_id,component_type,component_ref,name,config_json,status,last_error,created_at,updated_at FROM component_instances WHERE tenant_id=? ORDER BY created_at DESC`), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	instances := []Instance{}
	for rows.Next() {
		x, err := scanInstance(rows)
		if err != nil {
			rows.Close()
			statusErr(w, err)
			return
		}
		instances = append(instances, x)
	}
	rows.Close()
	out := make([]map[string]any, 0, len(instances))
	for _, instance := range instances {
		out = append(out, h.instanceDTO(r.Context(), p.TenantID, instance, false))
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *handler) createInstance(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AgentID        *string `json:"agentId"`
		ProviderID     string  `json:"providerId"`
		Type           string  `json:"type"`
		Ref            string  `json:"ref"`
		Slug           string  `json:"slug"`
		Name           string  `json:"name"`
		Start          bool    `json:"start"`
		Config, Secret json.RawMessage
	}
	if httpx.DecodeJSON(r, &body) != nil || body.Name == "" || (body.ProviderID == "" && body.Ref == "") {
		httpx.Error(w, http.StatusBadRequest, "providerId and name required")
		return
	}
	p := principal(r)
	if body.AgentID != nil {
		if _, err := h.store.GetAgent(r.Context(), p.TenantID, *body.AgentID); err != nil {
			statusErr(w, err)
			return
		}
	}
	if body.Type == "" {
		body.Type = "mcp"
	}
	if body.Ref == "" {
		body.Ref = body.ProviderID
	}
	if body.Slug != "" {
		body.Ref = body.Slug
	}
	now, id := h.store.now(), h.store.id()
	configPlain := validJSON(body.Config, "{}")
	secretValues := map[string]any{}
	_ = json.Unmarshal([]byte(validJSON(body.Secret, "{}")), &secretValues)
	if body.Type == "mcp" {
		configValues := map[string]any{}
		_ = json.Unmarshal([]byte(configPlain), &configValues)
		for _, key := range []string{"token", "apiKey", "accessToken", "headers", "credentials", "secret"} {
			if value, ok := configValues[key]; ok {
				secretValues[key] = value
				delete(configValues, key)
			}
		}
		encoded, _ := json.Marshal(configValues)
		configPlain = string(encoded)
	}
	secretPlain, _ := json.Marshal(secretValues)
	enc, encErr := secretBox(h.deps.Secret, "mcp:"+id, []byte(secretPlain))
	if encErr != nil {
		statusErr(w, encErr)
		return
	}
	secretStored, _ := json.Marshal(map[string]any{"enc": enc, "configured": len(secretValues) > 0})
	_, err := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'stopped',NULL,?,?)`), id, p.TenantID, body.AgentID, body.Type, body.Ref, body.Name, configPlain, string(secretStored), now, now)
	if err != nil {
		statusErr(w, err)
		return
	}
	instance, _ := h.getInstance(r.Context(), p.TenantID, id)
	if body.Start {
		if err := h.startInstanceValue(r.Context(), p.TenantID, &instance); err != nil {
			result := h.instanceDTO(r.Context(), p.TenantID, instance, false)
			result["error"] = err.Error()
			httpx.JSON(w, http.StatusCreated, result)
			return
		}
	}
	httpx.JSON(w, http.StatusCreated, h.instanceDTO(r.Context(), p.TenantID, instance, false))
}

func (h *handler) getInstanceHTTP(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	instance, err := h.getInstance(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, h.instanceDTO(r.Context(), p.TenantID, instance, true))
}

func (h *handler) patchInstance(w http.ResponseWriter, r *http.Request) {
	m, err := decodeMap(r)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	sets, args := []string{}, []any{}
	for key, column := range map[string]string{"name": "name", "agentId": "agent_id", "config": "config_json"} {
		if value, ok := m[key]; ok {
			if key == "config" {
				encoded, _ := json.Marshal(value)
				value = string(encoded)
			}
			sets, args = append(sets, column+"=?"), append(args, value)
		}
	}
	if len(sets) == 0 {
		h.getInstanceHTTP(w, r)
		return
	}
	sets, args = append(sets, "updated_at=?"), append(args, h.store.now(), principal(r).TenantID, chi.URLParam(r, "id"))
	result, err := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE component_instances SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`), args...)
	if err != nil {
		statusErr(w, err)
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.getInstanceHTTP(w, r)
}

func (h *handler) deleteInstance(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM component_instances WHERE tenant_id=? AND id=?`), p.TenantID, chi.URLParam(r, "id"))
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
func (h *handler) setInstanceStatus(ctx context.Context, tenant, id, status string, errText *string) error {
	res, e := h.deps.DB.ExecContext(ctx, h.store.q(`UPDATE component_instances SET status=?,last_error=?,updated_at=? WHERE tenant_id=? AND id=?`), status, errText, h.store.now(), tenant, id)
	if e != nil {
		return e
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
func (h *handler) startInstanceValue(ctx context.Context, tenant string, instance *Instance) error {
	if instance.Type == "mcp" {
		mcp, err := h.getMCPInstance(ctx, tenant, instance.ID)
		if err == nil {
			if body, stdio, secretErr := h.stdioBodyForInstance(mcp); secretErr != nil {
				err = secretErr
			} else if stdio {
				var active int
				_ = h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT COUNT(*) FROM managed_containers WHERE tenant_id=? AND instance_id=? AND docker_id IS NOT NULL AND status IN ('created','running')`), tenant, instance.ID).Scan(&active)
				if active == 0 {
					err = h.provisionStdioMCP(ctx, tenant, instance.ID, body)
				}
			} else {
				_, err = h.mcpRPC(ctx, mcp, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "zakura", "version": "go-rewrite"}})
			}
		}
		if err != nil {
			message := err.Error()
			_ = h.setInstanceStatus(ctx, tenant, instance.ID, "error", &message)
			return err
		}
	}
	if err := h.setInstanceStatus(ctx, tenant, instance.ID, "running", nil); err != nil {
		return err
	}
	instance.Status = "running"
	return nil
}
func (h *handler) startInstance(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	instance, err := h.getInstance(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	if err = h.startInstanceValue(r.Context(), p.TenantID, &instance); err != nil {
		httpx.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, h.instanceDTO(r.Context(), p.TenantID, instance, true))
}
func (h *handler) stopInstance(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	instanceID := chi.URLParam(r, "id")
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,docker_id,runtime_node_id FROM managed_containers WHERE tenant_id=? AND instance_id=? AND docker_id IS NOT NULL AND status IN ('created','running')`), p.TenantID, instanceID)
	if e != nil {
		statusErr(w, e)
		return
	}
	type activeContainer struct{ id, docker, node string }
	containers := []activeContainer{}
	for rows.Next() {
		var item activeContainer
		if rows.Scan(&item.id, &item.docker, &item.node) == nil {
			containers = append(containers, item)
		}
	}
	rows.Close()
	for _, item := range containers {
		runner, err := h.hub.get(item.node)
		if err != nil {
			httpx.Error(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		if err = runner.call(r.Context(), "docker.stop", map[string]any{"id": item.docker, "remove": true}, nil); err != nil {
			httpx.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE managed_containers SET status='removed',docker_id=NULL,updated_at=? WHERE id=? AND tenant_id=?`), h.store.now(), item.id, p.TenantID)
	}
	e = h.setInstanceStatus(r.Context(), p.TenantID, instanceID, "stopped", nil)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) rebuildInstance(w http.ResponseWriter, r *http.Request) { h.startInstance(w, r) }
func (h *handler) instanceRuntime(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if _, e := h.getInstance(r.Context(), p.TenantID, chi.URLParam(r, "id")); e != nil {
		statusErr(w, e)
		return
	}
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,docker_id,runtime_node_id FROM managed_containers WHERE tenant_id=? AND instance_id=? ORDER BY created_at`), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	type row struct {
		id           string
		docker, node *string
	}
	stored := []row{}
	for rows.Next() {
		var item row
		if rows.Scan(&item.id, &item.docker, &item.node) == nil {
			stored = append(stored, item)
		}
	}
	rows.Close()
	out := []map[string]any{}
	for _, item := range stored {
		var live any
		if item.docker != nil && item.node != nil {
			if runner, err := h.hub.get(*item.node); err == nil {
				var inspected map[string]any
				if runner.call(r.Context(), "docker.inspect", map[string]any{"id": *item.docker}, &inspected) == nil {
					live = inspected
				}
			}
		}
		out = append(out, map[string]any{"id": item.id, "runtime": live})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"containers": out})
}
func (h *handler) reconcileInstances(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE component_instances SET status='stopped',updated_at=? WHERE tenant_id=? AND status='starting' AND updated_at<?`), h.store.now(), p.TenantID, h.store.now().Add(-10*time.Minute))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	httpx.JSON(w, 200, map[string]any{"reconciled": n})
}

func (h *handler) listBindings(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	var space string
	if e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT space_id FROM agents WHERE tenant_id=? AND id=?`), p.TenantID, agent).Scan(&space); e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT b.id,b.instance_id,b.created_at,i.name,i.component_type,i.status FROM agent_bindings b JOIN component_instances i ON i.id=b.instance_id WHERE b.tenant_id=? AND b.space_id=? ORDER BY b.created_at`), p.TenantID, space)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, instance, created, name, typ, status string
		if rows.Scan(&id, &instance, &created, &name, &typ, &status) == nil {
			out = append(out, map[string]any{"id": id, "instanceId": instance, "createdAt": created, "name": name, "type": typ, "status": status})
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}
func (h *handler) createBinding(w http.ResponseWriter, r *http.Request) {
	var b struct {
		InstanceID string `json:"instanceId"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.InstanceID == "" {
		httpx.Error(w, 400, "instanceId required")
		return
	}
	p := principal(r)
	agent := chi.URLParam(r, "id")
	var space string
	if e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT space_id FROM agents WHERE tenant_id=? AND id=?`), p.TenantID, agent).Scan(&space); e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	var count int
	if e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM component_instances WHERE tenant_id=? AND id=?`), p.TenantID, b.InstanceID).Scan(&count); e != nil || count == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	id := h.store.id()
	_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO agent_bindings(id,tenant_id,space_id,agent_id,instance_id,created_at) VALUES(?,?,?,?,?,?)`), id, p.TenantID, space, agent, b.InstanceID, h.store.now())
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": id, "instanceId": b.InstanceID, "agentId": agent, "spaceId": space, "createdAt": h.store.now()})
}
func (h *handler) deleteBinding(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM agent_bindings WHERE tenant_id=? AND agent_id=? AND instance_id=?`), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "instanceId"))
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
func (h *handler) agentProviders(w http.ResponseWriter, r *http.Request) {
	options, err := h.buildAgentProviders(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, options)
}

func (h *handler) buildAgentProviders(ctx context.Context, tenant, agentID string) (map[string]any, error) {
	agent, err := h.store.GetAgent(ctx, tenant, agentID)
	if err != nil {
		return nil, err
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(agent.Config, &cfg)
	providers, _ := cfg["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{"mcp": map[string]any{"mode": "all", "instanceIds": []any{}}}
	}
	mcpCfg, _ := providers["mcp"].(map[string]any)
	mode, _ := mcpCfg["mode"].(string)
	if mode != "selected" {
		mode = "all"
	}
	exposeWorkspaceFS, ok := mcpCfg["exposeWorkspaceFs"].(bool)
	if !ok {
		exposeWorkspaceFS = true
	}
	rows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT i.id,i.name,i.component_ref,i.status,CASE WHEN b.id IS NULL THEN false ELSE true END FROM component_instances i LEFT JOIN agent_bindings b ON b.instance_id=i.id AND b.agent_id=? WHERE i.tenant_id=? AND i.component_type='mcp' ORDER BY i.name`), agentID, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	instances := []map[string]any{}
	for rows.Next() {
		var id, name, slug, status string
		var bound bool
		if err := rows.Scan(&id, &name, &slug, &status, &bound); err != nil {
			return nil, err
		}
		instances = append(instances, map[string]any{"id": id, "name": name, "slug": slug, "providerId": slug, "status": status, "bound": bound})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	webSearchCfg, _ := providers["webSearch"].(map[string]any)
	webFetchCfg, _ := providers["webFetch"].(map[string]any)
	webSearchEnabled, _ := webSearchCfg["enabled"].(bool)
	webFetchEnabled, _ := webFetchCfg["enabled"].(bool)
	return map[string]any{
		"providers": providers,
		"webSearch": map[string]any{
			"instanceId": "builtin:web-search", "status": "ready",
			"tenantDefaultEngine": nil, "tenantDefaultEngineName": nil,
			"engines": []map[string]any{
				{"id": "auto", "name": "Zakura Auto", "description": "Automatic engine selection"},
				{"id": "searxng", "name": "SearXNG", "description": "Self-hosted metasearch"},
			},
			"agent": map[string]any{"enabled": webSearchEnabled, "defaultEngine": valueOrNil(webSearchCfg, "defaultEngine")},
		},
		"webFetch": map[string]any{
			"instanceId": "builtin:web-fetch", "status": "ready",
			"tenantDefaultBackend": nil, "tenantDefaultBackendName": nil,
			"backends": []map[string]any{
				{"id": "auto", "name": "Zakura Auto", "description": "Automatic backend selection"},
				{"id": "jina-reader", "name": "Jina Reader", "description": "URL to Markdown"},
			},
			"agent": map[string]any{"enabled": webFetchEnabled, "defaultBackend": valueOrNil(webFetchCfg, "defaultBackend")},
		},
		"mcp": map[string]any{"mode": mode, "exposeWorkspaceFs": exposeWorkspaceFS, "instances": instances},
		"memory": map[string]any{
			"enabled": agent.EnableMemory, "providerId": agent.MemoryProviderID,
			"note": "Long-term memory is isolated to this agent",
		},
	}, nil
}

func valueOrNil(values map[string]any, key string) any {
	if value, ok := values[key]; ok && value != "" {
		return value
	}
	return nil
}

func (h *handler) putAgentProviders(w http.ResponseWriter, r *http.Request) {
	var patch map[string]any
	if json.NewDecoder(r.Body).Decode(&patch) != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	p := principal(r)
	agent, err := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(agent.Config, &cfg)
	providers, _ := cfg["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
	}
	for _, key := range []string{"webSearch", "webFetch", "mcp"} {
		if value, ok := patch[key]; ok {
			providers[key] = value
		}
	}
	cfg["providers"] = providers
	agentPatch := map[string]any{"config": cfg}
	if value, ok := patch["enableMemory"]; ok {
		agentPatch["enableMemory"] = value
	}
	if value, ok := patch["memoryProviderId"]; ok {
		agentPatch["memoryProviderId"] = value
	}
	agent, err = h.store.UpdateAgent(r.Context(), p.TenantID, agent.ID, agentPatch)
	if err != nil {
		statusErr(w, err)
		return
	}
	options, err := h.buildAgentProviders(r.Context(), p.TenantID, agent.ID)
	if err != nil {
		statusErr(w, err)
		return
	}
	result := h.agentDTO(r.Context(), p.TenantID, agent)
	result["options"] = options
	httpx.JSON(w, http.StatusOK, result)
}

func (h *handler) startAgent(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, err := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	space, err := h.store.GetSpace(r.Context(), p.TenantID, agent.SpaceID)
	if err != nil {
		statusErr(w, err)
		return
	}
	if space.RuntimeNodeID == nil || *space.RuntimeNodeID == "" {
		httpx.Error(w, http.StatusConflict, "bind a runtime node before starting the workspace")
		return
	}
	runner, err := h.hub.get(*space.RuntimeNodeID)
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE spaces SET workspace_status='starting',last_error=NULL,updated_at=? WHERE tenant_id=? AND id=?`), h.store.now(), p.TenantID, space.ID)
	var mkdir struct {
		Abs string `json:"abs"`
	}
	if err = runner.call(r.Context(), "host.fs.mkdir", map[string]any{"spaceId": space.ID, "path": "/"}, &mkdir); err != nil {
		h.failWorkspaceStart(r.Context(), p.TenantID, space.ID, err)
		httpx.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	if space.EnableComputer && space.WorkspaceKind != "host" {
		image := "sunwuyuan/zakura-workspace-dev:latest"
		if space.WorkspaceImage != nil && strings.TrimSpace(*space.WorkspaceImage) != "" {
			image = *space.WorkspaceImage
		}
		if err = runner.call(r.Context(), "docker.pull", map[string]any{"image": image}, nil); err != nil {
			h.failWorkspaceStart(r.Context(), p.TenantID, space.ID, err)
			httpx.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		var existing []runnerContainer
		_ = runner.call(r.Context(), "docker.list", map[string]any{"label": "zakura.space=" + space.ID}, &existing)
		var running struct {
			DockerID string            `json:"dockerId"`
			Name     string            `json:"name"`
			Image    string            `json:"image"`
			Status   string            `json:"status"`
			Labels   map[string]string `json:"labels"`
			Ports    any               `json:"ports"`
		}
		for _, item := range existing {
			if item.Labels["zakura.purpose"] == "workspace" || item.Labels["zakura.purpose"] == "" {
				running.DockerID, running.Name, running.Image, running.Status = item.DockerID, "zakura-ws-"+slugify(space.Slug), image, "running"
				break
			}
		}
		if running.DockerID == "" {
			err = runner.call(r.Context(), "docker.run", map[string]any{
				"name": "zakura-ws-" + slugify(space.Slug), "image": image,
				"env":     map[string]string{"ZAKURA_SPACE_ID": space.ID},
				"labels":  map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"},
				"volumes": []map[string]any{{"hostPath": mkdir.Abs, "containerPath": "/workspace"}},
				"ports":   []any{}, "workingDir": "/workspace", "restart": "unless-stopped",
			}, &running)
			if err != nil {
				h.failWorkspaceStart(r.Context(), p.TenantID, space.ID, err)
				httpx.Error(w, http.StatusBadGateway, err.Error())
				return
			}
		}
		labels, _ := json.Marshal(map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"})
		ports, _ := json.Marshal(running.Ports)
		if string(ports) == "null" {
			ports = []byte("[]")
		}
		now := h.store.now()
		var managedID string
		scanErr := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id FROM managed_containers WHERE tenant_id=? AND space_id=? AND purpose='workspace' ORDER BY created_at DESC LIMIT 1`), p.TenantID, space.ID).Scan(&managedID)
		if scanErr == nil {
			_, err = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE managed_containers SET docker_id=?,name=?,image=?,status='running',labels_json=?,ports_json=?,runtime_node_id=?,updated_at=? WHERE id=?`), running.DockerID, running.Name, image, string(labels), string(ports), space.RuntimeNodeID, now, managedID)
		} else {
			_, err = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO managed_containers(id,tenant_id,space_id,agent_id,docker_id,name,image,purpose,status,labels_json,ports_json,runtime_node_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'workspace','running',?,?,?, ?,?)`), h.store.id(), p.TenantID, space.ID, agent.ID, running.DockerID, running.Name, image, string(labels), string(ports), space.RuntimeNodeID, now, now)
		}
		if err != nil {
			statusErr(w, err)
			return
		}
	}
	_, err = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE spaces SET workspace_status='running',last_error=NULL,updated_at=? WHERE tenant_id=? AND id=?`), h.store.now(), p.TenantID, space.ID)
	if err != nil {
		statusErr(w, err)
		return
	}
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE component_instances SET status='running',last_error=NULL,updated_at=? WHERE tenant_id=? AND id IN (SELECT instance_id FROM agent_bindings WHERE agent_id=?)`), h.store.now(), p.TenantID, agent.ID)
	agent, _ = h.store.GetAgent(r.Context(), p.TenantID, agent.ID)
	result := h.agentDTO(r.Context(), p.TenantID, agent)
	result["starting"] = true
	httpx.JSON(w, http.StatusOK, result)
}

func (h *handler) failWorkspaceStart(ctx context.Context, tenant, spaceID string, cause error) {
	message := cause.Error()
	_, _ = h.deps.DB.ExecContext(context.WithoutCancel(ctx), h.store.q(`UPDATE spaces SET workspace_status='error',last_error=?,updated_at=? WHERE tenant_id=? AND id=?`), message, h.store.now(), tenant, spaceID)
}

func (h *handler) stopAgent(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, err := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	space, err := h.store.GetSpace(r.Context(), p.TenantID, agent.SpaceID)
	if err != nil {
		statusErr(w, err)
		return
	}
	if space.RuntimeNodeID != nil && space.WorkspaceKind != "host" {
		if runner, hubErr := h.hub.get(*space.RuntimeNodeID); hubErr == nil {
			var dockerID string
			if h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT docker_id FROM managed_containers WHERE tenant_id=? AND space_id=? AND purpose='workspace' ORDER BY created_at DESC LIMIT 1`), p.TenantID, space.ID).Scan(&dockerID) == nil && dockerID != "" {
				if err = runner.call(r.Context(), "docker.stop", map[string]any{"id": dockerID, "remove": false}, nil); err != nil {
					httpx.Error(w, http.StatusBadGateway, err.Error())
					return
				}
			}
		}
	}
	now := h.store.now()
	_, err = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE spaces SET workspace_status='stopped',updated_at=? WHERE tenant_id=? AND id=?`), now, p.TenantID, space.ID)
	if err != nil {
		statusErr(w, err)
		return
	}
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE managed_containers SET status='stopped',updated_at=? WHERE tenant_id=? AND space_id=? AND purpose='workspace'`), now, p.TenantID, space.ID)
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE component_instances SET status='stopped',updated_at=? WHERE tenant_id=? AND id IN (SELECT instance_id FROM agent_bindings WHERE agent_id=?)`), now, p.TenantID, agent.ID)
	agent, _ = h.store.GetAgent(r.Context(), p.TenantID, agent.ID)
	httpx.JSON(w, http.StatusOK, h.agentDTO(r.Context(), p.TenantID, agent))
}

func (h *handler) agentProgress(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, err := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	space, err := h.store.GetSpace(r.Context(), p.TenantID, agent.SpaceID)
	if err != nil {
		statusErr(w, err)
		return
	}
	workspaceStatus := space.WorkspaceStatus
	if workspaceStatus == "" {
		if space.EnableComputer {
			workspaceStatus = "idle"
		} else {
			workspaceStatus = "none"
		}
	}
	var dockerID, image sql.NullString
	var containerStatus sql.NullString
	err = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT docker_id,image,status FROM managed_containers WHERE tenant_id=? AND space_id=? ORDER BY created_at DESC LIMIT 1`), p.TenantID, space.ID).Scan(&dockerID, &image, &containerStatus)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		statusErr(w, err)
		return
	}
	if containerStatus.Valid {
		workspaceStatus = containerStatus.String
	}
	workspaceImage := any(nil)
	if image.Valid {
		workspaceImage = image.String
	} else if space.WorkspaceImage != nil {
		workspaceImage = *space.WorkspaceImage
	}
	phase := "idle"
	running := workspaceStatus == "starting"
	done := workspaceStatus == "running"
	if running {
		phase = "starting"
	} else if done {
		phase = "ready"
	} else if workspaceStatus == "error" {
		phase = "error"
	}
	percent := 0
	if done {
		percent = 100
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"agent": map[string]any{"id": agent.ID, "lastError": agent.LastError},
		"workspace": map[string]any{
			"status": workspaceStatus, "dockerId": nullableString(dockerID), "image": workspaceImage,
			"running": workspaceStatus == "running",
		},
		"progress": map[string]any{
			"agentId": agent.ID, "phase": phase, "percent": percent, "running": running,
			"done": done, "error": agent.LastError, "events": []any{}, "updatedAt": h.store.now().UnixMilli(),
		},
	})
}

func nullableString(value sql.NullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}

func dockerHTTP() (*http.Client, error) {
	sock := os.Getenv("DOCKER_HOST")
	if sock == "" {
		sock = "/var/run/docker.sock"
	} else {
		sock = strings.TrimPrefix(sock, "unix://")
	}
	if _, e := os.Stat(sock); e != nil {
		return nil, e
	}
	tr := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", sock)
	}}
	return &http.Client{Transport: tr, Timeout: 2 * time.Minute}, nil
}
func dockerCall(ctx context.Context, method, path string, body any) ([]byte, int, error) {
	client, e := dockerHTTP()
	if e != nil {
		return nil, 0, e
	}
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, _ := http.NewRequestWithContext(ctx, method, "http://docker"+path, reader)
	req.Header.Set("Content-Type", "application/json")
	resp, e := client.Do(req)
	if e != nil {
		return nil, 0, e
	}
	defer resp.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if e != nil {
		return nil, resp.StatusCode, e
	}
	if resp.StatusCode >= 400 {
		return raw, resp.StatusCode, fmt.Errorf("docker status %d: %s", resp.StatusCode, string(raw))
	}
	return raw, resp.StatusCode, nil
}
func (h *handler) listContainers(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,instance_id,space_id,agent_id,docker_id,name,image,purpose,status,labels_json,ports_json,allocated_to,runtime_node_id,created_at,updated_at FROM managed_containers WHERE tenant_id=? ORDER BY created_at DESC`), principal(r).TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, name, image, purpose, status, labels, ports, c, u string
		var instance, space, agent, dockerID, allocated, node *string
		if rows.Scan(&id, &instance, &space, &agent, &dockerID, &name, &image, &purpose, &status, &labels, &ports, &allocated, &node, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "instanceId": instance, "spaceId": space, "agentId": agent, "dockerId": dockerID, "name": name, "image": image, "purpose": purpose, "status": status, "labels": json.RawMessage(labels), "ports": json.RawMessage(ports), "allocatedTo": allocated, "runtimeNodeId": node, "createdAt": c, "updatedAt": u})
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}
func (h *handler) allocateContainer(w http.ResponseWriter, r *http.Request) {
	var b struct {
		InstanceID, SpaceID, AgentID *string
		RuntimeNodeID                *string `json:"runtimeNodeId"`
		Name, Image, Purpose         string
		Labels                       map[string]string
		Env                          map[string]string
		Command                      []string
		AllocatedTo                  string `json:"allocatedTo"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Image == "" {
		httpx.Error(w, 400, "image required")
		return
	}
	if b.Name == "" {
		b.Name = "zakura-" + strings.ToLower(h.store.id())
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`).MatchString(b.Name) {
		httpx.Error(w, 400, "invalid container name")
		return
	}
	p := principal(r)
	if b.RuntimeNodeID == nil || *b.RuntimeNodeID == "" {
		if b.SpaceID != nil {
			_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT runtime_node_id FROM spaces WHERE tenant_id=? AND id=?`), p.TenantID, *b.SpaceID).Scan(&b.RuntimeNodeID)
		} else if b.AgentID != nil {
			_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT s.runtime_node_id FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.id=?`), p.TenantID, *b.AgentID).Scan(&b.RuntimeNodeID)
		}
	}
	if b.RuntimeNodeID == nil || *b.RuntimeNodeID == "" {
		httpx.Error(w, http.StatusConflict, "runtimeNodeId is required")
		return
	}
	runner, e := h.hub.get(*b.RuntimeNodeID)
	if e != nil {
		httpx.Error(w, http.StatusServiceUnavailable, e.Error())
		return
	}
	if e = runner.call(r.Context(), "docker.pull", map[string]any{"image": b.Image}, nil); e != nil {
		httpx.Error(w, http.StatusBadGateway, e.Error())
		return
	}
	var created struct {
		DockerID string            `json:"dockerId"`
		Name     string            `json:"name"`
		Image    string            `json:"image"`
		Status   string            `json:"status"`
		Labels   map[string]string `json:"labels"`
		Ports    any               `json:"ports"`
	}
	e = runner.call(r.Context(), "docker.run", map[string]any{"name": b.Name, "image": b.Image, "command": b.Command, "env": b.Env, "labels": b.Labels}, &created)
	if e != nil || created.DockerID == "" {
		if e == nil {
			e = errors.New("runner returned no container ID")
		}
		httpx.Error(w, http.StatusBadGateway, e.Error())
		return
	}
	labels, _ := json.Marshal(b.Labels)
	ports, _ := json.Marshal(created.Ports)
	if string(ports) == "null" {
		ports = []byte("[]")
	}
	now := h.store.now()
	id := h.store.id()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO managed_containers(id,tenant_id,instance_id,space_id,agent_id,docker_id,name,image,purpose,status,labels_json,ports_json,env_enc,allocated_to,runtime_node_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'running',?,?,NULL,?,?,?,?)`), id, p.TenantID, b.InstanceID, b.SpaceID, b.AgentID, created.DockerID, b.Name, b.Image, b.Purpose, string(labels), string(ports), nullString(b.AllocatedTo), b.RuntimeNodeID, now, now)
	if e != nil {
		_ = runner.call(context.WithoutCancel(r.Context()), "docker.stop", map[string]any{"id": created.DockerID, "remove": true}, nil)
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": id, "dockerId": created.DockerID, "name": b.Name, "image": b.Image, "purpose": b.Purpose, "status": "running", "labelsJson": string(labels), "portsJson": string(ports), "runtimeNodeId": b.RuntimeNodeID, "createdAt": now, "updatedAt": now})
}
func (h *handler) stopContainer(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var dockerID, nodeID string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT docker_id,runtime_node_id FROM managed_containers WHERE tenant_id=? AND id=?`), p.TenantID, chi.URLParam(r, "id")).Scan(&dockerID, &nodeID)
	if e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	runner, e := h.hub.get(nodeID)
	if e != nil {
		httpx.Error(w, http.StatusServiceUnavailable, e.Error())
		return
	}
	var body struct {
		Remove *bool `json:"remove"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	remove := true
	if body.Remove != nil {
		remove = *body.Remove
	}
	if e = runner.call(r.Context(), "docker.stop", map[string]any{"id": dockerID, "remove": remove}, nil); e != nil {
		httpx.Error(w, http.StatusBadGateway, e.Error())
		return
	}
	status := "stopped"
	if remove {
		status = "removed"
	}
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE managed_containers SET status=?,docker_id=CASE WHEN ? THEN NULL ELSE docker_id END,updated_at=? WHERE tenant_id=? AND id=?`), status, remove, h.store.now(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) containerLogs(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var dockerID, nodeID string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT docker_id,runtime_node_id FROM managed_containers WHERE tenant_id=? AND id=? AND instance_id=?`), p.TenantID, chi.URLParam(r, "containerId"), chi.URLParam(r, "id")).Scan(&dockerID, &nodeID)
	if e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	runner, e := h.hub.get(nodeID)
	if e != nil {
		httpx.Error(w, http.StatusServiceUnavailable, e.Error())
		return
	}
	var result struct {
		Logs string `json:"logs"`
	}
	e = runner.call(r.Context(), "docker.logs", map[string]any{"id": dockerID, "tail": 500}, &result)
	if e != nil {
		httpx.Error(w, http.StatusBadGateway, e.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"logs": result.Logs})
}

var _ = time.Now
