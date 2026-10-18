// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func (s *Service) checkToolApprovalAccess(ctx context.Context, tenant string) error {
	if err := checkToolApprovalAccess(ctx); err != nil {
		return err
	}
	if _, ok := ctx.Value(toolApprovalAccessCheckKey{}).(func(context.Context) error); ok {
		return nil // ACP revalidates its saved original actor and workspace together.
	}
	actor, ok := httpx.PrincipalFrom(ctx)
	if !ok {
		return nil
	}
	invalid := errors.New("tool caller authorization is no longer valid")
	if actor.TenantID != tenant {
		return invalid
	}
	user := actor.UserID
	if actor.APIKey {
		var key httpx.Principal
		if actor.APIKeyID == "" {
			return invalid
		}
		err := s.store.deps.DB.QueryRowContext(ctx, s.store.deps.Rebind(`SELECT COALESCE(k.user_id,''),COALESCE(k.space_id,''),COALESCE(k.agent_id,''),k.scopes FROM api_keys k JOIN tenants t ON t.id=k.tenant_id WHERE k.id=? AND k.tenant_id=? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>?) AND t.status='active'`), actor.APIKeyID, tenant, runtimeTimeString(s.store.now())).Scan(&user, &key.SpaceID, &key.AgentID, &key.APIKeyScopes)
		key.APIKey = true
		if err != nil || key.SpaceID != actor.SpaceID || key.AgentID != actor.AgentID || !APIKeyScopeAllows(key, "api") {
			return invalid
		}
	} else {
		if user == "" {
			return invalid
		}
		if actor.OAuth {
			allowed := false
			for _, scope := range strings.Fields(actor.OAuthScope) {
				allowed = allowed || scope == "api"
			}
			if !allowed || !actor.OAuthExpiresAt.After(s.store.now()) {
				return invalid
			}
		} else if actor.SessionID != "" {
			var active int
			if err := s.store.deps.DB.QueryRowContext(ctx, s.store.deps.Rebind(`SELECT 1 FROM user_sessions WHERE id=? AND user_id=? AND tenant_id=? AND revoked_at IS NULL AND expires_at>?`), actor.SessionID, user, tenant, runtimeTimeString(s.store.now())).Scan(&active); err != nil {
				return invalid
			}
		}
	}
	if user != "" {
		var active int
		if err := s.store.deps.DB.QueryRowContext(ctx, s.store.deps.Rebind(`SELECT 1 FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND u.status='active' AND t.status='active'`), tenant, user).Scan(&active); err != nil {
			return invalid
		}
	}
	return nil
}
