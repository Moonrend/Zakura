// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/appdeps"
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
	rows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT r.id,s.id,s.agent_id FROM cloud_agent_runs r JOIN cloud_agent_sessions s ON s.id=r.session_id WHERE s.tenant_id=? AND r.status IN ('queued','running')`), tenant)
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
	err = appdeps.InTx(ctx, h.deps.DB, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, h.store.q(`UPDATE cloud_agent_runs SET cancel_requested=TRUE,status='cancelled',completed_at=? WHERE id IN (SELECT r.id FROM cloud_agent_runs r JOIN cloud_agent_sessions s ON s.id=r.session_id WHERE s.tenant_id=? AND r.status IN ('queued','running'))`), now, tenant); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, h.store.q(`UPDATE cloud_agent_sessions SET active_run_id=NULL,updated_at=? WHERE tenant_id=?`), now, tenant)
		return err
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
	h.acp.closeTenant(tenant)
	if err := h.cancelTenantRuns(ctx, tenant); err != nil {
		return err
	}
	rows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT id,docker_id,runtime_node_id FROM managed_containers WHERE tenant_id=? AND docker_id IS NOT NULL AND status NOT IN ('removed','stopped') ORDER BY id`), tenant)
	if err != nil {
		return err
	}
	type container struct{ id, dockerID, nodeID string }
	containers := []container{}
	for rows.Next() {
		var item container
		if err := rows.Scan(&item.id, &item.dockerID, &item.nodeID); err != nil {
			rows.Close()
			return err
		}
		containers = append(containers, item)
	}
	rows.Close()
	for _, item := range containers {
		if item.nodeID == "" {
			return fmt.Errorf("container %s has no runtime node for cleanup", item.id)
		}
		runner, err := h.hub.get(item.nodeID)
		if err != nil {
			return fmt.Errorf("container %s cleanup: %w", item.id, err)
		}
		callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err = runner.call(callCtx, "docker.stop", map[string]any{"id": item.dockerID, "remove": true}, nil)
		cancel()
		if err != nil {
			return fmt.Errorf("container %s cleanup: %w", item.id, err)
		}
		_, _ = h.deps.DB.ExecContext(ctx, h.store.q(`UPDATE managed_containers SET status='removed',docker_id=NULL,updated_at=? WHERE id=? AND tenant_id=?`), h.store.now(), item.id, tenant)
	}
	var nodeRows *sql.Rows
	nodeRows, err = h.deps.DB.QueryContext(ctx, h.store.q(`SELECT id FROM runtime_nodes WHERE tenant_id=?`), tenant)
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
		if runner, err := h.hub.get(id); err == nil {
			runner.close(errors.New("tenant deleted"))
			h.hub.remove(runner)
		}
	}
	return nil
}

func (h *handler) afterMemberRemoved(ctx context.Context, tenant, user string) error {
	h.closeLiveAccess(tenant, user)
	rows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT s.agent_id,s.id FROM cloud_agent_sessions s WHERE s.tenant_id=? AND s.created_by_user_id=? AND s.active_run_id IS NOT NULL`), tenant, user)
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
