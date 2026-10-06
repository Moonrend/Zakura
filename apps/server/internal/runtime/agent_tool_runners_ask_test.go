// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func seedAskUserHarness(t *testing.T) (*handler, Agent, Session) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	return h, agent, session
}

func TestRunAskUserToolSyncAnswered(t *testing.T) {
	h, agent, session := seedAskUserHarness(t)
	replied := make(chan struct{})
	go func() {
		defer close(replied)
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			var row struct {
				ID string `gorm:"column:id"`
			}
			err := h.deps.Gorm.Table("agent_user_questions").Select("id").Where("session_id=? AND status='pending'", session.ID).Take(&row).Error
			if err == nil && row.ID != "" {
				answer, _ := json.Marshal(map[string]any{"cancelled": false, "selected": nil, "text": "yes please"})
				h.deps.Gorm.Table("agent_user_questions").Where("id=?", row.ID).Updates(map[string]any{"status": "answered", "answer_json": string(answer), "resolved_at": runtimeTimeString(h.store.now())})
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	}()
	rawResult, err := h.runAskUserTool(context.Background(), "tenant", agent.ID, session.ID, "tc-sync", raw(map[string]any{"question": "Proceed?", "timeoutSeconds": 30}))
	if err != nil {
		t.Fatalf("runAskUserTool: %v", err)
	}
	<-replied
	out := decodeBuiltinResult(t, rawResult, nil)
	if out["status"] != "answered" || out["text"] != "yes please" || !strings.Contains(fmt.Sprint(out["summary"]), "yes please") {
		t.Fatalf("ask_user answered result: %#v", out)
	}
}

func TestRunAskUserToolTimeout(t *testing.T) {
	h, agent, session := seedAskUserHarness(t)
	go func() {
		time.Sleep(1500 * time.Millisecond)
		past := runtimeTimeString(h.store.now().Add(-time.Minute))
		h.deps.Gorm.Table("agent_user_questions").Where("session_id=? AND status='pending'", session.ID).Update("expires_at", past)
	}()
	started := time.Now()
	rawResult, err := h.runAskUserTool(context.Background(), "tenant", agent.ID, session.ID, "tc-timeout", raw(map[string]any{"question": "Proceed?", "timeoutSeconds": 1}))
	if err != nil {
		t.Fatalf("runAskUserTool: %v", err)
	}
	out := decodeBuiltinResult(t, rawResult, nil)
	if out["status"] != "timeout" {
		t.Fatalf("ask_user timeout result: %#v", out)
	}
	if time.Since(started) > 10*time.Second {
		t.Fatalf("timeout took too long: %s", time.Since(started))
	}
	var pending int64
	if err := h.deps.Gorm.Table("agent_user_questions").Where("session_id=? AND status='pending'", session.ID).Count(&pending).Error; err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("pending questions remain: %d", pending)
	}
}

func TestRunAskUserToolCancelled(t *testing.T) {
	h, agent, session := seedAskUserHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		time.Sleep(200 * time.Millisecond)
		cancel()
	}()
	_, err := h.runAskUserTool(ctx, "tenant", agent.ID, session.ID, "tc-cancel", raw(map[string]any{"question": "Proceed?"}))
	if err == nil || !strings.Contains(err.Error(), "ask_user cancelled") {
		t.Fatalf("expected ask_user cancelled, got %v", err)
	}
}

func TestRunAskUserToolAsync(t *testing.T) {
	h, agent, session := seedAskUserHarness(t)
	rawResult, err := h.runAskUserTool(context.Background(), "tenant", agent.ID, session.ID, "tc-async", raw(map[string]any{"question": "Proceed?", "mode": "async"}))
	if err != nil {
		t.Fatalf("runAskUserTool: %v", err)
	}
	out := decodeBuiltinResult(t, rawResult, nil)
	if out["status"] != "sent" || fmt.Sprint(out["requestId"]) == "" {
		t.Fatalf("ask_user async result: %#v", out)
	}
	var count int64
	if err := h.deps.Gorm.Table("agent_user_questions").Where("session_id=? AND status='pending' AND mode='async'", session.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("async question rows: %d", count)
	}
}
