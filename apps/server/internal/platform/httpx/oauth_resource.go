package httpx

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
)

// OAuthResourceQueryer lets issuance resolve the approved resource in the same
// transaction that consumes its authorization code or refresh token.
type OAuthResourceQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type OAuthMCPResource struct {
	SpaceID  string `json:"spaceId"`
	AgentID  string `json:"agentId,omitempty"`
	Resource string `json:"resource"`
}

// ResolveOAuthMCPResource accepts only this issuer's exact Space MCP endpoint or
// its legacy Agent alias. An Agent narrows a Space grant; an alias never grants
// another Agent, even when both Agents currently belong to the same Space.
// Empty resource+Agent remains unbound for ordinary OIDC/API clients, not MCP.
func ResolveOAuthMCPResource(ctx context.Context, deps *appdeps.Dependencies, db OAuthResourceQueryer, tenant, resource, agent string) (OAuthMCPResource, error) {
	bound := OAuthMCPResource{AgentID: agent}
	invalid := errors.New("invalid or mismatched OAuth MCP resource")
	if tenant == "" {
		return bound, invalid
	}
	if agent != "" {
		if err := db.QueryRowContext(ctx, deps.Rebind(`SELECT space_id FROM agents WHERE tenant_id=? AND id=?`), tenant, agent).Scan(&bound.SpaceID); err != nil {
			return bound, invalid
		}
	}
	if resource != "" {
		base, baseErr := url.Parse(deps.PublicURL)
		u, err := url.Parse(resource)
		if baseErr != nil || err != nil || !u.IsAbs() || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") || !strings.EqualFold(u.Scheme, base.Scheme) || !strings.EqualFold(u.Host, base.Host) {
			return bound, invalid
		}
		prefix := strings.TrimRight(base.Path, "/") + "/mcp/"
		if !strings.HasPrefix(u.Path, prefix) {
			return bound, invalid
		}
		parts := strings.Split(strings.TrimPrefix(u.Path, prefix), "/")
		if len(parts) != 2 || parts[1] == "" || parts[1] == "." || parts[1] == ".." || strings.ContainsAny(parts[1], "\\\x00") {
			return bound, invalid
		}
		var space string
		switch parts[0] {
		case "spaces":
			if err := db.QueryRowContext(ctx, deps.Rebind(`SELECT id FROM spaces WHERE tenant_id=? AND slug=?`), tenant, parts[1]).Scan(&space); err != nil {
				return bound, invalid
			}
		case "agents":
			var aliasAgent string
			if err := db.QueryRowContext(ctx, deps.Rebind(`SELECT id,space_id FROM agents WHERE tenant_id=? AND slug=?`), tenant, parts[1]).Scan(&aliasAgent, &space); err != nil || agent != "" && agent != aliasAgent {
				return bound, invalid
			}
			bound.AgentID = aliasAgent
		default:
			return bound, invalid
		}
		if bound.SpaceID != "" && bound.SpaceID != space {
			return bound, invalid
		}
		bound.SpaceID = space
	}
	if bound.SpaceID != "" {
		var slug string
		if err := db.QueryRowContext(ctx, deps.Rebind(`SELECT slug FROM spaces WHERE tenant_id=? AND id=?`), tenant, bound.SpaceID).Scan(&slug); err != nil {
			return bound, invalid
		}
		bound.Resource = strings.TrimRight(deps.PublicURL, "/") + "/mcp/spaces/" + url.PathEscape(slug)
	}
	return bound, nil
}
