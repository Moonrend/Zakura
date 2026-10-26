package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"gorm.io/gorm"
)

const workspaceLeaseDuration = 20 * time.Minute

var errWorkspaceLeaseLost = errors.New("workspace operation lease was replaced or expired")

type workspaceConfig struct {
	DiskID         string  `json:"diskId,omitempty"`
	RuntimeNodeID  *string `json:"runtimeNodeId"`
	WorkspaceKind  string  `json:"workspaceKind"`
	WorkspaceImage *string `json:"workspaceImage"`
	EnableComputer bool    `json:"enableComputer"`
}
type workspaceIntent struct {
	PreviousStatus        string           `json:"previousStatus"`
	DesiredConfig         *workspaceConfig `json:"desiredConfig,omitempty"`
	Uncertain             bool             `json:"uncertain,omitempty"`
	SharedProfile         string           `json:"sharedProfile,omitempty"`
	OwnerCleanupPrepared  bool             `json:"ownerCleanupPrepared,omitempty"`
	OwnerCleanupComputer  string           `json:"ownerCleanupComputer,omitempty"`
	TenantCleanupPrepared bool             `json:"tenantCleanupPrepared,omitempty"`
}
type workspaceLease struct {
	h                *handler
	Space            Space
	Token, Operation string
	Intent           workspaceIntent
	once             sync.Once
	retained         bool
}

// A status claim and its durable owner are committed together. An elapsed lease
// is deliberately not permission to repeat a remote create; only recovery may
// replace its token after observing the node.
func (h *handler) acquireSpaceWorkspace(ctx context.Context, tenant, id, operation string, stoppedOnly bool, desired *workspaceConfig) (*workspaceLease, error) {
	previous, err := h.store.GetSpace(ctx, tenant, id)
	if err != nil {
		return nil, err
	}
	if accepted, ok := ctx.Value(workspaceRequestTargetKey{}).(Space); ok && accepted.TenantID == tenant && accepted.ID == id {
		if accepted.WorkspaceGeneration != previous.WorkspaceGeneration || (accepted.CurrentWorkspaceInstanceID == nil) != (previous.CurrentWorkspaceInstanceID == nil) || accepted.CurrentWorkspaceInstanceID != nil && *accepted.CurrentWorkspaceInstanceID != *previous.CurrentWorkspaceInstanceID {
			return nil, errWorkspaceLeaseLost
		}
	}
	l := &workspaceLease{h: h, Space: previous, Token: h.store.id(), Operation: operation, Intent: workspaceIntent{PreviousStatus: previous.WorkspaceStatus, DesiredConfig: desired}}
	raw, err := json.Marshal(l.Intent)
	if err != nil {
		return nil, err
	}
	now := h.store.now()
	err = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		q := tx.Table("spaces").Where("tenant_id=? AND id=? AND deletion_pending=FALSE AND workspace_status=? AND workspace_status NOT IN ('starting','stopping','configuring','migrating','deleting')", tenant, id, previous.WorkspaceStatus)
		q = q.Where("workspace_generation=?", previous.WorkspaceGeneration)
		if previous.CurrentWorkspaceInstanceID == nil {
			q = q.Where("current_workspace_instance_id IS NULL")
		} else {
			q = q.Where("current_workspace_instance_id=?", *previous.CurrentWorkspaceInstanceID)
		}
		if stoppedOnly {
			q = q.Where("workspace_status <> 'running'")
		}
		r := q.Updates(map[string]any{"workspace_status": operation, "updated_at": runtimeTimeString(now)})
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return errWorkspaceStarting
		}
		r = tx.Exec(`INSERT INTO computer_workspace_leases(space_id,tenant_id,token,operation,expires_at,intent_json,updated_at,workspace_instance_id,workspace_generation) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(space_id) DO NOTHING`, id, tenant, l.Token, operation, now.Add(workspaceLeaseDuration).UnixMilli(), string(raw), now.UnixMilli(), previous.CurrentWorkspaceInstanceID, previous.WorkspaceGeneration)
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return errWorkspaceStarting
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	l.Space.WorkspaceStatus = operation
	return l, nil
}

// Compatibility wrapper preserves previous-status CAS and idempotent release.
func (h *handler) claimSpaceWorkspace(ctx context.Context, tenant, id, state string, stoppedOnly bool) (Space, func(), error) {
	l, err := h.acquireSpaceWorkspace(ctx, tenant, id, state, stoppedOnly, nil)
	if err != nil {
		return Space{}, func() {}, err
	}
	return l.Space, l.release, nil
}
func (l *workspaceLease) fenced(ctx context.Context, f func(*gorm.DB) error) error {
	return l.h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := l.h.store.now()
		// Use the same owner-then-lease lock order as retirement. A late callback
		// must not update the replacement even if it still holds an old token.
		owner := tx.Table("spaces").Where("tenant_id=? AND id=? AND workspace_generation=?", l.Space.TenantID, l.Space.ID, l.Space.WorkspaceGeneration)
		lease := tx.Table("computer_workspace_leases").Where("space_id=? AND tenant_id=? AND token=? AND expires_at>? AND workspace_generation=?", l.Space.ID, l.Space.TenantID, l.Token, now.UnixMilli(), l.Space.WorkspaceGeneration)
		if l.Space.CurrentWorkspaceInstanceID == nil {
			owner = owner.Where("current_workspace_instance_id IS NULL")
			lease = lease.Where("workspace_instance_id IS NULL")
		} else {
			owner = owner.Where("current_workspace_instance_id=?", *l.Space.CurrentWorkspaceInstanceID)
			lease = lease.Where("workspace_instance_id=?", *l.Space.CurrentWorkspaceInstanceID)
		}
		r := owner.Update("workspace_generation", l.Space.WorkspaceGeneration)
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return errWorkspaceLeaseLost
		}
		r = lease.Updates(map[string]any{"expires_at": now.Add(workspaceLeaseDuration).UnixMilli(), "updated_at": now.UnixMilli()})
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return errWorkspaceLeaseLost
		}
		return f(tx)
	})
}

// Persist profile identity before any remote effect. A crash must not leave a
// generic configuring intent which the workspace sweep could clear independently.
func (l *workspaceLease) bindSharedProfile(ctx context.Context, profile string) error {
	if profile == "" {
		return errors.New("shared profile identity required")
	}
	l.Intent.SharedProfile = profile
	raw, err := json.Marshal(l.Intent)
	if err != nil {
		return err
	}
	return l.fenced(ctx, func(tx *gorm.DB) error {
		return tx.Table("computer_workspace_leases").Where("space_id=? AND tenant_id=? AND token=?", l.Space.ID, l.Space.TenantID, l.Token).Update("intent_json", string(raw)).Error
	})
}

func (l *workspaceLease) check(ctx context.Context) error {
	return l.fenced(ctx, func(*gorm.DB) error { return nil })
}
func (l *workspaceLease) finish(ctx context.Context, status string, patch map[string]any) error {
	return l.fenced(ctx, func(tx *gorm.DB) error {
		if patch == nil {
			patch = map[string]any{}
		}
		patch["workspace_status"] = status
		patch["updated_at"] = runtimeTimeString(l.h.store.now())
		if err := tx.Table("spaces").Where("tenant_id=? AND id=?", l.Space.TenantID, l.Space.ID).Updates(patch).Error; err != nil {
			return err
		}
		return tx.Table("computer_workspace_leases").Where("space_id=? AND tenant_id=? AND token=?", l.Space.ID, l.Space.TenantID, l.Token).Delete(map[string]any{}).Error
	})
}
func (l *workspaceLease) release() {
	l.once.Do(func() {
		if !l.retained {
			_ = l.finish(context.Background(), l.Intent.PreviousStatus, nil)
		}
	})
}

// A failed preflight is retryable, but its diagnostic must survive a page reload.
// Ambiguous effects already retain their intent through uncertain.
func (l *workspaceLease) recordFailure(cause error) {
	if !l.retained {
		_ = l.finish(context.Background(), l.Intent.PreviousStatus, map[string]any{"last_error": cause.Error()})
	}
}

// Keep the intent after an uncertain remote response. A second HTTP request may
// not mistake absence in a later list for proof that the original RPC never ran.
func (l *workspaceLease) uncertain(cause error) error {
	l.retained = true
	l.Intent.Uncertain = true
	raw, _ := json.Marshal(l.Intent)
	_ = l.fenced(context.Background(), func(tx *gorm.DB) error {
		if err := tx.Table("computer_workspace_leases").Where("space_id=? AND tenant_id=? AND token=?", l.Space.ID, l.Space.TenantID, l.Token).Update("intent_json", string(raw)).Error; err != nil {
			return err
		}
		return tx.Table("spaces").Where("tenant_id=? AND id=?", l.Space.TenantID, l.Space.ID).Updates(map[string]any{"workspace_status": "error", "last_error": cause.Error(), "updated_at": runtimeTimeString(l.h.store.now())}).Error
	})
	return workspaceRunnerError{cause}
}
func (l *workspaceLease) applyConfig(ctx context.Context, c workspaceConfig) error {
	return l.fenced(ctx, func(tx *gorm.DB) error {
		if c.RuntimeNodeID != nil && *c.RuntimeNodeID != "" {
			var count int64
			if err := tx.Table("runtime_nodes").Where("id=? AND (tenant_id=? OR is_shared=TRUE) AND kind IN ('server','computer','local')", *c.RuntimeNodeID, l.Space.TenantID).Count(&count).Error; err != nil {
				return err
			}
			if count != 1 {
				return errors.New("workspace configuration runtime node is no longer available")
			}
		}
		patch := map[string]any{"runtime_node_id": c.RuntimeNodeID, "workspace_kind": c.WorkspaceKind, "workspace_image": c.WorkspaceImage, "enable_computer": c.EnableComputer, "workspace_status": "stopped", "last_error": nil, "updated_at": runtimeTimeString(l.h.store.now())}
		if err := tx.Table("spaces").Where("tenant_id=? AND id=?", l.Space.TenantID, l.Space.ID).Updates(patch).Error; err != nil {
			return err
		}
		if err := adoptLegacyComputer(tx, l.Space.TenantID, l.Space.ID); err != nil {
			return err
		}
		return tx.Table("computer_workspace_leases").Where("space_id=? AND tenant_id=? AND token=?", l.Space.ID, l.Space.TenantID, l.Token).Delete(map[string]any{}).Error
	})
}
