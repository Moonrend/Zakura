// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

var errLocalRunnerForbidden = errors.New("local runner permission required")

func (h *handler) authorizeLocalNode(ctx context.Context, p httpx.Principal, node string) error {
	if node == "" {
		return nil
	}
	var kind string
	if err := h.deps.Gorm.WithContext(ctx).Table("runtime_nodes").Select("kind").Where("id=? AND (tenant_id=? OR is_shared=TRUE)", node, p.TenantID).Scan(&kind).Error; err != nil {
		return err
	}
	if kind != "local" || !h.deps.MultiTenant || p.IsPlatformAdmin {
		return nil
	}
	if p.APIKey || p.UserID == "" {
		return errLocalRunnerForbidden
	}
	var permitted int64
	err := h.deps.Gorm.WithContext(ctx).Table("users AS u").Joins("JOIN tenant_memberships m ON m.user_id=u.id").Where("u.id=? AND u.status='active' AND u.can_use_local_runner=TRUE AND m.tenant_id=? AND m.status='active'", p.UserID, p.TenantID).Count(&permitted).Error
	if err != nil {
		return err
	}
	if permitted != 1 {
		return errLocalRunnerForbidden
	}
	return nil
}

func (h *handler) authorizeContextLocalNode(ctx context.Context, tenant, node string) error {
	p, _ := httpx.PrincipalFrom(ctx)
	if p.TenantID != "" && p.TenantID != tenant {
		return errLocalRunnerForbidden
	}
	p.TenantID = tenant
	return h.authorizeLocalNode(ctx, p, node)
}
