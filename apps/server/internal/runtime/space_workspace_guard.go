// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"gorm.io/gorm"
)

// The no-op UPDATE is intentional: it locks the same Space row updated by
// acquireSpaceWorkspace until the caller's transaction commits. A count-only
// preflight would let migration claim the Space between the check and Run INSERT.
func (s *Store) guardSpaceWorkspaceTx(tx *gorm.DB, tenant, space string) error {
	result := tx.Table("spaces").Where("tenant_id=? AND id=?", tenant, space).
		UpdateColumn("workspace_status", gorm.Expr("workspace_status"))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrNotFound
	}
	var current struct {
		Status          string `gorm:"column:workspace_status"`
		DeletionPending bool   `gorm:"column:deletion_pending"`
	}
	if err := tx.Table("spaces").Select("workspace_status,deletion_pending").Where("tenant_id=? AND id=?", tenant, space).Take(&current).Error; err != nil {
		return err
	}
	if current.DeletionPending {
		return fmt.Errorf("%w: Space deletion is pending", ErrConflict)
	}
	switch current.Status {
	case "starting", "stopping", "configuring", "migrating", "deleting":
		return fmt.Errorf("%w: Space workspace is %s", ErrConflict, current.Status)
	}
	var claims int64
	if err := tx.Table("computer_workspace_leases").Where("tenant_id=? AND space_id=?", tenant, space).Count(&claims).Error; err != nil {
		return err
	}
	// Expiry does not authorize new effects while an uncertain lifecycle intent
	// is retained; only explicit recovery may clear or replace that claim.
	if claims != 0 {
		return fmt.Errorf("%w: Space workspace has a pending infrastructure operation", ErrConflict)
	}
	return nil
}

func (s *Store) guardAgentWorkspaceTx(tx *gorm.DB, tenant, agent string) error {
	var row struct {
		Space string `gorm:"column:space_id"`
	}
	if err := tx.Table("agents").Select("space_id").Where("tenant_id=? AND id=?", tenant, agent).Take(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrNotFound
		}
		return err
	}
	return s.guardSpaceWorkspaceTx(tx, tenant, row.Space)
}

// Execution revalidates admission after the goroutine is scheduled. The run row
// stays active until settlement, so a migration which claims next observes it.
func (s *Store) guardRunWorkspace(ctx context.Context, tenant, agent, session, run string) error {
	return s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.guardAgentWorkspaceTx(tx, tenant, agent); err != nil {
			return err
		}
		var active int64
		if err := tx.Table("cloud_agent_runs AS r").Joins("JOIN cloud_agent_sessions AS s ON s.id=r.session_id").Where("s.tenant_id=? AND s.agent_id=? AND s.id=? AND s.active_run_id=? AND r.id=? AND r.status='running'", tenant, agent, session, run, run).Count(&active).Error; err != nil {
			return err
		}
		if active != 1 {
			return fmt.Errorf("%w: run is no longer active", ErrConflict)
		}
		return nil
	})
}

type workspaceWriteClaimKey struct{}
type workspaceWriteClaim struct {
	tenant, space string
	uncertain     func(error)
}

// Shared writers own the claim until their final database/rollback callback.
// finish is idempotent. Pass nil after a definite success or completed rollback;
// pass the remote error when an effect/rollback is uncertain, retaining ownership.
func (h *handler) claimSharedWorkspaceWrite(ctx context.Context, tenant, space string) (context.Context, func(error), error) {
	if held, ok := ctx.Value(workspaceWriteClaimKey{}).(workspaceWriteClaim); ok && held.tenant == tenant && held.space == space {
		return ctx, func(cause error) {
			if cause != nil && held.uncertain != nil {
				held.uncertain(cause)
			}
		}, nil
	}
	lease, err := h.acquireSpaceWorkspace(ctx, tenant, space, "configuring", false, nil)
	if err != nil {
		return ctx, nil, err
	}
	var once sync.Once
	var mu sync.Mutex
	var uncertainCause error
	mark := func(cause error) {
		if cause != nil {
			mu.Lock()
			if uncertainCause == nil {
				uncertainCause = cause
			}
			mu.Unlock()
		}
	}
	finish := func(cause error) {
		mark(cause)
		once.Do(func() {
			mu.Lock()
			cause = uncertainCause
			mu.Unlock()
			remote := lease.Space.RuntimeNodeID != nil && strings.TrimSpace(*lease.Space.RuntimeNodeID) != ""
			if remote && (cause != nil || ctx.Err() != nil) {
				if cause == nil {
					cause = ctx.Err()
				}
				_ = lease.uncertain(cause)
			}
			lease.release()
		})
	}
	return context.WithValue(ctx, workspaceWriteClaimKey{}, workspaceWriteClaim{tenant: tenant, space: space, uncertain: mark}), finish, nil
}

type workspaceWriteResponse struct {
	http.ResponseWriter
	status    int
	uncertain func(error)
}

func (w *workspaceWriteResponse) markWorkspaceWriteError(err error) {
	if err != nil && w.uncertain != nil {
		w.uncertain(err)
	}
}
func (w *workspaceWriteResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *workspaceWriteResponse) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
		w.ResponseWriter.WriteHeader(code)
	}
}
func (w *workspaceWriteResponse) Write(raw []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(raw)
}

// Management mutations hold the existing durable configuring claim over all
// filesystem effects. This never rewrites the selected execution computer.
func (h *handler) withWorkspaceWrite(w http.ResponseWriter, r *http.Request, space string, next http.HandlerFunc) {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		next(w, r)
		return
	}
	tenant := principal(r).TenantID
	ctx, finish, err := h.claimSharedWorkspaceWrite(r.Context(), tenant, space)
	if err != nil {
		if errors.Is(err, errWorkspaceStarting) {
			httpx.Error(w, http.StatusConflict, "Space workspace has an active infrastructure operation")
		} else {
			statusErr(w, err)
		}
		return
	}
	held, _ := ctx.Value(workspaceWriteClaimKey{}).(workspaceWriteClaim)
	response := &workspaceWriteResponse{ResponseWriter: w, uncertain: held.uncertain}
	completed := false
	defer func() {
		var cause error
		if !completed || r.Context().Err() != nil || response.status >= 500 {
			cause = errors.New("shared workspace write outcome is uncertain; reconcile before migration")
		}
		finish(cause)
	}()
	next(response, r.WithContext(ctx))
	completed = true
}
