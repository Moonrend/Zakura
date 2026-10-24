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
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func TestAgentProjectContextFixedSpaceAndRequestedSkills(t *testing.T) {
	t.Setenv("ZAKURA_WORKSPACE_ROOT", t.TempDir())
	h, agentID := newWebHandler(t)
	agent, _ := h.store.GetAgent(context.Background(), "tenant", agentID)
	router := workspaceTestRouter(h, httpx.Principal{TenantID: "tenant"})
	if code, value := workspaceTestRequest(t, router, "POST", "/spaces/"+agent.SpaceID+"/projects", `{"name":"demo","withWorkspace":true,"instructions":"conversation rules"}`); code != 200 {
		t.Fatalf("%d %#v", code, value)
	}
	fs, err := h.workspaceForSpace(context.Background(), "tenant", agent.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"projects/demo/AGENTS.md": "canonical directory rules", "projects/demo/CLAUDE.md": "ignored legacy rules",
		"projects/demo/.claude/skills/build/SKILL.md": "actual project skill body", "skills/shared/SKILL.md": "actual shared skill body",
	} {
		file := filepath.Join(fs.root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0640); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.WithValue(context.Background(), computerExecKey{}, &resolvedExecution{nodeID: "wrong", spaceID: "wrong", hostRoot: "wrong"})
	got, err := h.loadAgentProjectContext(ctx, "tenant", agent.SpaceID, agentID, "projects/demo", []string{"shared"}, []promptSkill{{Name: "shared", Path: "/workspace/skills/shared/SKILL.md"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"conversation rules", "canonical directory rules", "actual project skill body", "actual shared skill body"} {
		if !strings.Contains(got.text+got.turnText, value) {
			t.Fatalf("missing %q: %s", value, got.text+got.turnText)
		}
	}
	if strings.Contains(got.text, "ignored legacy") {
		t.Fatal("legacy instructions won")
	}
	if _, err := h.loadAgentProjectContext(ctx, "tenant", agent.SpaceID, agentID, "", []string{"unknown"}, nil); err == nil {
		t.Fatal("uninstalled requested skill accepted")
	}
	if _, err := h.readSpaceContextFile(ctx, "tenant", agent.SpaceID, "../secret", 1024); err == nil {
		t.Fatal("traversal accepted")
	}
	if code, value := workspaceTestRequest(t, router, "POST", "/spaces/"+agent.SpaceID+"/projects", `{"name":"notes","instructions":"metadata only"}`); code != 200 {
		t.Fatalf("%d %#v", code, value)
	}
	got, err = h.loadAgentProjectContext(ctx, "tenant", agent.SpaceID, agentID, "notes", nil, nil)
	if err != nil || !strings.Contains(got.text, "metadata only") {
		t.Fatalf("metadata-only project: %#v %v", got, err)
	}
}

func TestAgentProjectHooksMatchingBoundsAndUnsupported(t *testing.T) {
	var body map[string]any
	_ = json.Unmarshal([]byte(`{"pretooluse":[{"matcher":"Bash","hooks":[{"type":"command","command":"configured command","if":"Bash(git commit*)","timeout":90}]}]}`), &body)
	packages, err := parseProjectHookPackage("test", "", body)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	project := &agentProjectContext{hooks: packages, exec: func(ctx context.Context, p projectHookPackage, a projectHookAction, in projectHookInput) (string, error) {
		calls++
		if a.TimeoutMs != 10000 {
			t.Fatalf("timeout %d", a.TimeoutMs)
		}
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 10*time.Second {
			t.Fatal("missing event deadline")
		}
		return "external output", nil
	}}
	out, err := project.runHooks(context.Background(), projectHookInput{Event: "PreToolUse", ToolName: "re_shell_exec", ToolInput: json.RawMessage(`{"command":"FOO=x git commit -m test"}`)})
	if err != nil || calls != 1 || !strings.Contains(out, "untrusted data") {
		t.Fatalf("%s %v calls=%d", out, err, calls)
	}
	_, _ = project.runHooks(context.Background(), projectHookInput{Event: "PreToolUse", ToolName: "fs_read", ToolInput: json.RawMessage(`{"path":"git commit"}`)})
	if calls != 1 {
		t.Fatal("matcher ignored")
	}
	for _, event := range []string{"PreCommit", "PreCompact", "FabricatedEvent"} {
		_, err := parseProjectHookPackage("test", "", map[string]any{event: []any{map[string]any{"type": "prompt", "prompt": "configured"}}})
		if err == nil {
			t.Fatalf("%s silently accepted", event)
		}
	}
	project.exec = func(context.Context, projectHookPackage, projectHookAction, projectHookInput) (string, error) {
		return strings.Repeat("x", hookOutputMaxBytes+1), nil
	}
	if _, err := project.runHooks(context.Background(), projectHookInput{Event: "PreToolUse", ToolName: "Bash", ToolInput: json.RawMessage(`{"command":"git commit"}`)}); err == nil {
		t.Fatal("oversized output accepted")
	}
}

func TestAgentProjectHookRunnerFixedServerAndCapability(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	node := "node"
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	supported := true
	calls := 0
	h := builtinToolHarness(t, d, "rnr_project_hook", func(method string, params map[string]any) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		switch method {
		case "sys.info":
			return map[string]any{"kind": "computer", "storageRoot": "/srv/zakura", "goos": "linux", "capabilities": map[string]any{"host": true, "boundedExecOutput": supported}, "hostInfo": map[string]any{}}, nil
		case "host.exec":
			calls++
			if params["spaceId"] != space.ID || params["workingDir"] != "/projects/demo" || params["root"] != nil || params["maxOutputBytes"] != float64(16384) || params["timeoutMs"] != float64(1000) {
				return nil, fmt.Errorf("incorrect runner scope/bounds %#v", params)
			}
			var input projectHookInput
			_ = json.Unmarshal([]byte(mapStringValue(params["stdin"])), &input)
			if input.ToolName != "Bash" || input.Event != "PreToolUse" {
				return nil, fmt.Errorf("stdin %#v", input)
			}
			return map[string]any{"exitCode": 0, "stdout": "configured output", "stderr": ""}, nil
		default:
			return nil, fmt.Errorf("unexpected %s", method)
		}
	})
	ctx := context.WithValue(context.Background(), computerExecKey{}, &resolvedExecution{nodeID: "wrong", hostRoot: "wrong"})
	out, err := h.executeProjectHook(ctx, "tenant", space.ID, "demo", projectHookPackage{}, projectHookAction{Type: "command", Command: "printf configured", TimeoutMs: 1000}, projectHookInput{Event: "PreToolUse", ToolName: "re_shell_exec"})
	if err != nil || out != "configured output" {
		t.Fatalf("%q %v", out, err)
	}
	mu.Lock()
	supported = false
	mu.Unlock()
	if _, err := h.executeProjectHook(ctx, "tenant", space.ID, "demo", projectHookPackage{}, projectHookAction{Type: "command", Command: "printf configured", TimeoutMs: 1000}, projectHookInput{Event: "PreToolUse"}); err == nil || !strings.Contains(err.Error(), "boundedExecOutput") {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("unsupported runner executed command %d", calls)
	}
}

func TestAgentProjectHooksDurableStartAndFailureSemantics(t *testing.T) {
	h, agentID := newWebHandler(t)
	ctx := context.Background()
	sess, err := h.store.CreateSession(ctx, "tenant", "", agentID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	run, err := h.store.StartRun(ctx, "tenant", agentID, sess.ID, "hello", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	calls := map[string]int{}
	project := &agentProjectContext{hooks: []projectHookPackage{{Name: "test", Events: map[string][]projectHookGroup{}}}, exec: func(ctx context.Context, p projectHookPackage, a projectHookAction, in projectHookInput) (string, error) {
		calls[in.Event]++
		if in.Event == "SessionStart" {
			return "start once", nil
		}
		return "", errors.New("configured failure")
	}}
	for _, event := range []string{"SessionStart", "PreToolUse", "PostToolUse", "Stop"} {
		project.hooks[0].Events[event] = []projectHookGroup{{Actions: []projectHookAction{{Type: "command", Command: "configured", TimeoutMs: 1000}}}}
	}
	ctx = context.WithValue(ctx, agentProjectContextKey{}, project)
	s := NewService(h.store)
	req := TurnRequest{Tenant: "tenant", Agent: agentID, Session: sess.ID}
	for i := 0; i < 2; i++ {
		text, err := s.invokeProjectHooks(ctx, req, run.ID, projectHookInput{Event: "SessionStart"}, false)
		if err != nil || !strings.Contains(text, "start once") {
			t.Fatalf("%s %v", text, err)
		}
	}
	if calls["SessionStart"] != 1 {
		t.Fatal(calls)
	}
	for _, event := range []string{"PostToolUse", "Stop"} {
		text, err := s.invokeProjectHooks(ctx, req, run.ID, projectHookInput{Event: event}, true)
		if err != nil || !strings.Contains(text, "completed effects were not undone") {
			t.Fatalf("%s %v", text, err)
		}
	}
	sideEffects := 0
	s.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
		sideEffects++
		return json.RawMessage(`{}`), nil
	}
	messages := []chatMessage{}
	err = s.runRoundTools(ctx, req, sess, run.ID, []modelToolCall{{ID: "a", Name: "shell_exec", Arguments: `{}`}, {ID: "b", Name: "fs_write", Arguments: `{}`}}, agentCatalog{}, true, 4096, &messages)
	if err == nil || sideEffects != 0 {
		t.Fatalf("pre hook failure side effects=%d err=%v", sideEffects, err)
	}
	results := 0
	for _, message := range messages {
		if message.Role == "tool" {
			results++
		}
	}
	if results != 2 {
		t.Fatalf("unfinished tool placeholders %d", results)
	}
	var errorsCount int64
	_ = h.deps.Gorm.Table("cloud_agent_events").Where("session_id=? AND type=?", sess.ID, "hook_error").Count(&errorsCount).Error
	if errorsCount < 3 {
		t.Fatalf("missing visible hook diagnostics %d", errorsCount)
	}
}

func TestAgentProjectContextSystemInjection(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	ctx := context.Background()
	space, _ := store.CreateSpace(ctx, "tenant", Space{Name: "S"})
	agent, _ := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	var mu sync.Mutex
	captured := ""
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		captured = mapStringValue(body["messages"].([]any)[0].(map[string]any)["content"])
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}`)
	}))
	defer model.Close()
	up, _ := store.CreateUpstream(ctx, "tenant", Upstream{Name: "model", Protocol: "openai", Config: raw(map[string]any{"baseUrl": model.URL})})
	_, _ = store.CreateRoute(ctx, "tenant", ModelRoute{Name: "default", Capability: "chat", UpstreamID: up.ID, Model: "m", Priority: 100, Weight: 100, IsDefault: true})
	s := NewService(store)
	s.projectContext = func(context.Context, string, string, string, string, []string, []promptSkill) (*agentProjectContext, error) {
		return &agentProjectContext{text: "\nProject conversation and directory instructions; actual skill content"}, nil
	}
	sess, _ := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	run, _, err := s.StartTurn(ctx, "tenant", agent.ID, sess.ID, "hi", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, store, agent.ID, sess.ID, run.ID)
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(captured, "actual skill content") {
		t.Fatal(captured)
	}
}
