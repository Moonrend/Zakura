// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestACPCallbackPathsStayInWorkspace(t *testing.T) {
	for _, raw := range []string{"/etc/passwd", "/workspace/../x", "../x", `C:\\secrets`, "/workspace2/x", "/workspace/a\x00"} {
		if got, err := acpWorkspacePath(raw); err == nil {
			t.Errorf("accepted %q -> %q", raw, got)
		}
	}
	for raw, want := range map[string]string{"a.txt": "/workspace/a.txt", "/workspace/a.txt": "/workspace/a.txt", "/workspace": "/workspace"} {
		got, err := acpWorkspacePath(raw)
		if err != nil || got != want {
			t.Errorf("%q: %q %v", raw, got, err)
		}
	}
}

func TestACPCallbacksFSAndTerminalLifecycle(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	node := "node"
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Server", WorkspaceKind: "host", RuntimeNodeID: &node})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, Config: json.RawMessage(`{"cloud":{"approvals":{"policy":"allow_all"}}}`)})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{Kind: "acp"})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	calls := []string{}
	content := "one\ntwo\nthree"
	reads := 0
	replies := make(chan map[string]any, 20)
	h := builtinToolHarness(t, d, "rnr_acp-callbacks", func(method string, params map[string]any) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, method)
		switch method {
		case "sys.info":
			return map[string]any{"storageRoot": "/srv/zakura", "version": "test", "kind": "computer", "capabilities": map[string]any{"host": true}}, nil
		case "host.fs.read", "host.fs.write", "host.exec.start":
			if params["spaceId"] != space.ID || params["root"] != nil {
				return nil, fmt.Errorf("callback escaped Space server: %#v", params)
			}
			if method == "host.fs.read" {
				return map[string]any{"content": content}, nil
			}
			if method == "host.fs.write" {
				raw, _ := base64.StdEncoding.DecodeString(params["base64"].(string))
				content = string(raw)
				return map[string]any{}, nil
			}
			return map[string]any{"id": "job-1"}, nil
		case "host.exec.get":
			reads++
			if reads == 1 {
				return map[string]any{"stdout": "abcdef", "exitCode": nil}, nil
			}
			return map[string]any{"stdout": "abcdef", "exitCode": 7}, nil
		case "host.exec.kill":
			return map[string]any{}, nil
		case "host.pty.write":
			raw, _ := base64.StdEncoding.DecodeString(params["base64"].(string))
			var response map[string]any
			_ = json.Unmarshal(raw, &response)
			replies <- response
			return map[string]any{}, nil
		default:
			return nil, fmt.Errorf("unexpected %s", method)
		}
	})
	runner, _ := h.hub.get("node")
	rt := &acpLiveRuntime{manager: &acpRuntimeManager{h: h}, runner: runner, tenantID: "tenant", agentID: agent.ID, spaceID: space.ID, sid: session.ID, acpSessionID: "acp-1", workingDir: "/workspace", processID: "adapter", writeMethod: "host.pty.write", done: make(chan struct{}), terminals: map[string]*acpTerminal{}, inbound: map[string]acpInbound{}, pending: map[string]chan acpRPCReply{}}
	t.Cleanup(func() { close(rt.done) })
	callback := func(id int, method string, params map[string]any) map[string]any {
		t.Helper()
		params["sessionId"] = "acp-1"
		rt.handleCallback(method, json.RawMessage(fmt.Sprint(id)), params)
		select {
		case response := <-replies:
			if response["error"] != nil {
				t.Fatalf("%s: %#v", method, response)
			}
			return response["result"].(map[string]any)
		case <-time.After(time.Second):
			t.Fatal("callback reply blocked")
			return nil
		}
	}
	result := callback(1, "fs/read_text_file", map[string]any{"path": "/workspace/a.txt", "line": 2.0, "limit": 1.0})
	if result["content"] != "two" {
		t.Fatalf("line window %#v", result)
	}
	callback(2, "fs/write_text_file", map[string]any{"path": "/workspace/a.txt", "content": "updated"})
	if got := callback(3, "fs/read_text_file", map[string]any{"path": "/workspace/a.txt"}); got["content"] != "updated" {
		t.Fatal(got)
	}
	rt.handleCallback("fs/read_text_file", json.RawMessage("4"), map[string]any{"sessionId": "acp-1", "path": "/workspace/../secret"})
	if reply := <-replies; reply["error"] == nil {
		t.Fatal("traversal accepted")
	}
	created := callback(5, "terminal/create", map[string]any{"command": "printf", "args": []any{"hello"}, "outputByteLimit": 3.0})
	id := created["terminalId"].(string)
	output := callback(6, "terminal/output", map[string]any{"terminalId": id})
	if output["output"] != "def" || output["truncated"] != true {
		t.Fatal(output)
	}
	status := callback(7, "terminal/wait_for_exit", map[string]any{"terminalId": id})
	if status["exitCode"] != float64(7) {
		t.Fatal(status)
	}
	callback(8, "terminal/kill", map[string]any{"terminalId": id})
	callback(9, "terminal/release", map[string]any{"terminalId": id})
	if _, err := rt.terminalCallback(context.Background(), "terminal/output", map[string]any{"terminalId": id}); err == nil {
		t.Fatal("released terminal readable")
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Contains(strings.Join(calls, ","), "docker") {
		t.Fatal("selected computer used", calls)
	}
}

func TestACPDecisionsValidateTypeOptionsAndFrontendElicitation(t *testing.T) {
	replies := make(chan map[string]any, 8)
	fake := &fakeACPAdapter{onRPC: func(_ string, rpc map[string]any, _ func(any)) bool {
		if rpc["method"] == nil {
			replies <- rpc
			return true
		}
		return false
	}}
	manager, agent, session := acpAuthHarness(t, fake)
	rt, err := manager.ensure(context.Background(), "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		rt.queueDecision(ctx, "session/request_permission", json.RawMessage(`42`), map[string]any{"sessionId": "acp-session-1", "options": []any{map[string]any{"optionId": "once", "kind": "allow_once"}}})
	}()
	var approvalID string
	deadline := time.Now().Add(time.Second)
	for approvalID == "" && time.Now().Before(deadline) {
		_ = manager.h.deps.Gorm.Table("agent_tool_approvals").Select("id").Where("session_id=? AND status='pending'", session.ID).Scan(&approvalID).Error
		if approvalID == "" {
			time.Sleep(time.Millisecond * 5)
		}
	}
	if approvalID == "" {
		t.Fatal("unified approval not persisted")
	}
	for _, test := range []struct {
		body       map[string]any
		permission bool
	}{{map[string]any{}, true}, {map[string]any{"requestId": "42", "optionId": "invented"}, true}, {map[string]any{"requestId": "42", "action": "accept"}, false}} {
		if err := rt.resolveDecision(test.body, test.permission); err == nil {
			t.Fatal("invalid decision accepted")
		}
	}
	if err := rt.resolveDecision(map[string]any{"requestId": "42", "optionId": "once"}, true); err == nil {
		t.Fatal("legacy permission route bypassed unified gate")
	}
	if err := manager.h.store.settleApproval(ctx, "tenant", agent.ID, session.ID, approvalID, "approved", "user", false); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("permission did not settle")
	}
	response := <-replies
	if response["id"] != float64(42) {
		t.Fatalf("numeric protocol id changed: %#v", response)
	}
	if err := rt.resolveDecision(map[string]any{"requestId": "42", "optionId": "once"}, true); err == nil {
		t.Fatal("replay accepted")
	}
	rt.queueDecision(context.Background(), "elicitation/create", json.RawMessage(`"form"`), map[string]any{"sessionId": "acp-session-1"})
	if err := rt.resolveDecision(map[string]any{"requestId": "form", "cancelled": false, "content": map[string]any{"name": "Zakura"}}, false); err != nil {
		t.Fatal(err)
	}
	response = <-replies
	result := response["result"].(map[string]any)
	if result["action"] != "accept" || result["content"].(map[string]any)["name"] != "Zakura" {
		t.Fatal(response)
	}
}

func TestACPPermissionGrantPathBoundary(t *testing.T) {
	manager, agent, _ := acpAuthHarness(t, &fakeACPAdapter{})
	h := manager.h
	if err := h.saveSpaceACP(context.Background(), "tenant", agent.SpaceID, map[string]any{"permissionGrants": []any{map[string]any{"kind": "edit", "pathPrefix": "/workspace/project"}}}); err != nil {
		t.Fatal(err)
	}
	rt := &acpLiveRuntime{manager: manager, tenantID: "tenant", agentID: agent.ID, spaceID: agent.SpaceID}
	for _, test := range []struct {
		path string
		want bool
	}{{"/workspace/project/a", true}, {"/workspace/project2/a", false}, {"/workspace/project/../secret", false}} {
		allowed, err := rt.permissionAllowed(context.Background(), map[string]any{"toolCall": map[string]any{"kind": "edit", "locations": []any{map[string]any{"path": test.path}}}})
		if err != nil || allowed != test.want {
			t.Errorf("%s = %v %v", test.path, allowed, err)
		}
	}
}

func TestACPCallbackDoesNotBlockResponseParsing(t *testing.T) {
	reply := make(chan acpRPCReply, 1)
	manager, agent, session := acpAuthHarness(t, &fakeACPAdapter{})
	rt, err := manager.ensure(context.Background(), "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	rt.pending["99"] = reply
	rt.terminals["wait"] = &acpTerminal{done: make(chan struct{})}
	rt.mu.Unlock()
	rt.handleLine([]byte(`{"jsonrpc":"2.0","id":"callback","method":"terminal/wait_for_exit","params":{"sessionId":"acp-session-1","terminalId":"wait"}}`))
	rt.handleLine([]byte(`{"jsonrpc":"2.0","id":"99","result":{"ok":true}}`))
	select {
	case <-reply:
	case <-time.After(time.Second):
		t.Fatal("callback blocked protocol response parser")
	}
}
