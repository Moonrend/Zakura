// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"time"
)

var errACPAuthBusy = errors.New("another profile authentication is active")
var errACPAuthLockLost = errors.New("profile authentication lock expired or was replaced")

func (h *handler) acquireACPAuthLock(ctx context.Context, tenant, space, profile, kind, token string, ttl time.Duration, targets ...*resolvedExecution) error {
	if tenant == "" || space == "" || profile == "" || kind == "" || token == "" || ttl <= 0 || ttl > time.Hour {
		return errors.New("invalid profile authentication lock")
	}
	node, computer := "", ""
	if len(targets) > 0 && targets[0] != nil {
		target := targets[0]
		if target.spaceID != space || target.computer.TenantID != tenant || target.nodeID == "" || target.computer.ID == "" {
			return errors.New("invalid profile authentication target")
		}
		node, computer = target.nodeID, target.computer.ID
	}
	now := h.store.now().UnixMilli()
	result, err := h.deps.DB.ExecContext(ctx, h.deps.Rebind(`INSERT INTO acp_profile_auth_locks(tenant_id,space_id,profile_id,token,kind,expires_at,updated_at,node_id,computer_id) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM acp_device_auth_attempts WHERE tenant_id=? AND space_id=? AND profile_id=? AND status IN ('unknown','persisting')) ON CONFLICT(tenant_id,space_id,profile_id) DO UPDATE SET token=excluded.token,kind=excluded.kind,expires_at=excluded.expires_at,updated_at=excluded.updated_at,node_id=excluded.node_id,computer_id=excluded.computer_id WHERE acp_profile_auth_locks.expires_at<=? AND acp_profile_auth_locks.kind IN ('terminal-pending','device')`), tenant, space, profile, token, kind, now+ttl.Milliseconds(), now, node, computer, tenant, space, profile, now)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errACPAuthBusy
	}
	return nil
}

func (h *handler) activateACPTerminalAuthLock(ctx context.Context, tenant, space, profile, token string) error {
	now := h.store.now().UnixMilli()
	result, err := h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE acp_profile_auth_locks SET kind='terminal',expires_at=?,updated_at=? WHERE tenant_id=? AND space_id=? AND profile_id=? AND token=? AND kind='terminal-pending' AND expires_at>?`), now+acpLoginSessionLimit.Milliseconds(), now, tenant, space, profile, token, now)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errACPAuthLockLost
	}
	return nil
}

func (h *handler) renewACPAuthLock(ctx context.Context, tenant, space, profile, token string, ttl time.Duration) error {
	if ttl <= 0 || ttl > time.Hour {
		return errors.New("invalid profile authentication lock duration")
	}
	now := h.store.now().UnixMilli()
	result, err := h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE acp_profile_auth_locks SET expires_at=?,updated_at=? WHERE tenant_id=? AND space_id=? AND profile_id=? AND token=? AND expires_at>?`), now+ttl.Milliseconds(), now, tenant, space, profile, token, now)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errACPAuthLockLost
	}
	return nil
}

func (h *handler) releaseACPAuthLock(ctx context.Context, tenant, space, profile, token string) error {
	_, err := h.deps.DB.ExecContext(ctx, h.deps.Rebind(`DELETE FROM acp_profile_auth_locks WHERE tenant_id=? AND space_id=? AND profile_id=? AND token=?`), tenant, space, profile, token)
	return err
}
