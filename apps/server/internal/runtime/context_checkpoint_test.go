// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestContextPrefixStableAcrossRuns(t *testing.T) {
	var mu sync.Mutex
	var requests []map[string]any
	calls := 0
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		requests = append(requests, body)
		calls++
		n := calls
		mu.Unlock()
		if n == 1 {
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"checking","tool_calls":[{"id":"c1","type":"function","function":{"name":"inspect","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`)
			return
		}
		_, _ = io.WriteString(w, textCompletion("done"))
	})
	service.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
		return raw(map[string]any{"output": strings.Repeat("exact-output-", 1200)}), nil
	}
	var now atomic.Int64
	now.Store(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC).Unix())
	service.store.deps.Clock = func() time.Time { return time.Unix(now.Load(), 0) }
	first, _, err := service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "first", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, service.store, agent.ID, session.ID, first.ID)
	now.Add(3600)
	second, _, err := service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "second", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, service.store, agent.ID, session.ID, second.ID)
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 3 {
		t.Fatalf("requests=%d", len(requests))
	}
	old, next := requestMessages(requests[1]), requestMessages(requests[2])
	if len(next) <= len(old) || !reflect.DeepEqual(old, next[:len(old)]) {
		t.Fatal("restored request changed the cached prefix")
	}
	found := false
	for _, m := range old {
		if m["role"] == "tool" {
			found = len(gwStr(m["content"])) > 6000
		}
	}
	if !found {
		t.Fatal("test did not exercise an oversized historical result")
	}
	if strings.Contains(gwStr(old[0]["content"]), "2026-01-01T12:00") {
		t.Fatal("timestamp entered system prefix")
	}
}

func TestContextCheckpointLongTurnReplayAndBranch(t *testing.T) {
	var requests []map[string]any
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		requests = append(requests, body)
		_, _ = io.WriteString(w, textCompletion("Goal: finish task\nCompleted: old rounds\nNext: inspect latest result"))
	})
	ctx := context.Background()
	run, err := service.store.StartRunWith(ctx, "tenant", agent.ID, session.ID, runStartSpec{MessageID: "u1", Content: "keep original request", HasParent: true})
	if err != nil {
		t.Fatal(err)
	}
	req := TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID, MessageID: "u1"}
	messages := []chatMessage{
		{Role: "user", Content: "keep original request", UserMessageID: "u1"},
		{Role: "assistant", ToolCalls: []modelToolCall{{ID: "old", Name: "read", Arguments: "{}"}}},
		{Role: "tool", ToolCallID: "old", Content: strings.Repeat("old result ", 5000)},
		{Role: "user", UserMessageID: "steer", Content: "keep this correction too"},
		{Role: "assistant", ToolCalls: []modelToolCall{{ID: "recent", Name: "read", Arguments: "{}"}}},
		{Role: "tool", ToolCallID: "recent", Content: "recent result"},
	}
	if err = service.recordContextMessages(ctx, req, run.ID, messages); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"model": "m", "messages": renderMessages("stable", messages, nil, "openai"), "tools": []map[string]any{{"type": "function", "function": map[string]any{"name": "read"}}}, "reasoning_effort": "low"}
	policy := contextBudget{Window: 32000, Output: 4096, Trigger: 12000, Target: 4000}
	out, report, err := service.compactWorkingContext(ctx, req, run.ID, run.ID, messages, payload, policy, "auto", true, 0)
	if err != nil || !report.Compacted {
		t.Fatalf("compact: %+v %v", report, err)
	}
	preserved := map[string]bool{}
	for _, m := range out {
		preserved[m.UserMessageID] = true
	}
	if !preserved["u1"] || !preserved["steer"] {
		t.Fatal("original request or steering correction lost")
	}
	sent := requestMessages(requests[0])
	original := payload["messages"].([]map[string]any)
	rawOriginal, _ := json.Marshal(original)
	rawSent, _ := json.Marshal(sent[:len(original)])
	if string(rawOriginal) != string(rawSent) || requests[0]["reasoning_effort"] != "low" || requests[0]["tools"] == nil {
		t.Fatal("summary did not preserve request prefix/settings")
	}
	tail := []chatMessage{{Role: "assistant", Content: "finished after checkpoint"}}
	if err = service.recordContextMessages(ctx, req, run.ID, tail); err != nil {
		t.Fatal(err)
	}
	err = service.store.FinishRun(ctx, "tenant", agent.ID, session.ID, run.ID, "completed", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Restoring in a new service must exactly match the live post-compaction context.
	restored := NewService(service.store)
	events := restored.loadHistoryEvents(ctx, session.ID)
	events = append(events, histEvent{Seq: 99999, Type: "user_message", Payload: map[string]any{"messageId": "next", "content": "next", "parentRunId": run.ID}})
	got := buildChainMessages(events, "next", int(^uint(0)>>1))
	want := append(append([]chatMessage(nil), out...), tail...)
	if len(got) != len(want)+1 || !reflect.DeepEqual(got[:len(want)], want) {
		t.Fatalf("checkpoint replay mismatch\ngot=%+v\nwant=%+v", got, want)
	}
	retry := buildChainMessages(events, "u1", int(^uint(0)>>1))
	if len(retry) != 1 || retry[0].Content != "keep original request" {
		t.Fatalf("checkpoint leaked into regeneration: %+v", retry)
	}
	events = append(events, histEvent{Seq: 100000, Type: "user_message", Payload: map[string]any{"messageId": "edit", "content": "edited", "parentRunId": nil}})
	branch := buildChainMessages(events, "edit", int(^uint(0)>>1))
	if len(branch) != 1 || branch[0].Content != "edited" {
		t.Fatal("checkpoint leaked into edited branch")
	}
}

func TestContextManualCompactionAndConflict(t *testing.T) {
	summaries := 0
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] == false {
			summaries++
			_, _ = io.WriteString(w, textCompletion("Goal: continue. Completed: previous analysis."))
			return
		}
		_, _ = io.WriteString(w, textCompletion(strings.Repeat("analysis ", 2000)))
	})
	ctx := context.Background()
	run, _, err := service.StartTurn(ctx, "tenant", agent.ID, session.ID, "research", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, service.store, agent.ID, session.ID, run.ID)
	report, err := service.CompactSession(ctx, "tenant", agent.ID, session.ID)
	if err != nil || !report.Compacted || summaries != 1 || report.BeforeTokens <= report.AfterTokens {
		t.Fatalf("manual %+v %v summaries=%d", report, err, summaries)
	}
	events := service.loadHistoryEvents(ctx, session.ID)
	found := false
	for _, ev := range events {
		if cp, ok := readContextCheckpoint(ev); ok {
			found = cp.AnchorRunID == run.ID
		}
	}
	if !found {
		t.Fatal("manual checkpoint missing")
	}
	public, err := service.store.ListEvents(ctx, "tenant", agent.ID, session.ID, 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	completed := false
	for _, ev := range public {
		if ev.Type == "context.messages" || ev.Type == "context.template" || ev.Type == "context.checkpoint" {
			t.Fatal("internal projection exposed to chat stream")
		}
		if ev.Type == "context_compacted" {
			completed = true
		}
	}
	if !completed {
		t.Fatal("public completion event missing")
	}
	active, err := service.store.StartRunWith(ctx, "tenant", agent.ID, session.ID, runStartSpec{MessageID: "active", Content: "work"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.CompactSession(ctx, "tenant", agent.ID, session.ID); err != ErrConflict {
		t.Fatalf("active compact err=%v", err)
	}
	_ = service.store.FinishRun(ctx, "tenant", agent.ID, session.ID, active.ID, "cancelled", nil, nil)
}

func TestContextSummaryFailureKeepsOriginal(t *testing.T) {
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}`)
	})
	ctx := context.Background()
	run, err := service.store.StartRunWith(ctx, "tenant", agent.ID, session.ID, runStartSpec{MessageID: "u", Content: "task"})
	if err != nil {
		t.Fatal(err)
	}
	req := TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID}
	messages := []chatMessage{{Role: "user", UserMessageID: "u", Content: "task"}, {Role: "assistant", Content: strings.Repeat("result ", 4000)}}
	payload := map[string]any{"model": "m", "messages": renderMessages("stable", messages, nil, "openai")}
	got, report, err := service.compactWorkingContext(ctx, req, run.ID, run.ID, messages, payload, contextBudget{Target: 2000, Trigger: 3000}, "auto", true, 0)
	if err == nil || report.Compacted || !report.Failed || !reflect.DeepEqual(got, messages) {
		t.Fatalf("failure mutated context: %+v %v", report, err)
	}
	for _, ev := range service.loadHistoryEvents(ctx, session.ID) {
		if ev.Type == "context.checkpoint" {
			t.Fatal("failed summary installed")
		}
	}
	_ = service.store.FinishRun(ctx, "tenant", agent.ID, session.ID, run.ID, "cancelled", nil, nil)
}

func TestContextBudgetUsesModelAndTools(t *testing.T) {
	service, _, _ := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {})
	ctx := context.Background()
	routes, err := service.store.ListRoutes(ctx, "tenant", "chat")
	if err != nil {
		t.Fatal(err)
	}
	if err = service.store.deps.Gorm.Table("model_routes").Where("id=?", routes[0].ID).Update("options_json", `{"contextLimit":200000,"outputLimit":16000}`).Error; err != nil {
		t.Fatal(err)
	}
	p, err := service.contextPolicy(ctx, "tenant", "m")
	if err != nil {
		t.Fatal(err)
	}
	if p.Window != 200000 || p.Trigger <= 100000 || p.Target >= p.Trigger {
		t.Fatalf("budget %+v", p)
	}
	basic := map[string]any{"messages": []map[string]any{{"role": "system", "content": "rules"}, {"role": "user", "content": "hi"}}}
	n := estimatePayloadTokens(basic)
	basic["tools"] = []map[string]any{{"description": strings.Repeat("schema", 1000)}}
	if estimatePayloadTokens(basic) <= n+1000 {
		t.Fatal("tool schema missing from estimate")
	}
	if estimateTextTokens("中文") < 2 {
		t.Fatal("CJK undercounted")
	}
}

func TestContextCheckpointInstallConflict(t *testing.T) {
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {})
	ctx := context.Background()
	_, err := service.store.AppendEvent(ctx, "tenant", agent.ID, session.ID, "user_message", nil, map[string]any{"messageId": "u", "content": "new"})
	if err != nil {
		t.Fatal(err)
	}
	req := TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID}
	err = service.saveContextCheckpoint(ctx, req, "", contextCheckpoint{Version: 2, AnchorRunID: "r", ThroughSeq: 1, Summary: "stale", Messages: []chatMessage{{Role: "user", Content: "stale"}}}, compactionResult{Compacted: true}, session.LastSeq)
	if err != ErrConflict {
		t.Fatalf("stale install: %v", err)
	}
	for _, ev := range service.loadHistoryEvents(ctx, session.ID) {
		if ev.Type == "context.checkpoint" {
			t.Fatal("stale checkpoint committed")
		}
	}
}

func TestContextUsageAccounting(t *testing.T) {
	for _, tc := range []struct {
		dialect string
		usage   map[string]any
	}{
		{"openai", map[string]any{"prompt_tokens": float64(120), "completion_tokens": float64(3), "prompt_tokens_details": map[string]any{"cached_tokens": float64(100)}}},
		{"responses", map[string]any{"input_tokens": float64(120), "output_tokens": float64(3), "input_tokens_details": map[string]any{"cached_tokens": float64(100)}}},
		{"anthropic", map[string]any{"input_tokens": float64(20), "output_tokens": float64(3), "cache_read_input_tokens": float64(100)}},
	} {
		u := parseModelUsage(tc.usage, tc.dialect)
		if u.PromptTokens != 120 || u.CacheReadTokens != 100 || u.UncachedInputTokens != 20 {
			t.Fatalf("%s: %+v", tc.dialect, u)
		}
	}
	u := parseModelUsage(map[string]any{"input_tokens": float64(20), "cache_creation_input_tokens": float64(80), "cache_read_input_tokens": float64(100)}, "anthropic")
	if u.PromptTokens != 200 || u.CacheWriteTokens != 80 || u.UncachedInputTokens != 20 {
		t.Fatalf("write: %+v", u)
	}
}

func TestContextCacheBreakpointsAndRouteAffinity(t *testing.T) {
	ctx := withContextCache(context.Background(), "tenant", "session")
	body := chatRequestToAnthropic(map[string]any{"model": "m", "messages": []any{map[string]any{"role": "system", "content": "stable"}, map[string]any{"role": "user", "content": "first"}, map[string]any{"role": "assistant", "content": "reply"}, map[string]any{"role": "user", "content": "second"}}}, gwRouteDefaults{})
	applyContextCache(ctx, "anthropic", body)
	if gwMap(gwSlice(body["system"])[0])["cache_control"] == nil {
		t.Fatal("static prefix has no breakpoint")
	}
	messages := gwSlice(body["messages"])
	for _, m := range messages[len(messages)-2:] {
		blocks := gwSlice(gwMap(m)["content"])
		if gwMap(blocks[len(blocks)-1])["cache_control"] == nil {
			t.Fatal("history endpoint has no breakpoint")
		}
	}
	a := ModelCandidate{Route: ModelRoute{ID: "a", Priority: 10, Weight: 100}}
	b := ModelCandidate{Route: ModelRoute{ID: "b", Priority: 10, Weight: 100}}
	c := ModelCandidate{Route: ModelRoute{ID: "fallback", Priority: 20, Weight: 100}}
	first := []ModelCandidate{a, b, c}
	second := []ModelCandidate{b, a, c}
	preferContextRoute(ctx, first)
	preferContextRoute(withContextCache(context.Background(), "tenant", "session"), second)
	if first[0].Route.ID != second[0].Route.ID || first[0].Route.ID == "fallback" {
		t.Fatal("route affinity not stable")
	}
	rememberContextRoute(ctx, "fallback")
	preferContextRoute(ctx, second)
	if second[0].Route.ID != "fallback" {
		t.Fatal("successful failover affinity lost")
	}
}

func TestContextFrozenImages(t *testing.T) {
	calls := 0
	service := &Service{attachmentReader: func(context.Context, string, string, string, int64) ([]byte, error) {
		calls++
		return []byte("old image"), nil
	}}
	messages := []chatMessage{{Role: "user", Content: "image", Images: []string{"/image.png"}}}
	service.contextImages(context.Background(), "t", "a", messages)
	encoded, _ := json.Marshal(messages)
	var restored []chatMessage
	_ = json.Unmarshal(encoded, &restored)
	service.attachmentReader = func(context.Context, string, string, string, int64) ([]byte, error) {
		t.Fatal("restored image reread mutable path")
		return nil, nil
	}
	service.contextImages(context.Background(), "t", "a", restored)
	if calls != 1 || !reflect.DeepEqual(messages, restored) {
		t.Fatal("image projection changed")
	}
}
