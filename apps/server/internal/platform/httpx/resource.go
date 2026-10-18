package httpx

import (
	"context"
	"database/sql"
	"errors"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
)

var ErrResourceScope = errors.New("resource not found")

// AuthorizeResource checks ownership as well as API-key binding. Capability
// scopes remain the responsibility of the endpoint's capability middleware.
func AuthorizeResource(ctx context.Context, deps *appdeps.Dependencies, p Principal, space, agent string) error {
	if p.TenantID == "" || space == "" && agent == "" {
		return ErrResourceScope
	}
	if agent != "" {
		var owningSpace string
		err := deps.DB.QueryRowContext(ctx, deps.Rebind(`SELECT space_id FROM agents WHERE tenant_id=? AND id=?`), p.TenantID, agent).Scan(&owningSpace)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrResourceScope
			}
			return err
		}
		if space != "" && space != owningSpace {
			return ErrResourceScope
		}
		space = owningSpace
	}
	var exists int
	if err := deps.DB.QueryRowContext(ctx, deps.Rebind(`SELECT 1 FROM spaces WHERE tenant_id=? AND id=?`), p.TenantID, space).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrResourceScope
		}
		return err
	}
	if !p.APIKey && !p.OAuth {
		return nil
	}
	if p.SpaceID != "" && p.SpaceID != space || p.AgentID != "" && p.AgentID != agent {
		return ErrResourceScope
	}
	return nil
}
