// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestApprovalScopeDecisions(t *testing.T) {
	off := false
	for _, tc := range []struct {
		name, tool, args, want string
		cfg                    toolApprovalConfig
	}{
		{"read", "fs_read", `{}`, "allow", toolApprovalConfig{Policy: "ai"}},
		{"search", "re_web_search", `{}`, "allow", toolApprovalConfig{Policy: "ai"}},
		{"acp-read", "fs/read_text_file", `{}`, "allow", toolApprovalConfig{Policy: "ai"}},
		{"write", "fs_write", `{}`, "ai", toolApprovalConfig{Policy: "ai"}},
		{"shell", "shell_exec", `{"command":"git status"}`, "ai", toolApprovalConfig{Policy: "ai"}},
		{"unknown-mcp", "mcp__unknown__read", `{}`, "ai", toolApprovalConfig{Policy: "ai"}},
		{"space-all", "fs_read", `{}`, "ai", toolApprovalConfig{Policy: "ai", Scope: approvalScopeConfig{Scope: "all"}}},
		{"agent-all", "web_search", `{}`, "ai", toolApprovalConfig{Policy: "ai", AI: approvalAIConfig{Scope: "all"}}},
		{"agent-override", "fs_read", `{}`, "allow", toolApprovalConfig{Policy: "ai", AI: approvalAIConfig{Scope: "risky"}, Scope: approvalScopeConfig{Scope: "all"}}},
		{"read-opt-out", "fs_read", `{}`, "ai", toolApprovalConfig{Policy: "ai", Scope: approvalScopeConfig{AutoAllowReadOnly: &off}}},
		{"custom-safe", "mcp__docs__get", `{}`, "allow", toolApprovalConfig{Policy: "ai", Scope: approvalScopeConfig{SafeTools: []string{"mcp__docs__*"}}}},
		{"danger-over-safe", "fs_read", `{}`, "ai", toolApprovalConfig{Policy: "ai", Scope: approvalScopeConfig{SafeTools: []string{"*"}, DangerousTools: []string{"fs_read"}}}},
		{"danger-over-agent-allow", "fs_read", `{}`, "ai", toolApprovalConfig{Policy: "ai", AlwaysAllow: []string{"*"}, Scope: approvalScopeConfig{DangerousTools: []string{"fs_read"}}}},
		{"ask-over-remembered-allow", "fs_read", `{}`, "ask", toolApprovalConfig{Policy: "ai", AlwaysAllow: []string{"*"}, Rules: []approvalRule{{Matcher: "fs_read", Action: "ask"}}}},
		{"prefixed-command-rule", "re_shell_exec", `{"command":"git push origin main"}`, "ai", toolApprovalConfig{Policy: "ai", Scope: approvalScopeConfig{SafeTools: []string{"*"}, DangerousTools: []string{"Bash(git push*)"}}}},
		{"deny-read", "fs_read", `{}`, "deny", toolApprovalConfig{Policy: "ai", AlwaysDeny: []string{"fs_read"}}},
		{"ask-read", "fs_read", `{}`, "ask", toolApprovalConfig{Policy: "ai", Rules: []approvalRule{{Matcher: "fs_read", Action: "ask"}}}},
		{"strict", "web_search", `{}`, "ask", toolApprovalConfig{Policy: "always_ask"}},
		{"task-bypass", "shell_exec", `{}`, "allow", toolApprovalConfig{Policy: "always_ask", BypassAlwaysAsk: true}},
		{"task-deny", "shell_exec", `{}`, "deny", toolApprovalConfig{Policy: "always_ask", BypassAlwaysAsk: true, AlwaysDeny: []string{"shell_exec"}}},
		{"task-explicit-ask", "shell_exec", `{}`, "ask", toolApprovalConfig{Policy: "always_ask", BypassAlwaysAsk: true, Rules: []approvalRule{{Matcher: "shell_exec", Action: "ask"}}}},
		{"task-preserves-ai", "shell_exec", `{}`, "ai", toolApprovalConfig{Policy: "ai", BypassAlwaysAsk: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cfg.decision(tc.tool, json.RawMessage(tc.args)); got != tc.want {
				t.Fatalf("decision=%s want=%s", got, tc.want)
			}
		})
	}
}

func TestApprovalScopeReadOnlyWithoutEvaluation(t *testing.T) {
	s, a, session, run := approvalFixture(t, map[string]any{"policy": "ai"})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for _, name := range []string{"fs_read", "web_search"} {
		check, err := s.toolExecutionGuard(ctx, "tenant", a.ID, session.ID, run.ID, name, name, json.RawMessage(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		if err := check(); err != nil {
			t.Fatal(err)
		}
	}
	var approvals int64
	if err := s.store.deps.Gorm.Table("agent_tool_approvals").Count(&approvals).Error; err != nil || approvals != 0 {
		t.Fatalf("read-only requests produced approvals=%d err=%v", approvals, err)
	}
}

func TestApprovalScopeChangeInvalidatesApproval(t *testing.T) {
	s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- s.approveTool(ctx, "tenant", a.ID, session.ID, run.ID, "call", "fs_read", json.RawMessage(`{}`), "allow_all", "standard", "")
	}()
	id := waitApproval(t, s.store, session.ID)
	_, err := s.store.mutateSpaceConfig(ctx, "tenant", a.SpaceID, func(cfg map[string]any) error {
		cfg["approvals"] = map[string]any{"dangerousTools": []string{"fs_read"}}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.store.settleApproval(ctx, "tenant", a.ID, session.ID, id, "approved", "user", false); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err == nil || !strings.Contains(err.Error(), "policy changed") {
		t.Fatalf("obsolete scope authorized: %v", err)
	}
}

func TestAutomationApprovalBypassBoundToRun(t *testing.T) {
	s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
	ctx := context.WithValue(context.Background(), automationApprovalBypassKey{}, automationApprovalBypass{"tenant", a.ID, session.ID, run.ID})
	check, err := s.toolExecutionGuard(ctx, "tenant", a.ID, session.ID, run.ID, "call", "shell_exec", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if err = check(); err != nil {
		t.Fatal(err)
	}
	for _, other := range []struct{ session, run string }{{session.ID, "other"}, {"other", run.ID}, {session.ID, ""}} {
		cfg, err := s.effectiveApprovalConfig(ctx, a, other.session, other.run, "allow_all")
		if err != nil || cfg.decision("shell_exec", nil) != "ask" {
			t.Fatalf("bypass leaked: %+v %v", cfg, err)
		}
	}
	cfg, err := s.effectiveApprovalConfig(context.Background(), a, session.ID, run.ID, "allow_all")
	if err != nil || cfg.decision("shell_exec", nil) != "ask" {
		t.Fatalf("bypass persisted on Agent: %+v %v", cfg, err)
	}
}

func TestAutomationApprovalBypassPersistsOnSchedule(t *testing.T) {
	s, a, _, _ := approvalFixture(t, map[string]any{"policy": "always_ask"})
	h := &handler{store: s.store, deps: s.store.deps, service: s}
	ctx := context.Background()
	schedule, err := h.createScheduleInternal(ctx, "tenant", a.ID, Schedule{Name: "Task", Prompt: "Check", Pattern: "@hourly", Enabled: true, BypassToolApproval: true})
	if err != nil || !schedule.BypassToolApproval {
		t.Fatalf("created=%+v err=%v", schedule, err)
	}
	rows, err := h.listScheduleRows(ctx, "tenant", a.ID)
	if err != nil || len(rows) != 1 || !rows[0].BypassToolApproval {
		t.Fatalf("listed=%+v err=%v", rows, err)
	}
	schedule, err = h.patchScheduleInternal(ctx, "tenant", a.ID, schedule.ID, map[string]any{"bypassToolApproval": false})
	if err != nil || schedule.BypassToolApproval {
		t.Fatalf("updated=%+v err=%v", schedule, err)
	}
	if _, err = h.patchScheduleInternal(ctx, "tenant", a.ID, schedule.ID, map[string]any{"bypassToolApproval": "true"}); err == nil {
		t.Fatal("accepted invalid bypass flag")
	}
}

func TestAutomationApprovalBypassAdmission(t *testing.T) {
	for _, mode := range []string{"schedule", "listener", "cron", "inherit", "forged-options"} {
		t.Run(mode, func(t *testing.T) {
			var calls, effects atomic.Int32
			s, a, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if calls.Add(1) == 1 {
					_, _ = io.WriteString(w, `{"choices":[{"message":{"tool_calls":[{"id":"tc","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`)
					return
				}
				_, _ = io.WriteString(w, textCompletion("done"))
			})
			ctx := context.Background()
			_, err := s.store.updateAgentConfig(ctx, "tenant", a.ID, nil, func(cfg map[string]any) error {
				cfg["cloud"] = map[string]any{"approvals": map[string]any{"policy": "always_ask"}}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			s.catalogProvider = func(context.Context, string, string) (agentCatalog, error) {
				return agentCatalog{Tools: []agentTool{directBuiltin("echo", "echo", nil)}}, nil
			}
			s.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
				effects.Add(1)
				return json.RawMessage(`{}`), nil
			}
			h := &handler{store: s.store, deps: s.store.deps, service: s}
			var runID, sessionID string
			if mode == "forged-options" {
				run, _, err := s.StartTurn(ctx, "tenant", a.ID, session.ID, "run", nil, json.RawMessage(`{"bypassToolApproval":true}`), false)
				if err != nil {
					t.Fatal(err)
				}
				runID, sessionID = run.ID, session.ID
			} else {
				schedule, err := h.createScheduleInternal(ctx, "tenant", a.ID, Schedule{Name: "Task", Prompt: "run", Pattern: "@hourly", Enabled: true, BypassToolApproval: mode != "inherit"})
				if err != nil {
					t.Fatal(err)
				}
				var run AutomationRun
				if mode == "listener" {
					run, err = h.admitAutomation(ctx, "tenant", a.ID, "listener", &schedule.ID, schedule.Prompt)
				} else if mode == "cron" {
					err = s.store.deps.Gorm.Table("agent_schedules").Where("id=?", schedule.ID).Update("next_run_at", runtimeTimeString(s.store.now().Add(-time.Minute))).Error
					if err != nil {
						t.Fatal(err)
					}
					h.claimDue(ctx)
					runs, listErr := h.listAutomationRunsInternal(ctx, "tenant", a.ID, schedule.ID, 1)
					if listErr != nil || len(runs) != 1 {
						t.Fatalf("cron admission: %+v %v", runs, listErr)
					}
					run = runs[0]
				} else {
					run, err = h.runScheduleInternal(ctx, "tenant", a.ID, schedule.ID)
				}
				if err != nil {
					t.Fatal(err)
				}
				runID, sessionID = *run.CloudRunID, *run.SessionID
			}
			if mode == "inherit" || mode == "forged-options" {
				id := waitApproval(t, s.store, sessionID)
				if effects.Load() != 0 {
					t.Fatal("executed before approval")
				}
				if err := s.store.settleApproval(ctx, "tenant", a.ID, sessionID, id, "approved", "user", false); err != nil {
					t.Fatal(err)
				}
			}
			waitForAgentRun(t, s.store, a.ID, sessionID, runID)
			if effects.Load() != 1 {
				t.Fatalf("tool executions=%d", effects.Load())
			}
		})
	}
}

func TestSpaceApprovalConfigHTTP(t *testing.T) {
	s, a, _, _ := approvalFixture(t, map[string]any{})
	h := &handler{store: s.store, deps: s.store.deps}
	router := chi.NewRouter()
	router.Get("/spaces/{id}/approvals", h.spaceApprovalConfig)
	router.Put("/spaces/{id}/approvals", h.spaceApprovalConfig)
	request := func(method, body string, actor httpx.Principal) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/spaces/"+a.SpaceID+"/approvals", strings.NewReader(body))
		r = r.WithContext(httpx.WithPrincipal(r.Context(), actor))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	owner := httpx.Principal{TenantID: "tenant", Role: "owner"}
	if w := request(http.MethodGet, "", owner); w.Code != 200 || !strings.Contains(w.Body.String(), `"scope":"risky"`) {
		t.Fatalf("default=%d %s", w.Code, w.Body.String())
	}
	if w := request(http.MethodPut, `{"dangerousTools":["fs_read"],"safeTools":["mcp__docs__*"]}`, owner); w.Code != 200 {
		t.Fatalf("save=%d %s", w.Code, w.Body.String())
	}
	if w := request(http.MethodPut, `{"scope":"all"}`, owner); w.Code != 200 || !strings.Contains(w.Body.String(), "fs_read") {
		t.Fatalf("merge=%d %s", w.Code, w.Body.String())
	}
	for _, body := range []string{`{"scope":"invalid"}`, `{"safeTools":[""]}`, `{"autoAllowReadOnly":"yes"}`, `{"policy":"allow_all"}`} {
		if w := request(http.MethodPut, body, owner); w.Code != 400 {
			t.Fatalf("invalid=%s code=%d", body, w.Code)
		}
	}
	if w := request(http.MethodPut, `{"scope":"risky"}`, httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: a.ID}); w.Code != 403 {
		t.Fatalf("agent key changed Space policy: %d", w.Code)
	}
}
