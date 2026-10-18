// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

type workspaceConnection struct {
	ID          string  `gorm:"column:id"`
	TenantID    string  `gorm:"column:tenant_id"`
	SpaceID     string  `gorm:"column:space_id"`
	NodeID      string  `gorm:"column:node_id"`
	StreamOwner string  `gorm:"column:stream_owner"`
	ComputerID  *string `gorm:"column:computer_id"`
	RuntimeID   *string `gorm:"column:runtime_id"`
	Incarnation *string `gorm:"column:incarnation"`
	Kind        string  `gorm:"column:kind"`
	StreamID    *string `gorm:"column:stream_id"`
	CloseMethod *string `gorm:"column:close_method"`
	State       string  `gorm:"column:state"`
	CreatedAt   string  `gorm:"column:created_at"`
}

func workspaceStreamOwner(ctx context.Context, runner *runnerSession) (string, error) {
	var info struct {
		StreamOwner string `json:"streamOwner"`
	}
	if err := runner.call(ctx, "sys.info", map[string]any{}, &info); err != nil {
		return "", err
	}
	owner := info.StreamOwner
	if owner == "" || len(owner) > 256 {
		return "", errors.New("update the runtime node to enable recoverable workspace connections")
	}
	return owner, nil
}

// Commit the intent before allocation. A lost start reply never authorizes a
// replacement stream or lets migration silently forget the original effect.
func (h *handler) beginWorkspaceConnection(ctx context.Context, lease *workspaceLease, target *spaceWorkspaceTarget, kind string) (*workspaceConnection, error) {
	owner, err := workspaceStreamOwner(ctx, target.runner)
	if err != nil {
		return nil, err
	}
	if (kind != "terminal" && kind != "desktop") || target.ticket.Tenant != lease.Space.TenantID || target.ticket.Space != lease.Space.ID || target.ticket.Node == "" {
		return nil, errors.New("workspace connection binding changed")
	}
	row := &workspaceConnection{ID: h.store.id(), TenantID: lease.Space.TenantID, SpaceID: lease.Space.ID, NodeID: target.ticket.Node, StreamOwner: owner, Kind: kind, State: "allocating", CreatedAt: runtimeTimeString(h.store.now())}
	if err := lease.fenced(ctx, func(tx *gorm.DB) error {
		return tx.Table("workspace_connections").Create(row).Error
	}); err != nil {
		return nil, err
	}
	return row, nil
}

func (h *handler) beginComputerTerminalConnection(ctx context.Context, lease *workspaceLease, exec *resolvedExecution) (*workspaceConnection, error) {
	if exec == nil || exec.spaceID != lease.Space.ID || exec.computer.TenantID != lease.Space.TenantID || exec.computer.ID == "" || exec.runtime.ID == "" || exec.runtime.Incarnation == "" {
		return nil, errors.New("computer terminal binding changed")
	}
	runner, err := h.hub.get(exec.nodeID)
	if err != nil {
		return nil, err
	}
	owner, err := workspaceStreamOwner(ctx, runner)
	if err != nil {
		return nil, err
	}
	row := &workspaceConnection{ID: h.store.id(), TenantID: lease.Space.TenantID, SpaceID: lease.Space.ID, NodeID: exec.nodeID, StreamOwner: owner, ComputerID: &exec.computer.ID, RuntimeID: &exec.runtime.ID, Incarnation: &exec.runtime.Incarnation, Kind: "computer_terminal", State: "allocating", CreatedAt: runtimeTimeString(h.store.now())}
	if err := lease.fenced(ctx, func(tx *gorm.DB) error {
		res := tx.Table("computers").Where("tenant_id=? AND space_id=? AND id=? AND deletion_pending=FALSE", row.TenantID, row.SpaceID, exec.computer.ID).UpdateColumn("deletion_pending", false)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return errors.New("computer deletion is pending")
		}
		return tx.Table("workspace_connections").Create(row).Error
	}); err != nil {
		return nil, err
	}
	return row, nil
}

func (h *handler) activateWorkspaceConnection(ctx context.Context, lease *workspaceLease, row *workspaceConnection, id, method string) error {
	if id == "" || (method != "docker.exec.close" && method != "host.pty.close") || ((row.Kind == "desktop" || row.Kind == "computer_terminal") && method != "docker.exec.close") {
		return errors.New("workspace stream identity is incomplete")
	}
	return lease.fenced(ctx, func(tx *gorm.DB) error {
		result := tx.Table("workspace_connections").Where("id=? AND tenant_id=? AND space_id=? AND node_id=? AND stream_owner=? AND state='allocating' AND stream_id IS NULL", row.ID, row.TenantID, row.SpaceID, row.NodeID, row.StreamOwner).Updates(map[string]any{"stream_id": id, "close_method": method, "state": "active"})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrConflict
		}
		return nil
	})
}

func closeWorkspaceStream(ctx context.Context, runner *runnerSession, method, id, owner string) error {
	var result struct {
		OK bool `json:"ok"`
	}
	if err := runner.call(ctx, method, map[string]any{"id": id, "streamOwner": owner}, &result); err != nil {
		return err
	}
	if !result.OK {
		return errors.New("workspace stream cleanup was not acknowledged")
	}
	return nil
}

func (h *handler) finishWorkspaceConnection(row *workspaceConnection, confirmed bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	q := h.deps.Gorm.WithContext(ctx).Table("workspace_connections").Where("id=? AND tenant_id=? AND space_id=? AND node_id=? AND stream_owner=?", row.ID, row.TenantID, row.SpaceID, row.NodeID, row.StreamOwner)
	if confirmed {
		return q.Delete(map[string]any{}).Error
	}
	return q.Update("state", "unknown").Error
}

// Called under the migration/lifecycle claim, after local sockets have closed.
// The exact executor must acknowledge stream closure. A replacement executor's
// empty stream registry is not proof that an earlier remote process terminated.
func (h *handler) recoverWorkspaceConnections(ctx context.Context, lease *workspaceLease) error {
	return h.recoverOwnerWorkspaceConnections(ctx, lease, "")
}

func (h *handler) recoverOwnerWorkspaceConnections(ctx context.Context, lease *workspaceLease, computer string) error {
	return h.recoverOwnerConnections(ctx, lease.Space.TenantID, lease.Space.ID, computer, lease.fenced)
}

func (h *handler) recoverOwnerConnections(ctx context.Context, tenant, space, computer string, fenced func(context.Context, func(*gorm.DB) error) error) error {
	var rows []workspaceConnection
	q := h.deps.Gorm.WithContext(ctx).Table("workspace_connections").Where("tenant_id=? AND space_id=?", tenant, space)
	if computer != "" {
		q = q.Where("computer_id=? AND kind='computer_terminal'", computer)
	}
	if err := q.Order("id").Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		attached := row.Kind == "computer_terminal" && row.ComputerID != nil && *row.ComputerID != "" && row.RuntimeID != nil && *row.RuntimeID != "" && row.Incarnation != nil && *row.Incarnation != ""
		if row.StreamID == nil || *row.StreamID == "" || row.StreamOwner == "" || row.CloseMethod == nil || (*row.CloseMethod != "docker.exec.close" && *row.CloseMethod != "host.pty.close") || (row.Kind != "terminal" && row.Kind != "desktop" && !attached) || ((row.Kind == "desktop" || attached) && *row.CloseMethod != "docker.exec.close") {
			return errors.New("workspace connection allocation is unconfirmed; migration remains paused")
		}
		if err := fenced(ctx, func(*gorm.DB) error { return nil }); err != nil {
			return err
		}
		if err := h.authorizeContextLocalNode(ctx, row.TenantID, row.NodeID); err != nil {
			return err
		}
		runner, err := h.hub.get(row.NodeID)
		if err != nil {
			return err
		}
		cleanup, cancel := context.WithTimeout(ctx, 5*time.Second)
		owner, err := workspaceStreamOwner(cleanup, runner)
		if err == nil && owner != row.StreamOwner {
			err = errors.New("workspace stream executor changed; cleanup remains unconfirmed")
		}
		if err == nil {
			err = closeWorkspaceStream(cleanup, runner, *row.CloseMethod, *row.StreamID, row.StreamOwner)
		}
		cancel()
		if err != nil {
			return err
		}
		if err := fenced(ctx, func(tx *gorm.DB) error {
			return tx.Table("workspace_connections").Where("id=? AND tenant_id=? AND space_id=? AND node_id=? AND stream_owner=? AND stream_id=? AND close_method=?", row.ID, row.TenantID, row.SpaceID, row.NodeID, row.StreamOwner, *row.StreamID, *row.CloseMethod).Delete(map[string]any{}).Error
		}); err != nil {
			return err
		}
	}
	return nil
}
