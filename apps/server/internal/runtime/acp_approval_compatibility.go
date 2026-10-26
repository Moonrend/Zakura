// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"time"
)

const claudeACPApprovalBoundary = "this Claude ACP version cannot enforce approval for every tool; use a standard agent for strict or AI tool approval"

// Audited upstream v0.75.1 (3e23c5b960b66a6d2c892e7524c952e731c076a7):
// src/session-mode.ts exposes SDK permission modes; src/acp-agent.ts delegates
// permission checks to canUseTool, after SDK permission decisions. ACP has no
// standard capability promising that every internal tool reaches this callback.
// Scope this refusal to the exact registry implementation, not arbitrary adapters
// or custom commands which happen to use the same profile name.
func (rt *acpLiveRuntime) auditedClaudeACP() bool {
	return rt.profileID == "claude-code" && rt.adapterImage == "ghcr.io/moonrend/acp-registry/claude-acp:0.75.1"
}

func (rt *acpLiveRuntime) guardedApprovalPolicy(ctx context.Context) (bool, error) {
	a, err := rt.manager.h.store.GetAgent(ctx, rt.tenantID, rt.agentID)
	if err != nil {
		return false, err
	}
	fallback, err := rt.approvalFallback(ctx)
	if err != nil {
		return false, err
	}
	cfg, err := parseApprovalConfig(a.Config, fallback)
	if err != nil {
		return false, err
	}
	return cfg.Policy == "always_ask" || cfg.Policy == "ai", nil
}

func (rt *acpLiveRuntime) checkApprovalCompatibility(ctx context.Context) error {
	if !rt.auditedClaudeACP() {
		return nil
	}
	guarded, err := rt.guardedApprovalPolicy(ctx)
	if err != nil {
		return err
	}
	if guarded {
		return errors.New(claudeACPApprovalBoundary)
	}
	return nil
}

func (rt *acpLiveRuntime) checkApprovalModePatch(ctx context.Context, patch map[string]any) error {
	if !rt.auditedClaudeACP() {
		return nil
	}
	mode, _ := patch["modeId"].(string)
	if patch["configId"] == "mode" {
		mode, _ = patch["value"].(string)
		if mode == "" {
			return errors.New("invalid ACP permission mode")
		}
	}
	if mode == "" || mode == "default" || mode == "plan" {
		return nil
	}
	guarded, err := rt.guardedApprovalPolicy(ctx)
	if err != nil {
		return err
	}
	if guarded {
		return errors.New("automatic ACP permission modes conflict with the tool approval policy")
	}
	return nil
}

func (rt *acpLiveRuntime) constrainApprovalMode(ctx context.Context) error {
	if !rt.auditedClaudeACP() {
		return nil
	}
	guarded, err := rt.guardedApprovalPolicy(ctx)
	if err != nil || !guarded {
		return err
	}
	rt.mu.Lock()
	modes, _ := rt.state["modes"].(map[string]any)
	mode, _ := modes["currentId"].(string)
	session := rt.acpSessionID
	rt.mu.Unlock()
	if mode == "default" || mode == "plan" {
		return nil
	}
	if err := rt.call(ctx, "session/set_mode", map[string]any{"sessionId": session, "modeId": "default"}, nil); err != nil {
		return errors.New("ACP automatic permissions could not be disabled")
	}
	rt.mu.Lock()
	modes, _ = rt.state["modes"].(map[string]any)
	if modes == nil {
		modes = map[string]any{"available": []any{}}
		rt.state["modes"] = modes
	}
	modes["currentId"] = "default"
	if config, _ := rt.state["config"].(map[string]any); config != nil {
		config["mode"] = "default"
	}
	rt.mu.Unlock()
	return rt.persistSnapshot(ctx)
}

// A running prompt may have started under allow_all. Revoke that process when
// the policy becomes incompatible; cancelling its RPC alone is not a stop proof.
func (rt *acpLiveRuntime) enforceActiveApprovalPolicy() error {
	if !rt.auditedClaudeACP() {
		return nil
	}
	rt.approvalMu.Lock()
	defer rt.approvalMu.Unlock()
	rt.mu.Lock()
	active := rt.currentRunID != ""
	rt.mu.Unlock()
	if !active {
		return nil
	}
	select {
	case <-rt.done:
		return rt.close(nil)
	default:
	}
	ctx, cancel := context.WithTimeout(rt.manager.h.deps.RunContext(), 5*time.Second)
	defer cancel()
	if err := rt.checkApprovalCompatibility(ctx); err != nil {
		return rt.stopForApprovalPolicy(err)
	}
	return nil
}

func (rt *acpLiveRuntime) stopForApprovalPolicy(reason error) error {
	h := rt.manager.h
	ctx, cancel := context.WithTimeout(context.WithoutCancel(h.deps.RunContext()), 10*time.Second)
	defer cancel()
	ctx = rt.workspaceContext(ctx)
	lease, err := h.acquireSpaceInfrastructure(ctx, rt.tenantID, rt.spaceID)
	if err != nil {
		// Another infrastructure owner already fences new processes. Still revoke
		// this known process; never interpret a failed close as remote termination.
		return errors.Join(err, rt.close(reason))
	}
	defer lease.release()
	if err = lease.bindSharedProfile(ctx, rt.profileID); err != nil {
		closeErr := rt.close(reason)
		_ = lease.uncertain(errors.Join(err, closeErr))
		return errors.Join(err, closeErr)
	}
	target, err := resolveACPHost(ctx, h, rt.tenantID, rt.agentID, rt.sid)
	if err != nil || target.computer.ID != rt.computerID || target.nodeID != rt.runner.nodeID {
		cause := errors.New("ACP stop target changed; reconcile original profile authentication")
		closeErr := rt.close(reason)
		_ = lease.uncertain(errors.Join(cause, closeErr))
		return errors.Join(cause, closeErr)
	}
	token := h.store.id()
	if err = h.acquireACPAuthLock(ctx, rt.tenantID, rt.spaceID, rt.profileID, "protocol", token, workspaceLeaseDuration, target); err != nil {
		closeErr := rt.close(reason)
		_ = lease.uncertain(errors.Join(err, closeErr))
		return errors.Join(err, closeErr)
	}
	if err = rt.close(reason); err != nil {
		_ = lease.uncertain(err)
		return err
	}
	if err = h.releaseACPAuthLock(ctx, rt.tenantID, rt.spaceID, rt.profileID, token); err != nil {
		_ = lease.uncertain(err)
	}
	return err
}

func (rt *acpLiveRuntime) watchApprovalPolicy(ctx context.Context, ticks <-chan time.Time, stopped <-chan struct{}) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-rt.done:
			return
		case <-stopped:
			return
		case _, ok := <-ticks:
			if !ok {
				return
			}
			rt.enforceActiveApprovalPolicy()
		}
	}
}

// Called after configuration commits, never from a replayable CAS callback.
func (m *acpRuntimeManager) enforceApprovalPolicies(tenant, agent, space string) error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	var runtimes []*acpLiveRuntime
	for _, rt := range m.runtimes {
		if rt.tenantID == tenant && (agent == "" || rt.agentID == agent) && (space == "" || rt.spaceID == space) {
			runtimes = append(runtimes, rt)
		}
	}
	m.mu.Unlock()
	var outcome error
	for _, rt := range runtimes {
		outcome = errors.Join(outcome, rt.enforceActiveApprovalPolicy())
		// close waits for any concurrent cleanup before reading its outcome.
		select {
		case <-rt.done:
			outcome = errors.Join(outcome, rt.close(nil))
		default:
		}
	}
	return outcome
}
