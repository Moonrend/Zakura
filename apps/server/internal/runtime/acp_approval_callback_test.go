// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func TestACPApprovalRevokesOriginalActorOutsideSessionCreator(t *testing.T) {
	for _, revoke := range []string{"membership", "api-key"} {
		t.Run(revoke, func(t *testing.T) {
			manager, agent, session := acpAuthHarness(t, &fakeACPAdapter{})
			h := manager.h
			actor := acpMCPUser(t, h)
			now := runtimeTimeString(h.store.now())
			if err := h.deps.Gorm.Table("users").Create(map[string]any{"id": "session-creator", "email": "creator@example.test", "password_hash": "unused", "status": "active", "created_at": now, "updated_at": now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := h.deps.Gorm.Table("cloud_agent_sessions").Where("id=?", session.ID).Update("created_by_user_id", "session-creator").Error; err != nil {
				t.Fatal(err)
			}
			if revoke == "api-key" {
				actor = httpx.Principal{TenantID: "tenant", APIKey: true, APIKeyID: "key-tenant"}
			}
			rt, err := manager.ensure(httpx.WithPrincipal(context.Background(), actor), "tenant", agent.ID, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			approvalCtx, err := rt.approvalContext(ctx)
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			var effects atomic.Int64
			go func() {
				err := h.service.approveTool(approvalCtx, "tenant", agent.ID, session.ID, "", "call", "fs/read_text_file", json.RawMessage(`{}`), "always_ask", "acp_callback", "17")
				if err == nil {
					effects.Add(1)
				}
				done <- err
			}()
			id := waitApproval(t, h.store, session.ID)
			if revoke == "membership" {
				if err = h.deps.Gorm.Table("tenant_memberships").Where("tenant_id=? AND user_id=?", "tenant", actor.UserID).Update("status", "suspended").Error; err != nil {
					t.Fatal(err)
				}
				if err = h.afterMemberRemoved(ctx, "tenant", actor.UserID); err != nil {
					t.Fatal(err)
				}
			} else if err = h.deps.Gorm.Table("api_keys").Where("id=?", actor.APIKeyID).Update("revoked_at", now).Error; err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err == nil || effects.Load() != 0 {
					t.Fatalf("revoked original actor passed approval: %v effects=%d", err, effects.Load())
				}
			case <-ctx.Done():
				t.Fatal("approval borrowed session creator after original actor revocation")
			}
			row, err := h.store.getApproval(context.Background(), "tenant", agent.ID, session.ID, id)
			if err != nil || row.Status != "cancelled" {
				t.Fatalf("approval=%+v err=%v", row, err)
			}
			if err := h.store.settleApproval(context.Background(), "tenant", agent.ID, session.ID, id, "approved", "user", false); err == nil {
				t.Fatal("late allow accepted after actor revocation")
			}
		})
	}
}

func TestACPPermissionNeverSubstitutesPermanentOptions(t *testing.T) {
	for _, scenario := range []string{"no-single-allow", "no-single-deny", "single-allow"} {
		t.Run(scenario, func(t *testing.T) {
			replies := make(chan map[string]any, 1)
			fake := &fakeACPAdapter{onRPC: func(_ string, rpc map[string]any, _ func(any)) bool {
				if rpc["method"] == nil {
					replies <- rpc
					return true
				}
				return false
			}}
			manager, agent, session := acpAuthHarness(t, fake)
			policy := "allow_all"
			if scenario == "no-single-deny" {
				policy = "ai"
			}
			if _, err := manager.h.store.updateAgentConfig(context.Background(), "tenant", agent.ID, nil, func(cfg map[string]any) error {
				cfg["cloud"] = map[string]any{"approvals": map[string]any{"policy": policy, "alwaysDeny": []string{"denied"}}}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			rt, err := manager.ensure(context.Background(), "tenant", agent.ID, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			options := []any{map[string]any{"optionId": "permanent-yes", "kind": "allow_always"}, map[string]any{"optionId": "permanent-no", "kind": "reject_always"}}
			if scenario != "no-single-allow" {
				options = append(options, map[string]any{"optionId": "once", "kind": "allow_once"})
			}
			tool := "denied"
			if scenario == "single-allow" {
				tool = "read"
			}
			rt.queueDecision(context.Background(), "session/request_permission", json.RawMessage(`73`), map[string]any{"sessionId": "acp-session-1", "options": options, "toolCall": map[string]any{"kind": tool}})
			select {
			case reply := <-replies:
				if scenario == "no-single-allow" {
					if reply["error"] == nil {
						t.Fatal("permanent authorization substituted for absent single-use option")
					}
					return
				}
				result, _ := reply["result"].(map[string]any)
				outcome, _ := result["outcome"].(map[string]any)
				if scenario == "single-allow" {
					if reply["error"] != nil || outcome["outcome"] != "selected" || outcome["optionId"] != "once" {
						t.Fatalf("single-use allow not selected: %#v", reply)
					}
				} else if reply["error"] != nil || outcome["outcome"] != "cancelled" || outcome["optionId"] != nil {
					t.Fatalf("permanent rejection substituted for absent single-use option: %#v", reply)
				}
			case <-time.After(time.Second):
				t.Fatal("missing permission response")
			}
		})
	}
}

func TestACPPlatformCallbacksRequireSharedApproval(t *testing.T) {
	for _, method := range []string{"fs/read_text_file", "fs/write_text_file", "terminal/create"} {
		for _, decision := range []string{"approved", "denied"} {
			t.Run(method+"/"+decision, func(t *testing.T) {
				d := testDeps(t)
				seedTenant(t, d, "tenant")
				store := NewStore(d)
				node := "node"
				space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Callbacks", RuntimeNodeID: &node, WorkspaceKind: "host"})
				if err != nil {
					t.Fatal(err)
				}
				a, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, Config: json.RawMessage(`{"cloud":{"approvals":{"policy":"always_ask","alwaysAllow":["*"]}}}`)})
				if err != nil {
					t.Fatal(err)
				}
				session, err := store.CreateSession(context.Background(), "tenant", "", a.ID, Session{Kind: "acp"})
				if err != nil {
					t.Fatal(err)
				}
				var effects atomic.Int64
				replies := make(chan map[string]any, 2)
				h := builtinToolHarness(t, d, "rnr_callback_approval", func(rpc string, p map[string]any) (any, error) {
					switch rpc {
					case "sys.info":
						return codemodeInfo(), nil
					case "host.fs.read":
						effects.Add(1)
						return map[string]any{"content": "approved data"}, nil
					case "host.fs.write":
						effects.Add(1)
						return map[string]any{}, nil
					case "host.exec.start":
						effects.Add(1)
						return map[string]any{"id": "owned-job"}, nil
					case "host.pty.write":
						encoded, _ := p["base64"].(string)
						raw, err := base64.StdEncoding.DecodeString(encoded)
						if err != nil {
							return nil, err
						}
						var payload map[string]any
						if err = json.Unmarshal(raw, &payload); err != nil {
							return nil, err
						}
						replies <- payload
						return map[string]any{}, nil
					default:
						return nil, fmt.Errorf("unexpected effect %s", rpc)
					}
				})
				runner, err := h.hub.get(node)
				if err != nil {
					t.Fatal(err)
				}
				rt := &acpLiveRuntime{manager: &acpRuntimeManager{h: h}, tenantID: "tenant", agentID: a.ID, sid: session.ID, spaceID: space.ID, acpSessionID: "protocol-session", runner: runner, workingDir: "/workspace", processID: "adapter", writeMethod: "host.pty.write", done: make(chan struct{}), terminals: map[string]*acpTerminal{}, inbound: map[string]acpInbound{}}
				defer close(rt.done)
				params := map[string]any{"sessionId": "protocol-session", "path": "/workspace/file", "content": "pending write", "command": "printf", "args": []any{"hello"}}
				done := make(chan struct{})
				go func() { defer close(done); rt.handleCallback(method, json.RawMessage(`101`), params) }()
				id := waitApproval(t, store, session.ID)
				if effects.Load() != 0 {
					t.Fatal("ACP callback effect occurred before approval")
				}
				if err = store.settleApproval(context.Background(), "tenant", a.ID, session.ID, id, decision, "user", false); err != nil {
					t.Fatal(err)
				}
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Fatal("callback approval blocked")
				}
				select {
				case reply := <-replies:
					if (reply["error"] != nil) != (decision == "denied") {
						t.Fatalf("reply=%#v", reply)
					}
				case <-time.After(time.Second):
					t.Fatal("missing protocol response")
				}
				want := int64(0)
				if decision == "approved" {
					want = 1
				}
				if effects.Load() != want {
					t.Fatalf("effects=%d want=%d", effects.Load(), want)
				}
			})
		}
	}
}
