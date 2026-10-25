package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

type workspaceRequestTargetKey struct{}

// Run snapshots include the Space workspace even when the selected computer is
// different: an explicit server-computer call must not drift after replacement.
func (h *handler) resolveWorkspaceExecution(ctx context.Context, c computers.Computer, run string) (*resolvedExecution, error) {
	var id sql.NullString
	var generation int64
	var err error
	if run != "" {
		err = h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT workspace_instance_id,workspace_generation FROM run_computer_targets WHERE run_id=? AND tenant_id=? AND space_id=?`), run, c.TenantID, c.SpaceID).Scan(&id, &generation)
	} else if accepted, ok := ctx.Value(workspaceRequestTargetKey{}).(Space); ok && accepted.TenantID == c.TenantID && accepted.ID == c.SpaceID {
		if accepted.CurrentWorkspaceInstanceID != nil {
			id = sql.NullString{String: *accepted.CurrentWorkspaceInstanceID, Valid: true}
		}
		generation = accepted.WorkspaceGeneration
	} else {
		err = h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT current_workspace_instance_id,workspace_generation FROM spaces WHERE tenant_id=? AND id=? AND deletion_pending=FALSE`), c.TenantID, c.SpaceID).Scan(&id, &generation)
	}
	if err != nil {
		return nil, err
	}
	if !id.Valid {
		// Pre-v2 targets remain compatible only until their Space first acquires
		// an instance. Missing binding after retirement is never local fallback.
		var currentGeneration int64
		if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT workspace_generation FROM spaces WHERE tenant_id=? AND id=?`), c.TenantID, c.SpaceID).Scan(&currentGeneration); err != nil {
			return nil, err
		}
		if generation != 0 || currentGeneration != 0 {
			return nil, workspaces.ErrTargetRevoked
		}
		return serverComputerExecution(c), nil
	}
	instance, err := h.workspaceStore().Instance(ctx, c.TenantID, c.SpaceID, id.String)
	if err != nil {
		return nil, err
	}
	if instance.Generation != generation || instance.ComputerID != c.ID {
		return nil, workspaces.ErrTargetRevoked
	}
	_, disk, err := h.workspaceStore().Resolve(ctx, instance.Target)
	if err != nil {
		return nil, err
	}
	exec := serverComputerExecution(c)
	exec.nodeID = instance.NodeID
	exec.computer.RuntimeNodeID = instance.NodeID
	exec.workspace = &protocol.Binding{Target: instance.Target, Disk: disk.Wire()}
	if instance.DockerID != nil {
		exec.containerID = *instance.DockerID
	}
	return exec, nil
}

func (h *handler) validateWorkspaceExecution(ctx context.Context, exec *resolvedExecution) error {
	if exec == nil || exec.workspace == nil {
		return nil
	}
	_, disk, err := h.workspaceStore().Resolve(ctx, exec.workspace.Target)
	if err != nil {
		return err
	}
	if disk.Wire() != exec.workspace.Disk {
		return workspaces.ErrTargetRevoked
	}
	return nil
}

func (h *handler) workspaceInstanceExec(ctx context.Context, exec *resolvedExecution, mode string, timeoutMS int64, command string, args ...string) (map[string]any, error) {
	if mode == "sandbox" {
		return nil, errors.New("sandbox execution requires a host workspace; this workspace mode is unsupported")
	}
	bound, err := h.workspaceInstanceContainer(ctx, exec)
	if err != nil {
		return nil, err
	}
	return h.computerContainerExec(ctx, bound, mode, timeoutMS, command, args...)
}

func (h *handler) workspaceInstanceContainer(ctx context.Context, exec *resolvedExecution) (*resolvedExecution, error) {
	instance, _, err := h.workspaceStore().Resolve(ctx, exec.workspace.Target)
	if err != nil {
		return nil, err
	}
	var config workspaces.Config
	if json.Unmarshal(instance.Config, &config) != nil || config.Kind != "container" {
		return nil, errors.New("managed host execution is not available on this node")
	}
	if err := h.authorizeContextLocalNode(ctx, instance.TenantID, instance.NodeID); err != nil {
		return nil, err
	}
	// Only observe the frozen instance. A replacement in the same Space or on
	// the same node must never be selected by a broad container label search.
	space := Space{ID: instance.SpaceID, TenantID: instance.TenantID, RuntimeNodeID: &instance.NodeID, WorkspaceKind: config.Kind, CurrentWorkspaceInstanceID: &instance.InstanceID, WorkspaceGeneration: instance.Generation}
	obs, err := h.observeSpaceWorkspace(ctx, space)
	if err != nil {
		return nil, err
	}
	if obs.Container.DockerID == "" || obs.Container.Status != "running" {
		return nil, errors.New("workspace container is not running")
	}
	bound := *exec
	bound.containerID = obs.Container.DockerID
	return &bound, nil
}

func (h *handler) remotePinnedWorkspace(ctx context.Context, exec *resolvedExecution) (*remoteWorkspace, error) {
	if err := h.validateWorkspaceExecution(ctx, exec); err != nil {
		return nil, err
	}
	if h.hub == nil {
		return nil, errors.New("runtime node is offline")
	}
	runner, err := h.hub.get(exec.nodeID)
	if err != nil {
		return nil, err
	}
	return &remoteWorkspace{runner: runner, spaceID: exec.spaceID, workspace: exec.workspace, validate: func(ctx context.Context) error { return h.validateWorkspaceExecution(ctx, exec) }}, nil
}
