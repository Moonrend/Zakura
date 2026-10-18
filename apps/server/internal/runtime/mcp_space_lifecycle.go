// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"time"
)

// MCPInstanceLifecycle is supplied to integrations from the already-registered
// runtime handler; there is no separate handler, hub or service singleton.
type MCPInstanceLifecycle interface {
	Start(context.Context, string, string) error
	Stop(context.Context, string, string) error
	Bind(context.Context, string, string, string) error
	Delete(context.Context, string, string) error
}
type mcpInstanceLifecycle struct{ h *handler }

func (h *handler) MCPInstanceLifecycle() MCPInstanceLifecycle { return mcpInstanceLifecycle{h} }
func (s mcpInstanceLifecycle) Start(ctx context.Context, tenant, id string) error {
	return s.h.startMCPInstance(ctx, tenant, id)
}
func (s mcpInstanceLifecycle) Stop(ctx context.Context, tenant, id string) error {
	return s.h.stopMCPInstance(ctx, tenant, id)
}

func (s mcpInstanceLifecycle) Bind(ctx context.Context, tenant, space, id string) error {
	if err := s.h.ValidateMCPBinding(ctx, tenant, space, id); err != nil {
		return err
	}
	return s.h.deps.Gorm.WithContext(ctx).Table("agent_bindings").Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "space_id"}, {Name: "instance_id"}}, DoNothing: true}).Create(map[string]any{"id": s.h.store.id(), "tenant_id": tenant, "space_id": space, "agent_id": nil, "instance_id": id, "created_at": runtimeTimeString(s.h.store.now())}).Error
}
func (s mcpInstanceLifecycle) Delete(ctx context.Context, tenant, id string) error {
	if err := s.h.stopMCPInstance(ctx, tenant, id); err != nil {
		return err
	}
	return s.h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("DELETE FROM agent_bindings WHERE tenant_id=? AND instance_id=?", tenant, id).Error; err != nil {
			return err
		}
		return tx.Exec("DELETE FROM component_instances WHERE tenant_id=? AND id=? AND component_type='mcp'", tenant, id).Error
	})
}

func (h *handler) startMCPInstance(ctx context.Context, tenant, id string) (err error) {
	inst, err := h.getMCPInstance(ctx, tenant, id)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			message := err.Error()
			_ = h.setInstanceStatus(context.WithoutCancel(ctx), tenant, id, "error", &message)
		}
	}()
	body, stdio, err := h.stdioBodyForInstance(inst)
	if err != nil {
		return err
	}
	if stdio {
		owner, e := h.mcpOwnerSpace(ctx, inst)
		if e != nil {
			return e
		}
		if err = h.requireSpaceInfrastructureAvailable(ctx, tenant, owner); err != nil {
			return err
		}
		lease, e := h.acquireSpaceInfrastructure(ctx, tenant, owner)
		if e != nil {
			return e
		}
		defer lease.release()
		if err = lease.check(ctx); err != nil {
			return err
		}
		body.SpaceIDs = []string{owner}
		// The live Space server computer is authoritative, not a stale saved runner.
		body.RuntimeNodeID = nil
		var active []struct {
			DockerID string `gorm:"column:docker_id"`
			Node     string `gorm:"column:runtime_node_id"`
		}
		if err = h.deps.Gorm.WithContext(ctx).Table("managed_containers").Select("docker_id,runtime_node_id").Where("tenant_id=? AND instance_id=? AND docker_id IS NOT NULL AND status IN ('created','running')", tenant, id).Find(&active).Error; err != nil {
			return err
		}
		if len(active) > 1 {
			return errors.New("stdio MCP has multiple active containers; stop before starting")
		}
		if len(active) == 1 {
			exec, e := h.resolveServerComputer(ctx, tenant, owner)
			if e != nil {
				return e
			}
			if exec.nodeID != active[0].Node {
				return errors.New("stdio MCP runtime moved; stop the previous container before starting")
			}
			runner, e := h.hub.get(active[0].Node)
			if e != nil {
				return e
			}
			var inspected struct {
				Status string `json:"status"`
			}
			if e = runner.call(ctx, "docker.inspect", map[string]any{"id": active[0].DockerID}, &inspected); e != nil {
				return e
			}
			if inspected.Status != "running" {
				return errors.New("stdio MCP container is not running; stop before restarting")
			}
			_, err = h.mcpRPC(ctx, inst, "tools/list", map[string]any{})
			if err != nil {
				return err
			}
			return lease.fenced(ctx, func(tx *gorm.DB) error {
				return tx.Table("component_instances").Where("tenant_id=? AND id=? AND component_type='mcp'", tenant, id).Updates(map[string]any{"status": "running", "last_error": nil, "updated_at": runtimeTimeString(h.store.now())}).Error
			})
		}
		return h.provisionStdioMCPWithLease(ctx, tenant, id, body, owner, lease)
	} else {
		raw, e := h.mcpRPC(ctx, inst, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "zakura", "version": "1"}})
		if e != nil {
			return e
		}
		var result struct {
			ProtocolVersion string         `json:"protocolVersion"`
			Capabilities    map[string]any `json:"capabilities"`
		}
		if json.Unmarshal(raw, &result) != nil || result.ProtocolVersion == "" || result.Capabilities == nil {
			return errors.New("invalid MCP initialize result")
		}
	}
	return h.setInstanceStatus(ctx, tenant, id, "running", nil)
}
func (h *handler) stopMCPInstance(ctx context.Context, tenant, id string) error {
	if _, err := h.getMCPInstance(ctx, tenant, id); err != nil {
		return err
	}
	var rows []struct {
		ID       string `gorm:"column:id"`
		DockerID string `gorm:"column:docker_id"`
		Node     string `gorm:"column:runtime_node_id"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("managed_containers").Select("id,docker_id,runtime_node_id").Where("tenant_id=? AND instance_id=? AND docker_id IS NOT NULL AND status IN ('created','running')", tenant, id).Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		if row.Node == "" {
			return errors.New("managed stdio container has no runtime node")
		}
		runner, err := h.hub.get(row.Node)
		if err != nil {
			return err
		}
		if err = runner.call(ctx, "docker.stop", map[string]any{"id": row.DockerID, "remove": true}, nil); err != nil {
			return fmt.Errorf("stop stdio MCP: %w", err)
		}
		if err = h.deps.Gorm.WithContext(ctx).Table("managed_containers").Where("tenant_id=? AND id=?", tenant, row.ID).Updates(map[string]any{"status": "removed", "docker_id": nil, "updated_at": runtimeTimeString(h.store.now())}).Error; err != nil {
			return err
		}
	}
	return h.setInstanceStatus(ctx, tenant, id, "stopped", nil)
}

func mcpCleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
}
