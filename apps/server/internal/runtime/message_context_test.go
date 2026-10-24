// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestMessageContextHTTPReplayAndRetry(t *testing.T) {
	var bodies []map[string]any
	s, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, textCompletion("reply"))
	})
	h := &handler{store: s.store, service: s, deps: s.store.deps}
	w := loopHandlerRequest(h, agent.ID, session.ID, `{"messageId":"wrapped","content":"hello","context":{"prefix":"sender: Ada","suffix":"reply in bot"}}`, h.sendMessage)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	var accepted struct {
		RunID string `json:"runId"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &accepted)
	waitForAgentRun(t, s.store, agent.ID, session.ID, accepted.RunID)
	w = loopHandlerRequest(h, agent.ID, session.ID, `{"messageId":"wrapped"}`, h.retryRun)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	_ = json.Unmarshal(w.Body.Bytes(), &accepted)
	waitForAgentRun(t, s.store, agent.ID, session.ID, accepted.RunID)
	for _, body := range bodies {
		if !strings.Contains(strings.Join(messageContents(body), "|"), "sender: Ada\n\nhello\n\nreply in bot") {
			t.Fatalf("context missing: %#v", body)
		}
	}
	events, _ := s.store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
	users := 0
	for _, event := range events {
		if event.Type != "user_message" {
			continue
		}
		users++
		var payload map[string]any
		_ = json.Unmarshal(event.Payload, &payload)
		if payload["content"] != "hello" || userPayloadContent(payload) != "sender: Ada\n\nhello\n\nreply in bot" {
			t.Fatalf("visible content changed: %s", event.Payload)
		}
	}
	if users != 1 {
		t.Fatalf("retry duplicated message: %d", users)
	}
}

func TestMessageContextSurvivesQueue(t *testing.T) {
	s, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, textCompletion("ok")) })
	ctx := context.Background()
	queued, err := s.store.Enqueue(ctx, "tenant", agent.ID, session.ID, QueueMessage{Content: "body", Context: &MessageContext{Prefix: "before", Suffix: "after"}})
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.store.PendingQueue(ctx, "tenant", agent.ID, session.ID)
	if err != nil || len(items) != 1 || items[0].Context.render(items[0].Content) != "before\n\nbody\n\nafter" {
		t.Fatalf("queue lost context: %#v %v", items, err)
	}
	_, err = s.store.UpdateQueued(ctx, "tenant", agent.ID, session.ID, queued.ID, QueueMessage{Content: "edited"})
	if err != nil {
		t.Fatal(err)
	}
	items, _ = s.store.PendingQueue(ctx, "tenant", agent.ID, session.ID)
	if items[0].Context.render(items[0].Content) != "before\n\nedited\n\nafter" {
		t.Fatal("edit lost context")
	}
}

func TestCompactionSplitsOversizedSummaryRequests(t *testing.T) {
	calls := 0
	s, _, _ := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if len(body.Messages[1].Content) > 3000 {
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"error":{"message":"maximum context length exceeded"}}`)
			return
		}
		_, _ = io.WriteString(w, textCompletion("Remember the request and completed work."))
	})
	got, err := s.summarizeContext(context.Background(), "tenant", "m", strings.Repeat("会话", 1000), 0)
	if err != nil || got == "" || calls < 4 {
		t.Fatalf("automatic split failed: %q %v, calls=%d", got, err, calls)
	}
}

func TestCompactionLongToolTurn(t *testing.T) {
	messages := []chatMessage{
		{Role: "user", Content: "original task", UserMessageID: "u1"},
		{Role: "assistant", ToolCalls: []modelToolCall{{ID: "a", Name: "tool"}}},
		{Role: "tool", ToolCallID: "a", Content: strings.Repeat("result", 1000)},
		{Role: "assistant", ToolCalls: []modelToolCall{{ID: "b", Name: "tool"}}},
		{Role: "tool", ToolCallID: "b", Content: "latest result"},
	}
	if split := checkpointSplit(messages, 1000); split != 3 {
		t.Fatalf("long turn split=%d, want completed tool round", split)
	}
}

func TestCompactionKeepsToolPairsAndBranchScope(t *testing.T) {
	messages := []chatMessage{{Role: "user", Content: strings.Repeat("old", 100)}, {Role: "assistant", ToolCalls: []modelToolCall{{ID: "c", Name: "tool"}}}, {Role: "tool", ToolCallID: "c", Content: "result"}, {Role: "user", Content: "latest", UserMessageID: "latest"}, {Role: "assistant", ToolCalls: []modelToolCall{{ID: "d", Name: "tool"}}}, {Role: "tool", ToolCallID: "d", Content: "result"}}
	if split := checkpointSplit(messages, 100); split != 3 {
		t.Fatalf("split tool pair: %d", split)
	}
	events := []histEvent{
		{ID: "a", Seq: 1, Type: "user_message", Payload: map[string]any{"messageId": "a", "content": "old", "parentRunId": nil}},
		{ID: "b", Seq: 2, Type: "user_message", Payload: map[string]any{"messageId": "b", "content": "branch", "parentRunId": nil}},
		{Seq: 3, Type: "session.compacted", Payload: map[string]any{"anchorMessageId": "b", "throughSeq": float64(1), "summary": "other branch"}},
	}
	got := buildChainMessages(events, "a", 10000)
	if len(got) != 1 || got[0].Content != "old" {
		t.Fatalf("summary leaked across branches: %#v", got)
	}
}
