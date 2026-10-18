// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func (h *handler) reconnectACPRuntime(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	live, err := h.reconnectACP(ctx, principal(r), chi.URLParam(r, "id"), chi.URLParam(r, "sid"))
	if err != nil {
		if errors.Is(err, httpx.ErrResourceScope) {
			httpx.Error(w, http.StatusNotFound, "resource not found")
		} else {
			httpx.Error(w, http.StatusConflict, err.Error())
		}
		return
	}
	httpx.JSON(w, http.StatusOK, live.snapshot())
}

// Reconnection is an explicit authorization boundary, not a sliding grant
// renewal. It closes the old process before loading the same durable session
// using the current request's identity; queued receipts retain their old fence.
func (h *handler) reconnectACP(ctx context.Context, p httpx.Principal, agent, sid string) (*acpLiveRuntime, error) {
	if err := httpx.AuthorizeResource(ctx, h.deps, p, "", agent); err != nil {
		return nil, err
	}
	ctx = httpx.WithPrincipal(ctx, p)
	mu := h.service.sessionLock(sid)
	mu.Lock()
	defer mu.Unlock()
	sess, err := h.store.GetSession(ctx, p.TenantID, agent, sid)
	if err != nil {
		return nil, err
	}
	if sess.Kind != "acp" || sess.ActiveRunID != nil {
		return nil, errors.New("ACP reconnection requires an idle ACP session")
	}
	a, err := h.store.GetAgent(ctx, p.TenantID, agent)
	if err != nil {
		return nil, err
	}
	lease, err := h.acquireSpaceInfrastructure(ctx, p.TenantID, a.SpaceID)
	if err != nil {
		return nil, err
	}
	defer lease.release()
	// A different server can admit a run after the first read but before this
	// lease. Re-read under the shared infrastructure fence before closing it.
	sess, err = h.store.GetSession(ctx, p.TenantID, agent, sid)
	if err != nil || sess.ActiveRunID != nil {
		return nil, errors.New("ACP session became active before reconnection")
	}
	key := p.TenantID + "\x00" + sid
	h.acp.mu.Lock()
	current, starting := h.acp.runtimes[key], h.acp.starting[key] != nil
	h.acp.mu.Unlock()
	if starting {
		return nil, errors.New("ACP runtime is already starting")
	}
	if current != nil {
		if !current.authMu.TryLock() {
			return nil, errors.New("ACP authentication or prompt is active")
		}
		defer current.authMu.Unlock()
		exec, resolveErr := resolveACPHost(ctx, h, p.TenantID, agent, sid)
		if resolveErr != nil || exec.spaceID != current.spaceID || exec.computer.ID != current.computerID || exec.nodeID != current.runner.nodeID {
			return nil, errors.New("ACP reconnection target changed; reconcile profile authentication")
		}
		token := h.store.id()
		if err = h.acquireACPAuthLock(ctx, p.TenantID, a.SpaceID, current.profileID, "protocol", token, workspaceLeaseDuration, exec); err != nil {
			return nil, err
		}
		if err = lease.bindSharedProfile(ctx, current.profileID); err != nil {
			_ = h.releaseACPAuthLock(context.WithoutCancel(ctx), p.TenantID, a.SpaceID, current.profileID, token)
			return nil, err
		}
		if err = current.close(nil); err != nil {
			_ = lease.uncertain(err)
			return nil, errors.New("ACP cleanup is unconfirmed; reconcile profile authentication before reconnecting")
		}
		if err = h.releaseACPAuthLock(context.WithoutCancel(ctx), p.TenantID, a.SpaceID, current.profileID, token); err != nil {
			_ = lease.uncertain(err)
			return nil, errors.New("ACP authentication lock release is unconfirmed")
		}
	}
	lease.release()
	return h.acp.ensure(ctx, p.TenantID, agent, sid)
}

var errACPCleanupUnconfirmed = errors.New("ACP process cleanup is unconfirmed")
