// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"testing"
)

func TestACPConfigMutationPreservesConcurrentInstallAndProfile(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S"})
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	calls := 0
	next, err := h.mutateSpaceACP(context.Background(), "tenant", space.ID, nil, func(previous map[string]any) (map[string]any, error) {
		calls++
		if calls == 1 {
			if err := h.saveACPInstall(context.Background(), "tenant", space.ID, "codex", map[string]any{"state": "pulling"}); err != nil {
				return nil, err
			}
			if _, err := h.mutateSpaceACP(context.Background(), "tenant", space.ID, nil, func(current map[string]any) (map[string]any, error) {
				parsed := parseACPConfig(current)
				parsed.Agents["sibling"] = parseACPSetup("sibling", map[string]any{"enabled": true, "command": "sibling-acp"}, true)
				return acpConfigJSON(parsed, current), nil
			}); err != nil {
				return nil, err
			}
		}
		parsed := parseACPConfig(previous)
		parsed.Agents["custom"] = parseACPSetup("custom", map[string]any{"enabled": true, "command": "custom-acp"}, true)
		return acpConfigJSON(parsed, previous), nil
	})
	if err != nil || calls != 2 {
		t.Fatalf("mutation calls=%d err=%v", calls, err)
	}
	profiles := parseACPConfig(next).Agents
	if profiles["custom"].Command != "custom-acp" || profiles["sibling"].Command != "sibling-acp" || gwMap(gwMap(next["installs"])["codex"])["state"] != "pulling" {
		t.Fatalf("concurrent ACP fields lost: %#v", next)
	}
}
