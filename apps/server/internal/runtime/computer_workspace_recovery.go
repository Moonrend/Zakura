package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"gorm.io/gorm"
)

// recoverSpaceWorkspaces is called by the existing computer sweep. It installs
// no scheduler. A token rotation fences every old completion/release before any
// observation or metadata repair, including a worker resuming after a crash.
func (h *handler) recoverSpaceWorkspaces(ctx context.Context, limit int) error {
	if limit <= 0 {
		return nil
	}
	// Upgrade-era status-only claims have no durable owner. Preserve them as
	// uncertain intents instead of leaving a Space permanently busy. Recovery
	// still only observes/retries idempotent stop; it never recreates a container.
	var stranded []struct {
		ID       string `gorm:"column:id"`
		TenantID string `gorm:"column:tenant_id"`
		Status   string `gorm:"column:workspace_status"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("spaces").Select("id,tenant_id,workspace_status").Where("workspace_status IN ('starting','stopping','configuring') AND NOT EXISTS (SELECT 1 FROM computer_workspace_leases l WHERE l.space_id=spaces.id AND l.tenant_id=spaces.tenant_id)").Limit(limit).Find(&stranded).Error; err != nil {
		return err
	}
	for _, space := range stranded {
		raw, _ := json.Marshal(workspaceIntent{PreviousStatus: "stopped", Uncertain: true})
		if err := h.deps.Gorm.WithContext(ctx).Exec(`INSERT INTO computer_workspace_leases(space_id,tenant_id,token,operation,expires_at,intent_json,updated_at) SELECT id,tenant_id,?,?,0,?,? FROM spaces WHERE id=? AND tenant_id=? AND workspace_status=? ON CONFLICT(space_id) DO NOTHING`, h.store.id(), space.Status, string(raw), h.store.now().UnixMilli(), space.ID, space.TenantID, space.Status).Error; err != nil {
			return err
		}
	}
	var rows []struct {
		SpaceID    string `gorm:"column:space_id"`
		TenantID   string `gorm:"column:tenant_id"`
		Token      string `gorm:"column:token"`
		Operation  string `gorm:"column:operation"`
		IntentJSON string `gorm:"column:intent_json"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Select("space_id,tenant_id,token,operation,intent_json").Where("expires_at<=?", h.store.now().UnixMilli()).Order("expires_at,space_id").Limit(limit).Find(&rows).Error; err != nil {
		return err
	}
	var failures []error
	for _, row := range rows {
		space, err := h.store.GetSpace(ctx, row.TenantID, row.SpaceID)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		l := &workspaceLease{h: h, Space: space, Token: h.store.id(), Operation: row.Operation}
		if err = json.Unmarshal([]byte(row.IntentJSON), &l.Intent); err != nil {
			failures = append(failures, err)
			continue
		}
		if l.Intent.SharedProfile != "" {
			// Profile recovery coordinates both owner tokens explicitly. Even token
			// rotation here would invalidate a reviewed authentication recovery.
			continue
		}
		now := h.store.now()
		result := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Where("space_id=? AND tenant_id=? AND token=? AND expires_at<=?", row.SpaceID, row.TenantID, row.Token, now.UnixMilli()).Updates(map[string]any{"token": l.Token, "expires_at": now.Add(workspaceLeaseDuration).UnixMilli(), "updated_at": now.UnixMilli()})
		if result.Error != nil {
			failures = append(failures, result.Error)
			continue
		}
		if result.RowsAffected != 1 {
			continue
		}
		if err = h.recoverSpaceWorkspace(ctx, l); err != nil {
			failures = append(failures, fmt.Errorf("recover workspace %s: %w", space.ID, err))
		}
	}
	return errors.Join(failures...)
}
func (h *handler) recoverSpaceWorkspace(ctx context.Context, l *workspaceLease) error {
	if l.Intent.SharedProfile != "" {
		return l.uncertain(errors.New("profile authentication outcome requires explicit profile recovery"))
	}
	if l.Operation == "migrating" {
		return h.recoverWorkspaceMigration(ctx, l)
	}
	obs, err := h.observeSpaceWorkspace(ctx, l.Space)
	if err != nil {
		return l.uncertain(err)
	}
	if l.Operation == "starting" && l.Space.RuntimeNodeID != nil {
		op, err := h.workspaceCreateOperation(ctx, l.Space)
		if err != nil {
			return err
		}
		if op != nil {
			runner, err := h.hub.get(*l.Space.RuntimeNodeID)
			if err != nil {
				return l.uncertain(err)
			}
			if err = h.reconcileWorkspaceCreate(ctx, l, runner, op, obs); err != nil {
				return l.uncertain(err)
			}
		}
	}
	if err = l.recordObservation(ctx, obs); err != nil {
		return err
	}
	switch l.Operation {
	case "starting":
		if l.Space.WorkspaceKind == "host" {
			return l.finish(ctx, "stopped", map[string]any{"last_error": nil})
		}
		if obs.Container.DockerID == "" {
			return l.uncertain(errors.New("workspace creation is still being checked; no replacement will be created until the original operation is confirmed"))
		}
		state := "stopped"
		if obs.Container.Status == "running" {
			state = "running"
		}
		return l.finish(ctx, state, map[string]any{"last_error": nil})
	case "stopping":
		if obs.Container.Status == "running" {
			if err = l.check(ctx); err != nil {
				return err
			}
			runner, err := h.hub.get(*l.Space.RuntimeNodeID)
			if err != nil {
				return l.uncertain(err)
			}
			if err = runner.call(ctx, "docker.stop", map[string]any{"id": obs.Container.DockerID, "remove": false}, nil); err != nil {
				return l.uncertain(err)
			}
			obs, err = h.observeSpaceWorkspace(ctx, l.Space)
			if err != nil {
				return l.uncertain(err)
			}
			if obs.Container.Status == "running" {
				return l.uncertain(errors.New("workspace stop remains unconfirmed"))
			}
			if err = l.recordObservation(ctx, obs); err != nil {
				return err
			}
		}
		return l.finish(ctx, "stopped", map[string]any{"last_error": nil})
	case "configuring":
		if l.Intent.DesiredConfig == nil {
			return l.uncertain(errors.New("shared workspace write outcome is unknown; explicit recovery acknowledgement is required"))
		}
		if obs.Container.Status == "running" {
			return l.finish(ctx, "running", map[string]any{"last_error": "configuration was not applied because the workspace is running"})
		}
		if err = l.removeStoppedWorkspace(ctx, obs); err != nil {
			return err
		}
		return l.applyConfig(ctx, *l.Intent.DesiredConfig)
	default:
		return l.uncertain(errors.New("unknown workspace operation"))
	}
}

// acknowledgeAbsentSpaceWorkspace is an integration hook for an explicitly
// authorized operator action, not a sweep or automatic retry. The caller must
// display the persisted token/intent and obtain acknowledgement that the remote
// operation has been quiesced. A fresh authoritative list and token CAS are still
// required, so a stale UI cannot unlock a replacement operation.
func (h *handler) acknowledgeAbsentSpaceWorkspace(ctx context.Context, tenant, spaceID, token string) error {
	space, err := h.store.GetSpace(ctx, tenant, spaceID)
	if err != nil {
		return err
	}
	l := &workspaceLease{h: h, Space: space, Token: token}
	var lease struct {
		IntentJSON string `gorm:"column:intent_json"`
		Operation  string `gorm:"column:operation"`
	}
	err = h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Select("intent_json,operation").Where("space_id=? AND tenant_id=? AND token=?", spaceID, tenant, token).Take(&lease).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return errWorkspaceLeaseLost
	}
	if err != nil {
		return err
	}
	if err = json.Unmarshal([]byte(lease.IntentJSON), &l.Intent); err != nil {
		return err
	}
	if l.Intent.SharedProfile != "" {
		return errors.New("reconcile authentication through the profile recovery endpoint")
	}
	if !l.Intent.Uncertain || space.WorkspaceStatus != "error" {
		return errors.New("an active workspace operation cannot be acknowledged as absent")
	}
	obs, err := h.observeSpaceWorkspace(ctx, space)
	if err != nil {
		return err
	}
	sharedWrite := lease.Operation == "configuring" && l.Intent.DesiredConfig == nil
	if obs.Container.DockerID != "" && !sharedWrite {
		return errors.New("a workspace container exists; reconcile it instead of acknowledging absence")
	}
	status := "stopped"
	if sharedWrite {
		status = l.Intent.PreviousStatus
		if obs.Container.DockerID != "" {
			status = "stopped"
			if obs.Container.Status == "running" {
				status = "running"
			}
		}
	}
	// Rotate and renew even an expired lease: this path is explicitly acknowledged,
	// unlike normal acquisition, which never steals an expired operation.
	old := token
	l.Token = h.store.id()
	now := h.store.now()
	r := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Where("space_id=? AND tenant_id=? AND token=?", spaceID, tenant, old).Updates(map[string]any{"token": l.Token, "expires_at": now.Add(workspaceLeaseDuration).UnixMilli(), "updated_at": now.UnixMilli()})
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return errWorkspaceLeaseLost
	}
	return l.fenced(ctx, func(tx *gorm.DB) error {
		if err := tx.Table("spaces").Where("tenant_id=? AND id=?", tenant, spaceID).Updates(map[string]any{"workspace_status": status, "last_error": nil, "updated_at": runtimeTimeString(now)}).Error; err != nil {
			return err
		}
		return tx.Table("computer_workspace_leases").Where("space_id=? AND tenant_id=? AND token=?", spaceID, tenant, l.Token).Delete(map[string]any{}).Error
	})
}
