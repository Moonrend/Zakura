// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestToolApprovalJevExecutionPaths(t *testing.T) {
	for _, method := range []string{"standard", "session/request_permission", "fs/read_text_file", "fs/write_text_file", "terminal/create"} {
		for _, scenario := range []string{"allow", "deny", "escalate-allow", "low-confidence-deny", "malformed-allow", "cancel", "policy-changed", "target-changed", "human-policy-changed"} {
			t.Run(method+"/"+scenario, func(t *testing.T) {
				answer := strings.Replace(validJevAnswer, `"confidence":0.61`, `"confidence":0.95`, 1)
				switch scenario {
				case "deny", "escalate-allow":
					answer = strings.Replace(answer, `"choice":"allow"`, `"choice":"deny"`, 1)
				case "low-confidence-deny", "human-policy-changed":
					answer = validJevAnswer
				case "malformed-allow":
					answer = `{"answers":{"approval":{"choice":"allow"}}}`
				}
				store, gateway, _, route, requests := jevFixture(t, answer)
				ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
				defer cancel()
				node := "node"
				space, err := store.CreateSpace(ctx, "tenant", Space{Name: "Jev execution", RuntimeNodeID: &node, WorkspaceKind: "host"})
				if err != nil {
					t.Fatal(err)
				}
				a, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID, Config: rawJSON(map[string]any{"cloud": map[string]any{"approvals": map[string]any{"policy": "ai", "aiGate": map[string]any{"provider": "jev", "scope": "all", "routeId": route.ID, "escalateOnDeny": scenario == "escalate-allow"}}}})})
				if err != nil {
					t.Fatal(err)
				}
				session, err := store.CreateSession(ctx, "tenant", "", a.ID, Session{})
				if err != nil {
					t.Fatal(err)
				}
				run, err := store.StartRun(ctx, "tenant", a.ID, session.ID, "test", nil, nil)
				if err != nil {
					t.Fatal(err)
				}

				// Hold the real fixture response before the gate receives its verdict.
				evaluated, release := make(chan struct{}), make(chan struct{})
				var releaseOnce sync.Once
				releaseEvaluation := func() { releaseOnce.Do(func() { close(release) }) }
				defer releaseEvaluation()
				base := gateway.client.Transport
				if base == nil {
					base = http.DefaultTransport
				}
				gateway.client = &http.Client{Transport: approvalRoundTripper(func(req *http.Request) (*http.Response, error) {
					response, err := base.RoundTrip(req)
					if err != nil {
						return nil, err
					}
					close(evaluated)
					select {
					case <-release:
						return response, nil
					case <-req.Context().Done():
						_ = response.Body.Close()
						return nil, req.Context().Err()
					}
				})}

				var effects, hooks atomic.Int32
				replies := make(chan map[string]any, 2)
				s := NewService(store)
				stop := cancel
				done := make(chan error, 1)
				if method == "standard" {
					s.gateway = gateway
					s.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
						effects.Add(1)
						return json.RawMessage(`{}`), nil
					}
					project := &agentProjectContext{hooks: []projectHookPackage{{Name: "fixture", Events: map[string][]projectHookGroup{"PreToolUse": {{Actions: []projectHookAction{{Type: "command", Command: "fixture"}}}}}}}, exec: func(context.Context, projectHookPackage, projectHookAction, projectHookInput) (string, error) {
						hooks.Add(1)
						return "", nil
					}}
					ctx = context.WithValue(ctx, agentProjectContextKey{}, project)
					go func() {
						messages := []chatMessage{}
						done <- s.runRoundTools(ctx, TurnRequest{Tenant: "tenant", Agent: a.ID, Session: session.ID}, session, run.ID, []modelToolCall{{ID: "call", Name: "fs_read", Arguments: `{"path":"/workspace/file"}`}}, agentCatalog{}, true, 8000, &messages)
					}()
				} else {
					h := builtinToolHarness(t, store.deps, "rnr_jev_execution", func(rpc string, params map[string]any) (any, error) {
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
							encoded, _ := params["base64"].(string)
							raw, err := base64.StdEncoding.DecodeString(encoded)
							if err != nil {
								return nil, err
							}
							var reply map[string]any
							if err := json.Unmarshal(raw, &reply); err != nil {
								return nil, err
							}
							replies <- reply
							return map[string]any{}, nil
						default:
							return nil, fmt.Errorf("unexpected effect %s", rpc)
						}
					})
					s = h.service
					s.gateway = gateway
					runner, err := h.hub.get(node)
					if err != nil {
						t.Fatal(err)
					}
					rt := &acpLiveRuntime{manager: &acpRuntimeManager{h: h}, tenantID: "tenant", agentID: a.ID, sid: session.ID, spaceID: space.ID, acpSessionID: "protocol-session", runner: runner, currentRunID: run.ID, workingDir: "/workspace", processID: "adapter", writeMethod: "host.pty.write", done: make(chan struct{}), terminals: map[string]*acpTerminal{}, inbound: map[string]acpInbound{}}
					var stopOnce sync.Once
					stop = func() { stopOnce.Do(func() { close(rt.done) }) }
					defer stop()
					params := map[string]any{"sessionId": "protocol-session", "path": "/workspace/file", "content": "pending write", "command": "printf", "args": []any{"hello"}, "toolCall": map[string]any{"toolCallId": "call", "kind": "read", "title": "Read file"}, "options": []any{map[string]any{"optionId": "permanent", "kind": "allow_always"}, map[string]any{"optionId": "once", "kind": "allow_once"}, map[string]any{"optionId": "no", "kind": "reject_once"}}}
					go func() {
						rt.handleCallback(method, json.RawMessage(`101`), params)
						done <- nil
					}()
				}

				select {
				case <-evaluated:
				case <-ctx.Done():
					t.Fatal("evaluation did not start")
				}
				if effects.Load() != 0 || hooks.Load() != 0 {
					t.Fatal("effect occurred before AI verdict")
				}
				switch scenario {
				case "cancel":
					stop()
				case "policy-changed":
					_, err = store.updateAgentConfig(ctx, "tenant", a.ID, nil, func(cfg map[string]any) error {
						cfg["cloud"].(map[string]any)["approvals"].(map[string]any)["policy"] = "always_ask"
						return nil
					})
				case "target-changed":
					err = store.deps.Gorm.Table("spaces").Where("id=?", space.ID).Update("runtime_node_id", "replacement").Error
				}
				if err != nil {
					t.Fatal(err)
				}
				releaseEvaluation()
				human := scenario == "escalate-allow" || scenario == "low-confidence-deny" || scenario == "malformed-allow" || scenario == "human-policy-changed"
				if human {
					id := waitApproval(t, store, session.ID)
					if hooks.Load() != 0 || effects.Load() != 0 {
						t.Fatal("effect occurred before human decision")
					}
					select {
					case reply := <-replies:
						t.Fatalf("ACP responded before human decision: %#v", reply)
					default:
					}
					if scenario == "human-policy-changed" {
						_, err = store.updateAgentConfig(ctx, "tenant", a.ID, nil, func(cfg map[string]any) error {
							cfg["cloud"].(map[string]any)["approvals"].(map[string]any)["policy"] = "always_ask"
							return nil
						})
						if err != nil {
							t.Fatal(err)
						}
					}
					decision := "approved"
					if scenario == "low-confidence-deny" {
						decision = "denied"
					}
					if err := store.settleApproval(ctx, "tenant", a.ID, session.ID, id, decision, "user", false); err != nil {
						t.Fatal(err)
					}
				}
				select {
				case err := <-done:
					if err != nil && scenario != "cancel" {
						t.Fatal(err)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("execution path did not finish")
				}
				allowed := scenario == "allow" || scenario == "escalate-allow" || scenario == "malformed-allow"
				if method != "standard" && scenario != "cancel" {
					select {
					case reply := <-replies:
						if method == "session/request_permission" {
							result, _ := reply["result"].(map[string]any)
							outcome, _ := result["outcome"].(map[string]any)
							want := "no"
							if allowed {
								want = "once"
							}
							if reply["error"] != nil || outcome["outcome"] != "selected" || outcome["optionId"] != want {
								t.Fatalf("single-use outcome=%#v want=%s", reply, want)
							}
						} else if (reply["error"] == nil) != allowed {
							t.Fatalf("callback reply=%#v allowed=%v", reply, allowed)
						}
					case <-time.After(time.Second):
						t.Fatal("missing ACP response")
					}
				}
				wantEffects, wantHooks := int32(0), int32(0)
				if allowed && method != "session/request_permission" {
					wantEffects = 1
					if method == "standard" {
						wantHooks = 1
					}
				}
				if effects.Load() != wantEffects || hooks.Load() != wantHooks {
					t.Fatalf("effects/hooks=%d/%d want=%d/%d", effects.Load(), hooks.Load(), wantEffects, wantHooks)
				}
				if requests.Load() != 1 {
					t.Fatalf("evaluation requests=%d", requests.Load())
				}
				var audits []approvalRecord
				if err := store.deps.Gorm.Table("agent_tool_approvals").Where("session_id=?", session.ID).Find(&audits).Error; err != nil {
					t.Fatal(err)
				}
				wantAudits := 1
				if scenario == "cancel" || scenario == "policy-changed" || scenario == "target-changed" {
					wantAudits = 0
				}
				if len(audits) != wantAudits {
					t.Fatalf("audits=%+v want=%d", audits, wantAudits)
				}
				for _, audit := range audits {
					source, protocol := "standard", ""
					if method == "session/request_permission" {
						source, protocol = "acp", "101"
					} else if method != "standard" {
						source, protocol = "acp_callback", "101"
					}
					if audit.Status == "pending" || audit.Source != source || audit.ProtocolRequestID != protocol {
						t.Fatalf("unsettled or misbound audit=%+v", audit)
					}
				}
			})
		}
	}
}
