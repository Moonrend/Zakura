// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
)

// migrationPauseRuns cancels in-process execution without invoking Cancel,
// whose normal user-facing contract intentionally drains queued follow-ups.
// A durable run owned by another/previous server is not evidence of quiescence.
func (h *handler) migrationPauseRuns(ctx context.Context, lease *workspaceLease) error {
	var rows []struct {
		ID      string `gorm:"column:id"`
		Agent   string `gorm:"column:agent_id"`
		Session string `gorm:"column:session_id"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("cloud_agent_runs AS r").Select("r.id,s.agent_id,r.session_id").Joins("JOIN cloud_agent_sessions AS s ON s.id=r.session_id").Joins("JOIN agents AS a ON a.id=s.agent_id AND a.tenant_id=s.tenant_id").Where("a.tenant_id=? AND a.space_id=? AND r.status IN ('running','pending','queued')", lease.Space.TenantID, lease.Space.ID).Find(&rows).Error; err != nil {
		return err
	}
	if len(rows) != 0 && h.service == nil {
		return errors.New("active execution cannot be contacted; migration is waiting for it to stop")
	}
	liveRuns := make([]*liveRun, 0, len(rows))
	for _, row := range rows {
		live := h.service.lookupRun(row.ID)
		if live == nil {
			return errors.New("active execution is not attached to this server; its stop must be confirmed before migration")
		}
		liveRuns = append(liveRuns, live)
	}
	for _, live := range liveRuns {
		live.cancelRequested.Store(true)
		live.cancel()
	}
	waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for _, live := range liveRuns {
		select {
		case <-live.done:
		case <-waitCtx.Done():
			return fmt.Errorf("waiting for execution to stop: %w", waitCtx.Err())
		}
	}
	return lease.check(ctx)
}

// All shutdown effects run under the original migration claim. Calling the
// public ACP/MCP/workspace lifecycle endpoints here would acquire a second
// infrastructure lease and either deadlock or punch a hole in the fence.
func (h *handler) migrationCloseProcesses(ctx context.Context, lease *workspaceLease) error {
	space := lease.Space
	if h.acp != nil {
		h.acp.mu.Lock()
		var runtimes []*acpLiveRuntime
		for _, runtime := range h.acp.runtimes {
			if runtime.tenantID == space.TenantID && runtime.spaceID == space.ID {
				runtimes = append(runtimes, runtime)
			}
		}
		for key := range h.acp.starting {
			if strings.HasPrefix(key, space.TenantID+"\x00") {
				sid := strings.TrimPrefix(key, space.TenantID+"\x00")
				var owned int64
				if err := h.deps.Gorm.WithContext(ctx).Table("cloud_agent_sessions AS s").Joins("JOIN agents AS a ON a.id=s.agent_id AND a.tenant_id=s.tenant_id").Where("s.tenant_id=? AND s.id=? AND a.space_id=?", space.TenantID, sid, space.ID).Count(&owned).Error; err != nil {
					h.acp.mu.Unlock()
					return err
				}
				if owned != 0 {
					// A starting process has no verified target identity yet.
					h.acp.mu.Unlock()
					return errors.New("an ACP process is still starting; migration will wait")
				}
			}
		}
		h.acp.mu.Unlock()
		for _, runtime := range runtimes {
			if !runtime.authMu.TryLock() {
				return errors.New("ACP authentication or execution has not stopped")
			}
			err := lease.check(ctx)
			if err == nil {
				err = runtime.close(nil)
			}
			runtime.authMu.Unlock()
			if err != nil {
				return lease.uncertain(fmt.Errorf("ACP shutdown is unconfirmed: %w", err))
			}
		}
	}
	if err := h.migrationCloseManagedContainers(ctx, lease); err != nil {
		return err
	}
	return nil
}

func (h *handler) migrationCloseManagedContainers(ctx context.Context, lease *workspaceLease) error {
	space := lease.Space
	runner, err := h.hub.get(*space.RuntimeNodeID)
	if err != nil {
		return err
	}
	var containers []acpSidecarContainer
	if err := runner.call(ctx, "docker.list", map[string]any{"label": "zakura.space=" + space.ID}, &containers); err != nil {
		return err
	}
	var stoppedIDs []string
	for _, container := range containers {
		if container.Labels["zakura.purpose"] == "workspace" || container.Labels["zakura.purpose"] == "computer" {
			continue
		}
		purpose := container.Labels["zakura.purpose"]
		if container.DockerID == "" || container.Labels["zakura.tenant"] != space.TenantID || container.Labels["zakura.space"] != space.ID || (purpose != "acp-adapter" && purpose != "component" && purpose != "mcp") {
			return errors.New("unrecognized Space process cannot be stopped automatically")
		}
		var owned int64
		if err := h.deps.Gorm.WithContext(ctx).Table("managed_containers").Where("tenant_id=? AND space_id=? AND runtime_node_id=? AND docker_id=? AND purpose<>'workspace'", space.TenantID, space.ID, *space.RuntimeNodeID, container.DockerID).Count(&owned).Error; err != nil {
			return err
		}
		if owned != 1 {
			return errors.New("Space process is not owned by a verified managed container")
		}
		if err := lease.check(ctx); err != nil {
			return err
		}
		if err := runner.call(ctx, "docker.stop", map[string]any{"id": container.DockerID, "remove": true}, nil); err != nil {
			return lease.uncertain(fmt.Errorf("Space process shutdown is unconfirmed: %w", err))
		}
		stoppedIDs = append(stoppedIDs, container.DockerID)
	}
	var after []acpSidecarContainer
	if err := runner.call(ctx, "docker.list", map[string]any{"label": "zakura.space=" + space.ID}, &after); err != nil {
		return lease.uncertain(err)
	}
	for _, container := range after {
		if container.Labels["zakura.purpose"] != "workspace" && container.Labels["zakura.purpose"] != "computer" {
			return lease.uncertain(errors.New("Space process removal was not confirmed"))
		}
	}
	return lease.fenced(ctx, func(tx *gorm.DB) error {
		now := runtimeTimeString(h.store.now())
		if len(stoppedIDs) > 0 {
			if err := tx.Table("managed_containers").Where("tenant_id=? AND space_id=? AND docker_id IN ?", space.TenantID, space.ID, stoppedIDs).Updates(map[string]any{"status": "removed", "docker_id": nil, "updated_at": now}).Error; err != nil {
				return err
			}
		}
		// A missing container does not establish that an outstanding remote
		// operation ended. Keep unmatched durable rows for explicit recovery.
		var unresolved int64
		if err := tx.Table("managed_containers").Where("tenant_id=? AND space_id=? AND purpose<>'workspace' AND (status<>'removed' OR docker_id IS NOT NULL)", space.TenantID, space.ID).Count(&unresolved).Error; err != nil {
			return err
		}
		if unresolved != 0 {
			return errors.New("a previous Space process operation must be reconciled before migration")
		}
		return tx.Table("component_instances").Where("tenant_id=? AND component_type='mcp' AND status='running' AND id IN (SELECT instance_id FROM managed_containers WHERE tenant_id=? AND space_id=? AND purpose='component')", space.TenantID, space.TenantID, space.ID).Updates(map[string]any{"status": "stopped", "updated_at": now}).Error
	})
}
