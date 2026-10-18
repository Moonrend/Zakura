package runtime

import (
	"context"
	"encoding/hex"
	"errors"
	"strings"

	"gorm.io/gorm"
)

type workspaceCreateOperation struct {
	SpaceID      string  `gorm:"column:space_id"`
	TenantID     string  `gorm:"column:tenant_id"`
	NodeID       string  `gorm:"column:node_id"`
	ComputerID   string  `gorm:"column:computer_id"`
	OperationID  string  `gorm:"column:operation_id"`
	Name         string  `gorm:"column:name"`
	ConfigDigest *string `gorm:"column:config_digest"`
	CreatedAt    string  `gorm:"column:created_at"`
}

func (h *handler) workspaceCreateOperation(ctx context.Context, space Space) (*workspaceCreateOperation, error) {
	if space.RuntimeNodeID == nil {
		return nil, errWorkspaceNodeRequired
	}
	var row workspaceCreateOperation
	err := h.deps.Gorm.WithContext(ctx).Table("workspace_create_operations").Where("space_id=? AND tenant_id=? AND node_id=?", space.ID, space.TenantID, *space.RuntimeNodeID).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
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
	if err := lease.fenced(ctx, func(tx *gorm.DB) error {
		return tx.Table("workspace_create_operations").Create(op).Error
	}); err != nil {
		return nil, err
	}
	return op, nil
}

func (op *workspaceCreateOperation) wire() map[string]string {
	return map[string]string{"id": op.OperationID, "tenantId": op.TenantID, "spaceId": op.SpaceID, "computerId": op.ComputerID}
}

func (op *workspaceCreateOperation) matches(c computerContainer, digest string) bool {
	return c.DockerID != "" && strings.TrimPrefix(c.Name, "/") == op.Name &&
		c.Labels["zakura.tenant"] == op.TenantID && c.Labels["zakura.space"] == op.SpaceID &&
		c.Labels["zakura.computer"] == op.ComputerID && c.Labels["zakura.purpose"] == "workspace" &&
		c.Labels["zakura.create-operation"] == op.OperationID && c.Labels["zakura.create-digest"] == digest
}

func (h *handler) reconcileWorkspaceCreate(ctx context.Context, lease *workspaceLease, runner *runnerSession, op *workspaceCreateOperation, obs workspaceObservation) error {
	var receipt struct {
		State, ConfigDigest, Name string
		Container                 *computerContainer
	}
	if err := runner.call(ctx, "docker.create.status", map[string]string{"operationId": op.OperationID, "tenantId": op.TenantID, "spaceId": op.SpaceID, "computerId": op.ComputerID, "name": op.Name}, &receipt); err != nil {
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
