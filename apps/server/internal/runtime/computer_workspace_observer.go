package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"gorm.io/gorm"
)

type workspaceMetadata struct {
	ID       string  `gorm:"column:id"`
	DockerID *string `gorm:"column:docker_id"`
	NodeID   *string `gorm:"column:runtime_node_id"`
}
type workspaceObservation struct {
	Container computerContainer
	Rows      []workspaceMetadata
}

// Every lifecycle path uses the same complete node observation. Metadata is a
// cache, never evidence of absence. In particular, a failed inspect/list must not
// turn into an empty result and authorize create or configuration changes.
func (h *handler) observeSpaceWorkspace(ctx context.Context, space Space) (workspaceObservation, error) {
	var obs workspaceObservation
	if err := h.deps.Gorm.WithContext(ctx).Table("managed_containers").Select("id,docker_id,runtime_node_id").Where("tenant_id=? AND space_id=? AND purpose='workspace' AND (status <> 'removed' OR docker_id IS NOT NULL)", space.TenantID, space.ID).Find(&obs.Rows).Error; err != nil {
		return obs, err
	}
	if space.RuntimeNodeID == nil || *space.RuntimeNodeID == "" {
		if len(obs.Rows) > 0 {
			return obs, errors.New("workspace metadata has no configured runtime node")
		}
		return obs, nil
	}
	for _, r := range obs.Rows {
		if r.NodeID != nil && *r.NodeID != "" && *r.NodeID != *space.RuntimeNodeID {
			return obs, errors.New("workspace metadata belongs to a different runtime node")
		}
	}
	if space.WorkspaceKind == "host" && len(obs.Rows) == 0 {
		return obs, nil
	}
	if h.hub == nil {
		return obs, errors.New("workspace runtime node is unavailable")
	}
	runner, err := h.hub.get(*space.RuntimeNodeID)
	if err != nil {
		return obs, err
	}
	var containers []computerContainer
	if err = runner.call(ctx, "docker.list", map[string]any{"label": "zakura.space=" + space.ID}, &containers); err != nil {
		return obs, workspaceRunnerError{err}
	}
	for _, c := range containers {
		purpose := c.Labels["zakura.purpose"]
		if purpose != "workspace" && purpose != "" {
			continue
		}
		if c.DockerID == "" || c.Status == "" || c.Labels["zakura.space"] != space.ID {
			return obs, errors.New("workspace container ownership or observation is incomplete")
		}
		switch c.Status {
		case "running", "exited", "created", "dead":
		default:
			return obs, errors.New("workspace container state is not stable; reconcile it before continuing")
		}
		known := false
		for _, r := range obs.Rows {
			if r.DockerID != nil && *r.DockerID == c.DockerID {
				known = true
			}
		}
		// Legacy workspace containers may have no purpose/tenant label, but only a
		// persisted exact Docker identity may establish that ownership.
		if c.Labels["zakura.tenant"] != space.TenantID && !(known && c.Labels["zakura.tenant"] == "") {
			return obs, errors.New("workspace container tenant ownership mismatch")
		}
		if purpose == "" && !known {
			return obs, errors.New("unowned legacy workspace container")
		}
		if obs.Container.DockerID != "" {
			return obs, errors.New("multiple workspace containers found; reconcile them before continuing")
		}
		obs.Container = c
	}
	for _, r := range obs.Rows {
		if r.DockerID != nil && *r.DockerID != "" && obs.Container.DockerID != "" && *r.DockerID != obs.Container.DockerID {
			return obs, errors.New("workspace metadata conflicts with observed container")
		}
	}
	return obs, nil
}

// Repair the cache under the operation token, including an orphaned real
// container with no database row. This never manufactures provider runtimes or
// assumes that a server computer's ID is derived from its Space ID.
func (l *workspaceLease) recordObservation(ctx context.Context, obs workspaceObservation) error {
	return l.fenced(ctx, func(tx *gorm.DB) error {
		now := runtimeTimeString(l.h.store.now())
		if obs.Container.DockerID == "" {
			return tx.Table("managed_containers").Where("tenant_id=? AND space_id=? AND purpose='workspace'", l.Space.TenantID, l.Space.ID).Updates(map[string]any{"docker_id": nil, "status": "removed", "updated_at": now}).Error
		}
		c := obs.Container
		labels, _ := json.Marshal(c.Labels)
		status := c.Status
		if status != "running" {
			status = "stopped"
		}
		values := map[string]any{"agent_id": nil, "docker_id": c.DockerID, "name": strings.TrimPrefix(c.Name, "/"), "image": c.Image, "status": status, "labels_json": string(labels), "runtime_node_id": l.Space.RuntimeNodeID, "updated_at": now}
		if len(obs.Rows) > 0 {
			if err := tx.Table("managed_containers").Where("tenant_id=? AND space_id=? AND purpose='workspace'", l.Space.TenantID, l.Space.ID).Updates(map[string]any{"docker_id": nil, "status": "removed", "updated_at": now}).Error; err != nil {
				return err
			}
			return tx.Table("managed_containers").Where("id=? AND tenant_id=?", obs.Rows[0].ID, l.Space.TenantID).Updates(values).Error
		}
		values["id"], values["tenant_id"], values["space_id"], values["purpose"], values["ports_json"], values["created_at"] = l.h.store.id(), l.Space.TenantID, l.Space.ID, "workspace", "[]", now
		return tx.Table("managed_containers").Create(values).Error
	})
}
