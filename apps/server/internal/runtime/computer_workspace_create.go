package runtime

import (
	"context"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"

	"gorm.io/gorm"
)

type workspaceCreateOperation struct {
	SpaceID         string             `gorm:"column:space_id"`
	TenantID        string             `gorm:"column:tenant_id"`
	NodeID          string             `gorm:"column:node_id"`
	ComputerID      string             `gorm:"column:computer_id"`
	OperationID     string             `gorm:"column:operation_id"`
	Name            string             `gorm:"column:name"`
	ConfigDigest    *string            `gorm:"column:config_digest"`
	CreatedAt       string             `gorm:"column:created_at"`
	InstanceID      *string            `gorm:"column:workspace_instance_id"`
	IdentityVersion int                `gorm:"column:identity_version"`
	target          *workspaces.Target `gorm:"-"`
}

func (h *handler) workspaceCreateOperation(ctx context.Context, space Space) (*workspaceCreateOperation, error) {
	if space.RuntimeNodeID == nil {
		return nil, errWorkspaceNodeRequired
	}
	var row workspaceCreateOperation
	query := h.deps.Gorm.WithContext(ctx).Table("workspace_create_operations").Where("space_id=? AND tenant_id=? AND node_id=?", space.ID, space.TenantID, *space.RuntimeNodeID)
	if space.CurrentWorkspaceInstanceID == nil {
		query = query.Where("workspace_instance_id IS NULL")
	} else {
		query = query.Where("workspace_instance_id=?", *space.CurrentWorkspaceInstanceID)
	}
	err := query.Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err == nil && row.IdentityVersion == 2 {
		instance, e := h.workspaceStore().Instance(ctx, space.TenantID, space.ID, *space.CurrentWorkspaceInstanceID)
		if e != nil {
			return nil, e
		}
		if instance.Generation != space.WorkspaceGeneration {
			return nil, workspaces.ErrTargetRevoked
		}
		row.target = &instance.Target
	}
	return &row, err
}

// The database intent precedes docker.create. Once present, neither a missing
// receipt nor an empty Docker list can authorize another create on this node.
func (h *handler) beginWorkspaceCreate(ctx context.Context, lease *workspaceLease, runner *runnerSession) (*workspaceCreateOperation, error) {
	var info struct {
		Capabilities struct {
			Receipts bool `json:"dockerCreateReceipts"`
		} `json:"capabilities"`
	}
	if err := runner.call(ctx, "sys.info", map[string]any{}, &info); err != nil {
		return nil, err
	}
	if !info.Capabilities.Receipts {
		return nil, errors.New("update the runtime node before creating a workspace safely")
	}
	exec, err := h.resolveServerComputer(ctx, lease.Space.TenantID, lease.Space.ID)
	if err != nil {
		return nil, err
	}
	if exec.nodeID != runner.nodeID {
		return nil, errors.New("workspace computer binding changed")
	}
	op := &workspaceCreateOperation{SpaceID: lease.Space.ID, TenantID: lease.Space.TenantID, NodeID: runner.nodeID, ComputerID: exec.computer.ID, OperationID: h.store.id(), Name: "zakura-ws-" + slugify(lease.Space.Slug) + "-" + lease.Space.ID, CreatedAt: runtimeTimeString(h.store.now())}
	op.IdentityVersion = 1
	if exec.workspace != nil {
		if lease.Space.CurrentWorkspaceInstanceID == nil || *lease.Space.CurrentWorkspaceInstanceID != exec.workspace.Target.InstanceID || lease.Space.WorkspaceGeneration != exec.workspace.Target.Generation {
			return nil, workspaces.ErrTargetRevoked
		}
		op.InstanceID = &exec.workspace.Target.InstanceID
		op.IdentityVersion = 2
		op.target = &exec.workspace.Target
		op.Name = "zakura-ws-" + exec.workspace.Target.InstanceID
	}
	if err := lease.fenced(ctx, func(tx *gorm.DB) error {
		if err := tx.Table("workspace_create_operations").Create(op).Error; err != nil {
			return err
		}
		if op.InstanceID != nil {
			r := tx.Table("workspace_instances").Where("id=? AND tenant_id=? AND space_id=? AND revoked_at IS NULL AND create_operation_id IS NULL", *op.InstanceID, op.TenantID, op.SpaceID).Updates(map[string]any{"create_operation_id": op.OperationID, "state": "creating", "updated_at": op.CreatedAt})
			if r.Error != nil {
				return r.Error
			}
			if r.RowsAffected != 1 {
				return workspaces.ErrConflict
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return op, nil
}

func (op *workspaceCreateOperation) wire() map[string]any {
	params := map[string]any{"id": op.OperationID, "tenantId": op.TenantID, "spaceId": op.SpaceID, "computerId": op.ComputerID}
	if t := op.target; t != nil {
		params["instanceId"], params["generation"], params["diskId"] = t.InstanceID, t.Generation, t.DiskID
		params["locatorVersion"], params["nodeIncarnation"] = t.LocatorVersion, t.NodeIncarnation
	}
	return params
}

func (op *workspaceCreateOperation) labels() map[string]string {
	labels := map[string]string{"zakura.tenant": op.TenantID, "zakura.space": op.SpaceID, "zakura.computer": op.ComputerID, "zakura.purpose": "workspace"}
	if t := op.target; t != nil {
		labels["zakura.workspace-instance"] = t.InstanceID
		labels["zakura.workspace-generation"] = strconv.FormatInt(t.Generation, 10)
		labels["zakura.disk"] = t.DiskID
		labels["zakura.disk-version"] = strconv.FormatInt(t.LocatorVersion, 10)
		labels["zakura.node-incarnation"] = t.NodeIncarnation
	}
	return labels
}

func (op *workspaceCreateOperation) matches(c computerContainer, digest string) bool {
	for key, value := range op.labels() {
		if c.Labels[key] != value {
			return false
		}
	}
	return c.DockerID != "" && strings.TrimPrefix(c.Name, "/") == op.Name &&
		c.Labels["zakura.create-operation"] == op.OperationID && c.Labels["zakura.create-digest"] == digest
}

func (h *handler) reconcileWorkspaceCreate(ctx context.Context, lease *workspaceLease, runner *runnerSession, op *workspaceCreateOperation, obs workspaceObservation) error {
	var receipt struct {
		State, ConfigDigest, Name string
		Container                 *computerContainer
	}
	params := op.wire()
	delete(params, "id")
	params["operationId"], params["name"] = op.OperationID, op.Name
	if err := runner.call(ctx, "docker.create.status", params, &receipt); err != nil {
		return err
	}
	digest, err := hex.DecodeString(receipt.ConfigDigest)
	if err != nil || len(digest) != 32 || hex.EncodeToString(digest) != receipt.ConfigDigest || receipt.State != "committed" || receipt.Name != op.Name || receipt.Container == nil || !op.matches(*receipt.Container, receipt.ConfigDigest) {
		return errors.New("workspace creation is still being checked; the original operation has not been confirmed")
	}
	if op.ConfigDigest != nil && *op.ConfigDigest != receipt.ConfigDigest {
		return errors.New("workspace creation receipt changed configuration")
	}
	// A receipt proves a past effect, not current liveness or absence.
	if obs.Container.DockerID != receipt.Container.DockerID || !op.matches(obs.Container, receipt.ConfigDigest) {
		return errors.New("workspace creation receipt does not match the current container")
	}
	return lease.fenced(ctx, func(tx *gorm.DB) error {
		r := tx.Table("workspace_create_operations").Where("space_id=? AND tenant_id=? AND node_id=? AND operation_id=? AND (config_digest IS NULL OR config_digest=?)", op.SpaceID, op.TenantID, op.NodeID, op.OperationID, receipt.ConfigDigest).Update("config_digest", receipt.ConfigDigest)
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return errWorkspaceLeaseLost
		}
		return nil
	})
}
