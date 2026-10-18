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
