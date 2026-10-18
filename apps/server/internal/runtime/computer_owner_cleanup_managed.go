package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"gorm.io/gorm"
)

type managedOwnerContainer struct {
	ID         string  `gorm:"column:id"`
	NodeID     *string `gorm:"column:runtime_node_id"`
	DockerID   *string `gorm:"column:docker_id"`
	InstanceID *string `gorm:"column:instance_id"`
	Purpose    string  `gorm:"column:purpose"`
	Name       string  `gorm:"column:name"`
	Image      string  `gorm:"column:image"`
	LabelsJSON string  `gorm:"column:labels_json"`
}
type managedCleanupSnapshot struct {
	TenantID    string            `json:"tenantId"`
	SpaceID     string            `json:"spaceId"`
	ContainerID string            `json:"containerId"`
	NodeID      string            `json:"nodeId"`
	Container   computerContainer `json:"container"`
}

func (h *handler) captureOwnerManagedContainers(ctx context.Context, tenant, space, computer string) ([]managedCleanupSnapshot, error) {
	var rows []managedOwnerContainer
	q := h.deps.Gorm.WithContext(ctx).Table("managed_containers").Select("id,runtime_node_id,docker_id,instance_id,purpose,name,image,labels_json").Where("tenant_id=? AND docker_id IS NOT NULL AND docker_id<>''", tenant)
	if space != "" {
		q = q.Where("space_id=?", space)
	}
	if err := q.Find(&rows).Error; err != nil {
		return nil, err
	}
	nodes := map[string]bool{}
	known := map[string]managedOwnerContainer{}
	for _, row := range rows {
		if computer != "" {
			var labels map[string]string
			if json.Unmarshal([]byte(row.LabelsJSON), &labels) != nil || labels["zakura.computer"] != computer {
				continue
			}
		}
		node := ownerString(row.NodeID)
		if node == "" {
			return nil, errors.New("managed container has no runtime node")
		}
		nodes[node] = true
		known[node+"/"+ownerString(row.DockerID)] = row
	}
	if space != "" && computer == "" {
		s, err := h.store.GetSpace(ctx, tenant, space)
		if err != nil {
			return nil, err
		}
		if node := ownerString(s.RuntimeNodeID); node != "" {
			nodes[node] = true
		}
	} else if space == "" {
		var tenantNodes []string
		if err := h.deps.Gorm.WithContext(ctx).Table("runtime_nodes").Where("tenant_id=?", tenant).Pluck("id", &tenantNodes).Error; err != nil {
			return nil, err
		}
		for _, node := range tenantNodes {
			// Registration alone is not evidence of a workload: admin-created
			// nodes can exist without ever connecting. Known managed/Space/
			// computer routes remain mandatory; extra live nodes are scanned
			// only to discover tenant-owned containers missing their cache row.
			if h.hub != nil {
				if _, err := h.hub.get(node); err == nil {
					nodes[node] = true
				}
			}
		}
	}
	// ACP sidecars on an attached temporary computer may never have had a
	// managed metadata row, and its node need not be the Space workspace node.
	var computerNodes []string
	computerQuery := h.deps.Gorm.WithContext(ctx).Table("computers").Where("tenant_id=? AND runtime_node_id IS NOT NULL AND runtime_node_id<>''", tenant)
	if space != "" {
		computerQuery = computerQuery.Where("space_id=?", space)
	}
	if computer != "" {
		computerQuery = computerQuery.Where("id=? AND provider IN ('server','temporary')", computer)
	}
	if err := computerQuery.Pluck("runtime_node_id", &computerNodes).Error; err != nil {
		return nil, err
	}
	for _, node := range computerNodes {
		nodes[node] = true
	}
	var snapshots []managedCleanupSnapshot
	seen := map[string]bool{}
	for node := range nodes {
		if h.hub == nil {
			if computer != "" {
				continue // Stored attached identities can be queued while offline.
			}
			return nil, errors.New("managed cleanup runtime node is offline")
		}
		runner, err := h.hub.get(node)
		if err != nil {
			if computer != "" {
				continue
			}
			return nil, err
		}
		var listed []computerContainer
		if err = runner.call(ctx, "docker.list", map[string]any{}, &listed); err != nil {
			if computer != "" {
				continue
			}
			return nil, err
		}
		for _, c := range listed {
			row, isKnown := known[node+"/"+c.DockerID]
			relevant := isKnown || (c.Labels["zakura.tenant"] == tenant && (space == "" || c.Labels["zakura.space"] == space))
			if computer != "" {
				relevant = c.Labels["zakura.computer"] == computer && (isKnown || (c.Labels["zakura.tenant"] == tenant && c.Labels["zakura.space"] == space))
			}
			if !relevant {
				continue
			}
			purpose := c.Labels["zakura.purpose"]
			if purpose == "computer" {
				continue
			} // provider snapshot owns its storage cleanup
			if c.DockerID == "" || c.Name == "" || c.Image == "" {
				return nil, errors.New("managed cleanup observation is incomplete")
			}
			switch c.Status {
			case "running", "exited", "created", "dead":
			default:
				return nil, errors.New("managed cleanup container state is uncertain")
			}
			if isKnown {
				if row.Name != "" && strings.TrimPrefix(c.Name, "/") != strings.TrimPrefix(row.Name, "/") {
					return nil, errors.New("managed cleanup container name mismatch")
				}
				if row.Image != "" && c.Image != row.Image {
					return nil, errors.New("managed cleanup container image mismatch")
				}
				var labels map[string]string
				if row.LabelsJSON != "" && json.Unmarshal([]byte(row.LabelsJSON), &labels) != nil {
					return nil, errors.New("managed cleanup ownership metadata is invalid")
				}
				for key, value := range labels {
					if c.Labels[key] != value {
						return nil, errors.New("managed cleanup ownership label mismatch")
					}
				}
				if purpose == "component" {
					if ownerString(row.InstanceID) == "" || c.Labels["zakura.instance"] != ownerString(row.InstanceID) {
						return nil, errors.New("managed component ownership mismatch")
					}
				} else if c.Labels["zakura.space"] != space && space != "" {
					return nil, errors.New("managed container Space ownership mismatch")
				}
				if c.Labels["zakura.tenant"] != "" && c.Labels["zakura.tenant"] != tenant {
					return nil, errors.New("managed container tenant ownership mismatch")
				}
			} else if c.Labels["zakura.tenant"] != tenant || (space != "" && c.Labels["zakura.space"] != space) {
				return nil, errors.New("orphan managed container ownership mismatch")
			}
			switch purpose {
			case "workspace", "component", "acp-adapter", "acp-sidecar", "acp-login":
			default:
				return nil, errors.New("managed cleanup container purpose is unsupported")
			}
			key := node + "/" + c.DockerID
			if seen[key] {
				return nil, errors.New("duplicate managed cleanup observation")
			}
			seen[key] = true
			id := row.ID
			if id == "" {
				id = "observed:" + c.DockerID
			}
			snapshots = append(snapshots, managedCleanupSnapshot{TenantID: tenant, SpaceID: space, ContainerID: id, NodeID: node, Container: c})
		}
	}
	// Known identities absent from a complete list still need an intent so a late
	// retry cannot resurrect metadata. Their stored ownership remains explicit.
	for key, row := range known {
		if seen[key] || row.Purpose == "computer" {
			continue
		}
		var labels map[string]string
		if row.LabelsJSON != "" {
			if json.Unmarshal([]byte(row.LabelsJSON), &labels) != nil {
				return nil, errors.New("managed cleanup labels are invalid")
			}
		}
		if computer != "" && labels["zakura.computer"] != computer {
			continue
		}
		snapshots = append(snapshots, managedCleanupSnapshot{TenantID: tenant, SpaceID: space, ContainerID: row.ID, NodeID: ownerString(row.NodeID), Container: computerContainer{DockerID: ownerString(row.DockerID), Name: row.Name, Image: row.Image, Labels: labels}})
	}
	return snapshots, nil
}
func sealManagedSnapshot(h *handler, s managedCleanupSnapshot, plain []byte) (string, error) {
	space := s.SpaceID
	if space == "" {
		space = "tenant-managed"
	}
	return computers.SealCredentials(h.deps.Secret, s.TenantID, space, "managed:"+s.ContainerID, plain)
}
func openManagedSnapshot(h *handler, tenant, space, id, sealed string) (managedCleanupSnapshot, error) {
	identitySpace := space
	if identitySpace == "" {
		identitySpace = "tenant-managed"
	}
	plain, err := computers.OpenCredentials(h.deps.Secret, tenant, identitySpace, "managed:"+id, sealed)
	if err != nil {
		return managedCleanupSnapshot{}, errors.New("managed cleanup snapshot could not be opened")
	}
	var snapshot managedCleanupSnapshot
	if json.Unmarshal(plain, &snapshot) != nil || snapshot.TenantID != tenant || snapshot.SpaceID != space || snapshot.ContainerID != id {
		return managedCleanupSnapshot{}, errors.New("managed cleanup snapshot identity is invalid")
	}
	return snapshot, nil
}

func (h *handler) queueManagedContainerCleanup(ctx context.Context, snapshot managedCleanupSnapshot) error {
	plain, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	sealed, err := sealManagedSnapshot(h, snapshot, plain)
	if err != nil {
		return err
	}
	now := h.store.now().UnixMilli()
	return h.deps.Gorm.WithContext(ctx).Exec(`INSERT INTO managed_container_cleanup_intents(id,tenant_id,space_id,container_id,node_id,docker_id,snapshot_json,pending,attempts,next_attempt,token,updated_at) VALUES(?,?,?,?,?,?,?,TRUE,0,?,'',?) ON CONFLICT(node_id,docker_id) DO NOTHING`, h.store.id(), snapshot.TenantID, snapshot.SpaceID, snapshot.ContainerID, snapshot.NodeID, snapshot.Container.DockerID, sealed, now, now).Error
}

func (h *handler) sweepManagedContainerCleanup(ctx context.Context, limit int) error {
	var rows []struct {
		ID           string `gorm:"column:id"`
		TenantID     string `gorm:"column:tenant_id"`
		SpaceID      string `gorm:"column:space_id"`
		ContainerID  string `gorm:"column:container_id"`
		NodeID       string `gorm:"column:node_id"`
		DockerID     string `gorm:"column:docker_id"`
		SnapshotJSON string `gorm:"column:snapshot_json"`
		Token        string `gorm:"column:token"`
		NextAttempt  int64  `gorm:"column:next_attempt"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("managed_container_cleanup_intents").Where("pending=TRUE AND next_attempt<=?", h.store.now().UnixMilli()).Order("next_attempt,id").Limit(limit).Find(&rows).Error; err != nil {
		return err
	}
	var failures []error
	for _, row := range rows {
		now := h.store.now()
		token := h.store.id()
		result := h.deps.Gorm.WithContext(ctx).Table("managed_container_cleanup_intents").Where("id=? AND token=? AND next_attempt=? AND pending=TRUE", row.ID, row.Token, row.NextAttempt).Updates(map[string]any{"token": token, "attempts": gorm.Expr("attempts+1"), "next_attempt": now.Add(2 * time.Minute).UnixMilli(), "updated_at": now.UnixMilli()})
		if result.Error != nil {
			failures = append(failures, result.Error)
			continue
		}
		if result.RowsAffected != 1 {
			continue
		}
		callCtx, cancel := context.WithTimeout(ctx, time.Minute)
		snapshot, err := openManagedSnapshot(h, row.TenantID, row.SpaceID, row.ContainerID, row.SnapshotJSON)
		if err == nil && (snapshot.NodeID != row.NodeID || snapshot.Container.DockerID != row.DockerID) {
			err = errors.New("managed cleanup durable identity mismatch")
		}
		if err == nil {
			err = h.destroyManagedSnapshot(callCtx, snapshot)
		}
		cancel()
		done := h.store.now()
		var last any
		if err != nil {
			last = err.Error()
		}
		writeErr := h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			res := tx.Table("managed_container_cleanup_intents").Where("id=? AND token=? AND pending=TRUE AND next_attempt>?", row.ID, token, done.UnixMilli()).Updates(map[string]any{"pending": err != nil, "last_error": last, "next_attempt": done.Add(time.Minute).UnixMilli(), "updated_at": done.UnixMilli()})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return errWorkspaceLeaseLost
			}
			if err == nil {
				return tx.Table("managed_containers").Where("tenant_id=? AND id=? AND runtime_node_id=? AND docker_id=?", row.TenantID, row.ContainerID, row.NodeID, row.DockerID).Updates(map[string]any{"docker_id": nil, "status": "removed", "updated_at": runtimeTimeString(done)}).Error
			}
			return nil
		})
		if writeErr != nil {
			failures = append(failures, writeErr)
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("managed cleanup: %w", err))
		}
	}
	return errors.Join(failures...)
}
func (h *handler) destroyManagedSnapshot(ctx context.Context, s managedCleanupSnapshot) error {
	if h.hub == nil {
		return errors.New("managed cleanup node is offline")
	}
	runner, err := h.hub.get(s.NodeID)
	if err != nil {
		return err
	}
	observe := func() (bool, error) {
		var list []computerContainer
		if err := runner.call(ctx, "docker.list", map[string]any{}, &list); err != nil {
			return false, err
		}
		found := false
		for _, c := range list {
			if c.DockerID != s.Container.DockerID && strings.TrimPrefix(c.Name, "/") != strings.TrimPrefix(s.Container.Name, "/") {
				continue
			}
			if c.DockerID != s.Container.DockerID {
				return false, errors.New("managed cleanup name belongs to a replacement")
			}
			if c.Name != s.Container.Name || c.Image != s.Container.Image {
				return false, errors.New("managed cleanup identity changed")
			}
			for key, value := range s.Container.Labels {
				if c.Labels[key] != value {
					return false, errors.New("managed cleanup ownership changed")
				}
			}
			if found {
				return false, errors.New("managed cleanup duplicate identity")
			}
			found = true
		}
		return found, nil
	}
	found, err := observe()
	if err != nil {
		return err
	}
	if !found {
		return nil
	}
	if err = runner.call(ctx, "docker.stop", map[string]any{"id": s.Container.DockerID, "remove": true}, nil); err != nil {
		return err
	}
	found, err = observe()
	if err != nil {
		return err
	}
	if found {
		return errors.New("managed cleanup removal is not confirmed")
	}
	return nil
}
