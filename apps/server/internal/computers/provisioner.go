package computers

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrProviderUnavailable = errors.New("computer provider adapter is unavailable")
var ErrCreationUncertain = errors.New("computer creation outcome is uncertain; reconciliation is required")

// CreationProvider is a control-plane interface, never exposed to execution tools.
// Create must tag the instance with CreateOperationID. Find must only observe
// that operation in the exact computer/account scope; it MUST NOT create, retry,
// or search another account. Empty ID means not yet observed, not safe to retry.
// Implementations load credentials using r's persisted tenant/computer identity.
type CreationProvider interface {
	Create(context.Context, Runtime) (string, error)
	Find(context.Context, Runtime) (string, error)
}

// Provisioner coordinates durable approval with provider effects. Only the CAS
// winner calls Create. A crash after approval leaves Creating for observation,
// not another Create. Authorization and explicit confirmation belong to callers.
type Provisioner struct {
	Store     Store
	Providers map[Provider]CreationProvider
	Now       func() time.Time
}

func (p Provisioner) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func (p Provisioner) adapter(ctx context.Context, t Target) (Runtime, CreationProvider, error) {
	r, err := p.Store.GetRuntime(ctx, t)
	if err != nil {
		return r, nil, err
	}
	var provider Provider
	err = p.Store.DB.QueryRowContext(ctx, p.Store.query(`SELECT provider FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), r.TenantID, r.SpaceID, r.ComputerID).Scan(&provider)
	if err != nil {
		return r, nil, err
	}
	adapter := p.Providers[provider]
	if adapter == nil {
		return r, nil, ErrProviderUnavailable
	}
	return r, adapter, nil
}

func (p Provisioner) ApproveAndCreate(ctx context.Context, t Target, operation, actor string) (Runtime, error) {
	r, adapter, err := p.adapter(ctx, t)
	if err != nil {
		return r, err
	}
	if r.CreateOperationID != operation || r.State != PendingApproval {
		return r, ErrTransitionConflict
	}
	if err = p.Store.ApproveCreation(ctx, t, operation, actor, p.now()); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return r, ErrTransitionConflict
		}
		return r, err
	}
	r.State = Creating
	id, createErr := adapter.Create(ctx, r)
	// A disconnected client must not prevent persisting an observed instance.
	// Bound this detached DB-only work; no extra provider calls are made here.
	persist, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if createErr != nil || strings.TrimSpace(id) == "" {
		err = p.Store.Transition(persist, t, Creating, Unknown, p.now().UTC().Format(time.RFC3339Nano))
		if err != nil {
			return r, errors.Join(ErrCreationUncertain, err)
		}
		r.State = Unknown
		// Provider errors may contain credentials or signed URLs. Never surface them.
		return r, ErrCreationUncertain
	}
	if err = p.Store.CompleteCreation(persist, t, operation, id, p.now()); err != nil {
		return r, fmt.Errorf("record provider instance (reconcile before retry): %w", err)
	}
	return p.Store.GetRuntime(persist, t)
}

// ReconcileCreation is safe after restarts and ambiguous network failures. It
// deliberately never calls Create, even when Find reports no matching instance.
func (p Provisioner) ReconcileCreation(ctx context.Context, t Target) (Runtime, error) {
	r, adapter, err := p.adapter(ctx, t)
	if err != nil {
		return r, err
	}
	if r.State == Ready {
		return r, nil
	}
	if r.State == PendingApproval {
		return r, ErrApprovalRequired
	}
	if (r.State != Creating && r.State != Unknown) || r.ExternalID != "" {
		return r, ErrTransitionConflict
	}
	// Verify persisted approval before any provider read/credential access.
	var approved int
	err = p.Store.DB.QueryRowContext(ctx, p.Store.query(`SELECT 1 FROM computer_creation_approvals WHERE runtime_id=? AND create_operation_id=?`), r.ID, r.CreateOperationID).Scan(&approved)
	if err != nil {
		return r, ErrApprovalRequired
	}
	id, err := adapter.Find(ctx, r)
	if err != nil || strings.TrimSpace(id) == "" {
		return r, ErrCreationUncertain
	}
	persist, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	err = p.Store.CompleteCreation(persist, t, r.CreateOperationID, id, p.now())
	if errors.Is(err, ErrTransitionConflict) {
		// Another reconciler may have completed the same observation. Accept only
		// that exact instance; never treat a different provider ID as success.
		current, readErr := p.Store.GetRuntime(persist, t)
		if readErr == nil && current.State == Ready && current.ExternalID == id {
			return current, nil
		}
	}
	if err != nil {
		return r, err
	}
	return p.Store.GetRuntime(persist, t)
}
