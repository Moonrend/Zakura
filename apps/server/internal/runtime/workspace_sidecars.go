package runtime

import (
	"context"
	"errors"
	"path"
	"strings"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"

	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

// Sidecars use the same disk and durable writer ledger as the primary container.
// The name is also the operation identity: an uncertain retry cannot create a
// second writer with the same name but a different receipt.
func (h *handler) createWorkspaceSidecar(ctx context.Context, runner *runnerSession, exec *resolvedExecution, params map[string]any, out any) error {
	if exec.workspace == nil {
		root, err := h.serverComputerHostRoot(ctx, exec)
		if err != nil {
			return err
		}
		params["volumes"] = []workspaceMount{{HostPath: root, ContainerPath: "/workspace"}}
		return runner.call(ctx, "docker.create", params, out)
	}
	remote, err := h.remotePinnedWorkspace(ctx, exec)
	if err != nil {
		return err
	}
	if remote.runner != runner {
		return errors.New("workspace node connection changed")
	}
	mount, err := remote.mount(ctx)
	if err != nil {
		return err
	}
	name, _ := params["name"].(string)
	labels, _ := params["labels"].(map[string]string)
	purpose := labels["zakura.purpose"]
	if purpose != "acp-adapter" && purpose != "acp-login" && purpose != "component" {
		return errors.New("unsupported workspace sidecar purpose")
	}
	if purpose == "component" {
		component := labels["zakura.instance"]
		if !protocol.ValidIdentity(component) {
			return errors.New("component identity required")
		}
		mount.ContainerPath = "/data"
		if mount.VolumeName != "" {
			mount.VolumeSubpath = path.Join(mount.VolumeSubpath, ".zakura", "components", component)
		} else {
			mount.HostPath = strings.TrimRight(mount.HostPath, "/\\") + "/.zakura/components/" + component
		}
	}
	op := workspaceCreateOperation{OperationID: name, TenantID: exec.computer.TenantID, SpaceID: exec.spaceID, ComputerID: exec.computer.ID, target: &exec.workspace.Target}
	owned := op.labels()
	for key, value := range labels {
		if expected, reserved := owned[key]; reserved && key != "zakura.purpose" && value != expected {
			return workspaces.ErrConflict
		}
		owned[key] = value
	}
	wire := op.wire()
	wire["purpose"] = purpose
	params["operation"], params["labels"], params["volumes"] = wire, owned, []workspaceMount{mount}
	return remote.call(ctx, "docker.create", params, out)
}

// Removal is a cleanup operation and must remain possible after retirement.
// The agent verifies the original receipt and container ID before acknowledging.
func cleanupWorkspaceContainer(ctx context.Context, runner *runnerSession, remote *remoteWorkspace, id string) error {
	params := map[string]any{"id": id, "remove": true}
	if remote != nil && remote.workspace != nil {
		params["workspace"] = *remote.workspace
		var ack struct {
			OK bool `json:"ok"`
		}
		if err := runner.call(ctx, "docker.stop", params, &ack); err != nil {
			return err
		}
		if !ack.OK {
			return errors.New("workspace container cleanup was not acknowledged")
		}
		return nil
	}
	return runner.call(ctx, "docker.stop", params, nil)
}

func (h *handler) executionRemote(runner *runnerSession, exec *resolvedExecution) *remoteWorkspace {
	return &remoteWorkspace{runner: runner, spaceID: exec.spaceID, workspace: exec.workspace,
		validate: func(ctx context.Context) error { return h.validateWorkspaceExecution(ctx, exec) }}
}
