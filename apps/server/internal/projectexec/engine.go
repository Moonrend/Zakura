// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

// Engine does not hold authoritative execution state in memory. The map below
// only expedites local cancellation; another replica observes controls through
// its next fenced database operation or lease renewal.
type Engine struct {
	store      *Store
	executor   mission.Executor
	workspaces mission.WorkspaceProvider
	config     EngineConfig
	initError  error
	mu         sync.Mutex
	started    bool
	closed     bool
	cancel     context.CancelFunc
	done       chan struct{}
	active     map[string]map[string]context.CancelFunc
	runTenants map[string]string
}

func NewEngine(store *Store, executor mission.Executor, workspaces mission.WorkspaceProvider, config EngineConfig) *Engine {
	d := DefaultEngineConfig()
	if config.Workers == 0 {
		config.Workers = d.Workers
	}
	if config.Lease == 0 {
		config.Lease = d.Lease
	}
	if config.HeartbeatInterval == 0 {
		config.HeartbeatInterval = config.Lease / 3
	}
	if config.PollInterval == 0 {
		config.PollInterval = d.PollInterval
	}
	if config.MaxTurns == 0 {
		config.MaxTurns = d.MaxTurns
	}
	if config.MaxDecisionTokens == 0 {
		config.MaxDecisionTokens = d.MaxDecisionTokens
	}
	e := &Engine{store: store, executor: executor, workspaces: workspaces, config: config, done: make(chan struct{}), active: make(map[string]map[string]context.CancelFunc), runTenants: make(map[string]string)}
	if store == nil || executor == nil || workspaces == nil {
		e.initError = errors.New("project execution store, executor and workspace provider are required")
	} else if config.Workers < 1 || config.Workers > 64 || config.Lease < 100*time.Millisecond || config.Lease > time.Hour || config.HeartbeatInterval <= 0 || config.HeartbeatInterval >= config.Lease || config.PollInterval <= 0 || config.PollInterval > time.Minute || config.MaxTurns < 1 || config.MaxTurns > 10000 || config.MaxDecisionTokens < 1 || config.MaxDecisionTokens > 1000000 {
		e.initError = errors.New("invalid project execution worker configuration")
	}
	if config.WorkerID == "" {
		var nonce [16]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			e.initError = fmt.Errorf("allocate worker identity: %w", err)
		} else {
			e.config.WorkerID = "project-worker-" + hex.EncodeToString(nonce[:])
		}
	} else if len(config.WorkerID) > 160 || strings.ContainsAny(config.WorkerID, "\r\n\x00") {
		e.initError = errors.New("invalid worker identity")
	}
	return e
}

// Start launches a bounded worker pool and returns immediately. The supplied
// context governs the pool lifetime. A stopped engine cannot be restarted.
func (e *Engine) Start(ctx context.Context) error {
	if ctx == nil {
		return errors.New("project execution context is required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.initError != nil {
		return e.initError
	}
	if e.closed {
		return ErrClosed
	}
	if e.started {
		return ErrConflict
	}
	workerCtx, cancel := context.WithCancel(ctx)
	e.cancel = cancel
	e.started = true
	var workers sync.WaitGroup
	workers.Add(e.config.Workers)
	for i := 0; i < e.config.Workers; i++ {
		owner := fmt.Sprintf("%s:%d", e.config.WorkerID, i)
		go func() { defer workers.Done(); e.worker(workerCtx, owner) }()
	}
	go func() { workers.Wait(); e.mu.Lock(); e.closed = true; e.mu.Unlock(); close(e.done) }()
	return nil
}

func (e *Engine) Stop(ctx context.Context) error {
	if ctx == nil {
		return errors.New("stop context is required")
	}
	e.mu.Lock()
	if !e.started {
		e.closed = true
		e.mu.Unlock()
		return nil
	}
	cancel := e.cancel
	e.mu.Unlock()
	cancel()
	select {
	case <-e.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *Engine) worker(ctx context.Context, owner string) {
	for ctx.Err() == nil {
		a, err := e.store.ClaimTask(ctx, owner, e.config.Lease)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			e.report(ctx, fmt.Errorf("claim project execution work: %w", err))
			if !waitEngine(ctx, e.config.PollInterval) {
				return
			}
			continue
		}
		if a == nil {
			if !waitEngine(ctx, e.config.PollInterval) {
				return
			}
			continue
		}
		e.executeClaim(ctx, *a)
	}
}

func waitEngine(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (e *Engine) report(ctx context.Context, err error) {
	if e.config.OnError != nil {
		e.config.OnError(err)
		return
	}
	slog.ErrorContext(ctx, "project execution worker error", "error", err)
}

func (e *Engine) addActive(runID, taskID, tenantID string, cancel context.CancelFunc) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.active[runID] == nil {
		e.active[runID] = make(map[string]context.CancelFunc)
	}
	e.active[runID][taskID] = cancel
	e.runTenants[runID] = tenantID
}

func (e *Engine) removeActive(runID, taskID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.active[runID], taskID)
	if len(e.active[runID]) == 0 {
		delete(e.active, runID)
		delete(e.runTenants, runID)
	}
}

func (e *Engine) cancelActive(runID string) {
	e.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(e.active[runID]))
	for _, cancel := range e.active[runID] {
		cancels = append(cancels, cancel)
	}
	e.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (e *Engine) executeClaim(parent context.Context, a mission.Assignment) {
	ctx, cancel := context.WithCancel(parent)
	ref := FenceRequest{Scope: a.Scope, RunID: a.Run.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}
	incarnation := fmt.Sprintf("%s:%d", a.Task.ID, a.Task.Fence)
	e.addActive(a.Run.ID, incarnation, a.Scope.TenantID, cancel)
	heartbeatDone := make(chan struct{})
	leaseErrors := make(chan error, 1)
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(e.config.HeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := e.store.RenewLease(ctx, ref, e.config.Lease); err != nil {
					select {
					case leaseErrors <- err:
					default:
					}
					cancel()
					return
				}
			}
		}
	}()
	defer func() {
		cancel()
		<-heartbeatDone
		e.removeActive(a.Run.ID, incarnation)
		if recovered := recover(); recovered != nil {
			err := fmt.Errorf("execution adapter panic: %v", recovered)
			e.failOwned(parent, ref, "adapter", err)
		}
	}()
	err := e.process(ctx, ref, a)
	if err == nil {
		return
	}
	select {
	case leaseErr := <-leaseErrors:
		if !errors.Is(leaseErr, ErrLeaseLost) && !errors.Is(leaseErr, ErrInvalidState) && !errors.Is(leaseErr, ErrConflict) && !errors.Is(leaseErr, ErrTenantDraining) && !errors.Is(leaseErr, context.Canceled) {
			e.report(parent, &ExecutionError{Scope: a.Scope, RunID: a.Run.ID, TaskID: a.Task.ID, Stage: "lease renewal", Cause: leaseErr})
		}
		return
	default:
	}
	// A cancelled model request or runner request may have taken effect. Leaving
	// its durable write-ahead state intact lets a later worker inspect it safely.
	if ctx.Err() != nil || errors.Is(err, ErrLeaseLost) || errors.Is(err, ErrInvalidState) || errors.Is(err, ErrConflict) || errors.Is(err, ErrTenantDraining) {
		return
	}
	if errors.Is(err, errAwaitingDecision) {
		return
	}
	e.failOwned(parent, ref, "execution", err)
}

func (e *Engine) failOwned(ctx context.Context, ref FenceRequest, stage string, cause error) {
	err := e.store.FailTask(context.WithoutCancel(ctx), ref, cause.Error())
	if err != nil && !errors.Is(err, ErrLeaseLost) && !errors.Is(err, ErrConflict) && !errors.Is(err, ErrInvalidState) && !errors.Is(err, ErrTenantDraining) {
		e.report(ctx, &ExecutionError{Scope: ref.Scope, RunID: ref.RunID, TaskID: ref.TaskID, Stage: "persist failure", Cause: err})
	}
	e.report(ctx, &ExecutionError{Scope: ref.Scope, RunID: ref.RunID, TaskID: ref.TaskID, Stage: stage, Cause: cause})
}

func (e *Engine) Pause(ctx context.Context, tenant, projectID, runID string, revision int64) (mission.Run, error) {
	run, err := e.store.PauseRun(ctx, tenant, projectID, runID, revision)
	if err == nil {
		e.cancelActive(runID)
	}
	return run, err
}
func (e *Engine) Resume(ctx context.Context, tenant, projectID, runID string, revision int64) (mission.Run, error) {
	return e.store.ResumeRun(ctx, tenant, projectID, runID, revision)
}
func (e *Engine) Cancel(ctx context.Context, tenant, projectID, runID string, revision int64) (mission.Run, error) {
	run, err := e.store.CancelRun(ctx, tenant, projectID, runID, revision)
	if err == nil {
		e.cancelActive(runID)
	}
	return run, err
}
func (e *Engine) RetryTask(ctx context.Context, tenant, projectID, runID, taskID string, revision int64) (mission.Task, error) {
	return e.store.RetryTask(ctx, tenant, projectID, runID, taskID, revision)
}

// CancelTenant fences persistent work before cancelling local contexts. Call it
// before deleting the tenant or its workspace: goroutines cannot claim or
// advance work after the control transaction commits.
func (e *Engine) CancelTenant(ctx context.Context, tenant string) error {
	if err := e.store.CancelTenant(ctx, tenant); err != nil {
		return err
	}
	e.mu.Lock()
	cancels := []context.CancelFunc{}
	for runID, ownerTenant := range e.runTenants {
		if ownerTenant == tenant {
			for _, cancel := range e.active[runID] {
				cancels = append(cancels, cancel)
			}
		}
	}
	e.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	return nil
}
