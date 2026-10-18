// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestToolApprovalGuardsPreToolHooks(t *testing.T) {
	for _, scenario := range []string{"approve", "deny", "cancel", "resource-denied", "resource-revoked", "hook-revoked", "hook-cancelled", "hook-policy", "hook-target"} {
		t.Run(scenario, func(t *testing.T) {
			s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
			var hooks, effects atomic.Int32
			var denied atomic.Bool
			denied.Store(scenario == "resource-denied")
			s.toolAuthorizer = func(context.Context, string, string, string, string, json.RawMessage) error {
				if denied.Load() {
					return errors.New("resource access denied")
				}
				return nil
			}
			s.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
				effects.Add(1)
				return json.RawMessage(`{}`), nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			project := &agentProjectContext{hooks: []projectHookPackage{{Name: "fixture", Events: map[string][]projectHookGroup{"PreToolUse": {{Actions: []projectHookAction{{Type: "command", Command: "fixture"}}}}}}}, exec: func(context.Context, projectHookPackage, projectHookAction, projectHookInput) (string, error) {
				hooks.Add(1)
				switch scenario {
				case "hook-revoked":
					denied.Store(true)
				case "hook-cancelled":
					cancel()
				case "hook-policy":
					return "", s.store.deps.Gorm.Table("agents").Where("id=?", a.ID).Update("config_json", `{"cloud":{"approvals":{"policy":"always_ask","alwaysDeny":["fs_read"]}}}`).Error
				case "hook-target":
					return "", s.store.deps.Gorm.Table("spaces").Where("id=?", a.SpaceID).Update("runtime_node_id", "replacement").Error
				}
				return "", nil
			}}
			ctx = context.WithValue(ctx, agentProjectContextKey{}, project)
			done := make(chan error, 1)
			go func() {
				messages := []chatMessage{}
				done <- s.runRoundTools(ctx, TurnRequest{Tenant: "tenant", Agent: a.ID, Session: session.ID}, session, run.ID, []modelToolCall{{ID: "call", Name: "fs_read", Arguments: `{}`}}, agentCatalog{}, true, 8000, &messages)
			}()
			if scenario != "resource-denied" {
				id := waitApproval(t, s.store, session.ID)
				if hooks.Load() != 0 || effects.Load() != 0 {
					t.Fatal("effectful hook or tool ran before approval")
				}
				if scenario == "cancel" {
					cancel()
				} else {
					if scenario == "resource-revoked" {
						denied.Store(true)
					}
					status := "approved"
					if scenario == "deny" {
						status = "denied"
					}
					if err := s.store.settleApproval(ctx, "tenant", a.ID, session.ID, id, status, "user", false); err != nil {
						t.Fatal(err)
					}
				}
			}
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("tool approval did not finish")
			}
			want := int32(0)
			if scenario == "approve" {
				want = 1
			}
			wantHooks := want
			if strings.HasPrefix(scenario, "hook-") {
				wantHooks = 1
			}
			if hooks.Load() != wantHooks || effects.Load() != want {
				t.Fatalf("hooks/effects=%d/%d want=%d/%d", hooks.Load(), effects.Load(), wantHooks, want)
			}
			if scenario == "resource-denied" {
				var approvals int64
				if err := s.store.deps.Gorm.Table("agent_tool_approvals").Where("session_id=?", session.ID).Count(&approvals).Error; err != nil || approvals != 0 {
					t.Fatal("unauthorized resource reached approval")
				}
			}
		})
	}
}

func TestCodemodeToolCallsShareApprovalAndCancellation(t *testing.T) {
	for _, scenario := range []string{"approve", "deny", "cancel", "memory-disabled", "tool-failure"} {
		t.Run(scenario, func(t *testing.T) {
			s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
			h := &handler{deps: s.store.deps, store: s.store, service: s}
			s.toolAuthorizer = h.authorizeAgentTool
			if err := h.deps.Gorm.Table("agents").Where("id=?", a.ID).Update("enable_memory", true).Error; err != nil {
				t.Fatal(err)
			}
			if scenario == "memory-disabled" {
				if err := h.deps.Gorm.Table("agents").Where("id=?", a.ID).Update("enable_memory", false).Error; err != nil {
					t.Fatal(err)
				}
			}
			var preHooks, postHooks, failureHooks atomic.Int32
			project := &agentProjectContext{hooks: []projectHookPackage{{Name: "nested", Events: map[string][]projectHookGroup{
				"PreToolUse":         {{Actions: []projectHookAction{{Type: "command", Command: "fixture"}}}},
				"PostToolUse":        {{Actions: []projectHookAction{{Type: "command", Command: "fixture"}}}},
				"PostToolUseFailure": {{Actions: []projectHookAction{{Type: "command", Command: "fixture"}}}},
			}}}, exec: func(_ context.Context, _ projectHookPackage, _ projectHookAction, input projectHookInput) (string, error) {
				switch input.Event {
				case "PreToolUse":
					preHooks.Add(1)
				case "PostToolUse":
					postHooks.Add(1)
				case "PostToolUseFailure":
					failureHooks.Add(1)
				}
				return "", nil
			}}
			ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), computerRunKey{}, run.ID), 4*time.Second)
			defer cancel()
			ctx = context.WithValue(ctx, agentProjectContextKey{}, project)
			done := make(chan error, 1)
			go func() {
				args := json.RawMessage(`{"content":"fixture note"}`)
				if scenario == "tool-failure" {
					args = json.RawMessage(`{}`)
				}
				_, err := h.runCodemodeCall(ctx, "tenant", a.ID, session.ID, "outer/codemode-1", "memory_remember", args)
				done <- err
			}()
			if scenario != "memory-disabled" {
				id := waitApproval(t, h.store, session.ID)
				if preHooks.Load() != 0 || postHooks.Load() != 0 || failureHooks.Load() != 0 {
					t.Fatal("nested effectful hooks ran before approval")
				}
				var count int64
				if err := h.deps.Gorm.Table("memories").Count(&count).Error; err != nil || count != 0 {
					t.Fatal("nested call wrote memory before approval")
				}
				if scenario == "cancel" {
					cancel()
				} else {
					decision := "approved"
					if scenario == "deny" {
						decision = "denied"
					}
					if err := h.store.settleApproval(ctx, "tenant", a.ID, session.ID, id, decision, "user", false); err != nil {
						t.Fatal(err)
					}
				}
			}
			select {
			case err := <-done:
				if (err == nil) != (scenario == "approve") {
					t.Fatalf("nested call: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("nested call did not stop")
			}
			var count int64
			want := int64(0)
			if scenario == "approve" {
				want = 1
			}
			if err := h.deps.Gorm.Table("memories").Count(&count).Error; err != nil || count != want {
				t.Fatalf("nested effects=%d want=%d err=%v", count, want, err)
			}
			wantPre, wantPost, wantFailure := int32(0), int32(0), int32(0)
			if scenario == "approve" {
				wantPre, wantPost = 1, 1
			}
			if scenario == "tool-failure" {
				wantPre, wantFailure = 1, 1
			}
			if preHooks.Load() != wantPre || postHooks.Load() != wantPost || failureHooks.Load() != wantFailure {
				t.Fatalf("nested pre/post/failure=%d/%d/%d", preHooks.Load(), postHooks.Load(), failureHooks.Load())
			}
			var results int64
			if err := h.deps.Gorm.Table("cloud_agent_events").Where("session_id=? AND run_id=? AND type='tool_call_result'", session.ID, run.ID).Count(&results).Error; err != nil || results != 1 {
				t.Fatalf("nested durable results=%d err=%v", results, err)
			}
		})
	}
}

func TestToolAuthorizationRechecksCurrentMCPPolicyWithoutRPC(t *testing.T) {
	s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
	h := &handler{deps: s.store.deps, store: s.store}
	insertAgentMCPInstance(t, h.deps, "mcp-fixture", "fixture", "Fixture", "http://unreachable.invalid", a.ID, nil)
	name := mcpToolModelName("fixture", "Fixture", "write")
	h.storeCatalogCache("tenant/"+a.ID, agentCatalog{Tools: []agentTool{{Name: name, Kind: "mcp", InstanceID: "mcp-fixture", LocalName: "write"}}})
	node := "fixture-node"
	if _, err := h.deps.DB.Exec(`UPDATE spaces SET runtime_node_id=?,enable_computer=TRUE WHERE id=?`, node, a.SpaceID); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), computerRunKey{}, run.ID)
	if err := h.authorizeAgentTool(ctx, "tenant", a.ID, session.ID, name, json.RawMessage(`{}`)); err != nil {
		t.Fatalf("allowed tool: %v", err)
	}
	if err := h.deps.Gorm.Table("mcp_policies").Create(map[string]any{"id": "deny-now", "name": "Deny writes", "tenant_id": "tenant", "space_id": a.SpaceID, "policy_json": `{"toolDenylist":["write"]}`, "created_at": runtimeTimeString(h.store.now()), "updated_at": runtimeTimeString(h.store.now())}).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.authorizeAgentTool(ctx, "tenant", a.ID, session.ID, name, json.RawMessage(`{}`)); err == nil {
		t.Fatal("cached catalog bypassed current MCP deny")
	}
}
