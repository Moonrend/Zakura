// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func approvalFixture(t *testing.T, config map[string]any) (*Service, Agent, Session, Run) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	ctx := context.Background()
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "Approval"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID, Config: rawJSON(map[string]any{"cloud": map[string]any{"approvals": config}})})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.StartRun(ctx, "tenant", agent.ID, session.ID, "test", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	return NewService(store), agent, session, run
}

func waitApproval(t *testing.T, s *Store, session string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var id string
		err := s.deps.Gorm.Table("agent_tool_approvals").Select("id").Where("session_id=? AND status='pending'", session).Scan(&id).Error
		if err != nil {
			t.Fatal(err)
		}
		if id != "" {
			return id
		}
		time.Sleep(time.Millisecond * 5)
	}
	t.Fatal("pending approval not found")
	return ""
}

func TestToolApprovalStrictRulesAndReadOnly(t *testing.T) {
	for _, legacy := range []string{"ask", "always_ask"} {
		cfg, err := parseApprovalConfig(rawJSON(map[string]any{"cloud": map[string]any{"approvals": map[string]any{"policy": legacy, "alwaysAllow": []string{"*"}, "rules": []any{map[string]any{"matcher": "*", "action": "allow"}}}}}), "allow_all")
		if err != nil || cfg.decision("fs_read", json.RawMessage(`{"path":"/workspace/a"}`)) != "ask" {
			t.Fatalf("strict bypass %s: %+v %v", legacy, cfg, err)
		}
		cfg.AlwaysDeny = []string{"fs_read"}
		if cfg.decision("fs_read", nil) != "deny" {
			t.Fatal("explicit deny lost")
		}
	}
	if _, err := parseApprovalConfig(json.RawMessage(`{"cloud":{"approvals":{"policy":"broken"}}}`), "allow_all"); err == nil {
		t.Fatal("invalid policy allowed")
	}
	if approvalMatcher("Bash(git status*)", "shell_exec", json.RawMessage(`{"command":"rm -rf /;git status"}`)) {
		t.Fatal("unanchored command matched")
	}
}

func TestToolApprovalStandardWaitsBeforeToolSideEffects(t *testing.T) {
	service, agent, session, run := approvalFixture(t, map[string]any{"policy": "always_ask", "alwaysAllow": []string{"*"}})
	calls := make(chan struct{}, 1)
	service.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
		calls <- struct{}{}
		return json.RawMessage(`{}`), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		messages := []chatMessage{}
		done <- service.runRoundTools(ctx, TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID}, session, run.ID, []modelToolCall{{ID: "call", Name: "fs_read", Arguments: `{"path":"/workspace/a"}`}}, agentCatalog{}, true, 8000, &messages)
	}()
	id := waitApproval(t, service.store, session.ID)
	select {
	case <-calls:
		t.Fatal("executed before approval")
	default:
	}
	if err := service.store.settleApproval(ctx, "other", agent.ID, session.ID, id, "approved", "user", false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross tenant %v", err)
	}
	if err := service.store.settleApproval(ctx, "tenant", agent.ID, session.ID, id, "approved", "user", true); err == nil {
		t.Fatal("permanent allow accepted")
	}
	if err := service.store.settleApproval(ctx, "tenant", agent.ID, session.ID, id, "approved", "user", false); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("approval blocked run")
	}
	select {
	case <-calls:
	default:
		t.Fatal("tool not executed")
	}
	if err := service.store.settleApproval(ctx, "tenant", agent.ID, session.ID, id, "approved", "user", false); !errors.Is(err, ErrConflict) {
		t.Fatalf("replay accepted %v", err)
	}
}

func TestToolApprovalCancellationAndTargetChange(t *testing.T) {
	for _, scenario := range []string{"cancel", "target", "tools-disabled"} {
		t.Run(scenario, func(t *testing.T) {
			s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- s.approveTool(ctx, "tenant", a.ID, session.ID, run.ID, "call", "fs_read", json.RawMessage(`{}`), "allow_all", "standard", "")
			}()
			id := waitApproval(t, s.store, session.ID)
			if scenario == "cancel" {
				cancel()
			} else {
				if scenario == "tools-disabled" {
					_, err := s.store.updateAgentConfig(ctx, "tenant", a.ID, nil, func(cfg map[string]any) error {
						cfg["cloud"].(map[string]any)["enableTools"] = false
						return nil
					})
					if err != nil {
						t.Fatal(err)
					}
				} else if err := s.store.deps.Gorm.Table("spaces").Where("id=?", a.SpaceID).Update("runtime_node_id", "new-node").Error; err != nil {
					t.Fatal(err)
				}
				if err := s.store.settleApproval(ctx, "tenant", a.ID, session.ID, id, "approved", "user", false); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("unsafe approval allowed")
				}
			case <-time.After(time.Second):
				t.Fatal("did not stop")
			}
			row, err := s.store.getApproval(context.Background(), "tenant", a.ID, session.ID, id)
			if err != nil || row.Status == "pending" {
				t.Fatalf("unsettled %+v %v", row, err)
			}
		})
	}
}

func TestToolApprovalJevLowConfidenceBecomesHuman(t *testing.T) {
	store, _, _, route, _ := jevFixture(t, validJevAnswer)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "AI"})
	if err != nil {
		t.Fatal(err)
	}
	a, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID, Config: rawJSON(map[string]any{"cloud": map[string]any{"approvals": map[string]any{"policy": "ai", "aiGate": map[string]any{"provider": "jev", "scope": "all", "routeId": route.ID}}}})})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, "tenant", "", a.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	s := NewService(store)
	done := make(chan error, 1)
	go func() {
		done <- s.approveTool(ctx, "tenant", a.ID, session.ID, "", "call", "fs_read", json.RawMessage(`{}`), "allow_all", "standard", "")
	}()
	id := waitApproval(t, store, session.ID)
	if err := store.settleApproval(ctx, "tenant", a.ID, session.ID, id, "denied", "user", false); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("low native confidence used high winning probability")
	}
}
