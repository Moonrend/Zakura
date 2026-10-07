package rpc

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Moonrend/Zakura/apps/agent/internal/sandbox"
)

var sandboxSpaceID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// The authenticated control plane supplies the space identity. Never accept an
// arbitrary root, a storage-root fallback, or a symlink into another workspace.
func (h *Handler) sandboxRoot(spaceID string) (string, error) {
	if !sandboxSpaceID.MatchString(spaceID) {
		return "", fmt.Errorf("a valid spaceId is required for sandbox execution")
	}
	root, err := filepath.Abs(h.StorageRoot)
	if err != nil || h.StorageRoot == "" {
		return "", fmt.Errorf("sandbox storage root is unavailable")
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil || resolved != root {
		return "", fmt.Errorf("sandbox storage root must be an existing non-symlink directory")
	}
	for _, part := range []string{"spaces", spaceID, "workspace"} {
		root = filepath.Join(root, part)
		if err := os.Mkdir(root, 0755); err != nil && !os.IsExist(err) {
			return "", fmt.Errorf("sandbox workspace is unavailable")
		}
		info, err := os.Lstat(root)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("sandbox workspace must use real directories")
		}
	}
	return root, nil
}

type sandboxRequest struct {
	sandbox.ExecParams
	SpaceID string `json:"spaceId"`
}

func (h *Handler) sandboxExecContext(ctx context.Context, raw json.RawMessage) (any, error) {
	var p sandboxRequest
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid sandbox execution parameters")
	}
	root, err := h.sandboxRoot(p.SpaceID)
	if err != nil {
		return nil, err
	}
	return sandbox.Run(ctx, root, p.ExecParams)
}

func (h *Handler) sandboxExecStart(raw json.RawMessage) (any, error) {
	var p sandboxRequest
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid sandbox execution parameters")
	}
	root, err := h.sandboxRoot(p.SpaceID)
	if err != nil {
		return nil, err
	}
	return h.sandboxJobs.Start(root, p.ExecParams)
}

func (h *Handler) sandboxJob(raw json.RawMessage, cancel bool) (any, error) {
	var p struct {
		ID      string `json:"id"`
		SpaceID string `json:"spaceId"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid sandbox job parameters")
	}
	root, err := h.sandboxRoot(p.SpaceID)
	if err != nil {
		return nil, err
	}
	var snap *sandbox.JobSnap
	if cancel {
		snap = h.sandboxJobs.KillScoped(p.ID, root)
	} else {
		snap = h.sandboxJobs.GetScoped(p.ID, root)
	}
	if snap == nil {
		return nil, fmt.Errorf("sandbox job not found")
	}
	return snap, nil
}

// Enforcement is captured when the authenticated runner handler is created.
// A request can select stronger isolation but cannot turn operator policy off.
func (h *Handler) sandboxRequested(raw json.RawMessage) (bool, error) {
	var p struct {
		ExecutionMode string `json:"executionMode"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return false, fmt.Errorf("invalid execution policy parameters")
	}
	if p.ExecutionMode != "" && p.ExecutionMode != "host" && p.ExecutionMode != "sandbox" {
		return false, fmt.Errorf("executionMode must be host or sandbox")
	}
	return h.sandboxEnforced || p.ExecutionMode == "sandbox", nil
}

func executionResult(value any, mode string) (any, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	result := map[string]any{}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	result["executionMode"] = mode
	result["isolated"] = mode == "sandbox"
	return result, nil
}

func (h *Handler) execWithPolicy(ctx context.Context, raw json.RawMessage, start bool) (any, error) {
	enabled, err := h.sandboxRequested(raw)
	if err != nil {
		return nil, err
	}
	var result any
	mode := "host"
	if enabled {
		mode = "sandbox"
		if start {
			result, err = h.sandboxExecStart(raw)
		} else {
			result, err = h.sandboxExecContext(ctx, raw)
		}
	} else {
		if start {
			result, err = h.hostExecStart(raw)
		} else {
			result, err = h.hostExec(raw)
		}
	}
	if err != nil {
		return nil, err
	}
	return executionResult(result, mode)
}

func (h *Handler) jobWithPolicy(raw json.RawMessage, cancel bool) (any, error) {
	enabled, err := h.sandboxRequested(raw)
	if err != nil {
		return nil, err
	}
	var result any
	mode := "host"
	if enabled {
		mode = "sandbox"
		result, err = h.sandboxJob(raw, cancel)
	} else if cancel {
		result, err = h.hostExecKill(raw)
	} else {
		result, err = h.hostExecGet(raw)
	}
	if err != nil {
		return nil, err
	}
	return executionResult(result, mode)
}

// Unknown nonempty values fail closed rather than silently turning policy off.
func sandboxEnforcement(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && !strings.EqualFold(value, "false") && value != "0"
}
