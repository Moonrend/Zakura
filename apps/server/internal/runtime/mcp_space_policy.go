// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func (h *handler) authorizeMCPPolicy(ctx context.Context, p httpx.Principal, space, agent *string) error {
	s, a := "", ""
	if space != nil {
		s = *space
	}
	if agent != nil {
		a = *agent
	}
	if s == "" && a == "" {
		if p.APIKey && (p.SpaceID != "" || p.AgentID != "") {
			return ErrNotFound
		}
		return nil
	}
	_, _, err := h.authorizeMCPScope(ctx, p, s, a)
	if err != nil {
		return err
	}
	// An Agent-bound key can only alter its own narrowing, never the Space ceiling.
	if p.APIKey && p.AgentID != "" && a != p.AgentID {
		return ErrNotFound
	}
	return nil
}
func (h *handler) authorizeMCPPolicyID(ctx context.Context, p httpx.Principal, id string) (*string, *string, error) {
	var row struct {
		SpaceID *string `gorm:"column:space_id"`
		AgentID *string `gorm:"column:agent_id"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("mcp_policies").Select("space_id,agent_id").Where("tenant_id=? AND id=?", p.TenantID, id).Take(&row).Error; err != nil {
		return nil, nil, ErrNotFound
	}
	return row.SpaceID, row.AgentID, h.authorizeMCPPolicy(ctx, p, row.SpaceID, row.AgentID)
}
func validateMCPPolicy(raw json.RawMessage) error {
	var p map[string]any
	if json.Unmarshal(raw, &p) != nil || p == nil {
		return errors.New("policy object required")
	}
	for _, key := range []string{"instanceIds", "toolAllowlist", "toolDenylist", "resourceAllowlist", "resourceDenylist", "promptAllowlist", "promptDenylist"} {
		value, exists := p[key]
		if !exists || value == nil {
			continue
		}
		items, ok := value.([]any)
		if !ok {
			return errors.New("policy lists must be arrays or null")
		}
		for _, item := range items {
			if _, ok := item.(string); !ok {
				return errors.New("policy list entries must be strings")
			}
		}
	}
	return nil
}

// PatchMCPConfig preserves the encrypted credential envelope and forbids API
// callers from rewriting the canonical owner or provisioning provenance.
func (h *handler) PatchMCPConfig(ctx context.Context, tenant, id string, patch json.RawMessage) (string, string, error) {
	inst, err := h.getMCPInstance(ctx, tenant, id)
	if err != nil {
		return "", "", err
	}
	current := map[string]any{}
	next := map[string]any{}
	if json.Unmarshal(inst.Config, &current) != nil || json.Unmarshal(patch, &next) != nil {
		return "", "", errors.New("invalid MCP config")
	}
	if value, ok := next["exposure"]; ok {
		exposure, valid := value.(string)
		if !valid || !mcpExposureValue(exposure) {
			return "", "", errors.New("exposure must be direct, deferred or hidden")
		}
	}
	if value, ok := next["toolExposure"]; ok {
		overrides, valid := value.(map[string]any)
		if !valid {
			return "", "", errors.New("toolExposure must be an object")
		}
		for name, value := range overrides {
			exposure, valid := value.(string)
			if name == "" || !valid || !mcpExposureValue(exposure) {
				return "", "", errors.New("toolExposure values must be direct, deferred or hidden")
			}
		}
	}
	for _, key := range []string{"ownerSpaceId", "serverComputerId", "runtimeNodeId", "dataSpaceId", "dataPath", "workspaceTarget"} {
		if value, ok := next[key]; ok {
			a, _ := json.Marshal(value)
			b, _ := json.Marshal(current[key])
			if string(a) != string(b) {
				return "", "", errors.New("MCP ownership and runtime provenance cannot be patched")
			}
		}
	}
	var envelope struct {
		Enc string `json:"enc"`
	}
	_ = json.Unmarshal(inst.Secret, &envelope)
	secret := map[string]any{}
	if envelope.Enc != "" {
		plain, e := openSecretBox(h.deps.Secret, "mcp:"+id, envelope.Enc)
		if e != nil {
			return "", "", e
		}
		if e = json.Unmarshal(plain, &secret); e != nil {
			return "", "", e
		}
	}
	for key, value := range next {
		current[key] = value
	}
	for _, key := range []string{"token", "apiKey", "accessToken", "access_token", "headers", "credentials", "secret", "env", "clientSecret"} {
		if value, ok := current[key]; ok {
			secret[key] = value
			delete(current, key)
		}
	}
	configRaw, _ := json.Marshal(current)
	secretRaw, _ := json.Marshal(secret)
	enc, err := secretBox(h.deps.Secret, "mcp:"+id, secretRaw)
	if err != nil {
		return "", "", err
	}
	stored, _ := json.Marshal(map[string]any{"enc": enc, "configured": len(secret) > 0})
	return string(configRaw), string(stored), nil
}
