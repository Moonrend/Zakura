package runtime

import "context"

func acpRecoveryMatchesSpace(state acpAuthRecoveryState, space Space) bool {
	if state.WorkspaceInstanceID == "" {
		return space.CurrentWorkspaceInstanceID == nil && space.WorkspaceGeneration == 0
	}
	return space.CurrentWorkspaceInstanceID != nil && *space.CurrentWorkspaceInstanceID == state.WorkspaceInstanceID && space.WorkspaceGeneration == state.WorkspaceGeneration
}

func (h *handler) validateACPRecoveryInstance(ctx context.Context, tenant, space string, state acpAuthRecoveryState) error {
	current, err := h.store.GetSpace(ctx, tenant, space)
	if err != nil {
		return err
	}
	if !acpRecoveryMatchesSpace(state, current) {
		return errACPAuthLockLost
	}
	return nil
}
