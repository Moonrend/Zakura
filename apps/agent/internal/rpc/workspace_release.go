package rpc

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
	"github.com/Moonrend/Zakura/apps/agent/internal/workspacestate"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

func (h *Handler) releaseWorkspace(ctx context.Context, b protocol.Binding) (any, error) {
	guard, err := h.workspaceState.BeginRelease(ctx, b)
	if err != nil {
		return nil, err
	}
	defer guard.Close()
	effects, err := guard.Effects()
	if err != nil {
		return nil, err
	}
	for _, effect := range effects {
		if effect.Released {
			continue
		}
		if effect.Kind != "container" || effect.Create == nil {
			return nil, fmt.Errorf("workspace still has unconfirmed writers")
		}
		request := *effect.Create
		if !workspaceEffectMatches(effect, b.Target) {
			return nil, workspacestate.ErrConflict
		}
		status, err := docker.CreateReceiptStatus(ctx, h.workspaceState.StateRoot, request)
		if err != nil {
			return nil, err
		}
		// Unknown means an effect may still arrive. A list miss never resolves
		// that ambiguity and cannot authorize reusing the disk.
		if status.State != "committed" || status.Container == nil {
			return nil, fmt.Errorf("workspace creation is still unconfirmed")
		}
		container := *status.Container
		if effect.ExternalID != "" && effect.ExternalID != container.DockerID {
			return nil, workspacestate.ErrConflict
		}
		if err := removeReceiptContainer(ctx, container); err != nil {
			return nil, err
		}
		if err := guard.ConfirmEffectReleased(effect); err != nil {
			return nil, err
		}
	}
	// Removing the exact container terminates its exec writers even when the
	// node lost their transport state during a restart. Close remaining local
	// transports only after that durable container obligation is resolved.
	h.mu.Lock()
	var streams []string
	for id, binding := range h.workspaceStreams {
		if binding == b {
			streams = append(streams, id)
		}
	}
	h.mu.Unlock()
	for _, id := range streams {
		raw, _ := json.Marshal(map[string]string{"id": id})
		if err := h.ptyClose(raw); err != nil {
			return nil, err
		}
	}
	if b.Disk.Locator.Kind == "legacy-bind" {
		// Adoption still needs the existing process/sidecar and v1 receipt
		// inventory. An empty new ledger cannot attest those writers stopped.
		return nil, fmt.Errorf("legacy workspace writers require reconciliation")
	}
	if err := h.workspaceState.CompleteRelease(ctx, guard); err != nil {
		return nil, err
	}
	return map[string]any{"target": b.Target, "released": true}, nil
}

func (h *Handler) cleanupWorkspaceContainer(ctx context.Context, b protocol.Binding, id string) error {
	if id == "" {
		return fmt.Errorf("exact container ID required")
	}
	guard, err := h.workspaceState.BeginEffectCleanup(ctx, b)
	if err != nil {
		return err
	}
	defer guard.Close()
	effects, err := guard.Effects()
	if err != nil {
		return err
	}
	for _, effect := range effects {
		if !workspaceEffectMatches(effect, b.Target) {
			continue
		}
		status, err := docker.CreateReceiptStatus(ctx, h.workspaceState.StateRoot, *effect.Create)
		if err != nil {
			return err
		}
		if status.State != "committed" || status.Container == nil {
			return fmt.Errorf("workspace creation is still unconfirmed")
		}
		if status.Container.DockerID != id {
			continue
		}
		if effect.ExternalID != "" && effect.ExternalID != id {
			return workspacestate.ErrConflict
		}
		if effect.Released {
			return nil
		}
		if err := removeReceiptContainer(ctx, *status.Container); err != nil {
			return err
		}
		return guard.ConfirmEffectReleased(effect)
	}
	return fmt.Errorf("container does not belong to the pinned workspace instance")
}

func removeReceiptContainer(ctx context.Context, expected docker.ContainerInfo) error {
	// List inspects every entry and rejects partial results. Only exact Docker
	// identity and all persisted ownership labels authorize removal.
	containers, err := docker.List(ctx, "")
	if err != nil {
		return err
	}
	present := false
	for _, actual := range containers {
		if actual.DockerID != expected.DockerID {
			continue
		}
		if actual.Name != expected.Name {
			return workspacestate.ErrConflict
		}
		for key, value := range expected.Labels {
			if actual.Labels[key] != value {
				return workspacestate.ErrConflict
			}
		}
		present = true
	}
	if !present {
		return nil
	}
	if err := docker.Stop(ctx, expected.DockerID, true); err != nil {
		return err
	}
	remaining, err := docker.List(ctx, "")
	if err != nil {
		return err
	}
	for _, actual := range remaining {
		if actual.DockerID == expected.DockerID {
			return fmt.Errorf("workspace container removal is unconfirmed")
		}
	}
	return nil
}
