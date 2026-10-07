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

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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
	r.Get("/spaces/{id}/bindings", h.listSpaceBindings)
	r.Post("/spaces/{id}/bindings", h.createSpaceBinding)
	r.Delete("/spaces/{id}/bindings/{instanceId}", h.deleteSpaceBinding)
	r.Get("/spaces/{id}/providers", h.spaceProviders)
	r.Put("/spaces/{id}/providers", h.putSpaceProviders)
	r.Post("/agents/{id}/start", h.startAgent)
	r.Post("/agents/{id}/stop", h.stopAgent)
	r.Get("/agents/{id}/progress", h.agentProgress)
	r.Get("/containers", h.listContainers)
	r.Post("/containers/allocate", h.allocateContainer)
	r.Post("/containers/{id}/stop", h.stopContainer)
	r.Get("/instances/{id}/containers/{containerId}/logs", h.containerLogs)
}
func (h *handler) getInstance(ctx context.Context, tenant, id string) (Instance, error) {
	var c struct {
		ID        string  `gorm:"column:id"`
		AgentID   *string `gorm:"column:agent_id"`
		Type      string  `gorm:"column:component_type"`
		Ref       string  `gorm:"column:component_ref"`
		Name      string  `gorm:"column:name"`
		Config    string  `gorm:"column:config_json"`
		Status    string  `gorm:"column:status"`
		LastError *string `gorm:"column:last_error"`
		CreatedAt string  `gorm:"column:created_at"`
		UpdatedAt string  `gorm:"column:updated_at"`
	}
	e := h.deps.Gorm.WithContext(ctx).Table("component_instances").Select("id,agent_id,component_type,component_ref,name,config_json,status,last_error,created_at,updated_at").Where("tenant_id = ? AND id = ?", tenant, id).Take(&c).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return Instance{}, ErrNotFound
	}
	if e != nil {
		return Instance{}, e
	}
	return Instance{ID: c.ID, AgentID: c.AgentID, Type: c.Type, Ref: c.Ref, Name: c.Name, Config: json.RawMessage(c.Config), Status: c.Status, LastError: c.LastError, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt}, nil
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
	var providerRow struct {
		Name string `gorm:"column:name"`
		Kind string `gorm:"column:kind"`
	}
	if e := h.deps.Gorm.WithContext(ctx).Table("provider_catalog").Select("name, kind").Where("id = ?", instance.Ref).Take(&providerRow).Error; e == nil {
		out["provider"] = map[string]any{"id": instance.Ref, "name": providerRow.Name, "category": providerRow.Kind}
	} else {
		out["provider"] = nil
	}
	var containerRows []struct {
		ID       string  `gorm:"column:id"`
		Name     string  `gorm:"column:name"`
		Image    string  `gorm:"column:image"`
		Status   string  `gorm:"column:status"`
		DockerID *string `gorm:"column:docker_id"`
		Ports    string  `gorm:"column:ports_json"`
	}
	containers := []map[string]any{}
	if err := h.deps.Gorm.WithContext(ctx).Table("managed_containers").Select("id,name,image,status,docker_id,ports_json").Where("tenant_id = ? AND instance_id = ?", tenant, instance.ID).Order("created_at").Find(&containerRows).Error; err == nil {
		for _, cr := range containerRows {
			containers = append(containers, map[string]any{"id": cr.ID, "name": cr.Name, "image": cr.Image, "status": cr.Status, "dockerId": cr.DockerID, "portsJson": cr.Ports})
		}
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
		tool["localName"], tool["qualifiedName"], tool["instanceId"], tool["providerId"] = name, slugify(instance.Ref)+"__"+name, instance.ID, instance.Ref
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
	var rows []struct {
		ID        string  `gorm:"column:id"`
		AgentID   *string `gorm:"column:agent_id"`
		Type      string  `gorm:"column:component_type"`
		Ref       string  `gorm:"column:component_ref"`
		Name      string  `gorm:"column:name"`
		Config    string  `gorm:"column:config_json"`
		Status    string  `gorm:"column:status"`
		LastError *string `gorm:"column:last_error"`
		CreatedAt string  `gorm:"column:created_at"`
		UpdatedAt string  `gorm:"column:updated_at"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("component_instances").Select("id,agent_id,component_type,component_ref,name,config_json,status,last_error,created_at,updated_at").Where("tenant_id = ?", p.TenantID).Order("created_at DESC").Find(&rows).Error; e != nil {
		statusErr(w, e)
		return
	}
	instances := []Instance{}
	for _, c := range rows {
		instances = append(instances, Instance{ID: c.ID, AgentID: c.AgentID, Type: c.Type, Ref: c.Ref, Name: c.Name, Config: json.RawMessage(c.Config), Status: c.Status, LastError: c.LastError, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt})
	}
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
	err := h.deps.Gorm.WithContext(r.Context()).Table("component_instances").Create(map[string]any{"id": id, "tenant_id": p.TenantID, "agent_id": body.AgentID, "component_type": body.Type, "component_ref": body.Ref, "name": body.Name, "config_json": configPlain, "secret_json": string(secretStored), "status": "stopped", "last_error": nil, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error
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
	sets, args = append(sets, "updated_at=?"), append(args, runtimeTimeString(h.store.now()), principal(r).TenantID, chi.URLParam(r, "id"))
	result := h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE component_instances SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`, args...)
	if err := result.Error; err != nil {
		statusErr(w, err)
		return
	}
	if result.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.getInstanceHTTP(w, r)
}

func (h *handler) deleteInstance(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res := h.deps.Gorm.WithContext(r.Context()).Table("component_instances").Where("tenant_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id")).Delete(nil)
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
func (h *handler) setInstanceStatus(ctx context.Context, tenant, id, status string, errText *string) error {
	res := h.deps.Gorm.WithContext(ctx).Table("component_instances").Where("tenant_id = ? AND id = ?", tenant, id).Updates(map[string]any{"status": status, "last_error": errText, "updated_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
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
				var active int64
				_ = h.deps.Gorm.WithContext(ctx).Table("managed_containers").Where("tenant_id = ? AND instance_id = ? AND docker_id IS NOT NULL AND status IN ('created','running')", tenant, instance.ID).Count(&active).Error
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
	var rows []struct {
		ID     string  `gorm:"column:id"`
		Docker *string `gorm:"column:docker_id"`
		Node   *string `gorm:"column:runtime_node_id"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Select("id,docker_id,runtime_node_id").Where("tenant_id = ? AND instance_id = ? AND docker_id IS NOT NULL AND status IN ('created','running')", p.TenantID, instanceID).Find(&rows).Error; e != nil {
		statusErr(w, e)
		return
	}
	type activeContainer struct{ id, docker, node string }
	containers := []activeContainer{}
	for _, item := range rows {
		if item.Docker != nil && item.Node != nil {
			containers = append(containers, activeContainer{id: item.ID, docker: *item.Docker, node: *item.Node})
		}
	}
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
		_ = h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Where("id = ? AND tenant_id = ?", item.id, p.TenantID).Updates(map[string]any{"status": "removed", "docker_id": nil, "updated_at": runtimeTimeString(h.store.now())}).Error
	}
	e := h.setInstanceStatus(r.Context(), p.TenantID, instanceID, "stopped", nil)
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
	var stored []struct {
		ID     string  `gorm:"column:id"`
		Docker *string `gorm:"column:docker_id"`
		Node   *string `gorm:"column:runtime_node_id"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Select("id,docker_id,runtime_node_id").Where("tenant_id = ? AND instance_id = ?", p.TenantID, chi.URLParam(r, "id")).Order("created_at").Find(&stored).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := []map[string]any{}
	for _, item := range stored {
		var live any
		if item.Docker != nil && item.Node != nil {
			if runner, err := h.hub.get(*item.Node); err == nil {
				var inspected map[string]any
				if runner.call(r.Context(), "docker.inspect", map[string]any{"id": *item.Docker}, &inspected) == nil {
					live = inspected
				}
			}
		}
		out = append(out, map[string]any{"id": item.ID, "runtime": live})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"containers": out})
}
func (h *handler) reconcileInstances(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res := h.deps.Gorm.WithContext(r.Context()).Table("component_instances").Where("tenant_id = ? AND status = 'starting' AND updated_at < ?", p.TenantID, runtimeTimeString(h.store.now().Add(-10*time.Minute))).Updates(map[string]any{"status": "stopped", "updated_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	httpx.JSON(w, 200, map[string]any{"reconciled": res.RowsAffected})
}

func (h *handler) listBindings(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	var spaceRow struct {
		SpaceID string `gorm:"column:space_id"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("agents").Select("space_id").Where("tenant_id = ? AND id = ?", p.TenantID, agent).Take(&spaceRow).Error; e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	var rows []struct {
		ID        string `gorm:"column:id"`
		Instance  string `gorm:"column:instance_id"`
		CreatedAt string `gorm:"column:created_at"`
		Name      string `gorm:"column:name"`
		Type      string `gorm:"column:component_type"`
		Status    string `gorm:"column:status"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT b.id,b.instance_id,b.created_at,i.name,i.component_type,i.status FROM agent_bindings b JOIN component_instances i ON i.id=b.instance_id WHERE b.tenant_id=? AND b.space_id=? ORDER BY b.created_at`, p.TenantID, spaceRow.SpaceID).Scan(&rows).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0, len(rows))
	for _, item := range rows {
		out = append(out, map[string]any{"id": item.ID, "instanceId": item.Instance, "createdAt": item.CreatedAt, "name": item.Name, "type": item.Type, "status": item.Status})
	}
	httpx.JSON(w, http.StatusOK, out)
}
func (h *handler) upsertSpaceBinding(ctx context.Context, tenant, spaceID, instanceID string) (string, error) {
	var count int64
	if e := h.deps.Gorm.WithContext(ctx).Table("component_instances").Where("tenant_id = ? AND id = ?", tenant, instanceID).Count(&count).Error; e != nil || count == 0 {
		return "", ErrNotFound
	}
	id := h.store.id()
	e := h.deps.Gorm.WithContext(ctx).Table("agent_bindings").
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "space_id"}, {Name: "instance_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"agent_id"}),
		}).
		Create(map[string]any{"id": id, "tenant_id": tenant, "space_id": spaceID, "agent_id": nil, "instance_id": instanceID, "created_at": runtimeTimeString(h.store.now())}).Error
	if e != nil {
		return "", e
	}
	return id, nil
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
	agent, err := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	id, err := h.upsertSpaceBinding(r.Context(), p.TenantID, agent.SpaceID, b.InstanceID)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": id, "instanceId": b.InstanceID, "agentId": agent.ID, "spaceId": agent.SpaceID, "createdAt": h.store.now()})
}
func (h *handler) deleteBinding(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, err := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	res := h.deps.Gorm.WithContext(r.Context()).Table("agent_bindings").Where("tenant_id = ? AND space_id = ? AND instance_id = ?", p.TenantID, agent.SpaceID, chi.URLParam(r, "instanceId")).Delete(nil)
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
func (h *handler) listSpaceBindings(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if _, err := h.store.GetSpace(r.Context(), p.TenantID, chi.URLParam(r, "id")); err != nil {
		statusErr(w, err)
		return
	}
	var rows []struct {
		ID        string `gorm:"column:id"`
		Instance  string `gorm:"column:instance_id"`
		CreatedAt string `gorm:"column:created_at"`
		Name      string `gorm:"column:name"`
		Type      string `gorm:"column:component_type"`
		Status    string `gorm:"column:status"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT b.id,b.instance_id,b.created_at,i.name,i.component_type,i.status FROM agent_bindings b JOIN component_instances i ON i.id=b.instance_id WHERE b.tenant_id=? AND b.space_id=? ORDER BY b.created_at`, p.TenantID, chi.URLParam(r, "id")).Scan(&rows).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0, len(rows))
	for _, item := range rows {
		out = append(out, map[string]any{"id": item.ID, "instanceId": item.Instance, "createdAt": item.CreatedAt, "name": item.Name, "type": item.Type, "status": item.Status})
	}
	httpx.JSON(w, http.StatusOK, out)
}
func (h *handler) createSpaceBinding(w http.ResponseWriter, r *http.Request) {
	var b struct {
		InstanceID string `json:"instanceId"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.InstanceID == "" {
		httpx.Error(w, 400, "instanceId required")
		return
	}
	p := principal(r)
	space, err := h.store.GetSpace(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	id, err := h.upsertSpaceBinding(r.Context(), p.TenantID, space.ID, b.InstanceID)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": id, "instanceId": b.InstanceID, "agentId": nil, "spaceId": space.ID, "createdAt": h.store.now()})
}
func (h *handler) deleteSpaceBinding(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res := h.deps.Gorm.WithContext(r.Context()).Table("agent_bindings").Where("tenant_id = ? AND space_id = ? AND instance_id = ?", p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "instanceId")).Delete(nil)
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
	spaceCfg := map[string]any{}
	if space, e := h.store.GetSpace(ctx, tenant, agent.SpaceID); e == nil {
		_ = json.Unmarshal(space.Config, &spaceCfg)
	}
	spaceProviders, _ := spaceCfg["providers"].(map[string]any)
	mcpCfg, _ := spaceProviders["mcp"].(map[string]any)
	mode, _ := mcpCfg["mode"].(string)
	if mode != "selected" {
		mode = "all"
	}
	exposeWorkspaceFS, ok := mcpCfg["exposeWorkspaceFs"].(bool)
	if !ok {
		exposeWorkspaceFS = true
	}
	var rows []struct {
		ID     string `gorm:"column:id"`
		Name   string `gorm:"column:name"`
		Slug   string `gorm:"column:component_ref"`
		Status string `gorm:"column:status"`
		Bound  bool   `gorm:"column:bound"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Raw(`SELECT i.id,i.name,i.component_ref,i.status,CASE WHEN b.id IS NULL THEN false ELSE true END AS bound FROM component_instances i LEFT JOIN agent_bindings b ON b.instance_id=i.id AND b.space_id=? AND b.agent_id IS NULL WHERE i.tenant_id=? AND i.component_type='mcp' ORDER BY i.name`, agent.SpaceID, tenant).Scan(&rows).Error; err != nil {
		return nil, err
	}
	instances := []map[string]any{}
	for _, item := range rows {
		instances = append(instances, map[string]any{"id": item.ID, "name": item.Name, "slug": item.Slug, "providerId": item.Slug, "status": item.Status, "bound": item.Bound})
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
	columns := map[string]any{}
	if value, ok := patch["enableMemory"]; ok {
		columns["enable_memory"] = value
	}
	if value, ok := patch["memoryProviderId"]; ok {
		columns["memory_provider_id"] = value
	}
	agent, err := h.store.updateAgentConfig(r.Context(), p.TenantID, chi.URLParam(r, "id"), columns, func(cfg map[string]any) error {
		providers, _ := cfg["providers"].(map[string]any)
		if providers == nil {
			providers = map[string]any{}
		}
		for _, key := range []string{"webSearch", "webFetch"} {
			if value, ok := patch[key]; ok {
				providers[key] = value
			}
		}
		cfg["providers"] = providers
		return nil
	})
	if err != nil {
		statusErr(w, err)
		return
	}
	if value, ok := patch["mcp"]; ok {
		if err := h.mergeSpaceMCPProviders(r.Context(), p.TenantID, agent.SpaceID, value); err != nil {
			statusErr(w, err)
			return
		}
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

func (h *handler) mergeSpaceMCPProviders(ctx context.Context, tenant, spaceID string, mcp any) error {
	space, err := h.store.GetSpace(ctx, tenant, spaceID)
	if err != nil {
		return err
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(space.Config, &cfg)
	providers, _ := cfg["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
	}
	providers["mcp"] = mcp
	cfg["providers"] = providers
	_, err = h.store.UpdateSpace(ctx, tenant, spaceID, map[string]any{"config": cfg})
	return err
}

func (h *handler) buildSpaceProviders(ctx context.Context, tenant, spaceID string) (map[string]any, error) {
	space, err := h.store.GetSpace(ctx, tenant, spaceID)
	if err != nil {
		return nil, err
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(space.Config, &cfg)
	providers, _ := cfg["providers"].(map[string]any)
	mcpCfg, _ := providers["mcp"].(map[string]any)
	mode, _ := mcpCfg["mode"].(string)
	if mode != "selected" {
		mode = "all"
	}
	exposeWorkspaceFS, ok := mcpCfg["exposeWorkspaceFs"].(bool)
	if !ok {
		exposeWorkspaceFS = true
	}
	var rows []struct {
		ID     string `gorm:"column:id"`
		Name   string `gorm:"column:name"`
		Slug   string `gorm:"column:component_ref"`
		Status string `gorm:"column:status"`
		Bound  bool   `gorm:"column:bound"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Raw(`SELECT i.id,i.name,i.component_ref,i.status,CASE WHEN b.id IS NULL THEN false ELSE true END AS bound FROM component_instances i LEFT JOIN agent_bindings b ON b.instance_id=i.id AND b.space_id=? AND b.agent_id IS NULL WHERE i.tenant_id=? AND i.component_type='mcp' ORDER BY i.name`, spaceID, tenant).Scan(&rows).Error; err != nil {
		return nil, err
	}
	instances := []map[string]any{}
	for _, item := range rows {
		instances = append(instances, map[string]any{"id": item.ID, "name": item.Name, "slug": item.Slug, "providerId": item.Slug, "status": item.Status, "bound": item.Bound})
	}
	return map[string]any{"mcp": map[string]any{"mode": mode, "exposeWorkspaceFs": exposeWorkspaceFS, "instances": instances}}, nil
}

func (h *handler) spaceProviders(w http.ResponseWriter, r *http.Request) {
	options, err := h.buildSpaceProviders(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, options)
}

func (h *handler) putSpaceProviders(w http.ResponseWriter, r *http.Request) {
	var patch map[string]any
	if json.NewDecoder(r.Body).Decode(&patch) != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	p := principal(r)
	space, err := h.store.GetSpace(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	if value, ok := patch["mcp"]; ok {
		if err = h.mergeSpaceMCPProviders(r.Context(), p.TenantID, space.ID, value); err != nil {
			statusErr(w, err)
			return
		}
	}
	options, err := h.buildSpaceProviders(r.Context(), p.TenantID, space.ID)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, options)
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
	_ = h.deps.Gorm.WithContext(r.Context()).Table("spaces").Where("tenant_id = ? AND id = ?", p.TenantID, space.ID).Updates(map[string]any{"workspace_status": "starting", "last_error": nil, "updated_at": runtimeTimeString(h.store.now())}).Error
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
		var managedRow struct {
			ID string `gorm:"column:id"`
		}
		g := h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Select("id").Where("tenant_id = ? AND space_id = ? AND purpose = 'workspace'", p.TenantID, space.ID).Order("created_at DESC").Limit(1)
		if e := g.Take(&managedRow).Error; e == nil {
			err = h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Where("id = ?", managedRow.ID).Updates(map[string]any{"docker_id": running.DockerID, "name": running.Name, "image": image, "status": "running", "labels_json": string(labels), "ports_json": string(ports), "runtime_node_id": space.RuntimeNodeID, "updated_at": runtimeTimeString(now)}).Error
		} else {
			err = h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Create(map[string]any{"id": h.store.id(), "tenant_id": p.TenantID, "space_id": space.ID, "agent_id": agent.ID, "docker_id": running.DockerID, "name": running.Name, "image": image, "purpose": "workspace", "status": "running", "labels_json": string(labels), "ports_json": string(ports), "runtime_node_id": space.RuntimeNodeID, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error
		}
		if err != nil {
			statusErr(w, err)
			return
		}
	}
	if err = h.deps.Gorm.WithContext(r.Context()).Table("spaces").Where("tenant_id = ? AND id = ?", p.TenantID, space.ID).Updates(map[string]any{"workspace_status": "running", "last_error": nil, "updated_at": runtimeTimeString(h.store.now())}).Error; err != nil {
		statusErr(w, err)
		return
	}
	_ = h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE component_instances SET status='running',last_error=NULL,updated_at=? WHERE tenant_id=? AND id IN (SELECT instance_id FROM agent_bindings WHERE space_id=? AND agent_id IS NULL)`, runtimeTimeString(h.store.now()), p.TenantID, agent.SpaceID).Error
	agent, _ = h.store.GetAgent(r.Context(), p.TenantID, agent.ID)
	result := h.agentDTO(r.Context(), p.TenantID, agent)
	result["starting"] = true
	httpx.JSON(w, http.StatusOK, result)
}

func (h *handler) failWorkspaceStart(ctx context.Context, tenant, spaceID string, cause error) {
	message := cause.Error()
	_ = h.deps.Gorm.WithContext(context.WithoutCancel(ctx)).Table("spaces").Where("tenant_id = ? AND id = ?", tenant, spaceID).Updates(map[string]any{"workspace_status": "error", "last_error": message, "updated_at": runtimeTimeString(h.store.now())}).Error
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
			var containerRow struct {
				DockerID *string `gorm:"column:docker_id"`
			}
			if e := h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Select("docker_id").Where("tenant_id = ? AND space_id = ? AND purpose = 'workspace'", p.TenantID, space.ID).Order("created_at DESC").Limit(1).Take(&containerRow).Error; e == nil && containerRow.DockerID != nil && *containerRow.DockerID != "" {
				if err = runner.call(r.Context(), "docker.stop", map[string]any{"id": *containerRow.DockerID, "remove": false}, nil); err != nil {
					httpx.Error(w, http.StatusBadGateway, err.Error())
					return
				}
			}
		}
	}
	now := h.store.now()
	if err = h.deps.Gorm.WithContext(r.Context()).Table("spaces").Where("tenant_id = ? AND id = ?", p.TenantID, space.ID).Updates(map[string]any{"workspace_status": "stopped", "updated_at": runtimeTimeString(now)}).Error; err != nil {
		statusErr(w, err)
		return
	}
	_ = h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Where("tenant_id = ? AND space_id = ? AND purpose = 'workspace'", p.TenantID, space.ID).Updates(map[string]any{"status": "stopped", "updated_at": runtimeTimeString(now)}).Error
	_ = h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE component_instances SET status='stopped',updated_at=? WHERE tenant_id=? AND id IN (SELECT instance_id FROM agent_bindings WHERE space_id=? AND agent_id IS NULL)`, runtimeTimeString(now), p.TenantID, agent.SpaceID).Error
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
	var containerRow struct {
		DockerID *string `gorm:"column:docker_id"`
		Image    *string `gorm:"column:image"`
		Status   *string `gorm:"column:status"`
	}
	err = h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Select("docker_id,image,status").Where("tenant_id = ? AND space_id = ?", p.TenantID, space.ID).Order("created_at DESC").Limit(1).Take(&containerRow).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		statusErr(w, err)
		return
	}
	if containerRow.Status != nil {
		workspaceStatus = *containerRow.Status
	}
	workspaceImage := any(nil)
	if containerRow.Image != nil {
		workspaceImage = *containerRow.Image
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
			"status": workspaceStatus, "dockerId": containerRow.DockerID, "image": workspaceImage,
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
	var rows []struct {
		ID        string  `gorm:"column:id"`
		Instance  *string `gorm:"column:instance_id"`
		Space     *string `gorm:"column:space_id"`
		Agent     *string `gorm:"column:agent_id"`
		DockerID  *string `gorm:"column:docker_id"`
		Name      string  `gorm:"column:name"`
		Image     string  `gorm:"column:image"`
		Purpose   string  `gorm:"column:purpose"`
		Status    string  `gorm:"column:status"`
		Labels    string  `gorm:"column:labels_json"`
		Ports     string  `gorm:"column:ports_json"`
		Allocated *string `gorm:"column:allocated_to"`
		Node      *string `gorm:"column:runtime_node_id"`
		CreatedAt string  `gorm:"column:created_at"`
		UpdatedAt string  `gorm:"column:updated_at"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Select("id,instance_id,space_id,agent_id,docker_id,name,image,purpose,status,labels_json,ports_json,allocated_to,runtime_node_id,created_at,updated_at").Where("tenant_id = ?", principal(r).TenantID).Order("created_at DESC").Find(&rows).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0, len(rows))
	for _, c := range rows {
		out = append(out, map[string]any{"id": c.ID, "instanceId": c.Instance, "spaceId": c.Space, "agentId": c.Agent, "dockerId": c.DockerID, "name": c.Name, "image": c.Image, "purpose": c.Purpose, "status": c.Status, "labels": json.RawMessage(c.Labels), "ports": json.RawMessage(c.Ports), "allocatedTo": c.Allocated, "runtimeNodeId": c.Node, "createdAt": c.CreatedAt, "updatedAt": c.UpdatedAt})
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
		var nodeRow struct {
			NodeID *string `gorm:"column:runtime_node_id"`
		}
		if b.SpaceID != nil {
			_ = h.deps.Gorm.WithContext(r.Context()).Table("spaces").Select("runtime_node_id").Where("tenant_id = ? AND id = ?", p.TenantID, *b.SpaceID).Take(&nodeRow).Error
		} else if b.AgentID != nil {
			_ = h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT s.runtime_node_id FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.id=?`, p.TenantID, *b.AgentID).Scan(&nodeRow).Error
		}
		b.RuntimeNodeID = nodeRow.NodeID
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
	e = h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Create(map[string]any{"id": id, "tenant_id": p.TenantID, "instance_id": b.InstanceID, "space_id": b.SpaceID, "agent_id": b.AgentID, "docker_id": created.DockerID, "name": b.Name, "image": b.Image, "purpose": b.Purpose, "status": "running", "labels_json": string(labels), "ports_json": string(ports), "env_enc": nil, "allocated_to": nullString(b.AllocatedTo), "runtime_node_id": b.RuntimeNodeID, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error
	if e != nil {
		_ = runner.call(context.WithoutCancel(r.Context()), "docker.stop", map[string]any{"id": created.DockerID, "remove": true}, nil)
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": id, "dockerId": created.DockerID, "name": b.Name, "image": b.Image, "purpose": b.Purpose, "status": "running", "labelsJson": string(labels), "portsJson": string(ports), "runtimeNodeId": b.RuntimeNodeID, "createdAt": now, "updatedAt": now})
}
func (h *handler) stopContainer(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var row struct {
		DockerID string `gorm:"column:docker_id"`
		NodeID   string `gorm:"column:runtime_node_id"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Select("docker_id,runtime_node_id").Where("tenant_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id")).Take(&row).Error
	if e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	dockerID, nodeID := row.DockerID, row.NodeID
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
	e = h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE managed_containers SET status=?,docker_id=CASE WHEN ? THEN NULL ELSE docker_id END,updated_at=? WHERE tenant_id=? AND id=?`, status, remove, runtimeTimeString(h.store.now()), p.TenantID, chi.URLParam(r, "id")).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) containerLogs(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var row struct {
		DockerID string `gorm:"column:docker_id"`
		NodeID   string `gorm:"column:runtime_node_id"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Select("docker_id,runtime_node_id").Where("tenant_id = ? AND id = ? AND instance_id = ?", p.TenantID, chi.URLParam(r, "containerId"), chi.URLParam(r, "id")).Take(&row).Error
	if e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	runner, e := h.hub.get(row.NodeID)
	if e != nil {
		httpx.Error(w, http.StatusServiceUnavailable, e.Error())
		return
	}
	var result struct {
		Logs string `json:"logs"`
	}
	e = runner.call(r.Context(), "docker.logs", map[string]any{"id": row.DockerID, "tail": 500}, &result)
	if e != nil {
		httpx.Error(w, http.StatusBadGateway, e.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"logs": result.Logs})
}

var _ = time.Now
