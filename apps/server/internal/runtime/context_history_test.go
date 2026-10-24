// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestContextManualAncestorKeepsExistingDescendants(t *testing.T) {
	var summaryInput string
	s, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		summaryInput = string(body)
		_, _ = io.WriteString(w, textCompletion("Goal: ancestor task. Findings: verified."))
	})
	ctx := context.Background()
	appendRun := func(id, content, answer string, parent *string) Run {
		t.Helper()
		run, err := s.store.StartRunWith(ctx, "tenant", agent.ID, session.ID, runStartSpec{MessageID: id, Content: content, HasParent: true, ParentRunID: parent})
		if err != nil {
			t.Fatal(err)
		}
		req := TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID}
		// Stream payloads must not be read after a projection has replaced them.
		if _, err := s.store.AppendEvent(ctx, "tenant", agent.ID, session.ID, "assistant_delta", &run.ID, map[string]any{"delta": strings.Repeat("stream-noise", 2000)}); err != nil {
			t.Fatal(err)
		}
		if err := s.recordContextMessages(ctx, req, run.ID, []chatMessage{{Role: "user", UserMessageID: id, Content: content}, {Role: "assistant", Content: answer}}); err != nil {
			t.Fatal(err)
		}
		if err := s.recordContextTemplate(ctx, req, run.ID, "stable", map[string]any{"model": "m"}); err != nil {
			t.Fatal(err)
		}
		if err := s.store.FinishRun(ctx, "tenant", agent.ID, session.ID, run.ID, "completed", nil, nil); err != nil {
			t.Fatal(err)
		}
		return run
	}
	ancestor := appendRun("u1", "ancestor-task", strings.Repeat("ancestor finding ", 3000), nil)
	child := appendRun("u2", "existing-child", "child-answer", &ancestor.ID)
	other := appendRun("other", "unrelated-root", "unrelated-answer", nil)
	routes, err := s.store.ListRoutes(ctx, "tenant", "chat")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.store.UpdateSession(ctx, "tenant", agent.ID, session.ID, map[string]any{"modelRouteId": routes[0].ID}); err != nil {
		t.Fatal(err)
	}
	h := &handler{store: s.store, service: s, deps: s.store.deps}
	w := loopHandlerRequest(h, agent.ID, session.ID, string(raw(map[string]any{"runId": ancestor.ID})), h.compactSession)
	if w.Code != 200 {
		t.Fatalf("compact HTTP %d: %s", w.Code, w.Body.String())
	}
	var report compactionResult
	if err := json.Unmarshal(w.Body.Bytes(), &report); err != nil || !report.Compacted || report.AnchorRunID != ancestor.ID || report.Model != routes[0].ID {
		t.Fatalf("report: %+v %v", report, err)
	}
	if strings.Contains(summaryInput, "existing-child") || strings.Contains(summaryInput, "unrelated-root") || strings.Contains(summaryInput, "stream-noise") {
		t.Fatal("summary read a different branch or obsolete payload")
	}
	current, err := s.store.GetSession(ctx, "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	restored := NewService(s.store)
	events, err := restored.loadContextHistory(ctx, session.ID, "next", child.ID, current.LastSeq)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.Type == "assistant_delta" || ev.Type == "context.template" {
			t.Fatalf("unneeded payload loaded: %s", ev.Type)
		}
		if ev.Type == "context.messages" && (ev.RunID == ancestor.ID || ev.RunID == other.ID) {
			t.Fatal("covered or unrelated projection loaded")
		}
	}
	messages := buildChainMessages(events, "next", int(^uint(0)>>1))
	if len(messages) < 4 || messages[len(messages)-3].Content != "existing-child" || messages[len(messages)-2].Content != "child-answer" {
		t.Fatalf("descendants lost: %+v", messages)
	}
	// The optimized reader must match full-event replay, including old branches.
	all := s.loadHistoryEvents(ctx, session.ID)
	all = append(all, histEvent{Seq: current.LastSeq + 1, Type: "user_message", Payload: map[string]any{"messageId": "next", "parentRunId": child.ID, "content": ""}})
	if want := buildChainMessages(all, "next", int(^uint(0)>>1)); !reflect.DeepEqual(messages, want) {
		t.Fatal("optimized replay differs from full replay")
	}
	otherEvents, err := restored.loadContextHistory(ctx, session.ID, "other-next", other.ID, current.LastSeq)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range otherEvents {
		if ev.Type == "context.checkpoint" {
			t.Fatal("ancestor checkpoint leaked into unrelated root")
		}
	}
	report, err = s.CompactSession(ctx, "tenant", agent.ID, session.ID, ancestor.ID)
	if err != nil || report.Compacted {
		t.Fatalf("repeat compact should be a no-op: %+v %v", report, err)
	}
}

func TestContextProjectionAvoidsDuplicateSynchronousAnswer(t *testing.T) {
	messages := []chatMessage{{Role: "assistant", ToolCalls: []modelToolCall{{ID: "ask", Name: "ask_user", Arguments: "{}"}}}, {Role: "tool", ToolCallID: "ask", Content: "answer"}}
	events := []histEvent{
		{Seq: 1, Type: "user_message", Payload: map[string]any{"messageId": "u", "content": "task"}},
		{Seq: 2, Type: "run_start", RunID: "r", Payload: map[string]any{"replyToMessageId": "u"}},
		{Seq: 3, Type: "ask_user_request", RunID: "r", Payload: map[string]any{"requestId": "q", "toolCallId": "ask", "mode": "sync"}},
		{Seq: 4, Type: "context.messages", RunID: "r", Payload: map[string]any{"messages": messages}},
		{Seq: 5, Type: "ask_user_resolved", RunID: "r", Payload: map[string]any{"requestId": "q", "status": "answered", "answer": map[string]any{"text": "answer"}}},
		{Seq: 6, Type: "user_message", Payload: map[string]any{"messageId": "next", "content": "next", "parentRunId": "r"}},
	}
	got := buildChainMessages(events, "next", 100000)
	if len(got) != 4 {
		t.Fatalf("duplicate synchronous answer: %+v", got)
	}
}

func TestContextHistoryPropagatesDatabaseErrors(t *testing.T) {
	s, _, session := loopHarness(t, func(http.ResponseWriter, *http.Request) {})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.loadContextHistory(ctx, session.ID, "u", "", 100); !errors.Is(err, context.Canceled) {
		t.Fatalf("database cancellation hidden: %v", err)
	}
}

func TestContextSummaryFallbackBudgetAndUsage(t *testing.T) {
	calls := 0
	s, _, _ := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		input := gwStr(gwMap(gwSlice(body["messages"])[1])["content"])
		if len(input) > 3000 {
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"error":{"message":"maximum context length exceeded"}}`)
			return
		}
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"verified summary"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":40}}}`)
	})
	attempt := &summaryAttempt{remaining: 12, output: 512}
	_, err := s.summarizeFragment(context.Background(), "tenant", "m", strings.Repeat("x", 5000), 0, attempt)
	if err != nil || calls != 4 || attempt.usage == nil || attempt.usage.PromptTokens != 300 || attempt.usage.CacheReadTokens != 120 || attempt.usage.CompletionTokens != 30 {
		t.Fatalf("usage=%+v calls=%d err=%v", attempt.usage, calls, err)
	}
	calls = 0
	attempt = &summaryAttempt{remaining: 2, output: 512}
	_, err = s.summarizeFragment(context.Background(), "tenant", "m", strings.Repeat("x", 50000), 0, attempt)
	if err == nil || !strings.Contains(err.Error(), "budget exhausted") || calls != 2 {
		t.Fatalf("unbounded summary: calls=%d err=%v", calls, err)
	}
}

func TestContextAnthropicCumulativeUsage(t *testing.T) {
	stream := "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":20,\"cache_read_input_tokens\":100,\"output_tokens\":1}}}\n\n" +
		"data: {\"type\":\"message_delta\",\"usage\":{\"cache_creation_input_tokens\":30,\"output_tokens\":4}}\n\n" +
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n" +
		"data: {\"type\":\"message_stop\"}\n\n"
	result, err := parseModelStream(strings.NewReader(stream), discardSink{})
	if err != nil || result.Usage == nil {
		t.Fatalf("parse: %+v %v", result, err)
	}
	u := result.Usage
	if u.PromptTokens != 150 || u.UncachedInputTokens != 20 || u.CacheReadTokens != 100 || u.CacheWriteTokens != 30 || u.CompletionTokens != 5 {
		t.Fatalf("cumulative usage: %+v", u)
	}
}

func TestContextCacheRetainsPreviousEndpoint(t *testing.T) {
	ctx := withContextCache(context.Background(), "tenant", "session")
	messages := []any{map[string]any{"role": "system", "content": "stable"}, map[string]any{"role": "user", "content": "task"}}
	before := chatRequestToAnthropic(map[string]any{"messages": messages}, gwRouteDefaults{})
	applyContextCache(ctx, "anthropic", before)
	calls, results := []any{}, []any{}
	for i := 0; i < 30; i++ {
		id := strings.Repeat("c", i+1)
		calls = append(calls, map[string]any{"id": id, "type": "function", "function": map[string]any{"name": "inspect", "arguments": "{}"}})
		results = append(results, map[string]any{"role": "tool", "tool_call_id": id, "content": "result"})
	}
	messages = append(messages, map[string]any{"role": "assistant", "content": "checking", "tool_calls": calls})
	messages = append(messages, results...)
	after := chatRequestToAnthropic(map[string]any{"messages": messages}, gwRouteDefaults{})
	applyContextCache(ctx, "anthropic", after)
	if !reflect.DeepEqual(gwSlice(before["messages"])[0], gwSlice(after["messages"])[0]) {
		t.Fatal("previous request endpoint moved out of cache lookback")
	}
	marked := 1 // system
	for _, message := range gwSlice(after["messages"]) {
		for _, block := range gwSlice(gwMap(message)["content"]) {
			if gwMap(block)["cache_control"] != nil {
				marked++
			}
		}
	}
	if marked != 4 {
		t.Fatalf("cache breakpoints=%d", marked)
	}
	messages = append(messages, map[string]any{"role": "user", "content": continuationSummaryPrompt})
	summary := chatRequestToAnthropic(map[string]any{"messages": messages}, gwRouteDefaults{})
	applyContextCache(ctx, "anthropic", summary)
	oldBlocks := gwSlice(gwMap(gwSlice(after["messages"])[2])["content"])
	newBlocks := gwSlice(gwMap(gwSlice(summary["messages"])[2])["content"])
	if len(newBlocks) != len(oldBlocks)+1 {
		t.Fatal("summary did not append to merged tool-result message")
	}
	for i := range oldBlocks {
		a, b := clonePayload(gwMap(oldBlocks[i])), clonePayload(gwMap(newBlocks[i]))
		delete(a, "cache_control")
		delete(b, "cache_control")
		if !reflect.DeepEqual(a, b) {
			t.Fatal("summary rewrote cached content")
		}
	}
}
