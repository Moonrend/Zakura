// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"testing"
)

func TestSpaceConfigMutationRetriesOnLatestSection(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", Config: raw(map[string]any{"providers": map[string]any{"mcp": map[string]any{"mode": "all"}}})})
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	config, err := store.mutateSpaceConfig(context.Background(), "tenant", space.ID, func(config map[string]any) error {
		calls++
		if calls == 1 {
			_, err := store.mutateSpaceConfig(context.Background(), "tenant", space.ID, func(newer map[string]any) error {
				mergeConfigPatch(newer, map[string]any{"acp": map[string]any{"agents": map[string]any{"custom": map[string]any{"enabled": true}}}, "providers": map[string]any{"mcp": map[string]any{"exposeWorkspaceFs": false}}})
				return nil
			})
			if err != nil {
				return err
			}
		}
		mergeConfigPatch(config, map[string]any{"providers": map[string]any{"mcp": map[string]any{"mode": "selected"}}})
		return nil
	})
	if err != nil || calls != 2 {
		t.Fatalf("mutation calls=%d err=%v", calls, err)
	}
	mcp := gwMap(gwMap(config["providers"])["mcp"])
	if mcp["mode"] != "selected" || mcp["exposeWorkspaceFs"] != false || config["acp"] == nil {
		t.Fatalf("concurrent fields lost: %#v", config)
	}
	fresh, _ := store.GetSpace(context.Background(), "tenant", space.ID)
	var persisted map[string]any
	_ = json.Unmarshal(fresh.Config, &persisted)
	if gwMap(gwMap(persisted["providers"])["mcp"])["exposeWorkspaceFs"] != false {
		t.Fatalf("persisted stale section: %s", fresh.Config)
	}
}

func TestSpaceConfigMergeNullResetsOnlyTargetField(t *testing.T) {
	config := map[string]any{"web": map[string]any{"engine": "one", "enabled": true}, "acp": map[string]any{"enabled": true}}
	mergeConfigPatch(config, map[string]any{"web": map[string]any{"engine": nil}})
	if _, ok := gwMap(config["web"])["engine"]; ok || gwMap(config["web"])["enabled"] != true || config["acp"] == nil {
		t.Fatalf("incorrect reset: %#v", config)
	}
}

func TestAgentCannotMoveSpacesThroughOrdinaryUpdate(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S"})
	other, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "Other"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if _, err := store.UpdateAgent(context.Background(), "tenant", agent.ID, map[string]any{"spaceId": other.ID, "name": "changed"}); err != ErrConflict {
		t.Fatalf("move accepted: %v", err)
	}
	fresh, _ := store.GetAgent(context.Background(), "tenant", agent.ID)
	if fresh.SpaceID != space.ID || fresh.Name != "A" {
		t.Fatalf("partial update on rejected move: %#v", fresh)
	}
	if _, err := store.UpdateAgent(context.Background(), "tenant", agent.ID, map[string]any{"spaceId": space.ID, "name": "renamed"}); err != nil {
		t.Fatalf("idempotent space ignored incorrectly: %v", err)
	}
}
