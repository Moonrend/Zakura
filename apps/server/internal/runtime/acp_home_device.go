// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import "context"

// Device credentials are not generated API-key files and must never be entered
// into the cleanup manifest. An existing OAuth credential requires explicit user
// action rather than being silently replaced by another device authorization.
func (h *handler) requireEmptyACPDeviceAuth(ctx context.Context, runner *runnerSession, exec *resolvedExecution, profile string) error {
	fs := acpManagedFS{call: runner.call, space: exec.spaceID, home: "/workspace/.zakura/acp/" + profile + "/home"}
	_, exists, err := fs.inspect(ctx, fs.home+"/.codex/auth.json")
	if err != nil {
		return err
	}
	if exists {
		return acpManagedConflict()
	}
	return nil
}
