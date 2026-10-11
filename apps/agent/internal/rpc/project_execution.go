package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Moonrend/Zakura/apps/agent/internal/host"
	"github.com/Moonrend/Zakura/apps/agent/internal/projectrunner"
)

func (h *Handler) projectDispatch(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	return h.projects.Dispatch(ctx, method, raw)
}

// Source capture/merge and legacy filesystem calls share a space lock. This
// coordinates trusted API writes; arbitrary out-of-band host processes remain
// outside the runner's authority and are detected by source snapshot CAS.
func (h *Handler) lockFilesystemRPC(method string, raw json.RawMessage) (func(), error) {
	if !strings.HasPrefix(method, "host.fs.") {
		return func() {}, nil
	}
	var p spacePath
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.SpaceID == "" {
		return func() {}, nil
	}
	if err := projectrunner.ValidateID(p.SpaceID); err != nil {
		return nil, err
	}
	return h.projects.LockSpace(p.SpaceID)
}

// sourceProcessLease registers before process launch and follows its real
// foreground lifetime after an asynchronous RPC response has already returned.
type sourceProcessLease struct {
	handler *Handler
	method  string
	release func()
}

func (h *Handler) beginSourceProcess(msg Msg) (*sourceProcessLease, error) {
	switch msg.Method {
	case "host.exec", "host.exec.start", "host.pty.start":
	default:
		return nil, nil
	}
	isolated, err := h.sandboxRequested(msg.Params)
	if err != nil {
		return nil, err
	}
	if isolated {
		return nil, nil
	}
	var req struct {
		SpaceID string `json:"spaceId"`
	}
	if err := json.Unmarshal(msg.Params, &req); err != nil {
		return nil, err
	}
	release, err := h.projects.BeginSourceProcess(req.SpaceID)
	if err != nil {
		return nil, err
	}
	return &sourceProcessLease{handler: h, method: msg.Method, release: release}, nil
}
func (l *sourceProcessLease) complete(result any, operationErr error) {
	if l == nil {
		return
	}
	if errors.Is(operationErr, host.ErrSourceGroupUnknown) {
		return
	}
	if operationErr != nil || l.method == "host.exec" {
		l.release()
		return
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return
	}
	var identity struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(encoded, &identity) != nil || identity.ID == "" {
		return
	}
	if l.method == "host.exec.start" {
		done := l.handler.jobs.Done(identity.ID)
		if done == nil {
			return
		}
		go func() { <-done; l.release() }()
		return
	}
	l.handler.mu.Lock()
	session := l.handler.ptys[identity.ID]
	l.handler.mu.Unlock()
	if session == nil || session.Cmd == nil {
		return
	}
	go func() {
		_ = session.Cmd.Wait()
		if host.WaitSourceProcessGroup(context.Background(), session.Cmd) == nil {
			l.release()
		}
	}()
}
