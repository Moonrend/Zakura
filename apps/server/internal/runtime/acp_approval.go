// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func (rt *acpLiveRuntime) approvalFallback(ctx context.Context) (string, error) {
	_, raw, err := rt.manager.h.acpSpace(ctx, rt.tenantID, rt.agentID, rt.spaceID)
	if err != nil {
		return "", err
	}
	if parseACPConfig(acpMap(raw)).PermissionPolicy == "allow" {
		return "allow_all", nil
	}
	return "always_ask", nil
}

// Approval waits use the original actor, not an invented background owner.
// Revalidate the saved identity on each callback, even without an MCP grant.
func (rt *acpLiveRuntime) approvalContext(ctx context.Context) (context.Context, error) {
	ctx, err := rt.currentApprovalContext(ctx)
	if err != nil {
		return ctx, err
	}
	return context.WithValue(ctx, toolApprovalAccessCheckKey{}, func(checkCtx context.Context) error {
		_, err := rt.currentApprovalContext(checkCtx)
		return err
	}), nil
}

func (rt *acpLiveRuntime) currentApprovalContext(ctx context.Context) (context.Context, error) {
	h := rt.manager.h
	sess, err := h.store.GetSession(ctx, rt.tenantID, rt.agentID, rt.sid)
	if err != nil {
		return ctx, err
	}
	a, err := h.store.GetAgent(ctx, rt.tenantID, rt.agentID)
	if err != nil || a.SpaceID != rt.spaceID {
		return ctx, ErrNotFound
	}
	space, err := h.store.GetSpace(ctx, rt.tenantID, rt.spaceID)
	if err != nil {
		return ctx, err
	}
	if space.RuntimeNodeID == nil || *space.RuntimeNodeID != rt.runner.nodeID {
		return ctx, errors.New("ACP workspace binding changed; reopen the runtime")
	}
	if err := h.requireSpaceInfrastructureAvailable(ctx, rt.tenantID, rt.spaceID); err != nil {
		return ctx, err
	}
	var source httpx.Principal
	persisted := false
	if rt.mcpActor != nil {
		source = *rt.mcpActor
	} else if sess.CreatedByUserID != nil && *sess.CreatedByUserID != "" {
		source = httpx.Principal{TenantID: rt.tenantID, UserID: *sess.CreatedByUserID}
		persisted = true
	} else {
		if h.deps.MultiTenant {
			return ctx, errors.New("ACP callback has no authorized original actor")
		}
		return ctx, h.authorizeContextLocalNode(ctx, rt.tenantID, rt.runner.nodeID)
	}
	current, err := rt.currentACPActor(ctx, source, persisted, "api")
	if err != nil {
		return ctx, err
	}
	ctx = httpx.WithPrincipal(ctx, current)
	return ctx, h.authorizeContextLocalNode(ctx, rt.tenantID, rt.runner.nodeID)
}

func (rt *acpLiveRuntime) approveCallback(ctx context.Context, method string, id json.RawMessage, params map[string]any) error {
	h := rt.manager.h
	a, err := h.store.GetAgent(ctx, rt.tenantID, rt.agentID)
	if err != nil {
		return err
	}
	if !parseCloudConfig(a.Config).EnableTools {
		return errors.New("tools are disabled for this agent")
	}
	fallback, err := rt.approvalFallback(ctx)
	if err != nil {
		return err
	}
	if h.service == nil {
		return errors.New("tool approval unavailable")
	}
	rt.mu.Lock()
	run := rt.currentRunID
	rt.mu.Unlock()
	// Protocol toolCall descriptions are not necessarily the command/content of
	// this callback. Never reuse a descriptive grant for different parameters.
	args := make(map[string]any, len(params)+2)
	for key, value := range params {
		args[key] = value
	}
	delete(args, "computerId") // infrastructure always belongs to the Space
	args["acpMethod"], args["workspaceNodeId"] = method, rt.runner.nodeID
	return h.service.approveTool(ctx, rt.tenantID, rt.agentID, rt.sid, run, "acp-callback:"+rpcIDDisplay(id), method, rawJSON(args), fallback, "acp_callback", rpcIDDisplay(id))
}

func (rt *acpLiveRuntime) gatePermission(ctx context.Context, id json.RawMessage, params map[string]any, options map[string]string) {
	key := rpcIDDisplay(id)
	rt.mu.Lock()
	if _, ok := rt.inbound[key]; ok || len(rt.inbound) >= 128 {
		rt.mu.Unlock()
		_ = rt.respond(id, nil, &map[string]any{"code": -32602, "message": "Duplicate or excessive ACP request id"})
		return
	}
	select {
	case <-rt.done:
		rt.mu.Unlock()
		return
	default:
	}
	rt.inbound[key] = acpInbound{method: "session/request_permission", id: append(json.RawMessage(nil), id...), options: options}
	run := rt.currentRunID
	rt.mu.Unlock()
	defer func() { rt.mu.Lock(); delete(rt.inbound, key); rt.mu.Unlock() }()
	allow, deny := "", ""
	for id, kind := range options {
		if kind == "allow_once" {
			allow = id
		}
		if kind == "reject_once" {
			deny = id
		}
	}
	if allow == "" {
		_ = rt.respond(id, nil, &map[string]any{"code": -32602, "message": "ACP adapter must support single-call approval"})
		return
	}
	tool, _ := params["toolCall"].(map[string]any)
	name := builtinStringArg(tool, "kind")
	if name == "" {
		name = "acp_tool"
	}
	call := builtinStringArg(tool, "toolCallId")
	if call == "" {
		call = "acp:" + key
	}
	args := rawJSON(tool)
	fallback, err := rt.approvalFallback(ctx)
	if err == nil {
		ctx, err = rt.approvalContext(ctx)
	}
	if err == nil {
		service := rt.manager.h.service
		if service == nil {
			err = errors.New("tool approval unavailable")
		} else {
			err = service.approveTool(ctx, rt.tenantID, rt.agentID, rt.sid, run, call, name, args, fallback, "acp", key)
		}
	}
	if err == nil {
		_, err = rt.approvalContext(ctx)
	}
	outcome := map[string]any{"outcome": "cancelled"}
	if err == nil {
		outcome = map[string]any{"outcome": "selected", "optionId": allow}
	} else if deny != "" && ctx.Err() == nil {
		outcome = map[string]any{"outcome": "selected", "optionId": deny}
	}
	_ = rt.respond(id, map[string]any{"outcome": outcome}, nil)
}
