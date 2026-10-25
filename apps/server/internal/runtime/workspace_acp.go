package runtime

import (
	"context"
	"encoding/json"
	"errors"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
	"gorm.io/gorm"
)

func checkACPSessionWorkspace(origin json.RawMessage, exec *resolvedExecution) error {
	var saved struct {
		Target    *protocol.Target `json:"acpWorkspaceTarget"`
		RuntimeID string           `json:"acpRuntimeId"`
	}
	if len(origin) != 0 && json.Unmarshal(origin, &saved) != nil {
		return errors.New("invalid ACP session origin")
	}
	if saved.Target != nil {
		if exec.workspace == nil || *saved.Target != exec.workspace.Target {
			return workspaces.ErrTargetRevoked
		}
	} else if saved.RuntimeID != "" && exec.workspace != nil {
		return errors.New("ACP session predates this workspace; start a new session")
	}
	return nil
}

// Persist before any adapter or credential effect, including uncertain startup.
// A restart therefore cannot silently recreate this session on a replacement disk.
func (h *handler) pinACPSessionWorkspace(ctx context.Context, lease *workspaceLease, agent, sid string, exec *resolvedExecution) error {
	if exec.workspace == nil {
		return nil
	}
	return lease.fenced(ctx, func(tx *gorm.DB) error {
		var row struct {
			Origin string `gorm:"column:origin_json"`
		}
		query := tx.Table("cloud_agent_sessions").Where("tenant_id=? AND agent_id=? AND id=?", exec.computer.TenantID, agent, sid)
		if err := query.Select("COALESCE(origin_json,'{}') AS origin_json").Take(&row).Error; err != nil {
			return err
		}
		if err := checkACPSessionWorkspace(json.RawMessage(row.Origin), exec); err != nil {
			return err
		}
		origin := map[string]any{}
		if err := json.Unmarshal([]byte(row.Origin), &origin); err != nil || origin == nil {
			return errors.New("invalid ACP session origin")
		}
		origin["acpWorkspaceTarget"] = exec.workspace.Target
		raw, err := json.Marshal(origin)
		if err != nil {
			return err
		}
		result := tx.Table("cloud_agent_sessions").Where("tenant_id=? AND agent_id=? AND id=? AND COALESCE(origin_json,'{}')=?", exec.computer.TenantID, agent, sid, row.Origin).Update("origin_json", string(raw))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return workspaces.ErrConflict
		}
		return nil
	})
}

func (target *acpLoginTarget) closeStream(ctx context.Context, id string) error {
	if target.exec.workspace != nil {
		return closePinnedWorkspaceStream(ctx, target.runner, "docker.exec.close", id, target.streamOwner, target.exec.workspace)
	}
	return target.runner.call(ctx, "docker.exec.close", map[string]any{"id": id}, nil)
}

func (rt *acpLiveRuntime) workspaceRemote() *remoteWorkspace {
	if rt.remote != nil {
		return rt.remote
	}
	return &remoteWorkspace{runner: rt.runner, spaceID: rt.spaceID}
}

func (rt *acpLiveRuntime) workspaceContext(ctx context.Context) context.Context {
	space := Space{ID: rt.spaceID, TenantID: rt.tenantID}
	if rt.remote != nil && rt.remote.workspace != nil {
		target := rt.remote.workspace.Target
		space.CurrentWorkspaceInstanceID, space.WorkspaceGeneration = &target.InstanceID, target.Generation
	}
	return context.WithValue(ctx, workspaceRequestTargetKey{}, space)
}

func (rt *acpLiveRuntime) validateWorkspace(ctx context.Context) error {
	if rt.remote != nil && rt.remote.validate != nil {
		return rt.remote.validate(ctx)
	}
	return nil
}

func (rt *acpLiveRuntime) closeWorkspaceStream(ctx context.Context, method, id string) error {
	if rt.remote != nil && rt.remote.workspace != nil {
		return closePinnedWorkspaceStream(ctx, rt.runner, method, id, rt.streamOwner, rt.remote.workspace)
	}
	return rt.runner.call(ctx, method, map[string]any{"id": id}, nil)
}

func (rt *acpLiveRuntime) workspaceSpace(ctx context.Context) (Space, error) {
	space, err := rt.manager.h.store.GetSpace(ctx, rt.tenantID, rt.spaceID)
	if err != nil {
		return Space{}, err
	}
	if err := rt.validateWorkspace(ctx); err != nil {
		return Space{}, err
	}
	if rt.remote != nil && rt.remote.workspace != nil {
		target := rt.remote.workspace.Target
		if space.CurrentWorkspaceInstanceID == nil || *space.CurrentWorkspaceInstanceID != target.InstanceID || space.WorkspaceGeneration != target.Generation {
			return Space{}, workspaces.ErrTargetRevoked
		}
	}
	return space, nil
}
