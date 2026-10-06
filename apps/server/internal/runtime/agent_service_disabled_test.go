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
)

func TestNormalizeToolOptionName(t *testing.T) {
	cases := map[string]string{
		"shell_exec":       "shell_exec",
		"re_web_search":    "web_search",
		"re_echo__echo":    "echo__echo",
		"mcp__echo__echo":  "echo__echo",
		"mcp1:echo":        "echo",
		"  re_foo__bar  ":  "foo__bar",
		"mcp__my-ref__run": "my-ref__run",
		"":                 "",
	}
	for in, want := range cases {
		if got := normalizeToolOptionName(in); got != want {
			t.Fatalf("normalizeToolOptionName(%q)=%q want %q", in, got, want)
		}
	}
}

func TestToolNameDisabledMatching(t *testing.T) {
	set := disabledToolSet(raw(map[string]any{"disabledTools": []string{"shell_exec", "re_echo__echo"}}))
	if !toolNameDisabled(set, "shell_exec") {
		t.Fatalf("shell_exec should be disabled")
	}
	if !toolNameDisabled(set, "mcp__echo__echo") {
		t.Fatalf("mcp__echo__echo should be disabled via re_ core key")
	}
	if toolNameDisabled(set, "ask_user") || toolNameDisabled(set, "mcp__other__echo") {
		t.Fatalf("unexpected match: %v", set)
	}
	qualified := disabledToolSet(raw(map[string]any{"disabledTools": []string{"mcp1:echo"}}))
	if !toolNameDisabled(qualified, "mcp__echo__echo") {
		t.Fatalf("mcp1:echo should disable mcp__echo__echo")
	}
	if toolNameDisabled(qualified, "mcp__other__search") {
		t.Fatalf("mcp1:echo matched wrong tool")
	}
}

func TestToolDisabledFromContext(t *testing.T) {
	ctx := context.WithValue(context.Background(), disabledToolsKey{}, map[string]bool{"echo__echo": true})
	if !toolDisabled(ctx, "mcp__echo__echo") {
		t.Fatalf("expected ctx disabled match")
	}
	if toolDisabled(ctx, "mcp__other__echo") {
		t.Fatalf("unexpected ctx disabled match")
	}
}

func TestQueueMessagePreservesDisabledOptions(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	session, _ := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})

	options := raw(map[string]any{"disabledTools": []string{"shell_exec", "re_echo__echo"}})
	if _, err := store.Enqueue(context.Background(), "tenant", agent.ID, session.ID, QueueMessage{Content: "queued", Options: options}); err != nil {
		t.Fatal(err)
	}
	m, err := store.TakeQueued(context.Background(), "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !toolNameDisabled(disabledToolSet(m.Options), "shell_exec") || !toolNameDisabled(disabledToolSet(m.Options), "mcp__echo__echo") {
		t.Fatalf("queued options lost disabled tools: %s", string(m.Options))
	}
}

func runDisabledToolScenario(t *testing.T, disabled []string, optionsSet bool, modelHandler func(http.ResponseWriter, *http.Request, int)) (*Store, Agent, string, *fakeMCP, []map[string]any) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	nodeID := "node1"
	insertRuntimeNode(t, d, nodeID, "tenant", "online")
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local", EnableComputer: true, RuntimeNodeID: &nodeID})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	fake := newFakeMCP()
	t.Cleanup(fake.close)

	var mu sync.Mutex
	var bodies []map[string]any
	var calls atomic.Int32
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		n := calls.Add(1)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		modelHandler(w, r, int(n))
	}))
	t.Cleanup(model.Close)
	up, _ := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "model", Protocol: "openai", Config: raw(map[string]any{"baseUrl": model.URL})})
	_, _ = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "default", Capability: "chat", UpstreamID: up.ID, Model: "m", Priority: 100, Weight: 100, IsDefault: true})
	insertAgentMCPInstance(t, d, "mcp1", "echo", "Echo", fake.server.URL, agent.ID, nil)

	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	h.service.catalogProvider = func(ctx context.Context, tenant, agent string) (agentCatalog, error) {
		return h.cachedAgentToolCatalog(ctx, tenant, agent)
	}
	h.service.loadedTools = h.sessionLoadedTools
	h.service.toolRunner = h.dispatchAgentTool

	session, _ := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	var options json.RawMessage
	if optionsSet {
		options = raw(map[string]any{"disabledTools": disabled})
	}
	run, _, e := h.service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "use tool", nil, options, false)
	if e != nil {
		t.Fatal(e)
	}
	waitForAgentRun(t, store, agent.ID, session.ID, run.ID)

	mu.Lock()
	captured := append([]map[string]any(nil), bodies...)
	mu.Unlock()
	return store, agent, session.ID, fake, captured
}

func disabledEchoModelHandler(w http.ResponseWriter, r *http.Request, call int) {
	const mcpToolName = "mcp__echo__echo"
	switch call {
	case 1:
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"s1","type":"function","function":{"name":"tool_search","arguments":"{\"query\":\"echo\"}"}}]},"finish_reason":"tool_calls"}]}`)
	case 2:
		_, _ = io.WriteString(w, fmt.Sprintf(`{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"m1","type":"function","function":{"name":%q,"arguments":"{\"value\":\"hi\"}"}}]},"finish_reason":"tool_calls"}]}`, mcpToolName))
	default:
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}`)
	}
}

func assertDisabledToolInterception(t *testing.T, store *Store, agent Agent, sessionID string, fake *fakeMCP, bodies []map[string]any, expectShellExec bool) {
	t.Helper()
	const mcpToolName = "mcp__echo__echo"
	if len(bodies) != 3 {
		t.Fatalf("model calls=%d", len(bodies))
	}
	first := requestToolNames(bodies[0])
	if containsToolName(first, mcpToolName) || hasToolPrefix(first, "mcp__") {
		t.Fatalf("first request leaked mcp tools=%v", first)
	}
	if !containsToolName(first, "tool_search") || !containsToolName(first, "ask_user") {
		t.Fatalf("first request missing core tools=%v", first)
	}
	if expectShellExec {
		if !containsToolName(first, "shell_exec") {
			t.Fatalf("shell_exec unexpectedly absent=%v", first)
		}
	} else if containsToolName(first, "shell_exec") {
		t.Fatalf("disabled shell_exec declared=%v", first)
	}

	second := requestToolNames(bodies[1])
	if containsToolName(second, mcpToolName) {
		t.Fatalf("second request declared disabled mcp tool=%v", second)
	}
	if result := toolMessageContent(bodies[1]); !strings.Contains(result, "No matching tools found.") {
		t.Fatalf("tool_search result=%q", result)
	}

	intercepted := false
	events, _ := store.ListEvents(context.Background(), "tenant", agent.ID, sessionID, 0, 200)
	for _, ev := range events {
		if ev.Type != "tool_call_result" {
			continue
		}
		var payload map[string]any
		if json.Unmarshal(ev.Payload, &payload) != nil {
			continue
		}
		if payload["name"] != mcpToolName {
			continue
		}
		intercepted = true
		if isErr, _ := payload["isError"].(bool); !isErr {
			t.Fatalf("expected isError for disabled tool, payload=%v", payload)
		}
		if text, _ := payload["resultText"].(string); !strings.Contains(text, "is disabled for this run") {
			t.Fatalf("unexpected interception text=%q", text)
		}
	}
	if !intercepted {
		t.Fatalf("no tool_call_result for disabled tool")
	}
	if fake.callCalls.Load() != 0 {
		t.Fatalf("mcp server was called despite disabled tool")
	}
}

func TestDisabledToolsEndToEnd(t *testing.T) {
	store, agent, sessionID, fake, bodies := runDisabledToolScenario(t, []string{"shell_exec", "re_echo__echo"}, true, disabledEchoModelHandler)
	assertDisabledToolInterception(t, store, agent, sessionID, fake, bodies, false)
}

func TestDisabledToolsInstanceQualified(t *testing.T) {
	store, agent, sessionID, fake, bodies := runDisabledToolScenario(t, []string{"mcp1:echo"}, true, disabledEchoModelHandler)
	assertDisabledToolInterception(t, store, agent, sessionID, fake, bodies, true)
}

func TestDisabledToolsEmptyOptionsRegression(t *testing.T) {
	passThrough := func(w http.ResponseWriter, r *http.Request, call int) {
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}`)
	}
	t.Run("nil-options", func(t *testing.T) {
		_, _, _, _, bodies := runDisabledToolScenario(t, nil, false, passThrough)
		if len(bodies) != 1 {
			t.Fatalf("model calls=%d", len(bodies))
		}
		names := requestToolNames(bodies[0])
		if !containsToolName(names, "shell_exec") || !containsToolName(names, "tool_search") {
			t.Fatalf("nil options filtered tools=%v", names)
		}
		if hasToolPrefix(names, "mcp__") {
			t.Fatalf("nil options leaked deferred tools=%v", names)
		}
	})
	t.Run("empty-options", func(t *testing.T) {
		_, _, _, _, bodies := runDisabledToolScenario(t, []string{}, true, passThrough)
		if len(bodies) != 1 {
			t.Fatalf("model calls=%d", len(bodies))
		}
		names := requestToolNames(bodies[0])
		if !containsToolName(names, "shell_exec") || !containsToolName(names, "tool_search") {
			t.Fatalf("empty options filtered tools=%v", names)
		}
	})
}
