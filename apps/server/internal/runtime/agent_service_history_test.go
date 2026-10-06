// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func historyHarness(t *testing.T, respond func(call int, body map[string]any) string) (*Store, Agent, Session, func() []map[string]any) {
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
	var mu sync.Mutex
	var bodies []map[string]any
	var calls atomic.Int32
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		n := int(calls.Add(1))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, respond(n, body))
	}))
	t.Cleanup(model.Close)
	up, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "model", Protocol: "openai", Config: raw(map[string]any{"baseUrl": model.URL})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "default", Capability: "chat", UpstreamID: up.ID, Model: "m", Priority: 100, Weight: 100, IsDefault: true}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	captured := func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), bodies...)
	}
	return store, agent, session, captured
}

func textCompletion(text string) string {
	out, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": text}, "finish_reason": "stop"}}})
	return string(out)
}

func beginTurn(t *testing.T, store *Store, agentID, sessionID, content string) {
	t.Helper()
	run, _, err := NewService(store).StartTurn(context.Background(), "tenant", agentID, sessionID, content, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, store, agentID, sessionID, run.ID)
}

func requestMessages(body map[string]any) []map[string]any {
	out := []map[string]any{}
	list, _ := body["messages"].([]any)
	for _, item := range list {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func messageContents(body map[string]any) []string {
	out := []string{}
	for _, m := range requestMessages(body) {
		content, _ := m["content"].(string)
		out = append(out, fmtRole(m)+":"+content)
	}
	return out
}

func fmtRole(m map[string]any) string {
	role, _ := m["role"].(string)
	return role
}

func TestAgentSessionHistoryReplay(t *testing.T) {
	store, agent, session, captured := historyHarness(t, func(call int, body map[string]any) string {
		return textCompletion(map[int]string{1: "hi1", 2: "hi2", 3: "hi3"}[call])
	})
	beginTurn(t, store, agent.ID, session.ID, "p1")
	beginTurn(t, store, agent.ID, session.ID, "p2")
	beginTurn(t, store, agent.ID, session.ID, "p3")

	bodies := captured()
	if len(bodies) != 3 {
		t.Fatalf("model calls=%d", len(bodies))
	}
	second := strings.Join(messageContents(bodies[1]), "|")
	if !strings.Contains(second, "user:p1") || !strings.Contains(second, "assistant:hi1") || !strings.Contains(second, "user:p2") {
		t.Fatalf("second request messages=%v", messageContents(bodies[1]))
	}
	third := messageContents(bodies[2])
	if !strings.Contains(strings.Join(third, "|"), "user:p1") || !strings.Contains(strings.Join(third, "|"), "assistant:hi1") || !strings.Contains(strings.Join(third, "|"), "user:p2") || !strings.Contains(strings.Join(third, "|"), "assistant:hi2") || !strings.Contains(strings.Join(third, "|"), "user:p3") {
		t.Fatalf("third request messages=%v", third)
	}
	first := messageContents(bodies[0])
	if len(first) != 1 || first[0] != "user:p1" {
		t.Fatalf("first request messages=%v", first)
	}
}

func TestAgentSessionHistoryBudget(t *testing.T) {
	store, agent, session, captured := historyHarness(t, func(call int, body map[string]any) string {
		return textCompletion("ok")
	})
	long := strings.Repeat("x", 80000)
	if _, err := store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "user_message", nil, map[string]any{"content": long}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "user_message", nil, map[string]any{"content": "recent-note"}); err != nil {
		t.Fatal(err)
	}
	beginTurn(t, store, agent.ID, session.ID, "now")

	bodies := captured()
	if len(bodies) != 1 {
		t.Fatalf("model calls=%d", len(bodies))
	}
	joined := strings.Join(messageContents(bodies[0]), "|")
	if strings.Contains(joined, long) {
		t.Fatalf("oversized history message was not trimmed")
	}
	if !strings.Contains(joined, "recent-note") || !strings.Contains(joined, "user:now") {
		t.Fatalf("recent messages missing: %v", messageContents(bodies[0]))
	}
}

func TestAgentSessionHistoryAskUserPairing(t *testing.T) {
	store, agent, session, captured := historyHarness(t, func(call int, body map[string]any) string {
		return textCompletion("done")
	})
	answeredID, err := store.CreateQuestion(context.Background(), "tenant", agent.ID, session.ID, "", "tc-1", QuestionRequest{Question: "Proceed with deploy?", Mode: "async"})
	if err != nil {
		t.Fatal(err)
	}
	answer, _ := json.Marshal(map[string]any{"cancelled": false, "selected": nil, "text": "yes please"})
	if err := store.deps.Gorm.Table("agent_user_questions").Where("id = ?", answeredID).Updates(map[string]any{"status": "answered", "answer_json": string(answer)}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "ask_user_resolved", nil, map[string]any{"requestId": answeredID, "status": "answered", "cancelled": false, "answer": json.RawMessage(answer)}); err != nil {
		t.Fatal(err)
	}
	cancelledID, err := store.CreateQuestion(context.Background(), "tenant", agent.ID, session.ID, "", "tc-2", QuestionRequest{Question: "Drop the database?", Mode: "async"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.deps.Gorm.Table("agent_user_questions").Where("id = ?", cancelledID).Updates(map[string]any{"status": "cancelled", "answer_json": `{"cancelled":true,"selected":null,"text":null}`}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "ask_user_resolved", nil, map[string]any{"requestId": cancelledID, "status": "cancelled", "cancelled": true, "answer": json.RawMessage(`{"cancelled":true,"selected":null,"text":null}`)}); err != nil {
		t.Fatal(err)
	}
	beginTurn(t, store, agent.ID, session.ID, "next")

	bodies := captured()
	if len(bodies) != 1 {
		t.Fatalf("model calls=%d", len(bodies))
	}
	wantID := "au_" + answeredID
	if len(wantID) > 15 {
		wantID = wantID[:15]
	}
	foundCall, foundAnswer := false, false
	for _, m := range requestMessages(bodies[0]) {
		if m["role"] == "assistant" {
			if calls, ok := m["tool_calls"].([]any); ok {
				for _, call := range calls {
					cm, _ := call.(map[string]any)
					if cm["id"] == wantID {
						foundCall = true
						fn, _ := cm["function"].(map[string]any)
						if fn["name"] != "ask_user" {
							t.Fatalf("synthetic tool name=%v", fn["name"])
						}
					}
				}
			}
		}
		if m["role"] == "tool" && m["tool_call_id"] == wantID {
			if content, _ := m["content"].(string); content == "User answered: yes please" {
				foundAnswer = true
			}
		}
	}
	if !foundCall || !foundAnswer {
		t.Fatalf("ask_user pair missing call=%v answer=%v messages=%v", foundCall, foundAnswer, messageContents(bodies[0]))
	}
	for _, m := range requestMessages(bodies[0]) {
		if content, _ := m["content"].(string); strings.Contains(content, "Drop the database?") {
			t.Fatalf("cancelled question leaked into history: %v", messageContents(bodies[0]))
		}
	}
}

func TestAgentSessionHistoryCompacted(t *testing.T) {
	store, agent, session, captured := historyHarness(t, func(call int, body map[string]any) string {
		return textCompletion("done")
	})
	if _, err := store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "user_message", nil, map[string]any{"content": "old1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "assistant_message", nil, map[string]any{"content": "old2"}); err != nil {
		t.Fatal(err)
	}
	last, err := store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "assistant_message", nil, map[string]any{"content": "old3"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "session.compacted", nil, map[string]any{"throughSeq": last.Seq, "summary": "Summary text"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "user_message", nil, map[string]any{"content": "after"}); err != nil {
		t.Fatal(err)
	}
	beginTurn(t, store, agent.ID, session.ID, "now")

	bodies := captured()
	if len(bodies) != 1 {
		t.Fatalf("model calls=%d", len(bodies))
	}
	joined := strings.Join(messageContents(bodies[0]), "|")
	if !strings.Contains(joined, "[Earlier conversation summary]") || !strings.Contains(joined, "Summary text") {
		t.Fatalf("summary missing: %v", messageContents(bodies[0]))
	}
	for _, gone := range []string{"old1", "old2", "old3"} {
		if strings.Contains(joined, gone) {
			t.Fatalf("compacted message %q still present: %v", gone, messageContents(bodies[0]))
		}
	}
	if !strings.Contains(joined, "user:after") || !strings.Contains(joined, "user:now") {
		t.Fatalf("post-compaction messages missing: %v", messageContents(bodies[0]))
	}
}
