package runtime

import (
	"context"
	"errors"
	"time"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func (h *handler) syncWorkspaceRevocations(ctx context.Context, runner *runnerSession) error {
	bindings, err := h.workspaceStore().NodeRevocations(ctx, runner.nodeID)
	if err != nil || len(bindings) == 0 {
		return err
	}
	if err := verifyWorkspaceNode(ctx, runner, bindings[0].Target.NodeIncarnation); err != nil {
		return err
	}
	for _, binding := range bindings {
		if binding.Target.NodeIncarnation != bindings[0].Target.NodeIncarnation {
			return workspaces.ErrUnverified
		}
		var ack struct {
			Target protocol.Target `json:"target"`
			OK     bool            `json:"ok"`
		}
		if err := runner.call(ctx, "workspace.revoke", binding, &ack); err != nil {
			return err
		}
		if !ack.OK || ack.Target != binding.Target {
			return workspaces.ErrUnverified
		}
	}
	return nil
}

func (h *handler) startWorkspaceCleanup(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				callCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
				_ = h.sweepWorkspaceCleanup(callCtx, 25)
				cancel()
			}
		}
	}()
}

func (h *handler) sweepWorkspaceCleanup(ctx context.Context, limit int) error {
	if h.hub == nil {
		return nil
	}
	h.hub.mu.RLock()
	var nodes []string
	for id, session := range h.hub.sessions {
		if session.local == nil && session.ready.Load() && time.Since(time.UnixMilli(session.lastSeen.Load())) <= 60*time.Second {
			nodes = append(nodes, id)
		}
	}
	h.hub.mu.RUnlock()
	jobs, err := h.workspaceStore().DueNodeCleanups(ctx, h.store.now(), limit, nodes)
	if err != nil {
		return err
	}
	for _, job := range jobs {
		if err := ctx.Err(); err != nil {
			return err
		}
		runner, err := h.hub.get(job.Snapshot.Disk.NodeID)
		if err != nil {
			continue
		}
		claimed, err := h.workspaceStore().ClaimCleanup(ctx, job.TenantID, job.SpaceID, job.ID, h.store.id(), h.store.now())
		if errors.Is(err, workspaces.ErrConflict) {
			continue
		}
		if err != nil {
			return err
		}
		callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err = h.executeWorkspaceCleanup(callCtx, runner, claimed)
		cancel()
		if err != nil {
			_ = h.workspaceStore().RetryCleanup(ctx, claimed, claimed.Phase, err, h.store.now())
		}
	}
	return nil
}

func (h *handler) executeWorkspaceCleanup(ctx context.Context, runner *runnerSession, job workspaces.Cleanup) error {
	disk := job.Snapshot.Disk.Wire()
	disk.Locator = job.Snapshot.Locator
	if runner.nodeID != job.Snapshot.Disk.NodeID {
		return workspaces.ErrConflict
	}
	if err := verifyWorkspaceNode(ctx, runner, disk.NodeIncarnation); err != nil {
		return err
	}
	if job.Phase == "deleting_disk" {
		if !job.DeleteDisk {
			return workspaces.ErrConflict
		}
		var result struct {
			Disk    protocol.Disk `json:"disk"`
			Deleted bool          `json:"deleted"`
		}
		if err := runner.call(ctx, "workspace.disk.delete", map[string]any{"disk": disk, "requestId": job.RequestID}, &result); err != nil {
			return err
		}
		if !result.Deleted || result.Disk != disk {
			return workspaces.ErrUnverified
		}
		return h.workspaceStore().CompleteDiskDeletion(ctx, job, result.Disk, h.store.now())
	}
	instance := job.Snapshot.Instance
	if instance == nil || instance.IdentityVersion != 2 {
		return errors.New("legacy workspace writers require reconciliation")
	}
	binding := protocol.Binding{Target: instance.Target, Disk: disk}
	if err := binding.Validate(); err != nil {
		return err
	}
	var released struct {
		Target   protocol.Target `json:"target"`
		Released bool            `json:"released"`
	}
	if err := runner.call(ctx, "workspace.release", binding, &released); err != nil {
		return err
	}
	if !released.Released || released.Target != binding.Target {
		return workspaces.ErrUnverified
	}
	return h.workspaceStore().CompleteRelease(ctx, job, released.Target, h.store.now())
}
