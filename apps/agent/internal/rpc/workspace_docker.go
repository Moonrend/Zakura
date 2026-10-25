package rpc

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"

	"github.com/Moonrend/Zakura/apps/agent/internal/statefs"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
	"github.com/Moonrend/Zakura/apps/agent/internal/workspacestate"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

func componentWorkspaceMount(mount docker.Volume, component string) docker.Volume {
	mount.ContainerPath = "/data"
	if mount.VolumeName != "" {
		mount.VolumeSubpath = path.Join(mount.VolumeSubpath, ".zakura", "components", component)
	} else {
		mount.HostPath = filepath.Join(mount.HostPath, ".zakura", "components", component)
	}
	return mount
}

func (h *Handler) workspaceDockerCreate(ctx context.Context, binding protocol.Binding, raw json.RawMessage) (docker.ContainerInfo, error) {
	if requested, err := h.sandboxRequested(raw); err != nil || requested {
		if err != nil {
			return docker.ContainerInfo{}, err
		}
		return docker.ContainerInfo{}, fmt.Errorf("docker.create is unavailable in sandbox mode")
	}
	var request struct {
		docker.RunSpec
		Workspace protocol.Binding       `json:"workspace"`
		Operation docker.CreateOperation `json:"operation"`
	}
	if err := decodeDockerCreate(raw, &request); err != nil {
		return docker.ContainerInfo{}, err
	}
	target, op := binding.Target, request.Operation
	if op.InstanceID != target.InstanceID || op.Generation != target.Generation || op.TenantID != target.TenantID || op.SpaceID != target.SpaceID || op.DiskID != target.DiskID || op.LocatorVersion != target.LocatorVersion || op.NodeIncarnation != target.NodeIncarnation {
		return docker.ContainerInfo{}, workspacestate.ErrConflict
	}
	if h.workspaceState.VolumeName != "" {
		if err := docker.VerifyWorkspaceVolume(ctx, h.workspaceState.VolumeName, h.StorageRoot); err != nil {
			return docker.ContainerInfo{}, err
		}
	}
	mount, err := h.workspaceState.Mount(binding.Disk)
	if err != nil {
		return docker.ContainerInfo{}, err
	}
	component := ""
	if op.Purpose == "component" {
		component = request.Labels["zakura.instance"]
		if !protocol.ValidIdentity(component) {
			return docker.ContainerInfo{}, fmt.Errorf("component identity required")
		}
		mount = componentWorkspaceMount(mount, component)
	}
	if len(request.Volumes) != 1 || request.Volumes[0] != mount {
		return docker.ContainerInfo{}, fmt.Errorf("workspace create must mount its exact disk")
	}
	if err := docker.ValidateCreate(request.RunSpec, op); err != nil {
		return docker.ContainerInfo{}, err
	}
	guard, err := h.workspaceState.Begin(ctx, binding)
	if err != nil {
		return docker.ContainerInfo{}, err
	}
	defer guard.Close()
	if component != "" {
		parent := guard.Root
		for _, name := range []string{".zakura", "components", component} {
			child, err := statefs.MakeChild(parent, name, 0755)
			if err != nil {
				return docker.ContainerInfo{}, err
			}
			defer child.Close()
			parent = child
		}
	}
	status := docker.CreateStatusRequest{OperationID: op.ID, TenantID: op.TenantID, SpaceID: op.SpaceID, ComputerID: op.ComputerID, Name: request.Name,
		InstanceID: op.InstanceID, Generation: op.Generation, DiskID: op.DiskID, LocatorVersion: op.LocatorVersion, NodeIncarnation: op.NodeIncarnation, Purpose: op.Purpose}
	effect := workspacestate.Effect{Version: 1, ID: op.ID, Kind: "container", Create: &status}
	if err := guard.RecordEffect(effect); err != nil {
		return docker.ContainerInfo{}, err
	}
	container, err := docker.CreateWithReceipt(ctx, h.workspaceState.StateRoot, request.RunSpec, op)
	if err != nil {
		return docker.ContainerInfo{}, err
	}
	effect.ExternalID = container.DockerID
	if err := guard.RecordEffect(effect); err != nil {
		return docker.ContainerInfo{}, err
	}
	return container, nil
}
