// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"gorm.io/gorm"
)

func (h *handler) closeLiveAccess(tenant, user string) {
	realtimeHub.Lock()
	realtime := []*realtimeClient{}
	for _, client := range realtimeHub.clients {
		client.mu.Lock()
		principal := client.principal
		client.mu.Unlock()
		if principal.TenantID == tenant && (user == "" || principal.UserID == user) {
			realtime = append(realtime, client)
		}
	}
	realtimeHub.Unlock()
	for _, client := range realtime {
		client.close()
	}

	liveZakuraBotSockets.Lock()
	bots := []*zakuraBotSocket{}
	for socket, principal := range liveZakuraBotSockets.items {
		if principal.TenantID == tenant && (user == "" || principal.UserID == user) {
			bots = append(bots, socket)
		}
	}
	liveZakuraBotSockets.Unlock()
	for _, socket := range bots {
		_ = socket.conn.Close()
	}

	liveWorkspaceBridges.Lock()
	bridges := []*workspaceBridge{}
	for bridge, ticket := range liveWorkspaceBridges.items {
		if ticket.TenantID == tenant && (user == "" || ticket.UserID == user) {
			bridges = append(bridges, bridge)
		}
	}
	liveWorkspaceBridges.Unlock()
	for _, bridge := range bridges {
		_ = bridge.conn.Close()
	}
}

func (h *handler) cancelTenantRuns(ctx context.Context, tenant string) error {
	rows, err := h.deps.Gorm.WithContext(ctx).Raw(`SELECT r.id,s.id,s.agent_id FROM cloud_agent_runs r JOIN cloud_agent_sessions s ON s.id=r.session_id WHERE s.tenant_id=? AND r.status IN ('queued','running')`, tenant).Rows()
	if err != nil {
		return err
	}
	type active struct{ run, session, agent string }
	items := []active{}
	ids := []string{}
	for rows.Next() {
		var item active
		if rows.Scan(&item.run, &item.session, &item.agent) == nil {
			items = append(items, item)
			ids = append(ids, item.run)
		}
	}
	rows.Close()
	h.service.cancelRunIDs(ids)
	now := h.store.now()
	err = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := h.store.cancelOwnerApprovalsTx(ctx, tx, tenant, ""); err != nil {
			return err
		}
		if err := tx.Exec(`UPDATE cloud_agent_runs SET cancel_requested=TRUE,status='cancelled',completed_at=? WHERE id IN (SELECT r.id FROM cloud_agent_runs r JOIN cloud_agent_sessions s ON s.id=r.session_id WHERE s.tenant_id=? AND r.status IN ('queued','running'))`, runtimeTimeString(now), tenant).Error; err != nil {
			return err
		}
		return tx.Table("cloud_agent_sessions").Where("tenant_id = ?", tenant).Updates(map[string]any{"active_run_id": nil, "updated_at": runtimeTimeString(now)}).Error
	})
	if err == nil {
		for _, item := range items {
			h.store.recordRunTerminal(context.WithoutCancel(ctx), tenant, item.agent, item.session, item.run, "cancelled")
		}
	}
	return err
}

func (h *handler) beforeTenantDelete(ctx context.Context, tenant string) error {
	h.closeLiveAccess(tenant, "")
	if h.acp != nil {
		h.acp.closeTenant(tenant)
	}
	if err := h.cancelTenantRuns(ctx, tenant); err != nil {
		return err
	}
	var spaces []struct {
		ID string `gorm:"column:id"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("spaces").Select("id").Where("tenant_id=?", tenant).Order("id").Find(&spaces).Error; err != nil {
		return err
	}
	// A completed retry can follow the first callback disconnecting runners
	// before the surrounding tenant DELETE committed. Every Space must still
	// own its prepared deletion token, and no cleanup may remain pending.
	drained, err := h.ownerCleanupDrained(ctx, tenant, "")
	if err != nil {
		return err
	}
	prepared := drained && len(spaces) > 0
	for _, space := range spaces {
		var leaseRow struct {
			IntentJSON string `gorm:"column:intent_json"`
			Pending    bool   `gorm:"column:deletion_pending"`
		}
		res := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases l").Select("l.intent_json,s.deletion_pending").Joins("JOIN spaces s ON s.id=l.space_id AND s.tenant_id=l.tenant_id").Where("l.tenant_id=? AND l.space_id=? AND l.operation='deleting' AND l.token<>''", tenant, space.ID).Scan(&leaseRow)
		var intent workspaceIntent
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 || !leaseRow.Pending || json.Unmarshal([]byte(leaseRow.IntentJSON), &intent) != nil || !intent.OwnerCleanupPrepared || !intent.TenantCleanupPrepared || intent.OwnerCleanupComputer != "" {
			prepared = false
		}
	}
	for _, space := range spaces {
		if err := h.prepareSpaceDeletion(ctx, tenant, space.ID); err != nil {
			return err
		}
	}
	// Tenant-level MCP containers may not have a Space. Capture them as well,
	// including stopped containers, before disconnecting the tenant's runners.
	if !prepared {
		snapshots, err := h.captureOwnerManagedContainers(ctx, tenant, "", "")
		if err != nil {
			return err
		}
		for _, snapshot := range snapshots {
			if err = h.queueManagedContainerCleanup(ctx, snapshot); err != nil {
				return err
			}
		}
		// Tenant-wide orphans are now durable too; a Space-only marker is not
		// enough because an earlier tenant capture could have failed midway.
		for _, space := range spaces {
			var row struct {
				Token      string `gorm:"column:token"`
				IntentJSON string `gorm:"column:intent_json"`
			}
			if err = h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Select("token,intent_json").Where("tenant_id=? AND space_id=? AND operation='deleting'", tenant, space.ID).Take(&row).Error; err != nil {
				return err
			}
			current, readErr := h.store.GetSpace(ctx, tenant, space.ID)
			if readErr != nil {
				return readErr
			}
			lease := &workspaceLease{h: h, Space: current, Token: row.Token, Operation: "deleting", retained: true}
			if err = json.Unmarshal([]byte(row.IntentJSON), &lease.Intent); err != nil || !lease.Intent.OwnerCleanupPrepared || lease.Intent.OwnerCleanupComputer != "" {
				return errOwnerDeletionUncertain
			}
			lease.Intent.TenantCleanupPrepared = true
			raw, _ := json.Marshal(lease.Intent)
			if err = lease.fenced(ctx, func(tx *gorm.DB) error {
				return tx.Table("computer_workspace_leases").Where("tenant_id=? AND space_id=? AND token=? AND operation='deleting'", tenant, space.ID, lease.Token).Update("intent_json", string(raw)).Error
			}); err != nil {
				return err
			}
		}
	}
	deps := computers.CleanupDeps{Store: h.computerStore(), Destroyers: h.computerDestroyers(), Now: func() time.Time { return h.store.now() }}
	if _, _, err = deps.ExpireOverdue(ctx, 1000); err != nil {
		return err
	}
	if err = h.sweepManagedContainerCleanup(ctx, 1000); err != nil {
		return err
	}
	for _, table := range []string{"computer_cleanup_intents", "managed_container_cleanup_intents"} {
		var pending int64
		if err = h.deps.Gorm.WithContext(ctx).Table(table).Where("tenant_id=? AND pending=TRUE", tenant).Count(&pending).Error; err != nil {
			return err
		}
		if pending != 0 {
			return fmt.Errorf("tenant cleanup remains pending; retry before deleting runtime nodes")
		}
	}
	var nodeRows *sql.Rows
	nodeRows, err = h.deps.Gorm.WithContext(ctx).Raw(`SELECT id FROM runtime_nodes WHERE tenant_id=?`, tenant).Rows()
	if err != nil {
		return err
	}
	nodes := []string{}
	for nodeRows.Next() {
		var id string
		if nodeRows.Scan(&id) == nil {
			nodes = append(nodes, id)
		}
	}
	nodeRows.Close()
	for _, id := range nodes {
		if h.hub == nil {
			continue
		}
		if runner, err := h.hub.get(id); err == nil {
			runner.close(errors.New("tenant deleted"))
			h.hub.remove(runner)
		}
	}
	return nil
}

func (h *handler) afterMemberRemoved(ctx context.Context, tenant, user string) error {
	h.closeLiveAccess(tenant, user)
	if err := h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return h.store.cancelOwnerApprovalsTx(ctx, tx, tenant, user)
	}); err != nil {
		return err
	}
	rows, err := h.deps.Gorm.WithContext(ctx).Raw(`SELECT s.agent_id,s.id FROM cloud_agent_sessions s WHERE s.tenant_id=? AND s.created_by_user_id=? AND s.active_run_id IS NOT NULL`, tenant, user).Rows()
	if err != nil {
		return err
	}
	type session struct{ agent, id string }
	sessions := []session{}
	for rows.Next() {
		var item session
		if rows.Scan(&item.agent, &item.id) == nil {
			sessions = append(sessions, item)
		}
	}
	rows.Close()
	for _, item := range sessions {
		if queued, queueErr := h.store.PendingQueue(ctx, tenant, item.agent, item.id); queueErr == nil {
			for _, message := range queued {
				_ = h.store.DeleteQueued(ctx, tenant, item.agent, item.id, message.ID)
			}
		}
		if _, err := h.service.Cancel(ctx, tenant, item.agent, item.id); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
	}
	return nil
}
