// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

// MCP scope is explicit even for dashboard calls. A bound credential cannot
// supply another Agent (or silently widen itself to the whole Space).
func (h *handler) authorizeMCPScope(ctx context.Context, p httpx.Principal, space, agent string) (string, string, error) {
	if agent == "" && p.AgentID != "" {
		agent = p.AgentID
	}
	if space == "" {
		space = p.SpaceID
	}
	if agent != "" {
		a, err := h.store.GetAgent(ctx, p.TenantID, agent)
		if err != nil || space != "" && space != a.SpaceID {
			return "", "", ErrNotFound
		}
		space = a.SpaceID
	}
	if err := httpx.AuthorizeResource(ctx, h.deps, p, space, agent); err != nil {
		return "", "", ErrNotFound
	}
	return space, agent, nil
}

// The canonical owner is independent of consumers and chat computer selection.
// Legacy rows may be adopted only when their ownership is unambiguous.
func (h *handler) mcpOwnerSpace(ctx context.Context, inst mcpInstance) (string, error) {
	var cfg struct {
		Owner   string `json:"ownerSpaceId"`
		Data    string `json:"dataSpaceId"`
		Command string `json:"command"`
	}
	if json.Unmarshal(inst.Config, &cfg) != nil {
		return "", errors.New("invalid MCP configuration")
	}
	if cfg.Command == "" {
		return cfg.Owner, nil
	}
	var spaces []string
	if err := h.deps.Gorm.WithContext(ctx).Table("agent_bindings").Where("tenant_id=? AND instance_id=?", inst.TenantID, inst.ID).Distinct().Pluck("space_id", &spaces).Error; err != nil {
		return "", err
	}
	if inst.AgentID != nil && *inst.AgentID != "" {
		a, err := h.store.GetAgent(ctx, inst.TenantID, *inst.AgentID)
		if err != nil {
			return "", err
		}
		spaces = append(spaces, a.SpaceID)
	}
	if cfg.Data != "" {
		spaces = append(spaces, cfg.Data)
	}
	spaces = uniqueStrings(spaces)
	if cfg.Owner == "" {
		if len(spaces) != 1 {
			return "", errors.New("legacy stdio MCP has conflicting or missing owning Spaces; explicitly select one owner before starting")
		}
		cfg.Owner = spaces[0]
	}
	for _, s := range spaces {
		if s != cfg.Owner {
			return "", errors.New("stdio MCP cannot have multiple owning Spaces; remove conflicting legacy bindings")
		}
	}
	if _, err := h.store.GetSpace(ctx, inst.TenantID, cfg.Owner); err != nil {
		return "", err
	}
	return cfg.Owner, nil
}

// ValidateMCPBinding is shared by compatibility binding/provider handlers. A
// remote HTTP instance can have explicit consumers; a stdio install cannot.
func (h *handler) ValidateMCPBinding(ctx context.Context, tenant, space, id string) error {
	inst, err := h.getMCPInstance(ctx, tenant, id)
	if err != nil {
		return err
	}
	if _, err = h.store.GetSpace(ctx, tenant, space); err != nil {
		return err
	}
	if _, stdio := stdioBodyFromConfig(inst.Config); stdio {
		owner, e := h.mcpOwnerSpace(ctx, inst)
		if e != nil {
			return e
		}
		if owner != space {
			return errors.New("stdio MCP belongs to a different Space")
		}
	}
	return nil
}

type mcpPolicies []map[string]any

func (h *handler) effectiveMCPPolicies(ctx context.Context, tenant, agent, space string) (mcpPolicies, error) {
	var rows []struct {
		PolicyJSON string `gorm:"column:policy_json"`
	}
	err := h.deps.Gorm.WithContext(ctx).Table("mcp_policies").Select("policy_json").Where("tenant_id=? AND ((agent_id IS NULL AND space_id IS NULL) OR (space_id=? AND agent_id IS NULL) OR (agent_id=? AND (space_id IS NULL OR space_id=?)))", tenant, space, agent, space).Order("created_at,id").Find(&rows).Error
	if err != nil {
		return nil, err
	}
	out := mcpPolicies{}
	for _, row := range rows {
		var policy map[string]any
		if json.Unmarshal([]byte(row.PolicyJSON), &policy) != nil {
			return nil, errors.New("invalid MCP policy")
		}
		out = append(out, policy)
	}
	return out, nil
}
func policyListAllows(p map[string]any, key string, names ...string) bool {
	value, exists := p[key]
	if !exists || value == nil {
		return true
	}
	list := mcpStringList(value)
	return listContains(list, names...)
}
func (policies mcpPolicies) instanceAllowed(id string) bool {
	for _, p := range policies {
		if !policyListAllows(p, "instanceIds", id) {
			return false
		}
	}
	return true
}
func (policies mcpPolicies) operationAllowed(inst mcpInstance, method, name string) bool {
	if !policies.instanceAllowed(inst.ID) {
		return false
	}
	field := ""
	switch method {
	case "tools/call":
		field = "tool"
	case "resources/read":
		field = "resource"
	case "prompts/get":
		field = "prompt"
	}
	if field == "" {
		return true
	}
	qualified := slugify(inst.Ref) + "__" + name
	names := []string{name, qualified, "re_" + qualified, "re_" + name, inst.ID + ":" + name}
	for _, p := range policies {
		if !policyListAllows(p, field+"Allowlist", names...) || listContains(mcpStringList(p[field+"Denylist"]), names...) {
			return false
		}
	}
	if method == "tools/call" {
		cfg := map[string]any{}
		_ = json.Unmarshal(inst.Config, &cfg)
		if permissions, ok := cfg["toolPermissions"].(map[string]any); ok {
			if enabled, ok := permissions[name].(bool); ok && !enabled {
				return false
			}
		}
	}
	return true
}

func (h *handler) registerSpaceMCP(r chi.Router) {
	r.Get("/spaces/{spaceId}/mcp/inventory", h.spaceMCPInventory)
	r.Get("/spaces/{spaceId}/mcp/capabilities", h.spaceMCPCapabilities)
}
func (h *handler) spaceMCPInventory(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	space, agent, err := h.authorizeMCPScope(r.Context(), p, chi.URLParam(r, "spaceId"), r.URL.Query().Get("agentId"))
	if err != nil {
		statusErr(w, err)
		return
	}
	policies, err := h.effectiveMCPPolicies(r.Context(), p.TenantID, agent, space)
	if err != nil {
		statusErr(w, err)
		return
	}
	var rows []struct {
		ID        string  `gorm:"column:id"`
		Name      string  `gorm:"column:name"`
		Status    string  `gorm:"column:status"`
		Ref       string  `gorm:"column:component_ref"`
		Config    string  `gorm:"column:config_json"`
		LastError *string `gorm:"column:last_error"`
	}
	err = h.deps.Gorm.WithContext(r.Context()).Table("component_instances i").Select("i.id,i.name,i.status,i.component_ref,i.config_json,i.last_error").Where("i.tenant_id=? AND i.component_type='mcp' AND (i.agent_id IN (SELECT id FROM agents WHERE tenant_id=? AND space_id=?) OR i.id IN (SELECT instance_id FROM agent_bindings WHERE tenant_id=? AND space_id=?))", p.TenantID, p.TenantID, space, p.TenantID, space).Order("i.name,i.id").Find(&rows).Error
	if err != nil {
		statusErr(w, err)
		return
	}
	out := []map[string]any{}
	for _, row := range rows {
		if !policies.instanceAllowed(row.ID) {
			continue
		}
		kind := "http"
		owner := ""
		conflict := ""
		if _, stdio := stdioBodyFromConfig(json.RawMessage(row.Config)); stdio {
			kind = "stdio"
			owner, err = h.mcpOwnerSpace(r.Context(), mcpInstance{ID: row.ID, TenantID: p.TenantID, Config: json.RawMessage(row.Config)})
			if err != nil {
				conflict = err.Error()
			}
		}
		out = append(out, map[string]any{"id": row.ID, "name": row.Name, "slug": row.Ref, "status": row.Status, "kind": kind, "ownerSpaceId": nullString(owner), "ownershipError": nullString(conflict), "lastError": row.LastError})
	}
	httpx.JSON(w, 200, map[string]any{"spaceId": space, "instances": out})
}
func (h *handler) spaceMCPCapabilities(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	space, agent, err := h.authorizeMCPScope(r.Context(), p, chi.URLParam(r, "spaceId"), r.URL.Query().Get("agentId"))
	if err != nil {
		statusErr(w, err)
		return
	}
	inventory, err := h.scopedMCPCapabilities(r.Context(), p, space, agent)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, 200, inventory)
}
func (h *handler) scopedMCPInventory(ctx context.Context, p httpx.Principal, space, agent string) ([]map[string]any, []map[string]any, []map[string]any, []map[string]any, error) {
	inventory, err := h.scopedMCPCapabilities(ctx, p, space, agent)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	return inventory["tools"].([]map[string]any), inventory["resources"].([]map[string]any), inventory["prompts"].([]map[string]any), inventory["resourceTemplates"].([]map[string]any), nil
}
func (h *handler) scopedMCPCapabilities(ctx context.Context, p httpx.Principal, space, agent string) (map[string]any, error) {
	space, agent, err := h.authorizeMCPScope(ctx, p, space, agent)
	if err != nil {
		return nil, err
	}
	r, _ := http.NewRequestWithContext(httpx.WithPrincipal(ctx, mcpScopedPrincipal(p, space, agent)), http.MethodGet, "/internal/mcp/capabilities", nil)
	tools, err := h.exposedMCPTools(r, p, agent, space)
	if err != nil {
		return nil, err
	}
	outTools := []map[string]any{}
	resources := []map[string]any{}
	templates := []map[string]any{}
	prompts := []map[string]any{}
	failures := []map[string]any{}
	for _, item := range tools {
		tool := item.Tool
		tool["qualifiedName"] = item.Name
		tool["localName"] = item.LocalName
		tool["instanceId"] = item.Instance.ID
		tool["providerId"] = item.Instance.Ref
		outTools = append(outTools, tool)
	}
	instances, err := h.accessibleMCPInstances(r, principal(r), space)
	if err != nil {
		return nil, err
	}
	policies, err := h.effectiveMCPPolicies(r.Context(), p.TenantID, agent, space)
	if err != nil {
		return nil, err
	}
	for _, inst := range instances {
		for _, entry := range []struct {
			method, field string
			dest          *[]map[string]any
		}{{"resources/list", "resources", &resources}, {"resources/templates/list", "resourceTemplates", &templates}, {"prompts/list", "prompts", &prompts}} {
			raw, e := h.mcpRPC(r.Context(), inst, entry.method, map[string]any{})
			if e != nil {
				failures = append(failures, map[string]any{"instanceId": inst.ID, "method": entry.method, "error": e.Error()})
				continue
			}
			response := map[string][]map[string]any{}
			if json.Unmarshal(raw, &response) != nil {
				continue
			}
			for _, item := range response[entry.field] {
				if uri, _ := item["uri"].(string); uri != "" {
					if !policies.operationAllowed(inst, "resources/read", uri) {
						continue
					}
					item["uri"] = encodeMCPResourceURI(inst.ID, uri)
				}
				if uri, _ := item["uriTemplate"].(string); uri != "" {
					if !policies.operationAllowed(inst, "resources/read", uri) {
						continue
					}
					item["uriTemplate"] = qualifyMCPResourceTemplate(inst.ID, uri)
				}
				if entry.field == "prompts" {
					local, _ := item["name"].(string)
					if !policies.operationAllowed(inst, "prompts/get", local) {
						continue
					}
					item["localName"] = local
					item["name"] = slugify(inst.Ref) + "__" + local
				}
				item["instanceId"] = inst.ID
				item["providerId"] = inst.Ref
				*entry.dest = append(*entry.dest, item)
			}
		}
	}
	return map[string]any{"spaceId": space, "tools": outTools, "resources": resources, "resourceTemplates": templates, "prompts": prompts, "errors": failures}, nil
}
func mcpScopedPrincipal(p httpx.Principal, space, agent string) httpx.Principal {
	p.SpaceID = space
	p.AgentID = agent
	return p
}
func mcpOperationName(method string, params map[string]any) (string, string) {
	switch method {
	case "resources/read":
		name, _ := params["uri"].(string)
		return method, name
	case "completion/complete":
		ref, _ := params["ref"].(map[string]any)
		kind, _ := ref["type"].(string)
		if kind == "ref/resource" {
			name, _ := ref["uri"].(string)
			return "resources/read", name
		}
		name, _ := ref["name"].(string)
		return "prompts/get", name
	default:
		name, _ := params["name"].(string)
		return method, name
	}
}
func localMCPName(inst mcpInstance, name string) string {
	for _, prefix := range []string{"re_" + slugify(inst.Ref) + "__", slugify(inst.Ref) + "__", inst.ID + ":"} {
		if local, ok := strings.CutPrefix(name, prefix); ok {
			return local
		}
	}
	return name
}
