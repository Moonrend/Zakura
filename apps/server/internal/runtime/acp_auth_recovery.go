// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

type acpAuthRecoveryState struct {
	Token               string `gorm:"column:token" json:"-"`
	Kind                string `gorm:"column:kind" json:"kind"`
	ExpiresAt           int64  `gorm:"column:expires_at" json:"expiresAt"`
	UpdatedAt           int64  `gorm:"column:updated_at" json:"-"`
	NodeID              string `gorm:"column:node_id" json:"nodeId"`
	ComputerID          string `gorm:"column:computer_id" json:"computerId"`
	WorkspaceInstanceID string `gorm:"column:workspace_instance_id" json:"workspaceInstanceId,omitempty"`
	WorkspaceGeneration int64  `gorm:"column:workspace_generation" json:"workspaceGeneration,omitempty"`

	WorkspaceToken     string `gorm:"-" json:"-"`
	WorkspaceOperation string `gorm:"-" json:"-"`
	WorkspaceIntent    string `gorm:"-" json:"-"`
	WorkspaceExpiresAt int64  `gorm:"-" json:"-"`
}

func (s acpAuthRecoveryState) recoveryToken() string {
	raw, _ := json.Marshal(s)
	// Include the owner token without exposing a reusable terminal nonce.
	return acpLoginDigest([]byte(string(raw) + "\x00" + s.Token + "\x00" + s.WorkspaceToken + "\x00" + s.WorkspaceOperation + "\x00" + s.WorkspaceIntent))
}

func (h *handler) loadACPAuthRecovery(ctx context.Context, tenant, space, profile string) (acpAuthRecoveryState, error) {
	var state acpAuthRecoveryState
	err := h.deps.Gorm.WithContext(ctx).Table("acp_profile_auth_locks").Where("tenant_id=? AND space_id=? AND profile_id=?", tenant, space, profile).Take(&state).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return state, ErrNotFound
	}
	if err == nil {
		err = h.loadACPRecoveryWorkspace(ctx, tenant, space, &state)
	}
	return state, err
}

func (h *handler) loadACPRecoveryWorkspace(ctx context.Context, tenant, space string, state *acpAuthRecoveryState) error {
	var row struct {
		Token      string `gorm:"column:token"`
		Operation  string `gorm:"column:operation"`
		IntentJSON string `gorm:"column:intent_json"`
		ExpiresAt  int64  `gorm:"column:expires_at"`
	}
	err := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Select("token,operation,intent_json,expires_at").Where("tenant_id=? AND space_id=?", tenant, space).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	state.WorkspaceToken, state.WorkspaceOperation = row.Token, row.Operation
	state.WorkspaceIntent, state.WorkspaceExpiresAt = row.IntentJSON, row.ExpiresAt
	return nil
}

// This is an explicitly acknowledged takeover of the matching profile's intent,
// not generic expired-lease acquisition. Both old workspace and auth callbacks
// are fenced before the original node is observed. Unrelated intents stay busy.
func (h *handler) claimACPAuthRecovery(ctx context.Context, tenant, space, profile string, state acpAuthRecoveryState) (*workspaceLease, error) {
	if err := h.validateACPRecoveryInstance(ctx, tenant, space, state); err != nil {
		return nil, err
	}
	if state.WorkspaceToken == "" {
		lease, err := h.acquireSpaceInfrastructure(ctx, tenant, space)
		if err != nil {
			return nil, err
		}
		if !acpRecoveryMatchesSpace(state, lease.Space) {
			lease.release()
			return nil, errACPAuthLockLost
		}
		lease.Intent.Uncertain = true
		if err = lease.bindSharedProfile(ctx, profile); err != nil {
			lease.release()
			return nil, err
		}
		return lease, nil
	}
	var intent workspaceIntent
	if json.Unmarshal([]byte(state.WorkspaceIntent), &intent) != nil || intent.SharedProfile != profile || state.WorkspaceOperation != "configuring" {
		return nil, errors.New("Space has an unrelated infrastructure operation; reconcile it separately")
	}
	now := h.store.now()
	if !intent.Uncertain && state.WorkspaceExpiresAt > now.UnixMilli() {
		return nil, errors.New("profile infrastructure operation is still active")
	}
	current, err := h.store.GetSpace(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	intent.Uncertain = true
	intentRaw, err := json.Marshal(intent)
	if err != nil {
		return nil, err
	}
	lease := &workspaceLease{h: h, Space: current, Token: h.store.id(), Operation: "configuring", Intent: intent, retained: true}
	err = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Same lock order as ordinary claims, Run admission and deletion.
		result := tx.Table("spaces").Where("tenant_id=? AND id=? AND deletion_pending=FALSE", tenant, space).UpdateColumn("workspace_status", gorm.Expr("workspace_status"))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrConflict
		}
		if err := lockWorkspaceInstance(tx, tenant, space, current.CurrentWorkspaceInstanceID, current.WorkspaceGeneration); err != nil {
			return err
		}
		if !acpRecoveryMatchesSpace(state, current) {
			return errACPAuthLockLost
		}
		var auth int64
		if err := tx.Table("acp_profile_auth_locks").Where("tenant_id=? AND space_id=? AND profile_id=? AND token=? AND updated_at=? AND expires_at<=?", tenant, space, profile, state.Token, state.UpdatedAt, now.UnixMilli()).Count(&auth).Error; err != nil {
			return err
		}
		if auth != 1 {
			return errACPAuthLockLost
		}
		result = tx.Table("computer_workspace_leases").Where("tenant_id=? AND space_id=? AND token=? AND operation=? AND intent_json=? AND expires_at=?", tenant, space, state.WorkspaceToken, state.WorkspaceOperation, state.WorkspaceIntent, state.WorkspaceExpiresAt).Updates(map[string]any{"token": lease.Token, "intent_json": string(intentRaw), "expires_at": now.Add(workspaceLeaseDuration).UnixMilli(), "updated_at": now.UnixMilli()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errWorkspaceLeaseLost
		}
		return nil
	})
	return lease, err
}

func (h *handler) acpAuthRecoveryScope(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	p := principal(r)
	space, profile := chi.URLParam(r, "spaceId"), chi.URLParam(r, "profileId")
	if (p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin) || (p.APIKey && !APIKeyScopeAllows(p, "computers:manage")) {
		httpx.Error(w, 403, "profile recovery management permission required")
		return "", "", false
	}
	if !acpProfileIDPattern.MatchString(profile) || httpx.AuthorizeResource(r.Context(), h.deps, p, space, "") != nil {
		httpx.Error(w, 404, "resource not found")
		return "", "", false
	}
	w.Header().Set("Cache-Control", "no-store")
	return space, profile, true
}

func (h *handler) getACPAuthRecovery(w http.ResponseWriter, r *http.Request) {
	space, profile, ok := h.acpAuthRecoveryScope(w, r)
	if !ok {
		return
	}
	state, err := h.loadACPAuthRecovery(r.Context(), principal(r).TenantID, space, profile)
	if errors.Is(err, ErrNotFound) {
		httpx.JSON(w, 200, map[string]any{"authentication": nil})
		return
	}
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"authentication": state, "recoveryToken": state.recoveryToken()})
}

func (h *handler) reconcileACPAuthentication(ctx context.Context, tenant, space, profile, token string) error {
	state, err := h.loadACPAuthRecovery(ctx, tenant, space, profile)
	if err != nil {
		return err
	}
	if state.recoveryToken() != token || state.ExpiresAt > h.store.now().UnixMilli() {
		return errors.New("authentication changed or is still active; wait until its lease expires")
	}
	if state.NodeID == "" || state.ComputerID == "" {
		return errors.New("legacy authentication lock has no original target; operator reconciliation is required")
	}
	if state.WorkspaceInstanceID != "" {
		// An empty inventory cannot prove that a timed-out credential RPC ended.
		// Retiring the instance invokes the node's durable writer release barrier.
		return errors.New("managed workspace authentication is unconfirmed; delete the workspace while retaining its disk to release the original writers")
	}
	lease, err := h.claimACPAuthRecovery(ctx, tenant, space, profile, state)
	if err != nil {
		return err
	}
	defer lease.release()
	var inFlight int64
	if err = h.deps.Gorm.WithContext(ctx).Table(acpDeviceTable).Where("tenant_id=? AND space_id=? AND profile_id=? AND status='persisting' AND next_poll_at>?", tenant, space, profile, runtimeTimeString(h.store.now())).Count(&inFlight).Error; err != nil {
		return err
	}
	if inFlight != 0 {
		return errors.New("credential persistence is still active")
	}
	if h.acp != nil {
		h.acp.mu.Lock()
		live := false
		for _, rt := range h.acp.runtimes {
			if rt.tenantID == tenant && rt.spaceID == space && rt.profileID == profile {
				select {
				case <-rt.done:
				default:
					live = true
				}
			}
		}
		h.acp.mu.Unlock()
		if live {
			return errors.New("close live ACP sessions before reconciling authentication")
		}
	}
	// Fence late renew/release callbacks before observing the original node. An
	// observation failure leaves a quarantined, manually retryable recovery lock.
	next := h.store.id()
	result := h.deps.Gorm.WithContext(ctx).Table("acp_profile_auth_locks").Where("tenant_id=? AND space_id=? AND profile_id=? AND token=? AND updated_at=? AND expires_at<=?", tenant, space, profile, state.Token, state.UpdatedAt, h.store.now().UnixMilli()).Updates(map[string]any{"token": next, "kind": "recovering", "updated_at": h.store.now().UnixMilli()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errACPAuthLockLost
	}
	lease.retained = true
	runner, err := h.hub.get(state.NodeID)
	if err != nil {
		return err
	}
	var containers []acpSidecarContainer
	if err = runner.call(ctx, "docker.list", map[string]any{"label": "zakura.space=" + space}, &containers); err != nil {
		return errors.New("cannot confirm authentication process absence on the original node")
	}
	for _, container := range containers {
		if container.DockerID == "" || container.Labels["zakura.tenant"] != tenant || container.Labels["zakura.space"] != space {
			return errors.New("authentication process ownership is incomplete")
		}
		purpose := container.Labels["zakura.purpose"]
		if purpose == "acp-adapter" || purpose == "acp-login" {
			return errors.New("remove original ACP/login containers before reconciling authentication")
		}
	}
	return lease.fenced(ctx, func(tx *gorm.DB) error {
		result := tx.Table("acp_profile_auth_locks").Where("tenant_id=? AND space_id=? AND profile_id=? AND token=? AND kind='recovering'", tenant, space, profile, next).Delete(map[string]any{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errACPAuthLockLost
		}
		if err := tx.Table(acpDeviceTable).Where("tenant_id=? AND space_id=? AND profile_id=? AND status IN ?", tenant, space, profile, []string{"starting", "pending", "polling", "persisting", "unknown"}).Updates(map[string]any{"status": "cancelled", "encrypted_payload": "", "user_code": "", "verification_uri": "", "error": "Authentication explicitly reconciled by an administrator", "version": gorm.Expr("version+1"), "updated_at": runtimeTimeString(h.store.now())}).Error; err != nil {
			return err
		}
		if err := tx.Table("spaces").Where("tenant_id=? AND id=?", tenant, space).Updates(map[string]any{"workspace_status": lease.Intent.PreviousStatus, "last_error": nil, "updated_at": runtimeTimeString(h.store.now())}).Error; err != nil {
			return err
		}
		return tx.Table("computer_workspace_leases").Where("tenant_id=? AND space_id=? AND token=?", tenant, space, lease.Token).Delete(map[string]any{}).Error
	})
}

func (h *handler) acknowledgeACPAuthRecovery(w http.ResponseWriter, r *http.Request) {
	space, profile, ok := h.acpAuthRecoveryScope(w, r)
	if !ok {
		return
	}
	var body struct {
		RecoveryToken     string `json:"recoveryToken"`
		OperationQuiesced bool   `json:"operationQuiesced"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.RecoveryToken == "" || !body.OperationQuiesced {
		httpx.Error(w, 400, "confirm that the original remote operation has ended and provide its recovery token")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if err := h.reconcileACPAuthentication(ctx, principal(r).TenantID, space, profile, body.RecoveryToken); err != nil {
		httpx.Error(w, 409, err.Error())
		return
	}
	httpx.JSON(w, 200, map[string]any{"reconciled": true})
}
