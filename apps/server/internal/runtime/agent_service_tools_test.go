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

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
)

func wireAgentToolService(h *handler) {
	h.service.catalogProvider = func(ctx context.Context, tenant, agent string) (agentCatalog, error) {
		return h.cachedAgentToolCatalog(ctx, tenant, agent)
	}
	h.service.loadedTools = h.sessionLoadedTools
	h.service.toolRunner = func(ctx context.Context, tenant, agent, session, toolCallID, name string, args json.RawMessage) (json.RawMessage, error) {
		switch {
		case name == "tool_search":
			return h.runToolSearchTool(ctx, tenant, agent, session, toolCallID, args)
		case isBuiltinToolName(name):
			return h.runBuiltinTool(ctx, tenant, agent, name, args)
		case strings.HasPrefix(name, "mcp__"):
			return h.runCatalogMCPTool(ctx, tenant, agent, name, args)
		}
		return nil, fmt.Errorf("unexpected tool %q", name)
	}
}

type fakeMCP struct {
	server    *httptest.Server
	listCalls atomic.Int32
	callCalls atomic.Int32
	mu        sync.Mutex
	callNames []string
}

func newFakeMCP() *fakeMCP {
	f := &fakeMCP{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     any            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		result := map[string]any{}
		switch req.Method {
		case "tools/list":
			f.listCalls.Add(1)
			result = map[string]any{"tools": []any{map[string]any{
				"name":        "echo",
				"description": "Echo a value back",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"value": map[string]any{"type": "string"}}},
			}}}
		case "tools/call":
			f.callCalls.Add(1)
			name, _ := req.Params["name"].(string)
			f.mu.Lock()
			f.callNames = append(f.callNames, name)
			f.mu.Unlock()
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "echoed"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}))
	return f
}

func (f *fakeMCP) close() { f.server.Close() }

func insertAgentMCPInstance(t *testing.T, d *appdeps.Dependencies, id, ref, name, url, agentID string, extra map[string]any) {
	t.Helper()
	cfg := map[string]any{"url": url}
	for k, v := range extra {
		cfg[k] = v
	}
	now := d.Clock()
	_, e := d.DB.Exec(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, "tenant", agentID, "mcp", ref, name, string(raw(cfg)), "{}", "ready", now, now)
	if e != nil {
		t.Fatal(e)
	}
}

func waitForAgentRun(t *testing.T, store *Store, agentID, sessionID, runID string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current, e := store.GetRun(context.Background(), "tenant", agentID, sessionID, runID)
		if e == nil && current.Status == "completed" {
			return
		}
		if e == nil && current.Status == "failed" {
			errText := ""
			if current.Error != nil {
				errText = *current.Error
			}
			t.Fatalf("run failed: %s", errText)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("run did not complete")
}

func requestToolNames(body map[string]any) []string {
	names := []string{}
	list, _ := body["tools"].([]any)
	for _, item := range list {
		m, _ := item.(map[string]any)
		f, _ := m["function"].(map[string]any)
		if n, ok := f["name"].(string); ok {
			names = append(names, n)
		}
	}
	return names
}

func containsToolName(names []string, want string) bool {
	for _, name := range names {
		if name == want {
			return true
		}
	}
	return false
}

func hasToolPrefix(names []string, prefix string) bool {
	for _, name := range names {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func systemMessageContent(body map[string]any) string {
	msgs, _ := body["messages"].([]any)
	for _, item := range msgs {
		m, _ := item.(map[string]any)
		if m["role"] == "system" {
			content, _ := m["content"].(string)
			return content
		}
	}
	return ""
}

func toolMessageContent(body map[string]any) string {
	out := ""
	msgs, _ := body["messages"].([]any)
	for _, item := range msgs {
		m, _ := item.(map[string]any)
		if m["role"] == "tool" {
			content, _ := m["content"].(string)
			out = content
		}
	}
	return out
}

func runToolScenario(t *testing.T, agentMemory bool, exposure string, extra map[string]any, modelHandler func(http.ResponseWriter, *http.Request, int)) (*Store, Agent, *fakeMCP, []map[string]any) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, EnableMemory: agentMemory})
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
	if exposure != "" {
		extra = map[string]any{"exposure": exposure}
	}
	insertAgentMCPInstance(t, d, "mcp1", "echo", "Echo", fake.server.URL, agent.ID, extra)

	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	wireAgentToolService(h)

	session, _ := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	run, _, e := h.service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "use tool", nil, nil, false)
	if e != nil {
		t.Fatal(e)
	}
	waitForAgentRun(t, store, agent.ID, session.ID, run.ID)

	mu.Lock()
	captured := append([]map[string]any(nil), bodies...)
	mu.Unlock()
	return store, agent, fake, captured
}

func TestCloudAgentDynamicToolLoading(t *testing.T) {
	const mcpToolName = "mcp__echo__echo"
	modelHandler := func(w http.ResponseWriter, r *http.Request, call int) {
		switch call {
		case 1:
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"s1","type":"function","function":{"name":"tool_search","arguments":"{\"query\":\"echo\"}"}}]},"finish_reason":"tool_calls"}]}`)
		case 2:
			_, _ = io.WriteString(w, fmt.Sprintf(`{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"m1","type":"function","function":{"name":%q,"arguments":"{\"value\":\"hi\"}"}}]},"finish_reason":"tool_calls"}]}`, mcpToolName))
		default:
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}`)
		}
	}
	store, agent, fake, bodies := runToolScenario(t, true, "", nil, modelHandler)
	if len(bodies) != 3 {
		t.Fatalf("model calls=%d", len(bodies))
	}
	firstNames := requestToolNames(bodies[0])
	if !containsToolName(firstNames, "tool_search") || !containsToolName(firstNames, "memory_search") {
		t.Fatalf("first request tools=%v", firstNames)
	}
	if hasToolPrefix(firstNames, "mcp__") || containsToolName(firstNames, "shell_exec") {
		t.Fatalf("first request leaked tools=%v", firstNames)
	}
	secondNames := requestToolNames(bodies[1])
	if !containsToolName(secondNames, mcpToolName) || !containsToolName(secondNames, "tool_search") {
		t.Fatalf("second request tools=%v", secondNames)
	}
	hints := systemMessageContent(bodies[1])
	if !strings.Contains(hints, "tool_search") || !strings.Contains(hints, "mcp__echo") {
		t.Fatalf("system hints=%q", hints)
	}
	if fake.callCalls.Load() != 1 || fake.listCalls.Load() < 1 {
		t.Fatalf("mcp list=%d call=%d", fake.listCalls.Load(), fake.callCalls.Load())
	}
	fake.mu.Lock()
	names := append([]string(nil), fake.callNames...)
	fake.mu.Unlock()
	if len(names) != 1 || names[0] != "echo" {
		t.Fatalf("mcp call names=%v", names)
	}
	sessionID := sessionIDForAgent(t, store, agent.ID)
	events, _ := store.ListEvents(context.Background(), "tenant", agent.ID, sessionID, 0, 100)
	types := map[string]bool{}
	for _, ev := range events {
		types[ev.Type] = true
	}
	if !types["tools_loaded"] {
		t.Fatalf("missing tools_loaded event: %v", types)
	}
}

func TestCloudAgentDirectMCPExposure(t *testing.T) {
	const mcpToolName = "mcp__echo__echo"
	modelHandler := func(w http.ResponseWriter, r *http.Request, call int) {
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}`)
	}
	_, _, _, bodies := runToolScenario(t, false, "direct", nil, modelHandler)
	if len(bodies) != 1 {
		t.Fatalf("model calls=%d", len(bodies))
	}
	names := requestToolNames(bodies[0])
	if !containsToolName(names, mcpToolName) {
		t.Fatalf("direct exposure tools=%v", names)
	}
}

func TestCloudAgentToolSearchNoMatch(t *testing.T) {
	modelHandler := func(w http.ResponseWriter, r *http.Request, call int) {
		if call == 1 {
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"s1","type":"function","function":{"name":"tool_search","arguments":"{\"query\":\"zzzzxxqq\"}"}}]},"finish_reason":"tool_calls"}]}`)
			return
		}
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}`)
	}
	store, agent, _, bodies := runToolScenario(t, false, "", nil, modelHandler)
	if len(bodies) != 2 {
		t.Fatalf("model calls=%d", len(bodies))
	}
	result := toolMessageContent(bodies[1])
	if !strings.Contains(result, "No matching tools found.") {
		t.Fatalf("tool result=%q", result)
	}
	sessionID := sessionIDForAgent(t, store, agent.ID)
	events, _ := store.ListEvents(context.Background(), "tenant", agent.ID, sessionID, 0, 100)
	for _, ev := range events {
		if ev.Type == "tools_loaded" {
			t.Fatalf("unexpected tools_loaded event")
		}
	}
}

func sessionIDForAgent(t *testing.T, store *Store, agentID string) string {
	t.Helper()
	sessions, e := store.ListSessions(context.Background(), "tenant", agentID, nil, 10, 0)
	if e != nil || len(sessions) == 0 {
		t.Fatalf("no sessions: %v", e)
	}
	return sessions[0].ID
}
