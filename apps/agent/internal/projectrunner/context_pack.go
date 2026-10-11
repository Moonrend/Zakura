package projectrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/contextpack"
)

type contextRequest struct {
	Scope
	contextpack.Request
}

func decodeContextRequest(raw json.RawMessage) (contextRequest, error) {
	var req contextRequest
	if len(raw) == 0 || len(raw) > 32768 {
		return req, errors.New("context request exceeds limit")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&req); err != nil {
		return req, errors.New("invalid context parameters")
	}
	if d.Decode(new(any)) != io.EOF {
		return req, errors.New("single context object required")
	}
	if err := req.Scope.Validate(); err != nil {
		return req, err
	}
	if err := contextpack.Validate(req.Request); err != nil {
		return req, err
	}
	return req, nil
}

// ContextDispatch is read-only. Snapshot/seeds are constructed by the server
// from a scoped frozen task; model arguments never enter this RPC directly.
func (m *Manager) ContextDispatch(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	if method != "project.context.pack" {
		return nil, errors.New("unknown project context method")
	}
	req, err := decodeContextRequest(raw)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := m.get(req.Scope)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// Immutable repository reads have their own context-aware lock; do not
	// queue this read behind mutable project operations with an uncancellable mutex.
	pack, err := contextpack.Build(ctx, semanticSource{p.repository}, req.Request)
	if err != nil {
		return nil, err
	}
	// Recheck the actual default JSON encoding used by runner.call. This guard
	// covers metadata additions as well as source snippet bytes.
	encoded, err := json.Marshal(pack)
	if err != nil {
		return nil, err
	}
	if len(encoded) > pack.MaxBytes || len(encoded) > contextpack.MaxOutputBytes || pack.Bytes != len(encoded) {
		return nil, errors.New("context output budget invariant failed")
	}
	return pack, nil
}
