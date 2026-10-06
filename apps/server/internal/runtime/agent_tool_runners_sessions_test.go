// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAgentToolCatalogSessionsAutomationDelegate(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	catalog, err := h.agentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	byName := catalogByName(catalog)
	for _, name := range []string{
		"list_sessions", "search_sessions", "get_messages", "import_session",
		"list_routines", "create_routine", "update_routine", "pause_routine", "delete_routine", "run_routine",
		"list_automation_runs", "delegate_agent",
	} {
		tool, ok := byName[name]
		if !ok {
			t.Fatalf("missing tool %s: %v", name, catalog.Tools)
		}
		if tool.Kind != "builtin" || tool.Exposure != "deferred" || tool.LocalName != name {
			t.Fatalf("tool %s metadata: %+v", name, tool)
		}
	}
	if _, ok := byName["apply_patch"]; ok {
		t.Fatal("apply_patch present without workspace")
	}

	insertRuntimeNode(t, d, "node", "tenant", "online")
	node := "node"
	space2, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "WS", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	agent2, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "B", SpaceID: space2.ID})
	catalog2, err := h.agentToolCatalog(context.Background(), "tenant", agent2.ID)
	if err != nil {
		t.Fatal(err)
	}
	patch, ok := catalogByName(catalog2)["apply_patch"]
	if !ok || patch.Exposure != "direct" || patch.Kind != "builtin" {
		t.Fatalf("apply_patch metadata: %+v", patch)
	}
	required, _ := patch.InputSchema["required"].([]string)
	if len(required) != 1 || required[0] != "patch" {
		t.Fatalf("apply_patch required: %#v", patch.InputSchema["required"])
	}
}

func TestRunBuiltinToolSessionsGroup(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	h := &handler{deps: d, store: store}
	ctx := context.Background()

	first, _ := store.CreateSession(ctx, "tenant", "", agent.ID, Session{Title: "Alpha planning", Kind: "chat"})
	_, _ = store.AppendEvent(ctx, "tenant", agent.ID, first.ID, "user_message", nil, map[string]any{"content": "hello alpha"})
	_, _ = store.AppendEvent(ctx, "tenant", agent.ID, first.ID, "assistant_message", nil, map[string]any{"content": "hi there"})
	second, _ := store.CreateSession(ctx, "tenant", "", agent.ID, Session{Title: "Beta notes", Kind: "delegate"})
	_, _ = store.AppendEvent(ctx, "tenant", agent.ID, second.ID, "assistant_message", nil, map[string]any{"content": "beta reply"})

	listRaw, listErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "list_sessions", raw(map[string]any{"limit": 10}))
	list := decodeBuiltinResult(t, listRaw, listErr)
	sessions, _ := list["sessions"].([]any)
	if len(sessions) != 2 {
		t.Fatalf("list_sessions: %#v", list)
	}
	entry, _ := sessions[0].(map[string]any)
	for _, key := range []string{"id", "title", "kind", "status", "model", "createdAt", "updatedAt"} {
		if _, ok := entry[key]; !ok {
			t.Fatalf("session summary missing %s: %#v", key, entry)
		}
	}
	kindRaw, kindErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "list_sessions", raw(map[string]any{"kind": "delegate"}))
	kindList := decodeBuiltinResult(t, kindRaw, kindErr)
	if filtered, _ := kindList["sessions"].([]any); len(filtered) != 1 {
		t.Fatalf("list_sessions kind filter: %#v", kindList)
	}

	searchRaw, searchErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "search_sessions", raw(map[string]any{"query": "alpha"}))
	search := decodeBuiltinResult(t, searchRaw, searchErr)
	if search["query"] != "alpha" {
		t.Fatalf("search_sessions query: %#v", search)
	}
	if results, _ := search["sessions"].([]any); len(results) != 1 {
		t.Fatalf("search_sessions results: %#v", search)
	}
	if _, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "search_sessions", raw(map[string]any{"query": ""})); err == nil {
		t.Fatal("search_sessions empty query should fail")
	}

	currentRaw, currentErr := h.runBuiltinToolForSession(ctx, "tenant", agent.ID, first.ID, "", "get_messages", raw(map[string]any{}))
	current := decodeBuiltinResult(t, currentRaw, currentErr)
	messages, _ := current["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("get_messages current: %#v", current)
	}
	userMessage, _ := messages[0].(map[string]any)
	if userMessage["role"] != "user" || userMessage["content"] != "hello alpha" {
		t.Fatalf("get_messages first: %#v", userMessage)
	}
	otherRaw, otherErr := h.runBuiltinToolForSession(ctx, "tenant", agent.ID, first.ID, "", "get_messages", raw(map[string]any{"session_id": second.ID}))
	other := decodeBuiltinResult(t, otherRaw, otherErr)
	otherMessages, _ := other["messages"].([]any)
	if len(otherMessages) != 1 {
		t.Fatalf("get_messages explicit session: %#v", other)
	}

	importRaw, importErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "import_session", raw(map[string]any{
		"title":    "Imported",
		"messages": []any{map[string]any{"role": "user", "content": "one"}, map[string]any{"role": "assistant", "content": "two"}},
	}))
	imported := decodeBuiltinResult(t, importRaw, importErr)
	if imported["imported"] != float64(2) {
		t.Fatalf("import_session: %#v", imported)
	}
	sessionID, _ := imported["sessionId"].(string)
	if sessionID == "" {
		t.Fatalf("import_session missing id: %#v", imported)
	}
	readRaw, readErr := h.runBuiltinToolForSession(ctx, "tenant", agent.ID, sessionID, "", "get_messages", raw(map[string]any{}))
	read := decodeBuiltinResult(t, readRaw, readErr)
	if readMessages, _ := read["messages"].([]any); len(readMessages) != 2 {
		t.Fatalf("imported messages: %#v", read)
	}
	if _, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "import_session", raw(map[string]any{"messages": []any{}})); err == nil {
		t.Fatal("import_session empty messages should fail")
	}
	if _, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "import_session", raw(map[string]any{"messages": []any{map[string]any{"role": "system", "content": "x"}}})); err == nil {
		t.Fatal("import_session invalid role should fail")
	}
}

func TestRunBuiltinToolAutomationGroup(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	h.service.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
		return nil, errors.New("no tools")
	}
	ctx := context.Background()

	createdRaw, createdErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "create_routine", raw(map[string]any{"name": "Daily", "prompt": "summarize", "schedule": "@daily"}))
	created := decodeBuiltinResult(t, createdRaw, createdErr)
	id, _ := created["id"].(string)
	if id == "" || created["schedule"] != "@daily" || created["nextRunAt"] == nil {
		t.Fatalf("create_routine: %#v", created)
	}
	if _, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "create_routine", raw(map[string]any{"name": "Bad", "prompt": "x", "schedule": "not a cron"})); err == nil {
		t.Fatal("create_routine invalid cron should fail")
	}
	if _, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "create_routine", raw(map[string]any{"name": "", "prompt": "x", "schedule": "@daily"})); err == nil {
		t.Fatal("create_routine missing name should fail")
	}

	listRaw, listErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "list_routines", raw(map[string]any{}))
	routines := decodeBuiltinResult(t, listRaw, listErr)
	items, _ := routines["routines"].([]any)
	if len(items) != 1 {
		t.Fatalf("list_routines: %#v", routines)
	}

	updateRaw, updateErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "update_routine", raw(map[string]any{"id": id, "schedule": "@hourly", "name": "Hourly"}))
	updated := decodeBuiltinResult(t, updateRaw, updateErr)
	if updated["enabled"] != true || updated["schedule"] != "@hourly" {
		t.Fatalf("update_routine: %#v", updated)
	}

	pauseRaw, pauseErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "pause_routine", raw(map[string]any{"id": id}))
	paused := decodeBuiltinResult(t, pauseRaw, pauseErr)
	if paused["enabled"] != false {
		t.Fatalf("pause_routine: %#v", paused)
	}

	runRaw, runErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "run_routine", raw(map[string]any{"id": id}))
	runOut := decodeBuiltinResult(t, runRaw, runErr)
	runID, _ := runOut["runId"].(string)
	if runID == "" || runOut["status"] == "" || runOut["sessionId"] == nil {
		t.Fatalf("run_routine: %#v", runOut)
	}
	var runCount int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM agent_automation_runs WHERE tenant_id='tenant' AND agent_id=?`, agent.ID).Scan(&runCount); err != nil || runCount != 1 {
		t.Fatalf("automation run row count=%d err=%v", runCount, err)
	}

	runsRaw, runsErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "list_automation_runs", raw(map[string]any{"limit": 5}))
	runs := decodeBuiltinResult(t, runsRaw, runsErr)
	runItems, _ := runs["runs"].([]any)
	if len(runItems) != 1 {
		t.Fatalf("list_automation_runs: %#v", runs)
	}
	runEntry, _ := runItems[0].(map[string]any)
	for _, key := range []string{"id", "kind", "status", "prompt", "resultText", "error", "createdAt"} {
		if _, ok := runEntry[key]; !ok {
			t.Fatalf("automation run missing %s: %#v", key, runEntry)
		}
	}

	deleteRaw, deleteErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "delete_routine", raw(map[string]any{"id": id}))
	deleted := decodeBuiltinResult(t, deleteRaw, deleteErr)
	if deleted["deleted"] != true || deleted["id"] != id {
		t.Fatalf("delete_routine: %#v", deleted)
	}
	if _, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "delete_routine", raw(map[string]any{"id": id})); err == nil {
		t.Fatal("delete_routine missing should fail")
	}
}

func applyPatchHarness(t *testing.T, mode string) (*handler, Agent) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	node := "node"
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	h := builtinToolHarness(t, d, "rnr_patch", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{}}, nil
		case "host.fs.write":
			return map[string]any{"ok": true, "path": fmt.Sprint(params["path"])}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "labels": map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.exec":
			command, _ := params["command"].([]any)
			script := ""
			if len(command) >= 3 {
				script = fmt.Sprint(command[2])
			}
			if strings.HasPrefix(script, "git apply") {
				if mode == "success" {
					return map[string]any{"exitCode": 0, "stdout": "applied", "stderr": ""}, nil
				}
				return map[string]any{"exitCode": 1, "stdout": "", "stderr": "git failed"}, nil
			}
			if strings.HasPrefix(script, "patch -p1") {
				if mode == "fallback" {
					return map[string]any{"exitCode": 0, "stdout": "patched", "stderr": ""}, nil
				}
				return map[string]any{"exitCode": 1, "stdout": "", "stderr": "patch failed"}, nil
			}
			return map[string]any{"exitCode": 0, "stdout": "", "stderr": ""}, nil
		}
		return nil, fmt.Errorf("unexpected method %s", method)
	})
	return h, agent
}

func TestRunBuiltinToolApplyPatch(t *testing.T) {
	ctx := context.Background()

	t.Run("success", func(t *testing.T) {
		h, agent := applyPatchHarness(t, "success")
		raw, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "apply_patch", json.RawMessage(`{"patch":"diff --git a/x b/x\n"}`))
		out := decodeBuiltinResult(t, raw, err)
		if out["applied"] != true || out["stdout"] != "applied" {
			t.Fatalf("apply_patch success: %#v", out)
		}
	})

	t.Run("fallback", func(t *testing.T) {
		h, agent := applyPatchHarness(t, "fallback")
		raw, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "apply_patch", json.RawMessage(`{"patch":"diff --git a/x b/x\n"}`))
		out := decodeBuiltinResult(t, raw, err)
		if out["applied"] != true || out["stdout"] != "patched" {
			t.Fatalf("apply_patch fallback: %#v", out)
		}
	})

	t.Run("both-fail", func(t *testing.T) {
		h, agent := applyPatchHarness(t, "fail")
		if _, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "apply_patch", json.RawMessage(`{"patch":"diff --git a/x b/x\n"}`)); err == nil || !strings.Contains(err.Error(), "patch failed") {
			t.Fatalf("apply_patch both fail: %v", err)
		}
		if _, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "apply_patch", json.RawMessage(`{"patch":""}`)); err == nil || !strings.Contains(err.Error(), "patch is required") {
			t.Fatalf("apply_patch empty: %v", err)
		}
	})
}

func TestDelegateAgentEndToEnd(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	parent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Parent", Slug: "parent", SpaceID: space.ID})
	child, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Child", Slug: "child", SpaceID: space.ID})

	var parentCalls atomic.Int32
	parentModel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if parentCalls.Add(1) == 1 {
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"d1","type":"function","function":{"name":"delegate_agent","arguments":"{\"agent\":\"child\",\"prompt\":\"do x\"}"}}]},"finish_reason":"tool_calls"}]}`)
			return
		}
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"parent done"},"finish_reason":"stop"}]}`)
	}))
	defer parentModel.Close()
	childModel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"child done"},"finish_reason":"stop"}]}`)
	}))
	defer childModel.Close()

	parentUp, _ := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "parent", Protocol: "openai", Config: raw(map[string]any{"baseUrl": parentModel.URL})})
	childUp, _ := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "child", Protocol: "openai", Config: raw(map[string]any{"baseUrl": childModel.URL})})
	_, _ = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "parent", Capability: "chat", UpstreamID: parentUp.ID, Model: "parent-model", Priority: 200, Weight: 100})
	_, _ = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "child", Capability: "chat", UpstreamID: childUp.ID, Model: "child-model", Priority: 100, Weight: 100, IsDefault: true})

	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	h.service.toolRunner = h.dispatchAgentTool

	modelName := "parent-model"
	parentSession, _ := store.CreateSession(context.Background(), "tenant", "", parent.ID, Session{Model: &modelName})
	run, _, e := h.service.StartTurn(context.Background(), "tenant", parent.ID, parentSession.ID, "delegate please", nil, nil, false)
	if e != nil {
		t.Fatal(e)
	}
	waitForAgentRun(t, store, parent.ID, parentSession.ID, run.ID)

	childSessions, _ := store.ListSessions(context.Background(), "tenant", child.ID, []string{"delegate"}, 10, 0)
	if len(childSessions) != 1 {
		t.Fatalf("child sessions: %#v", childSessions)
	}
	childSession := childSessions[0]

	events, _ := store.ListEvents(context.Background(), "tenant", parent.ID, parentSession.ID, 0, 100)
	delegateEvent := false
	resultText := ""
	for _, ev := range events {
		var payload map[string]any
		if json.Unmarshal(ev.Payload, &payload) != nil {
			continue
		}
		if ev.Type == "tool_call_delegate" {
			if payload["childSessionId"] == childSession.ID && payload["childAgentId"] == child.ID {
				delegateEvent = true
			}
		}
		if ev.Type == "tool_call_result" {
			if text, ok := payload["resultText"].(string); ok {
				resultText = text
			}
		}
	}
	if !delegateEvent {
		t.Fatalf("missing tool_call_delegate event: %#v", events)
	}
	if !strings.Contains(resultText, "child done") {
		t.Fatalf("delegate result text: %q", resultText)
	}

	if _, err := h.runDelegateAgent(context.Background(), "tenant", child.ID, childSession.ID, "", raw(map[string]any{"agent": "parent", "prompt": "again"})); err == nil || !strings.Contains(err.Error(), "delegation is not available") {
		t.Fatalf("nested delegation should fail: %v", err)
	}
	if _, err := h.runDelegateAgent(context.Background(), "tenant", parent.ID, parentSession.ID, "", raw(map[string]any{"agent": "parent", "prompt": "self"})); err == nil || !strings.Contains(err.Error(), "cannot delegate to yourself") {
		t.Fatalf("self delegation should fail: %v", err)
	}
	if _, err := h.runDelegateAgent(context.Background(), "tenant", parent.ID, parentSession.ID, "", raw(map[string]any{"agent": "nobody", "prompt": "x"})); err == nil || !strings.Contains(err.Error(), "unknown agent") {
		t.Fatalf("unknown delegate should fail: %v", err)
	}
}
