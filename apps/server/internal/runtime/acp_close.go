// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
	"github.com/go-chi/chi/v5"
)

func (h *handler) closeACPRuntime(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	state, err := h.closeACP(ctx, principal(r), chi.URLParam(r, "id"), chi.URLParam(r, "sid"))
	if err != nil {
		if errors.Is(err, httpx.ErrResourceScope) || errors.Is(err, ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "resource not found")
		} else {
			httpx.Error(w, http.StatusConflict, err.Error())
		}
		return
	}
	httpx.JSON(w, http.StatusOK, state)
}

// Closing is independent from deleting a conversation or reconnecting it. It
// revokes the process grant, but never drains its queue or removes credentials.
func (h *handler) closeACP(ctx context.Context, p httpx.Principal, agent, sid string) (map[string]any, error) {
	if err := httpx.AuthorizeResource(ctx, h.deps, p, "", agent); err != nil {
		return nil, err
	}
	if h.acp == nil {
		return nil, errors.New("ACP runtime unavailable")
	}
	mu := h.service.sessionLock(sid)
	mu.Lock()
	defer mu.Unlock()
	sess, err := h.store.GetSession(ctx, p.TenantID, agent, sid)
	if err != nil {
		return nil, err
	}
	if sess.Kind != "acp" || sess.ActiveRunID != nil {
		return nil, errors.New("closing ACP requires an idle ACP session")
	}
	h.acp.mu.Lock()
	rt, starting := h.acp.runtimes[p.TenantID+"\x00"+sid], h.acp.starting[p.TenantID+"\x00"+sid] != nil
	h.acp.mu.Unlock()
	if starting {
		return nil, errors.New("ACP runtime is still starting")
	}
	if rt == nil {
		state, err := h.acp.snapshot(ctx, p.TenantID, agent, sid)
		if err != nil {
			return nil, err
		}
		if state != nil && state["state"] == "closed" {
			return state, nil
		}
		if state != nil && state["processClosed"] == true {
			agent, err := h.store.GetAgent(ctx, p.TenantID, agent)
			if err != nil {
				return nil, err
			}
			lease, err := h.acquireSpaceInfrastructure(ctx, p.TenantID, agent.SpaceID)
			if err != nil {
				return nil, err
			}
			defer lease.release()
			// Recheck under the shared fence: a different server may have started
			// this session since the first snapshot was read.
			state, err = h.acp.snapshot(ctx, p.TenantID, agent.ID, sid)
			if err != nil {
				return nil, err
			}
			if state == nil || state["processClosed"] != true {
				return nil, errors.New("ACP runtime changed before closing")
			}
			state["state"] = "closed"
			delete(state, "error")
			profile, _ := state["profileId"].(string)
			stopped := &acpLiveRuntime{manager: h.acp, tenantID: p.TenantID, agentID: agent.ID, sid: sid, profileID: profile, state: state}
			if err := stopped.persistSnapshot(ctx); err != nil {
				return nil, err
			}
			return state, nil
		}
		return nil, errors.New("original ACP process is not attached; reconcile profile authentication before reconnecting")
	}
	select {
	case <-rt.done:
		if rt.close(nil) == nil {
			rt.mu.Lock()
			rt.state["state"] = "closed"
			delete(rt.state, "error")
			rt.mu.Unlock()
			if err := rt.persistSnapshot(ctx); err != nil {
				return nil, err
			}
			return rt.snapshot(), nil
		}
	default:
	}
	if rt.agentID != agent || !rt.authMu.TryLock() {
		return nil, errors.New("ACP authentication or prompt is active")
	}
	defer rt.authMu.Unlock()
	if rt.remote != nil && rt.remote.workspace != nil {
		err := rt.validateWorkspace(ctx)
		if errors.Is(err, workspaces.ErrTargetRevoked) {
			// Retirement already moved every writer obligation to the tombstone.
			// Close this known process without taking the replacement's profile slot.
			if err = rt.close(nil); err != nil {
				return nil, err
			}
			return rt.snapshot(), nil
		}
		if err != nil {
			return nil, err
		}
	}
	lease, authToken, quarantined, err := h.claimACPClose(ctx, p, rt)
	if err != nil {
		return nil, err
	}
	defer lease.release()
	// Admission on another server must observe the same infrastructure fence.
	sess, err = h.store.GetSession(ctx, p.TenantID, agent, sid)
	if err != nil || sess.ActiveRunID != nil {
		if !quarantined {
			_ = h.releaseACPAuthLock(context.WithoutCancel(ctx), p.TenantID, rt.spaceID, rt.profileID, authToken)
		}
		return nil, errors.New("ACP session became active before closing")
	}
	if err = rt.close(nil); err != nil {
		_ = lease.uncertain(err)
		return nil, err
	}
	if quarantined {
		// Cleanup of this known process is not proof that a different late login
		// or credential write ended. Keep both fences for explicit reconciliation.
		_, err = h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE acp_profile_auth_locks SET expires_at=?,updated_at=? WHERE tenant_id=? AND space_id=? AND profile_id=? AND token=? AND kind='recovering'`), h.store.now().UnixMilli(), h.store.now().UnixMilli(), p.TenantID, rt.spaceID, rt.profileID, authToken)
	} else {
		err = h.releaseACPAuthLock(ctx, p.TenantID, rt.spaceID, rt.profileID, authToken)
	}
	if err != nil {
		_ = lease.uncertain(err)
		return nil, errors.New("ACP authentication lock release is unconfirmed")
	}
	return rt.snapshot(), nil
}

func (h *handler) claimACPClose(ctx context.Context, p httpx.Principal, rt *acpLiveRuntime) (*workspaceLease, string, bool, error) {
	tenant := p.TenantID
	ctx = rt.workspaceContext(ctx)
	lease, claimErr := h.acquireSpaceInfrastructure(ctx, tenant, rt.spaceID)
	if claimErr == nil {
		exec, err := resolveACPHost(ctx, h, tenant, rt.agentID, rt.sid)
		if err != nil || exec.computer.ID != rt.computerID || exec.nodeID != rt.runner.nodeID {
			lease.release()
			return nil, "", false, errors.New("ACP close target changed; reconcile original profile authentication")
		}
		token := h.store.id()
		claimErr = h.acquireACPAuthLock(ctx, tenant, rt.spaceID, rt.profileID, "protocol", token, workspaceLeaseDuration, exec)
		if claimErr == nil {
			if err = lease.bindSharedProfile(ctx, rt.profileID); err != nil {
				_ = h.releaseACPAuthLock(context.WithoutCancel(ctx), tenant, rt.spaceID, rt.profileID, token)
				lease.release()
				return nil, "", false, err
			}
			return lease, token, false, nil
		}
		lease.release()
	}
	if (p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin) || p.APIKey && !APIKeyScopeAllows(p, "computers:manage") || httpx.AuthorizeResource(ctx, h.deps, p, rt.spaceID, "") != nil {
		return nil, "", false, claimErr
	}
	state, err := h.loadACPAuthRecovery(ctx, tenant, rt.spaceID, rt.profileID)
	if err != nil || state.ExpiresAt > h.store.now().UnixMilli() || state.NodeID != rt.runner.nodeID || state.ComputerID != rt.computerID {
		return nil, "", false, claimErr
	}
	original, _ := ctx.Value(workspaceRequestTargetKey{}).(Space)
	if !acpRecoveryMatchesSpace(state, original) {
		return nil, "", false, errACPAuthLockLost
	}
	var intent workspaceIntent
	if state.WorkspaceToken != "" && (state.WorkspaceOperation != "configuring" || json.Unmarshal([]byte(state.WorkspaceIntent), &intent) != nil || intent.SharedProfile != rt.profileID) {
		return nil, "", false, claimErr
	}
	lease, err = h.claimACPAuthRecovery(ctx, tenant, rt.spaceID, rt.profileID, state)
	if err != nil {
		return nil, "", false, err
	}
	lease.retained = true
	token := h.store.id()
	now := h.store.now()
	result, err := h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE acp_profile_auth_locks SET token=?,kind='recovering',expires_at=?,updated_at=? WHERE tenant_id=? AND space_id=? AND profile_id=? AND token=? AND updated_at=? AND expires_at<=?`), token, now.Add(time.Minute).UnixMilli(), now.UnixMilli(), tenant, rt.spaceID, rt.profileID, state.Token, state.UpdatedAt, now.UnixMilli())
	if err != nil {
		return nil, "", false, err
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return nil, "", false, errACPAuthLockLost
	}
	return lease, token, true, nil
}
