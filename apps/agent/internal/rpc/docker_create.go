package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
)

func decodeDockerCreate(raw json.RawMessage, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("docker.create requires exactly one JSON object")
	}
	return nil
}

func (h *Handler) dockerCreate(ctx context.Context, raw json.RawMessage) (docker.ContainerInfo, error) {
	var request struct {
		docker.RunSpec
		Operation *docker.CreateOperation `json:"operation,omitempty"`
	}
	if err := decodeDockerCreate(raw, &request); err != nil {
		return docker.ContainerInfo{}, err
	}
	if request.Operation == nil {
		return docker.Create(ctx, request.RunSpec)
	}
	if request.Operation.InstanceID != "" {
		return docker.ContainerInfo{}, fmt.Errorf("workspace v2 creation requires a pinned workspace binding")
	}
	return docker.CreateWithReceipt(ctx, h.StorageRoot, request.RunSpec, *request.Operation)
}

func (h *Handler) dockerCreateStatus(ctx context.Context, raw json.RawMessage) (docker.CreateStatus, error) {
	var request docker.CreateStatusRequest
	if err := decodeDockerCreate(raw, &request); err != nil {
		return docker.CreateStatus{}, err
	}
	root := h.StorageRoot
	if request.InstanceID != "" {
		root = h.workspaceState.StateRoot
	}
	return docker.CreateReceiptStatus(ctx, root, request)
}
