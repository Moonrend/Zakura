package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"gorm.io/gorm"
)

var errOwnerDeletionUncertain = errors.New("computer creation or cleanup outcome is unknown; reconcile it before deletion")

// Callers must retain the durable deletion fence until their DELETE commits.
// A successful preparation is retryable and performs no remote destruction.
func (h *handler) requireSpaceNotDeleting(ctx context.Context, tenant, space string) error {
	var row struct {
		Pending bool `gorm:"column:deletion_pending"`
	}
	err := h.deps.Gorm.WithContext(ctx).Table("spaces").Select("deletion_pending").Where("tenant_id=? AND id=?", tenant, space).Take(&row).Error
	if err != nil {
		return err
	}
	if row.Pending {
		return computers.ErrOwnerDeleting
	}
	var deleting int64
	if err = h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Where("tenant_id=? AND space_id=? AND operation='deleting'", tenant, space).Count(&deleting).Error; err != nil {
		return err
	}
	if deleting != 0 {
		return computers.ErrOwnerDeleting
	}
	return nil
}

func (h *handler) prepareSpaceDeletion(ctx context.Context, tenant, space string) error {
	return h.prepareOwnerDeletion(ctx, tenant, space, "")
}
func (h *handler) prepareComputerDeletion(ctx context.Context, tenant, space, computer string) error {
	c, err := h.computerStore().Get(ctx, tenant, space, computer)
	if err != nil {
		return err
	}
	if c.IsServer() {
		return computers.ErrServerComputerManaged
	}
	return h.prepareAttachedComputerDeletion(ctx, c)
}

type ownerRuntimeRow struct {
	ID          string `gorm:"column:id"`
	Incarnation string `gorm:"column:incarnation"`
	ComputerID  string `gorm:"column:computer_id"`
	Provider    string `gorm:"column:provider"`
}
type ownerCleanupRuntime struct {
	Runtime  computers.Runtime
	Provider computers.Provider
}

func (h *handler) prepareOwnerDeletion(ctx context.Context, tenant, space, computer string) (err error) {
	// The workspace token is also needed for attached deletion: ACP and provider
	// operations share the Space node and may otherwise recreate a sidecar.
	resumed := false
	lease, err := h.acquireSpaceWorkspace(ctx, tenant, space, "deleting", false, nil)
	if errors.Is(err, errWorkspaceStarting) {
		// Retry only our own durable deletion, never steal another operation's lease.
		var row struct {
			Token      string `gorm:"column:token"`
			Operation  string `gorm:"column:operation"`
			IntentJSON string `gorm:"column:intent_json"`
		}
		if readErr := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Select("token,operation,intent_json").Where("tenant_id=? AND space_id=?", tenant, space).Take(&row).Error; readErr != nil || row.Operation != "deleting" {
			return err
		}
		var pending bool
		table, where, args := "spaces", "tenant_id=? AND id=?", []any{tenant, space}
		if computer != "" {
			table, where, args = "computers", "tenant_id=? AND space_id=? AND id=?", []any{tenant, space, computer}
		}
		if readErr := h.deps.Gorm.WithContext(ctx).Table(table).Select("deletion_pending").Where(where, args...).Scan(&pending).Error; readErr != nil || !pending {
			return err
		}
		current, readErr := h.store.GetSpace(ctx, tenant, space)
		if readErr != nil {
			return readErr
		}
		lease = &workspaceLease{h: h, Space: current, Token: row.Token, Operation: "deleting", retained: true}
		if readErr = json.Unmarshal([]byte(row.IntentJSON), &lease.Intent); readErr != nil {
			return readErr
		}
		resumed = true
		now := h.store.now()
		newToken := h.store.id()
		res := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Where("tenant_id=? AND space_id=? AND token=? AND operation='deleting'", tenant, space, row.Token).Updates(map[string]any{"token": newToken, "expires_at": now.Add(workspaceLeaseDuration).UnixMilli(), "updated_at": now.UnixMilli()})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return errWorkspaceLeaseLost
		}
		lease.Token = newToken
		err = nil
	}
	if err != nil {
		return err
	}
	keepFence := false
	defer func() {
		if !keepFence {
			lease.release()
		}
	}()
	err = lease.fenced(ctx, func(tx *gorm.DB) error {
		q := tx.Table("spaces").Where("tenant_id=? AND id=?", tenant, space)
		if computer != "" {
			// Lock the Space before computer, matching creation's lock order.
			if e := q.Update("updated_at", runtimeTimeString(h.store.now())).Error; e != nil {
				return e
			}
			q = tx.Table("computers").Where("tenant_id=? AND space_id=? AND id=?", tenant, space, computer)
		}
		result := q.Update("deletion_pending", true)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return err
	}
	if resumed && lease.Intent.OwnerCleanupPrepared {
		if lease.Intent.OwnerCleanupComputer != computer {
			return computers.ErrOwnerDeleting
		}
		drained, readErr := h.ownerCleanupDrained(ctx, tenant, space)
		if readErr != nil {
			return readErr
		}
		if drained {
			keepFence = true
			return lease.check(ctx)
		}
	}
	resetFlag := func() {
		if resumed {
			return
		}
		_ = lease.fenced(context.WithoutCancel(ctx), func(tx *gorm.DB) error {
			if computer != "" {
				return tx.Table("computers").Where("tenant_id=? AND space_id=? AND id=?", tenant, space, computer).Update("deletion_pending", false).Error
			}
			return tx.Table("spaces").Where("tenant_id=? AND id=?", tenant, space).Update("deletion_pending", false).Error
		})
	}
	var targets []ownerRuntimeRow
	q := h.deps.Gorm.WithContext(ctx).Table("computer_runtimes r").Select("r.id,r.incarnation,r.computer_id,c.provider").Joins("JOIN computers c ON c.id=r.computer_id AND c.tenant_id=r.tenant_id AND c.space_id=r.space_id").Where("r.tenant_id=? AND r.space_id=?", tenant, space)
	if computer != "" {
		q = q.Where("r.computer_id=?", computer)
	}
	if err = q.Find(&targets).Error; err != nil {
		resetFlag()
		return err
	}
	var runtimes []ownerCleanupRuntime
	for _, row := range targets {
		r, readErr := h.computerStore().GetRuntime(ctx, computers.Target{TenantID: tenant, SpaceID: space, ComputerID: row.ComputerID, RuntimeID: row.ID, Incarnation: row.Incarnation})
		if readErr != nil {
			resetFlag()
			return readErr
		}
		if r.State == computers.Creating || r.State == computers.Unknown {
			resetFlag()
			return errOwnerDeletionUncertain
		}
		if row.Provider == string(computers.Temporary) || row.Provider == string(computers.E2B) {
			if r.State == computers.Destroyed {
				runtimes = append(runtimes, ownerCleanupRuntime{r, computers.Provider(row.Provider)})
				continue
			}
			if r.ExternalID == "" {
				if r.State != computers.PendingApproval && r.State != computers.Failed {
					resetFlag()
					return errOwnerDeletionUncertain
				}
			} else if e := h.preflightOwnerRuntime(ctx, r, computers.Provider(row.Provider)); e != nil {
				resetFlag()
				return e
			}
		} else if r.State != computers.Destroyed && r.ExternalID != "" && row.Provider != string(computers.SSH) {
			resetFlag()
			return computers.ErrProviderUnavailable
		}
		if computer != "" && (r.State == computers.Ready || r.State == computers.Disconnected || r.State == computers.Stopping) {
			var busy int64
			if e := h.deps.Gorm.WithContext(ctx).Table("run_computer_targets t").Joins("JOIN cloud_agent_runs cr ON cr.id=t.run_id").Where("t.tenant_id=? AND t.space_id=? AND t.computer_id=? AND cr.status IN ('queued','running')", tenant, space, computer).Count(&busy).Error; e != nil {
				resetFlag()
				return e
			}
			if busy > 0 {
				resetFlag()
				return computers.ErrComputerInUse
			}
		}
		runtimes = append(runtimes, ownerCleanupRuntime{r, computers.Provider(row.Provider)})
	}
	managed, err := h.captureOwnerManagedContainers(ctx, tenant, space, computer)
	if err != nil {
		resetFlag()
		return err
	}
	if err = h.closeOwnerWorkspaceBridges(ctx, tenant, space, computer); err != nil {
		resetFlag()
		return err
	}
	if err = h.recoverOwnerWorkspaceConnections(ctx, lease, computer); err != nil {
		resetFlag()
		return err
	}
	// Revoke exact identities before queuing. A crash now retains the owner and
	// deletion flag; a retry can capture the terminal runtime and finish the queue.
	err = lease.fenced(ctx, func(tx *gorm.DB) error {
		for _, item := range runtimes {
			r := item.Runtime
			if r.State == computers.Destroyed || r.State == computers.Expired || r.State == computers.Failed {
				continue
			}
			state := computers.Expired
			if r.State == computers.PendingApproval {
				state = computers.Failed
			}
			res := tx.Table("computer_runtimes").Where("tenant_id=? AND space_id=? AND computer_id=? AND id=? AND incarnation=? AND state=? AND COALESCE(external_id,'')=?", tenant, space, r.ComputerID, r.ID, r.Incarnation, r.State, r.ExternalID).Updates(map[string]any{"state": state, "updated_at": runtimeTimeString(h.store.now())})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return computers.ErrTransitionConflict
			}
		}
		return nil
	})
	if err != nil {
		resetFlag()
		return err
	}
	// From this point rollback must not silently permit creation again.
	keepFence = true
	lease.retained = true
	deps := computers.CleanupDeps{Store: h.computerStore(), Destroyers: h.computerDestroyers(), Now: func() time.Time { return h.store.now() }}
	for _, item := range runtimes {
		if item.Runtime.ExternalID == "" || item.Runtime.State == computers.Destroyed {
			continue
		}
		if item.Provider != computers.Temporary && item.Provider != computers.E2B {
			continue
		}
		if err = deps.QueueCleanup(ctx, item.Runtime); err != nil {
			return err
		}
	}
	for _, snapshot := range managed {
		if err = h.queueManagedContainerCleanup(ctx, snapshot); err != nil {
			return err
		}
	}
	// Mark preparation only after every immutable snapshot/intent is durable.
	// The scope prevents an attached-computer preparation authorizing Space deletion.
	lease.Intent.OwnerCleanupPrepared = true
	lease.Intent.OwnerCleanupComputer = computer
	raw, err := json.Marshal(lease.Intent)
	if err != nil {
		return err
	}
	return lease.fenced(ctx, func(tx *gorm.DB) error {
		return tx.Table("computer_workspace_leases").Where("tenant_id=? AND space_id=? AND token=? AND operation='deleting'", tenant, space, lease.Token).Update("intent_json", string(raw)).Error
	})
}

func (h *handler) ownerCleanupDrained(ctx context.Context, tenant, space string) (bool, error) {
	for _, table := range []string{"computer_cleanup_intents", "managed_container_cleanup_intents"} {
		var pending int64
		q := h.deps.Gorm.WithContext(ctx).Table(table).Where("tenant_id=? AND pending=TRUE", tenant)
		if space != "" {
			q = q.Where("space_id=?", space)
		}
		if err := q.Count(&pending).Error; err != nil {
			return false, err
		}
		if pending != 0 {
			return false, nil
		}
	}
	return true, nil
}

func (h *handler) preflightOwnerRuntime(ctx context.Context, r computers.Runtime, provider computers.Provider) error {
	switch provider {
	case computers.Temporary:
		p := temporaryComputerProvider{h: h}
		if _, err := p.CaptureCleanup(ctx, r); err != nil {
			return err
		}
		runner, _, err := p.nodeRunner(ctx, r)
		if err != nil {
			return err
		}
		_, err = observeTemporaryCleanup(ctx, runner, r)
		return err
	case computers.E2B:
		p := e2bComputerProvider{h: h}
		if _, err := p.CaptureCleanup(ctx, r); err != nil {
			return err
		}
		cfg, err := p.configuration(ctx, r)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.base()+"/sandboxes/"+url.PathEscape(r.ExternalID), nil)
		if err != nil {
			return err
		}
		req.Header.Set("X-API-Key", cfg.APIKey)
		client := *p.client()
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		resp, err := client.Do(req)
		if err != nil {
			return errors.New("E2B deletion ownership request failed")
		}
		defer resp.Body.Close()
		if resp.StatusCode == 404 {
			return nil
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("E2B deletion ownership request rejected with status %d", resp.StatusCode)
		}
		var actual struct {
			SandboxID string            `json:"sandboxID"`
			Metadata  map[string]string `json:"metadata"`
		}
		if json.NewDecoder(resp.Body).Decode(&actual) != nil || actual.SandboxID != r.ExternalID || !e2bMetadataMatches(actual.Metadata, r) {
			return errors.New("E2B deletion ownership could not be verified")
		}
		return nil
	}
	return computers.ErrProviderUnavailable
}

func (h *handler) finishComputerDeletion(ctx context.Context, tenant, space string) error {
	var count int64
	if err := h.deps.Gorm.WithContext(ctx).Table("computers").Where("tenant_id=? AND space_id=? AND deletion_pending=TRUE", tenant, space).Count(&count).Error; err != nil {
		return err
	}
	if count != 0 {
		return computers.ErrOwnerDeleting
	}
	current, err := h.store.GetSpace(ctx, tenant, space)
	if err != nil {
		return err
	}
	var spacePending bool
	if err = h.deps.Gorm.WithContext(ctx).Table("spaces").Select("deletion_pending").Where("tenant_id=? AND id=?", tenant, space).Scan(&spacePending).Error; err != nil {
		return err
	}
	if spacePending {
		return computers.ErrOwnerDeleting
	}
	var row struct {
		Token      string `gorm:"column:token"`
		IntentJSON string `gorm:"column:intent_json"`
	}
	if err = h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Select("token,intent_json").Where("tenant_id=? AND space_id=? AND operation='deleting'", tenant, space).Take(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil // The successful finalizer may itself have lost its reply.
		}
		return err
	}
	l := &workspaceLease{h: h, Space: current, Token: row.Token, Operation: "deleting"}
	if err = json.Unmarshal([]byte(row.IntentJSON), &l.Intent); err != nil {
		return err
	}
	// Owner deletion can outlive the original lease. Only the exact retained
	// deletion token, with no pending owner left, may be renewed for finalization.
	now := h.store.now()
	res := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Where("tenant_id=? AND space_id=? AND token=? AND operation='deleting'", tenant, space, row.Token).Updates(map[string]any{"expires_at": now.Add(workspaceLeaseDuration).UnixMilli(), "updated_at": now.UnixMilli()})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected != 1 {
		return errWorkspaceLeaseLost
	}
	return l.finish(ctx, l.Intent.PreviousStatus, nil)
}

func ownerString(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}
