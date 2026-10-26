// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"time"
)

// finalizeACPLoginContainer observes exact ownership both before and after
// removal. A transport timeout is not proof the remote login process stopped.
// Callers must retain the profile lease whenever this returns an error.
func (h *handler) finalizeACPLoginContainer(target *acpLoginTarget, name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if target.exec != nil && target.exec.workspace != nil {
		op := workspaceCreateOperation{OperationID: name, TenantID: target.exec.computer.TenantID, SpaceID: target.exec.spaceID, ComputerID: target.exec.computer.ID, Name: name, target: &target.exec.workspace.Target}
		params := op.wire()
		delete(params, "id")
		params["operationId"], params["name"], params["purpose"] = name, name, "acp-login"
		var receipt struct {
			State     string
			Container *acpSidecarContainer
		}
		if err := target.runner.call(ctx, "docker.create.status", params, &receipt); err != nil {
			return err
		}
		if receipt.State != "committed" || receipt.Container == nil || receipt.Container.DockerID == "" {
			return errors.New("login creation is still unconfirmed")
		}
		return cleanupWorkspaceContainer(ctx, target.runner, h.executionRemote(target.runner, target.exec), receipt.Container.DockerID)
	}
	expected := acpLoginLabels(target.ticket, name)
	owned := func(c acpSidecarContainer) bool {
		if c.DockerID == "" {
			return false
		}
		for key, value := range expected {
			if c.Labels[key] != value {
				return false
			}
		}
		return true
	}
	var before []acpSidecarContainer
	if err := target.runner.call(ctx, "docker.list", map[string]any{"label": "zakura.login=" + name}, &before); err != nil {
		return err
	}
	for _, container := range before {
		if owned(container) {
			if err := target.runner.call(ctx, "docker.stop", map[string]any{"id": container.DockerID, "remove": true}, nil); err != nil {
				return err
			}
		}
	}
	var after []acpSidecarContainer
	if err := target.runner.call(ctx, "docker.list", map[string]any{"label": "zakura.login=" + name}, &after); err != nil {
		return err
	}
	for _, container := range after {
		if owned(container) {
			return errors.New("login container removal is not confirmed")
		}
	}
	return nil
}
