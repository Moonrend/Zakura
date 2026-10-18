// Package executor exposes the Agent RPC implementation to trusted in-process
// transports. Authorization and node selection remain the caller's responsibility.
package executor

import (
	"context"
	"sync"

	"github.com/Moonrend/Zakura/apps/agent/internal/rpc"
)

// Message is the same wire message used by the remote Agent transport.
type Message = rpc.Msg

type Executor struct {
	handler *rpc.Handler
	mu      sync.Mutex
	closed  bool
	active  map[string]context.CancelFunc
	wg      sync.WaitGroup
}

func New(kind, storageRoot string) *Executor {
	return &Executor{handler: rpc.New(kind, storageRoot), active: map[string]context.CancelFunc{}}
}

// Dispatch forwards every response and stream event, including events emitted
// after the start response. It is safe to dispatch concurrent requests.
func (e *Executor) Dispatch(ctx context.Context, msg Message, send func(Message)) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	e.mu.Lock()
	if e.closed || e.active[msg.ID] != nil {
		e.mu.Unlock()
		send(rpc.Err(msg.ID, "executor is closed or request ID is already active"))
		return
	}
	e.active[msg.ID] = cancel
	e.wg.Add(1)
	e.mu.Unlock()
	defer func() { e.mu.Lock(); delete(e.active, msg.ID); e.mu.Unlock(); e.wg.Done() }()
	e.handler.Dispatch(ctx, msg, send)
}

func (e *Executor) Cancel(id string) {
	e.mu.Lock()
	cancel := e.active[id]
	e.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Close cancels calls, waits for in-flight stream allocation, then closes all
// interactive processes. It is idempotent and must not run inside send.
func (e *Executor) Close() {
	e.mu.Lock()
	e.closed = true
	for _, cancel := range e.active {
		cancel()
	}
	e.mu.Unlock()
	e.wg.Wait()
	e.handler.CloseStreams()
}
