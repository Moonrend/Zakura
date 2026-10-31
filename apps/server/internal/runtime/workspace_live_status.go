package runtime

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"gorm.io/gorm"
)

// liveWorkspaceStatus is what the UI shows for a Space workspace. It is never
// read back from spaces.workspace_status, which only serializes lifecycle
// operations and goes stale whenever a node or the server stops unexpectedly.
//
//   - an unexpired lifecycle lease reports its operation (starting, stopping…);
//   - otherwise the node is asked directly which workspace container exists;
//   - an unreachable node is reported as offline, not as its last known state.
type liveWorkspaceStatus struct {
	State     string  `json:"state"`
	Operation *string `json:"operation"`
	NodeID    *string `json:"nodeId"`
	Error     *string `json:"error"`
}

const (
	workspaceLiveNone    = "none"
	workspaceLiveRunning = "running"
	workspaceLiveStopped = "stopped"
	workspaceLiveOffline = "offline"
	workspaceLiveUnknown = "unknown"
)

const workspaceObserveTimeout = 3 * time.Second

func (h *handler) observeLiveWorkspace(ctx context.Context, space Space) liveWorkspaceStatus {
	status := liveWorkspaceStatus{NodeID: space.RuntimeNodeID}
	var lease struct {
		Operation string `gorm:"column:operation"`
		ExpiresAt int64  `gorm:"column:expires_at"`
	}
	err := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Select("operation,expires_at").Where("space_id=? AND tenant_id=?", space.ID, space.TenantID).Take(&lease).Error
	if err == nil && lease.ExpiresAt > h.store.now().UnixMilli() {
		status.Operation = &lease.Operation
	} else if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) && !errors.Is(err, sql.ErrNoRows) {
		message := err.Error()
		status.State, status.Error = workspaceLiveUnknown, &message
		return status
	}
	if space.RuntimeNodeID == nil || *space.RuntimeNodeID == "" {
		status.State = workspaceLiveNone
		return status
	}
	if space.WorkspaceKind == "host" {
		// A host workspace is a directory; it is usable whenever its node is.
		if _, err := h.hubSession(*space.RuntimeNodeID); err != nil {
			status.State = workspaceLiveOffline
		} else {
			status.State = workspaceLiveRunning
		}
		return status
	}
	if h.hub == nil {
		status.State = workspaceLiveOffline
		return status
	}
	observeCtx, cancel := context.WithTimeout(ctx, workspaceObserveTimeout)
	defer cancel()
	obs, err := h.observeSpaceWorkspace(observeCtx, space)
	var runnerErr workspaceRunnerError
	switch {
	case err == nil && obs.Container.DockerID == "":
		status.State = workspaceLiveStopped
	case err == nil && obs.Container.Status == "running":
		status.State = workspaceLiveRunning
	case err == nil:
		status.State = workspaceLiveStopped
	case errors.As(err, &runnerErr) || isRunnerOffline(err):
		status.State = workspaceLiveOffline
	default:
		message := err.Error()
		status.State, status.Error = workspaceLiveUnknown, &message
	}
	return status
}

func (h *handler) hubSession(node string) (*runnerSession, error) {
	if h.hub == nil {
		return nil, errors.New("runtime node agent is offline")
	}
	return h.hub.get(node)
}

func isRunnerOffline(err error) bool {
	return err != nil && (errors.Is(err, context.DeadlineExceeded) || err.Error() == "runtime node agent is offline" || err.Error() == "workspace runtime node is unavailable")
}

// publishWorkspaceChanged tells every open page of the tenant to re-observe a
// Space workspace. It carries no state: subscribers fetch the live status.
func publishWorkspaceChanged(tenant, space string) {
	broadcastTenant(tenant, "platform", map[string]any{"type": "workspace_changed", "ts": time.Now().UnixMilli(), "spaceId": space}, "")
}
