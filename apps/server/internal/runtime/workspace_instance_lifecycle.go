package runtime

import (
	"context"
	"errors"
	"net/http"
	"strings"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

// A lifecycle lease carries its original instance; resolving it never follows current.
func (l *workspaceLease) remoteWorkspace(ctx context.Context) (*remoteWorkspace, error) {
	if err := l.check(ctx); err != nil {
		return nil, err
	}
	if l.Space.CurrentWorkspaceInstanceID == nil {
		return nil, workspaces.ErrTargetRevoked
	}
	i, err := l.h.workspaceStore().Instance(ctx, l.Space.TenantID, l.Space.ID, *l.Space.CurrentWorkspaceInstanceID)
	if err != nil {
		return nil, err
	}
	if i.Generation != l.Space.WorkspaceGeneration {
		return nil, workspaces.ErrTargetRevoked
	}
	_, d, err := l.h.workspaceStore().Resolve(ctx, i.Target)
	if err != nil {
		return nil, err
	}
	c, err := l.h.serverComputerRecord(ctx, l.Space.TenantID, l.Space.ID)
	if err != nil {
		return nil, err
	}
	exec := serverComputerExecution(c)
	exec.nodeID = i.NodeID
	exec.workspace = &protocol.Binding{Target: i.Target, Disk: d.Wire()}
	return l.h.remotePinnedWorkspace(ctx, exec)
}

func sameWorkspaceInstance(a, b Space) bool {
	if a.WorkspaceGeneration != b.WorkspaceGeneration {
		return false
	}
	if a.CurrentWorkspaceInstanceID == nil || b.CurrentWorkspaceInstanceID == nil {
		return a.CurrentWorkspaceInstanceID == nil && b.CurrentWorkspaceInstanceID == nil
	}
	return *a.CurrentWorkspaceInstanceID == *b.CurrentWorkspaceInstanceID
}

type workspaceMount struct {
	HostPath      string `json:"hostPath,omitempty"`
	VolumeName    string `json:"volumeName,omitempty"`
	VolumeSubpath string `json:"volumeSubpath,omitempty"`
	ContainerPath string `json:"containerPath"`
	NoCopy        bool   `json:"noCopy,omitempty"`
	ReadOnly      bool   `json:"readOnly,omitempty"`
}

func (r *remoteWorkspace) mount(ctx context.Context) (workspaceMount, error) {
	if r.workspace == nil {
		return workspaceMount{}, errors.New("workspace binding required")
	}
	if err := r.validate(ctx); err != nil {
		return workspaceMount{}, err
	}
	var result struct {
		Target protocol.Target `json:"target"`
		Mount  workspaceMount  `json:"mount"`
	}
	if err := r.runner.call(ctx, "workspace.mount", *r.workspace, &result); err != nil {
		return workspaceMount{}, err
	}
	m := result.Mount
	if result.Target != r.workspace.Target || m.ContainerPath != "/workspace" || m.ReadOnly || (m.HostPath == "") == (m.VolumeName == "") {
		return workspaceMount{}, workspaces.ErrUnverified
	}
	if m.VolumeName != "" && (!m.NoCopy || m.VolumeSubpath != r.workspace.Disk.Locator.RelativePath) || m.HostPath != "" && (m.NoCopy || m.VolumeSubpath != "") {
		return workspaceMount{}, workspaces.ErrUnverified
	}
	return m, nil
}

func (h *handler) configureWorkspaceInstance(w http.ResponseWriter, r *http.Request, space Space, in workspaceConfig) {
	ctx := r.Context()
	// Disk allocation has its own durable API intent; selecting it is retry-safe.
	if !protocol.ValidIdentity(in.DiskID) {
		httpx.Error(w, http.StatusBadRequest, "choose a verified data disk before creating a workspace")
		return
	}
	disk, err := h.workspaceStore().Disk(ctx, space.TenantID, space.ID, in.DiskID)
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	if in.RuntimeNodeID != nil && strings.TrimSpace(*in.RuntimeNodeID) != "" && *in.RuntimeNodeID != disk.NodeID {
		httpx.Error(w, http.StatusConflict, "the selected disk belongs to another node")
		return
	}
	if space.CurrentWorkspaceInstanceID != nil {
		current, err := h.workspaceStore().Instance(ctx, space.TenantID, space.ID, *space.CurrentWorkspaceInstanceID)
		if err != nil {
			workspaceStatusError(w, err)
			return
		}
		if current.DiskID != disk.ID {
			httpx.Error(w, http.StatusConflict, "delete the current workspace before selecting another disk")
			return
		}
		state, err := h.serverComputerState(ctx, space.TenantID, space.ID)
		if err != nil {
			workspaceStatusError(w, err)
			return
		}
		httpx.JSON(w, http.StatusOK, state)
		return
	}
	if space.WorkspaceGeneration == 0 && space.RuntimeNodeID != nil && *space.RuntimeNodeID != "" {
		httpx.Error(w, http.StatusConflict, "the existing workspace must be adopted before selecting a data disk")
		return
	}
	runner, incarnation, err := h.workspaceDiskNode(ctx, space.TenantID, disk.NodeID)
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	if incarnation != disk.NodeIncarnation {
		workspaceStatusError(w, workspaces.ErrUnverified)
		return
	}
	image := serverComputerImage
	if in.WorkspaceImage != nil && strings.TrimSpace(*in.WorkspaceImage) != "" {
		image = strings.TrimSpace(*in.WorkspaceImage)
	}
	config := workspaces.Config{Kind: "container", Image: image, EnableComputer: in.EnableComputer}
	in.RuntimeNodeID, in.WorkspaceKind, in.WorkspaceImage = &disk.NodeID, config.Kind, &image
	lease, err := h.acquireSpaceWorkspace(ctx, space.TenantID, space.ID, "configuring", true, &in)
	if err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	defer lease.release()
	instance, err := h.workspaceStore().Attach(ctx, space.TenantID, space.ID, h.store.id(), disk.ID, lease.Token, config, h.store.now())
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	// Update the lease snapshot from our committed result, never by re-reading current.
	lease.Space.CurrentWorkspaceInstanceID = &instance.InstanceID
	lease.Space.WorkspaceGeneration = instance.Generation
	lease.Space.RuntimeNodeID = &instance.NodeID
	lease.Space.WorkspaceKind, lease.Space.WorkspaceImage, lease.Space.EnableComputer = config.Kind, &image, config.EnableComputer
	binding := protocol.Binding{Target: instance.Target, Disk: disk.Wire()}
	lease.retained = true
	var ack struct {
		Target protocol.Target `json:"target"`
		OK     bool            `json:"ok"`
	}
	err = runner.call(ctx, "workspace.attach", binding, &ack)
	if err == nil && (!ack.OK || ack.Target != instance.Target) {
		err = workspaces.ErrUnverified
	}
	if err != nil {
		h.serverComputerLifecycleError(w, lease.uncertain(err))
		return
	}
	if err = lease.finish(ctx, "stopped", nil); err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	state, err := h.serverComputerState(ctx, space.TenantID, space.ID)
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, state)
}
