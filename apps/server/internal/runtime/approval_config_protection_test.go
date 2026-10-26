// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestStoredApprovalProtectionIsPrivateAndIdempotent(t *testing.T) {
	s, a, _, _ := approvalFixture(t, map[string]any{"policy": "always_ask"})
	ctx := context.Background()
	legacy := `{"privateSetting":false,"cloud":{"approvals":{"policy":"ask","alwaysDeny":["shell_exec"],"aiGate":{"provider":"jev","jevApiKey":"generated-migration-test-sentinel","jevBaseUrl":"https://example.test","jevModel":"old","confidenceThreshold":0.91}}}}`
	if err := s.store.deps.Gorm.Table("agents").Where("id=?", a.ID).Update("config_json", legacy).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.store.protectStoredAgentApprovals(ctx); err != nil {
		t.Fatal(err)
	}
	first, err := s.store.GetAgent(ctx, "tenant", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(first.Config), "generated-migration-test-sentinel") || strings.Contains(string(first.Config), "jevApiKey") {
		t.Fatal("legacy credential remains plaintext")
	}
	cfg := configMap(first.Config)
	gate := approvalGate(cfg, false)
	if cfg["privateSetting"] != false || gate["jevMigrationEnc"] == nil || gate["jevMigrationPending"] != true || gate["confidenceThreshold"] != .91 {
		t.Fatalf("lost private settings: %s", publicAgentConfig(first.Config))
	}
	if err := s.store.protectStoredAgentApprovals(ctx); err != nil {
		t.Fatal(err)
	}
	second, err := s.store.GetAgent(ctx, "tenant", a.ID)
	if err != nil || string(first.Config) != string(second.Config) {
		t.Fatalf("protection was not idempotent: %v", err)
	}
	public, err := json.Marshal(second)
	if err != nil || strings.Contains(string(public), "jevMigrationEnc") || strings.Contains(string(public), "generated-migration-test-sentinel") {
		t.Fatal("public Agent exposes migration secret")
	}
	var count int64
	if err := s.store.deps.Gorm.Table("model_upstreams").Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("private credential promoted tenant-wide: count=%d err=%v", count, err)
	}
	if _, err := s.store.UpdateAgent(ctx, "tenant", a.ID, map[string]any{"config": map[string]any{"cloud": map[string]any{"model": "new", "approvals": map[string]any{"policy": "allow_all", "aiGate": map[string]any{"jevMigrationEnc": "client-injected"}}}}}); err != nil {
		t.Fatal(err)
	}
	last, err := s.store.GetAgent(ctx, "tenant", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if approvalGate(configMap(last.Config), false)["jevMigrationEnc"] != gate["jevMigrationEnc"] {
		t.Fatal("whole-config save lost or replaced protected migration")
	}
}
