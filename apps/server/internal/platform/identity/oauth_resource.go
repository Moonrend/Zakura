package identity

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

// Existing resource TEXT columns also preserve immutable approved IDs, so a
// deleted/recreated slug or moved Agent cannot retarget an outstanding grant.
// Legacy rows containing only a URL (or only agent_id) remain readable.
func oauthStoredResource(binding httpx.OAuthMCPResource) *string {
	if binding.Resource == "" {
		return nil
	}
	raw, _ := json.Marshal(binding)
	value := string(raw)
	return &value
}

func (s *Service) oauthGrantBinding(ctx context.Context, tx *sql.Tx, tenant, agent, stored, requested string) (httpx.OAuthMCPResource, error) {
	resource := stored
	var pinned *httpx.OAuthMCPResource
	if strings.HasPrefix(stored, "{") {
		pinned = &httpx.OAuthMCPResource{}
		if json.Unmarshal([]byte(stored), pinned) != nil || pinned.SpaceID == "" || pinned.Resource == "" || pinned.AgentID != agent {
			return httpx.OAuthMCPResource{}, errors.New("invalid stored OAuth resource")
		}
		resource = pinned.Resource
	}
	bound, err := httpx.ResolveOAuthMCPResource(ctx, s.deps, tx, tenant, resource, agent)
	if err != nil {
		return bound, err
	}
	if pinned != nil && *pinned != bound {
		return bound, errors.New("approved OAuth resource ownership changed")
	}
	if requested != "" {
		candidate, err := httpx.ResolveOAuthMCPResource(ctx, s.deps, tx, tenant, requested, agent)
		if err != nil || bound.SpaceID == "" || candidate != bound {
			return bound, errors.New("resource differs from approved OAuth grant")
		}
	}
	return bound, nil
}

func oauthBindingValues(binding httpx.OAuthMCPResource) (sql.NullString, sql.NullString) {
	agent := sql.NullString{String: binding.AgentID, Valid: binding.AgentID != ""}
	resource := sql.NullString{}
	if stored := oauthStoredResource(binding); stored != nil {
		resource = sql.NullString{String: *stored, Valid: true}
	}
	return agent, resource
}
