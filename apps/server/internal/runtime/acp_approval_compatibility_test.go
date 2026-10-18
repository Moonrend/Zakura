// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestACPVerifiedApprovalCompatibility(t *testing.T) {
	for _, policy := range []string{"always_ask", "ai", "allow_all"} {
		t.Run(policy, func(t *testing.T) {
			fake := &fakeACPAdapter{onRPC: func(_ string, rpc map[string]any, send func(any)) bool {
				if rpc["method"] == "session/prompt" {
					send(map[string]any{"jsonrpc": "2.0", "id": rpc["id"], "result": map[string]any{"stopReason": "end_turn"}})
					return true
				}
				return false
			}}
			manager, a, session := acpAuthHarness(t, fake)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			rt, err := manager.ensure(ctx, "tenant", a.ID, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			_, err = manager.h.store.updateAgentConfig(ctx, "tenant", a.ID, nil, func(cfg map[string]any) error {
				cfg["cloud"] = map[string]any{"approvals": map[string]any{"policy": policy}}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			rt.profileID, rt.adapterImage = "claude-code", "ghcr.io/moonrend/acp-registry/claude-acp:0.75.1"
			guarded := policy != "allow_all"
			for _, patch := range []map[string]any{{"modeId": "acceptEdits"}, {"modeId": "auto"}, {"modeId": "bypassPermissions"}, {"configId": "mode", "value": "dontAsk"}} {
				if err := rt.patch(ctx, patch); (err != nil) != guarded {
					t.Fatalf("patch=%v err=%v guarded=%v", patch, err, guarded)
				}
			}
			if guarded && (fake.has("session/set_mode") || fake.has("session/set_config_option")) {
				t.Fatal("automatic permissions reached the adapter")
			}
			// A loaded session may already have automatic permissions persisted.
			rt.mu.Lock()
			rt.state["modes"] = map[string]any{"currentId": "bypassPermissions"}
			rt.mu.Unlock()
			run, err := manager.h.store.StartRun(ctx, "tenant", a.ID, session.ID, "test", nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			err = rt.prompt(ctx, run.ID, "do not send when incompatible")
			if guarded {
				if err == nil || !strings.Contains(err.Error(), claudeACPApprovalBoundary) || fake.has("session/prompt") || !fake.has("session/set_mode") {
					t.Fatalf("incompatible adapter prompt=%v", err)
				}
				if mode := rt.snapshot()["modes"].(map[string]any)["currentId"]; mode != "default" {
					t.Fatalf("persisted automatic mode not disabled: %v", mode)
				}
			} else if err != nil || !fake.has("session/prompt") {
				t.Fatalf("explicit allow_all prompt=%v", err)
			}
			// Do not manufacture the same guarantee or refusal for an unaudited
			// implementation, a different version, or a custom command.
			for _, image := range []string{"", "custom/adapter:0.75.1", "ghcr.io/moonrend/acp-registry/claude-acp:other"} {
				rt.adapterImage = image
				if err := rt.checkApprovalCompatibility(ctx); err != nil {
					t.Fatalf("unaudited adapter was broadly blocked: %s %v", image, err)
				}
			}
		})
	}
}
