package runtime

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"gorm.io/gorm"
)

// Attached computers own no Space workspace lifecycle. A row-level deletion
// fence serializes their creation claims without changing workspace status.
func (h *handler) prepareAttachedComputerDeletion(ctx context.Context, c computers.Computer) error {
	if err := h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Table("spaces").Where("tenant_id=? AND id=? AND deletion_pending=FALSE", c.TenantID, c.SpaceID).UpdateColumn("deletion_pending", gorm.Expr("deletion_pending"))
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return computers.ErrOwnerDeleting
		}
		var busy int64
		if err := tx.Table("run_computer_targets t").Joins("JOIN cloud_agent_runs r ON r.id=t.run_id").Where("t.tenant_id=? AND t.space_id=? AND t.computer_id=? AND r.status IN ('queued','running')", c.TenantID, c.SpaceID, c.ID).Count(&busy).Error; err != nil {
			return err
		}
		if busy != 0 {
			return computers.ErrComputerInUse
		}
		res = tx.Table("computers").Where("tenant_id=? AND space_id=? AND id=? AND role='attached'", c.TenantID, c.SpaceID, c.ID).Update("deletion_pending", true)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return ErrNotFound
		}
		return nil
	}); err != nil {
		return err
	}
	// Keep the fence on failure: retries finish the same cleanup and cannot
	// reopen provisioning after a snapshot has already been queued.
	if err := h.closeOwnerWorkspaceBridges(ctx, c.TenantID, c.SpaceID, c.ID); err != nil {
		return err
	}
	fence := func(ctx context.Context, fn func(*gorm.DB) error) error {
		return h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			res := tx.Table("computers").Where("tenant_id=? AND space_id=? AND id=? AND deletion_pending=TRUE", c.TenantID, c.SpaceID, c.ID).UpdateColumn("deletion_pending", true)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return computers.ErrOwnerDeleting
			}
			return fn(tx)
		})
	}
	if err := h.recoverOwnerConnections(ctx, c.TenantID, c.SpaceID, c.ID, fence); err != nil {
		return err
	}
	if err := fence(ctx, func(tx *gorm.DB) error {
		if err := tx.Table("computer_runtimes").Where("tenant_id=? AND space_id=? AND computer_id=? AND state='pending_approval'", c.TenantID, c.SpaceID, c.ID).Updates(map[string]any{"state": computers.Failed, "updated_at": runtimeTimeString(h.store.now())}).Error; err != nil {
			return err
		}
		return tx.Table("computer_runtimes").Where("tenant_id=? AND space_id=? AND computer_id=? AND state NOT IN ('destroyed','expired','failed')", c.TenantID, c.SpaceID, c.ID).Updates(map[string]any{"state": computers.Expired, "updated_at": runtimeTimeString(h.store.now())}).Error
	}); err != nil {
		return err
	}
	var rows []ownerRuntimeRow
	if err := h.deps.Gorm.WithContext(ctx).Table("computer_runtimes").Select("id,incarnation,computer_id").Where("tenant_id=? AND space_id=? AND computer_id=?", c.TenantID, c.SpaceID, c.ID).Find(&rows).Error; err != nil {
		return err
	}
	cleanup := computers.CleanupDeps{Store: h.computerStore(), Destroyers: h.computerDestroyers(), Now: h.store.now}
	for _, row := range rows {
		r, err := h.computerStore().GetRuntime(ctx, computers.Target{TenantID: c.TenantID, SpaceID: c.SpaceID, ComputerID: c.ID, RuntimeID: row.ID, Incarnation: row.Incarnation})
		if err != nil {
			return err
		}
		if c.SessionScoped() && r.State != computers.Destroyed && (r.ExternalID != "" || r.State == computers.Expired) {
			if err = cleanup.QueueCleanup(ctx, r); err != nil {
				return err
			}
		}
	}
	managed, err := h.captureOwnerManagedContainers(ctx, c.TenantID, c.SpaceID, c.ID)
	if err != nil {
		return err
	}
	for _, snapshot := range managed {
		if err = h.queueManagedContainerCleanup(ctx, snapshot); err != nil {
			return err
		}
	}
	return nil
}

// Old releases used a Space-wide deletion lease for attached computers. Finish
// only that computer's legacy lease; unrelated workspace operations are untouched.
func (h *handler) finishAttachedComputerDeletion(ctx context.Context, tenant, space, computer string) error {
	var row struct {
		IntentJSON string `gorm:"column:intent_json"`
	}
	err := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Select("intent_json").Where("tenant_id=? AND space_id=? AND operation='deleting'", tenant, space).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	var intent workspaceIntent
	if err = json.Unmarshal([]byte(row.IntentJSON), &intent); err != nil {
		return err
	}
	if intent.OwnerCleanupComputer != computer {
		return nil
	}
	return h.finishComputerDeletion(ctx, tenant, space)
}
