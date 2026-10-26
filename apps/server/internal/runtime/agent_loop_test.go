// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func loopHarness(t *testing.T, serve http.HandlerFunc) (*Service, Agent, Session) {
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
	model := httptest.NewServer(serve)
	t.Cleanup(model.Close)
	up, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "model", Protocol: "openai", Config: raw(map[string]any{"baseUrl": model.URL})})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "default", Capability: "chat", UpstreamID: up.ID, Model: "m", Priority: 100, Weight: 100, IsDefault: true})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store)
	service.retryBackoff = time.Millisecond
	return service, agent, session
}

func TestAgentLoopStreamsBeforeResponseCompletes(t *testing.T) {
	written := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] != true {
			t.Error("stream not requested")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(written)
		<-release
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"world\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	})
	ctx, cancel := context.WithCancel(context.Background())
	run, _, err := service.StartTurn(ctx, "tenant", agent.ID, session.ID, "hi", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	cancel() // HTTP request lifetime must not cancel the background turn.
	<-written
	deadline := time.Now().Add(2 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		events, _ := service.store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
		for _, event := range events {
			if event.Type == "assistant_delta" && strings.Contains(string(event.Payload), "Hello") {
				found = true
			}
		}
		if found {
			break
		}
		time.Sleep(time.Millisecond * 5)
	}
	if !found {
		t.Error("no incremental event before response completed")
	}
	releaseOnce.Do(func() { close(release) })
	waitForAgentRun(t, service.store, agent.ID, session.ID, run.ID)
	events, _ := service.store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
	for _, event := range events {
		if event.Type == "assistant_message" && strings.Contains(string(event.Payload), "Hello world") {
			return
		}
	}
	t.Fatal("final assistant_message missing")
}

func TestAgentLoopCloudSystemAndDisableTools(t *testing.T) {
	var captured map[string]any
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&captured)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, textCompletion("done"))
	})
	_, err := service.store.UpdateAgent(context.Background(), "tenant", agent.ID, map[string]any{"config": map[string]any{"cloud": map[string]any{"systemPrompt": "Custom exact instruction", "enableTools": false}}})
	if err != nil {
		t.Fatal(err)
	}
	service.catalogProvider = func(context.Context, string, string) (agentCatalog, error) {
		t.Error("disabled tools should not load catalog")
		return agentCatalog{}, nil
	}
	run, _, err := service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "hello", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, service.store, agent.ID, session.ID, run.ID)
	if !strings.Contains(systemMessageContent(captured), "Custom exact instruction") {
		t.Fatalf("system prompt missing: %v", captured)
	}
	if len(requestToolNames(captured)) > 0 {
		t.Fatal("tools declared despite enableTools=false")
	}
}

func TestAgentLoopCancelDrainsQueuedMessage(t *testing.T) {
	started := make(chan struct{})
	var calls atomic.Int32
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, ": ping\n\n")
			w.(http.Flusher).Flush()
			close(started)
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, textCompletion("queued reply"))
	})
	first, _, err := service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "first", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	_, queued, err := service.Start(context.Background(), TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID, Content: "second", QueueOnConflict: true, FollowUpMode: "queue"})
	if err != nil || queued == nil {
		t.Fatalf("queue: %v %v", queued, err)
	}
	if _, err = service.Cancel(context.Background(), "tenant", agent.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		events, _ := service.store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
		for _, event := range events {
			if event.Type == "assistant_message" && strings.Contains(string(event.Payload), "queued reply") {
				current, _ := service.store.GetRun(context.Background(), "tenant", agent.ID, session.ID, first.ID)
				if current.Status != "cancelled" {
					t.Fatalf("first status=%s", current.Status)
				}
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("queued message did not drain after cancellation")
}

func TestAgentLoopSteerInjectedAfterTool(t *testing.T) {
	toolStarted := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	var second map[string]any
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		if calls.Add(1) == 1 {
			_, _ = io.WriteString(w, `{"choices":[{"message":{"tool_calls":[{"id":"tc","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`)
			return
		}
		second = body
		_, _ = io.WriteString(w, textCompletion("followed steer"))
	})
	service.catalogProvider = func(context.Context, string, string) (agentCatalog, error) {
		return agentCatalog{Tools: []agentTool{directBuiltin("echo", "echo", nil)}}, nil
	}
	service.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
		close(toolStarted)
		<-release
		return []byte(`{"ok":true}`), nil
	}
	run, _, err := service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "first", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	<-toolStarted
	_, queued, err := service.Start(context.Background(), TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID, Content: "change direction", QueueOnConflict: true, FollowUpMode: "steer"})
	if err != nil || queued == nil || queued.Mode != "steer" {
		t.Fatalf("queue=%v err=%v", queued, err)
	}
	close(release)
	waitForAgentRun(t, service.store, agent.ID, session.ID, run.ID)
	if !strings.Contains(strings.Join(messageContents(second), "|"), "user:change direction") {
		t.Fatalf("steer missing: %v", second)
	}
	pending, _ := service.store.PendingQueue(context.Background(), "tenant", agent.ID, session.ID)
	if len(pending) != 0 {
		t.Fatalf("pending=%v", pending)
	}
}

func TestAgentLoopRetryDoesNotDuplicateUserMessage(t *testing.T) {
	var calls atomic.Int32
	var captured map[string]any
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&captured)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, textCompletion(fmt.Sprintf("variant-%d", calls.Add(1))))
	})
	run, _, err := service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "question", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, service.store, agent.ID, session.ID, run.ID)
	run, _, err = service.Start(context.Background(), TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID, Retry: true})
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, service.store, agent.ID, session.ID, run.ID)
	events, _ := service.store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
	users := 0
	for _, event := range events {
		if event.Type == "user_message" {
			users++
		}
	}
	if users != 1 {
		t.Fatalf("retry appended user message: %d", users)
	}
	if strings.Contains(strings.Join(messageContents(captured), "|"), "variant-1") {
		t.Fatalf("abandoned variant leaked: %v", captured)
	}
}

func TestAgentLoopRetriesTruncatedStreamWithRollback(t *testing.T) {
	var calls atomic.Int32
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if calls.Add(1) == 1 {
			_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"abandoned\"}}]}\n\n")
			return
		}
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"recovered\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	})
	run, _, err := service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "question", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, service.store, agent.ID, session.ID, run.ID)
	events, _ := service.store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
	rollback := false
	for _, event := range events {
		if event.Type == "assistant_rollback" {
			rollback = true
		}
	}
	if !rollback || calls.Load() != 2 {
		t.Fatalf("rollback=%v calls=%d", rollback, calls.Load())
	}
	chain := runEventsToMessages(service.loadHistoryEvents(context.Background(), session.ID))
	for _, message := range chain {
		if strings.Contains(message.Content, "abandoned") {
			t.Fatalf("rolled back text leaked: %v", chain)
		}
	}
}

func TestAgentLoopCancelCompletesPendingToolResults(t *testing.T) {
	toolStarted := make(chan struct{})
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"tool_calls":[{"id":"t1","function":{"name":"echo","arguments":"{}"}},{"id":"t2","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`)
	})
	service.catalogProvider = func(context.Context, string, string) (agentCatalog, error) {
		return agentCatalog{Tools: []agentTool{directBuiltin("echo", "echo", nil)}}, nil
	}
	service.toolRunner = func(ctx context.Context, tenant, agent, session, id, name string, args json.RawMessage) (json.RawMessage, error) {
		close(toolStarted)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	run, _, err := service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "tools", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	<-toolStarted
	if _, err := service.Cancel(context.Background(), "tenant", agent.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	events, _ := service.store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
	results := 0
	for _, event := range events {
		if event.Type == "tool_call_result" {
			results++
		}
		if event.Type == "run_end" && results != 2 {
			t.Fatalf("run ended before placeholders: %v", events)
		}
	}
	if results != 2 {
		t.Fatalf("pending tool results=%d", results)
	}
	current, _ := service.store.GetRun(context.Background(), "tenant", agent.ID, session.ID, run.ID)
	if current.Status != "cancelled" {
		t.Fatalf("status=%s", current.Status)
	}
}

func TestAgentLoopModelInheritance(t *testing.T) {
	var selected string
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		selected, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, textCompletion("ok"))
	})
	ctx := context.Background()
	routes, _ := service.store.ListRoutes(ctx, "tenant", "chat")
	for _, model := range []string{"space-model", "agent-model", "session-model"} {
		_, err := service.store.CreateRoute(ctx, "tenant", ModelRoute{Name: model, Capability: "chat", UpstreamID: routes[0].UpstreamID, Model: model})
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err := service.store.UpdateSpace(ctx, "tenant", agent.SpaceID, map[string]any{"config": map[string]any{"cloud": map[string]any{"model": "space-model"}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, level := range []string{"space", "agent", "session"} {
		if level == "agent" {
			_, err = service.store.UpdateAgent(ctx, "tenant", agent.ID, map[string]any{"config": map[string]any{"cloud": map[string]any{"model": "agent-model"}}})
		}
		if level == "session" {
			_, err = service.store.UpdateSession(ctx, "tenant", agent.ID, session.ID, map[string]any{"model": "session-model"})
		}
		if err != nil {
			t.Fatal(err)
		}
		run, _, err := service.StartTurn(ctx, "tenant", agent.ID, session.ID, "hello", nil, nil, false)
		if err != nil {
			t.Fatal(err)
		}
		waitForAgentRun(t, service.store, agent.ID, session.ID, run.ID)
		if selected != level+"-model" {
			t.Fatalf("%s selected %q", level, selected)
		}
	}
}

func TestModelStreamParsesSupportedDialects(t *testing.T) {
	for name, stream := range map[string]string{
		"openai":    "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
		"anthropic": "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
		"responses": "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			result, err := parseModelStream(strings.NewReader(stream), nil)
			if err != nil || result.Text != "hi" {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		})
	}
}
