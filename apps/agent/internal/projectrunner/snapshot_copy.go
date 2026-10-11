// SPDX-License-Identifier: AGPL-3.0-or-later
package projectrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/Moonrend/Zakura/packages/projectkit/delivery"
)

type snapshotCopyRequest struct {
	Scope
	OperationID     string `json:"operationId"`
	SourceProjectID string `json:"sourceProjectId"`
	SnapshotID      string `json:"snapshotId"`
}

// SnapshotCopyDispatch copies immutable CAS objects within one space. The
// control plane authenticates tenant/source/target relationships; this runner
// does not accept a source space, host path, alternate manager or mount.
func (m *Manager) SnapshotCopyDispatch(ctx context.Context, raw json.RawMessage) (any, error) {
	if len(raw) == 0 || len(raw) > 4096 {
		return nil, errors.New("invalid snapshot copy request size")
	}
	var req snapshotCopyRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&req) != nil {
		return nil, errors.New("invalid snapshot copy parameters")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errors.New("snapshot copy requires exactly one object")
	}
	if err := req.Scope.Validate(); err != nil {
		return nil, err
	}
	if err := ValidateID(req.OperationID); err != nil {
		return nil, err
	}
	if err := ValidateID(req.SourceProjectID); err != nil {
		return nil, err
	}
	source, err := m.get(Scope{SpaceID: req.SpaceID, ProjectID: req.SourceProjectID})
	if err != nil {
		return nil, err
	}
	target, err := m.get(req.Scope)
	if err != nil {
		return nil, err
	}
	// Only the target project mutex is held. Export and Import each acquire
	// their own immutable repository lock sequentially, so opposite concurrent
	// A→B/B→A copies cannot create a two-project lock-order deadlock.
	target.mu.Lock()
	defer target.mu.Unlock()
	return runJournal(ctx, target, req.OperationID, "project.snapshot.copy", raw, func() (any, error) {
		snapshot, err := source.repository.GetSnapshot(ctx, req.SnapshotID)
		if err != nil {
			return nil, err
		}
		if source == target {
			return map[string]any{"snapshotId": snapshot.ID}, nil
		}
		dir, err := SecureDirectory(target.root, "snapshot-copies")
		if err != nil {
			return nil, err
		}
		payload, err := os.CreateTemp(dir, ".copy-")
		if err != nil {
			return nil, err
		}
		defer os.Remove(payload.Name())
		defer payload.Close()
		if err := payload.Chmod(0600); err != nil {
			return nil, err
		}
		bounded := &deliveryBoundWriter{w: payload, remaining: delivery.MaxArchiveBytes}
		if err := source.repository.Export(ctx, snapshot.ID, bounded); err != nil {
			return nil, err
		}
		if _, err := payload.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
		imported, err := target.repository.Import(ctx, payload)
		if err != nil {
			return nil, err
		}
		if imported.ID != snapshot.ID {
			return nil, fmt.Errorf("copied snapshot identity changed")
		}
		return map[string]any{"snapshotId": imported.ID}, nil
	})
}
