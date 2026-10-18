// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

// Control-plane operations (authorization, configuration) can reach a stopped
// installation, but never bypass ownership or exact credential bindings.
func (h *handler) authorizeStoredMCPInstance(ctx context.Context, p httpx.Principal, inst mcpInstance) (string, error) {
	owner, err := h.mcpOwnerSpace(ctx, inst)
	if err != nil {
		return "", err
	}
	if owner == "" {
		var spaces []string
		if err = h.deps.Gorm.WithContext(ctx).Table("agent_bindings").Where("tenant_id=? AND instance_id=?", p.TenantID, inst.ID).Distinct().Pluck("space_id", &spaces).Error; err != nil {
			return "", err
		}
		if inst.AgentID != nil {
			a, e := h.store.GetAgent(ctx, p.TenantID, *inst.AgentID)
			if e != nil {
				return "", e
			}
			spaces = append(spaces, a.SpaceID)
		}
		spaces = uniqueStrings(spaces)
		if len(spaces) != 1 {
			return "", ErrNotFound
		}
		owner = spaces[0]
	}
	_, _, err = h.authorizeMCPScope(ctx, p, owner, p.AgentID)
	return owner, err
}

func mcpPublicConfig(raw json.RawMessage) json.RawMessage {
	config := map[string]any{}
	if json.Unmarshal(raw, &config) != nil {
		return json.RawMessage(`{}`)
	}
	for _, key := range []string{"env", "headers", "token", "apiKey", "accessToken", "access_token", "credentials", "secret", "clientSecret"} {
		delete(config, key)
	}
	out, _ := json.Marshal(config)
	return out
}
