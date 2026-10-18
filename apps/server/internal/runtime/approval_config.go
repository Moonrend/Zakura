// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/agentconfig"
)

// Agent JSON is always a public representation. Internal callers keep Config raw.
func (a Agent) MarshalJSON() ([]byte, error) {
	type plain Agent
	v := plain(a)
	v.Config = publicAgentConfig(a.Config)
	return json.Marshal(v)
}

func publicAgentConfig(raw json.RawMessage) json.RawMessage {
	var cfg map[string]any
	if json.Unmarshal(raw, &cfg) != nil || cfg == nil {
		return json.RawMessage(`{}`)
	}
	if cloud, ok := cfg["cloud"].(map[string]any); ok {
		redactCloudApprovals(cloud)
	}
	encoded, _ := json.Marshal(cfg)
	return encoded
}

func redactCloudApprovals(cloud map[string]any) {
	approvals, _ := cloud["approvals"].(map[string]any)
	gate, _ := approvals["aiGate"].(map[string]any)
	if gate == nil {
		return
	}
	if _, ok := gate["jevApiKey"]; ok {
		gate["jevMigrationPending"] = true
	}
	for _, key := range []string{"jevApiKey", "jevMigrationEnc", "apiKey", "credentialEnc", "accessToken", "refreshToken"} {
		delete(gate, key)
	}
}

func approvalGate(cfg map[string]any, create bool) map[string]any {
	cloud, _ := cfg["cloud"].(map[string]any)
	if cloud == nil && create {
		cloud = map[string]any{}
		cfg["cloud"] = cloud
	}
	approvals, _ := cloud["approvals"].(map[string]any)
	if approvals == nil && create {
		approvals = map[string]any{}
		cloud["approvals"] = approvals
	}
	gate, _ := approvals["aiGate"].(map[string]any)
	if gate == nil && create {
		gate = map[string]any{}
		approvals["aiGate"] = gate
	}
	return gate
}

func preserveApprovalMigration(cfg map[string]any, encrypted string) {
	if encrypted != "" {
		gate := approvalGate(cfg, true)
		gate["jevMigrationEnc"] = encrypted
		gate["jevMigrationPending"] = true
	}
}

func discardClientApprovalEnvelope(cfg map[string]any) {
	if gate := approvalGate(cfg, false); gate != nil {
		delete(gate, "jevMigrationEnc")
		delete(gate, "jevMigrationPending")
	}
}

// Protect old private credentials before any routes or background workers run.
// Each replayable CAS reads the current config; it never creates tenant-wide routes.
func (s *Store) protectStoredAgentApprovals(ctx context.Context) error {
	cursor := ""
	for {
		var rows []struct {
			ID       string `gorm:"column:id"`
			TenantID string `gorm:"column:tenant_id"`
		}
		if err := s.deps.Gorm.WithContext(ctx).Table("agents").Select("id,tenant_id").Where("id>? AND config_json LIKE ?", cursor, `%"approvals"%`).Order("id").Limit(100).Find(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			_, err := agentconfig.Update(ctx, s.deps.Gorm, row.TenantID, row.ID, runtimeTimeString(s.now()), nil, func(cfg map[string]any) error {
				return protectAgentApprovals(s.deps.Secret, row.TenantID, row.ID, cfg)
			})
			if err != nil {
				return fmt.Errorf("protect stored tool approval configuration: %w", err)
			}
			cursor = row.ID
		}
		if len(rows) < 100 {
			return nil
		}
	}
}

func protectAgentApprovals(secret []byte, tenant, agent string, cfg map[string]any) error {
	cloud, _ := cfg["cloud"].(map[string]any)
	approvals, _ := cloud["approvals"].(map[string]any)
	if approvals == nil {
		return nil
	}
	if policy, _ := approvals["policy"].(string); policy == "ask" {
		approvals["policy"] = "always_ask"
	}
	if gate, ok := approvals["aiGate"].(map[string]any); ok {
		return protectLegacyJevGate(secret, tenant, agent, gate)
	}
	return nil
}
