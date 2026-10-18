// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"net/http"
	"strings"
	"time"
)

const mcpResourceCallTimeout = 3 * time.Second

const mcpResourcePageLimit = 100

func normalizeMCPNamespaceArg(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "mcp__")
	return strings.ToLower(value)
}

func mcpNamespaceKey(value string) string {
	return strings.ReplaceAll(normalizeMCPNamespaceArg(value), "-", "_")
}

func withMCPAgentScope(ctx context.Context, tenant, agent, space string) context.Context {
	actor, _ := httpx.PrincipalFrom(ctx)
	if actor.TenantID == "" {
		actor.TenantID = tenant
	}
	return httpx.WithPrincipal(ctx, mcpScopedPrincipal(actor, space, agent))
}
func (h *handler) mcpAgentContext(ctx context.Context, tenant, agent string) (context.Context, error) {
	a, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return ctx, err
	}
	actor, exists := httpx.PrincipalFrom(ctx)
	if exists {
		if actor.TenantID != tenant {
			return ctx, ErrNotFound
		}
		if _, _, err = h.authorizeMCPScope(ctx, actor, a.SpaceID, agent); err != nil {
			return ctx, err
		}
	}
	return withMCPAgentScope(ctx, tenant, agent, a.SpaceID), nil
}

func (h *handler) runAgentMCPCall(ctx context.Context, tenant, agent string, inst mcpInstance, method string, params map[string]any) (json.RawMessage, error) {
	ctx, err := h.mcpAgentContext(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	actor, _ := httpx.PrincipalFrom(ctx)
	allowed := false
	for _, current := range h.agentMCPInstances(ctx, tenant, agent, actor.SpaceID) {
		if current.ID == inst.ID {
			inst = current
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, ErrNotFound
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/internal/mcp", nil)
	return h.authorizedMCPRPC(req, actor, actor.SpaceID, inst, method, params)
}

func (h *handler) mcpResourceInstances(ctx context.Context, tenant, agent string) []mcpInstance {
	record, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return nil
	}
	ctx = withMCPAgentScope(ctx, tenant, agent, record.SpaceID)
	return h.agentMCPInstances(ctx, tenant, agent, record.SpaceID)
}

func findMCPResourceInstance(instances []mcpInstance, ref string) (mcpInstance, bool) {
	key := mcpNamespaceKey(ref)
	if key == "" {
		return mcpInstance{}, false
	}
	for _, inst := range instances {
		for _, candidate := range []string{inst.Name, inst.Ref, slugify(inst.Name)} {
			if mcpNamespaceKey(candidate) == key {
				return inst, true
			}
		}
	}
	return mcpInstance{}, false
}

func withMCPResourceServer(server string, items []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		entry := make(map[string]any, len(item)+1)
		for key, value := range item {
			entry[key] = value
		}
		entry["server"] = server
		out = append(out, entry)
	}
	return out
}

func (h *handler) mcpResourcePage(ctx context.Context, inst mcpInstance, method, field, cursor string) ([]map[string]any, string, error) {
	params := map[string]any{}
	if cursor != "" {
		params["cursor"] = cursor
	}
	callCtx, cancel := context.WithTimeout(ctx, mcpResourceCallTimeout)
	defer cancel()
	result, err := h.mcpRPC(callCtx, inst, method, params)
	if err != nil {
		return nil, "", err
	}
	listed := map[string]any{}
	if err := json.Unmarshal(result, &listed); err != nil {
		return nil, "", err
	}
	next, _ := listed["nextCursor"].(string)
	actor, _ := httpx.PrincipalFrom(ctx)
	policies, policyErr := h.effectiveMCPPolicies(ctx, inst.TenantID, actor.AgentID, actor.SpaceID)
	if policyErr != nil {
		return nil, "", policyErr
	}
	items := []map[string]any{}
	if raw, ok := listed[field].([]any); ok {
		for _, item := range raw {
			if entry, ok := item.(map[string]any); ok {
				uri, _ := entry["uri"].(string)
				if field == "resourceTemplates" {
					uri, _ = entry["uriTemplate"].(string)
				}
				if !policies.operationAllowed(inst, "resources/read", uri) {
					continue
				}
				items = append(items, entry)
			}
		}
	}
	return items, next, nil
}

func (h *handler) collectMCPResourcePages(ctx context.Context, inst mcpInstance, method, field string) []map[string]any {
	out := []map[string]any{}
	cursor := ""
	for page := 0; page < mcpResourcePageLimit; page++ {
		items, next, err := h.mcpResourcePage(ctx, inst, method, field, cursor)
		if err != nil {
			break
		}
		out = append(out, withMCPResourceServer(inst.Name, items)...)
		if next == "" {
			break
		}
		cursor = next
	}
	return out
}

func (h *handler) runBuiltinToolResources(ctx context.Context, tenant, agent, name string, args map[string]any) (json.RawMessage, error) {
	var raw json.RawMessage
	var err error
	switch name {
	case "list_mcp_resources":
		raw, err = h.runListMCPResources(ctx, tenant, agent, args)
	case "list_mcp_resource_templates":
		raw, err = h.runListMCPResourceTemplates(ctx, tenant, agent, args)
	case "read_mcp_resource":
		raw, err = h.runReadMCPResource(ctx, tenant, agent, args)
	default:
		return nil, fmt.Errorf("unknown builtin tool %q", name)
	}
	if err != nil {
		return nil, err
	}
	return h.capToolResultJSON(ctx, tenant, agent, raw, name), nil
}

func (h *handler) runListMCPResources(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	var scopeErr error
	ctx, scopeErr = h.mcpAgentContext(ctx, tenant, agent)
	if scopeErr != nil {
		return nil, scopeErr
	}
	instances := h.mcpResourceInstances(ctx, tenant, agent)
	serverArg := strings.TrimSpace(builtinStringArg(args, "server"))
	cursor := strings.TrimSpace(builtinStringArg(args, "cursor"))
	if serverArg != "" {
		inst, ok := findMCPResourceInstance(instances, serverArg)
		if !ok {
			return nil, fmt.Errorf("unknown MCP server %q", serverArg)
		}
		items, next, err := h.mcpResourcePage(ctx, inst, "resources/list", "resources", cursor)
		if err != nil {
			return nil, err
		}
		out := map[string]any{"server": inst.Name, "resources": withMCPResourceServer(inst.Name, items)}
		if next != "" {
			out["nextCursor"] = next
		}
		return builtinJSON(out)
	}
	if cursor != "" {
		return nil, errors.New("cursor can only be used when a server is specified")
	}
	resources := []map[string]any{}
	for _, inst := range instances {
		resources = append(resources, h.collectMCPResourcePages(ctx, inst, "resources/list", "resources")...)
	}
	return builtinJSON(map[string]any{"resources": resources})
}

func (h *handler) runListMCPResourceTemplates(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	var scopeErr error
	ctx, scopeErr = h.mcpAgentContext(ctx, tenant, agent)
	if scopeErr != nil {
		return nil, scopeErr
	}
	instances := h.mcpResourceInstances(ctx, tenant, agent)
	serverArg := strings.TrimSpace(builtinStringArg(args, "server"))
	if serverArg != "" {
		inst, ok := findMCPResourceInstance(instances, serverArg)
		if !ok {
			return nil, fmt.Errorf("unknown MCP server %q", serverArg)
		}
		items, next, err := h.mcpResourcePage(ctx, inst, "resources/templates/list", "resourceTemplates", "")
		if err != nil {
			return nil, err
		}
		out := map[string]any{"server": inst.Name, "templates": withMCPResourceServer(inst.Name, items)}
		if next != "" {
			out["nextCursor"] = next
		}
		return builtinJSON(out)
	}
	templates := []map[string]any{}
	for _, inst := range instances {
		templates = append(templates, h.collectMCPResourcePages(ctx, inst, "resources/templates/list", "resourceTemplates")...)
	}
	return builtinJSON(map[string]any{"templates": templates})
}

func (h *handler) runReadMCPResource(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	var scopeErr error
	ctx, scopeErr = h.mcpAgentContext(ctx, tenant, agent)
	if scopeErr != nil {
		return nil, scopeErr
	}
	serverArg := strings.TrimSpace(builtinStringArg(args, "server"))
	uri := strings.TrimSpace(builtinStringArg(args, "uri"))
	if serverArg == "" {
		return nil, errors.New("server is required")
	}
	if uri == "" {
		return nil, errors.New("uri is required")
	}
	instances := h.mcpResourceInstances(ctx, tenant, agent)
	inst, ok := findMCPResourceInstance(instances, serverArg)
	if !ok {
		return nil, fmt.Errorf("unknown MCP server %q", serverArg)
	}
	callCtx, cancel := context.WithTimeout(ctx, mcpResourceCallTimeout)
	defer cancel()
	actor, _ := httpx.PrincipalFrom(callCtx)
	req, _ := http.NewRequestWithContext(callCtx, http.MethodPost, "/internal/mcp", nil)
	result, err := h.authorizedMCPRPC(req, actor, actor.SpaceID, inst, "resources/read", map[string]any{"uri": uri})
	if err != nil {
		return nil, err
	}
	var read struct {
		Contents []map[string]any `json:"contents"`
	}
	if err := json.Unmarshal(result, &read); err != nil {
		return nil, err
	}
	contents := make([]map[string]any, 0, len(read.Contents))
	for _, item := range read.Contents {
		entry := map[string]any{"uri": item["uri"]}
		if mime, ok := item["mimeType"].(string); ok && mime != "" {
			entry["mimeType"] = mime
		}
		if text, ok := item["text"].(string); ok {
			entry["text"] = text
		} else if blob, ok := item["blob"].(string); ok {
			entry["blob"] = blob
		} else {
			continue
		}
		contents = append(contents, entry)
	}
	return builtinJSON(map[string]any{"server": inst.Name, "uri": uri, "contents": contents})
}
