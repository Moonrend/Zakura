// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type fakeACPAdapter struct {
	mu        sync.Mutex
	methods   []string
	loads     int
	process   int
	promptID  any
	processID string
	conn      net.Conn
}

func (f *fakeACPAdapter) record(method string) {
	f.mu.Lock()
	f.methods = append(f.methods, method)
	if method == "session/load" {
		f.loads++
	}
	f.mu.Unlock()
}

func (f *fakeACPAdapter) has(method string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, item := range f.methods {
		if item == method {
			return true
		}
	}
	return false
}

func (f *fakeACPAdapter) loadCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.loads
}

func startACPRunner(t *testing.T, serverURL, token string, fake *fakeACPAdapter) {
	t.Helper()
	go func() {
		u, _ := url.Parse(serverURL)
		conn, err := net.Dial("tcp", u.Host)
		if err != nil {
			return
		}
		fake.conn = conn
		defer conn.Close()
		_, _ = fmt.Fprintf(conn, "GET /api/runtime-nodes/hub HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", u.Host, token)
		reader := bufio.NewReader(conn)
		_, _ = reader.ReadString('\n')
		for {
			line, _ := reader.ReadString('\n')
			if line == "\r\n" {
				break
			}
		}
		sendStream := func(process string, message any) {
			raw, _ := json.Marshal(message)
			raw = append(raw, '\n')
			frame, _ := json.Marshal(map[string]any{"type": "stream", "stream": process, "chan": "stdout", "data": base64.StdEncoding.EncodeToString(raw)})
			writeMaskedText(t, conn, string(frame))
		}
		for {
			raw, err := readRunnerServerText(reader)
			if err != nil {
				return
			}
			var frame struct {
				Type   string         `json:"type"`
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.Unmarshal([]byte(raw), &frame) != nil || frame.Type != "req" {
				continue
			}
			var result any = map[string]any{"ok": true}
			var after func()
			switch frame.Method {
			case "sys.info":
				result = map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true}, "hostInfo": map[string]any{}}
			case "host.pty.start":
				fake.mu.Lock()
				fake.process++
				process := fmt.Sprintf("pty-%d", fake.process)
				fake.processID = process
				fake.mu.Unlock()
				result = map[string]any{"id": process, "mode": "pty"}
			case "host.pty.close":
			case "host.pty.write":
				process := fmt.Sprint(frame.Params["id"])
				payload, _ := base64.StdEncoding.DecodeString(fmt.Sprint(frame.Params["base64"]))
				var rpc map[string]any
				_ = json.Unmarshal(payload, &rpc)
				method, _ := rpc["method"].(string)
				if method != "" {
					fake.record(method)
				}
				after = func() {
					id, hasID := rpc["id"]
					switch method {
					case "initialize":
						sendStream(process, map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"agentCapabilities": map[string]any{"loadSession": true, "promptCapabilities": map[string]any{"image": false}}}})
					case "session/new", "session/load":
						sendStream(process, map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"sessionId": "acp-session-1", "modes": map[string]any{"currentModeId": "ask", "availableModes": []any{map[string]any{"id": "ask", "name": "Ask"}, map[string]any{"id": "code", "name": "Code"}}}, "configOptions": []any{map[string]any{"id": "model", "currentValue": "small", "options": []any{map[string]any{"value": "small", "name": "Small"}, map[string]any{"value": "large", "name": "Large"}}}}}})
					case "session/set_mode", "session/set_model", "session/set_config_option":
						sendStream(process, map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{}})
					case "session/prompt":
						fake.mu.Lock()
						fake.promptID = id
						fake.mu.Unlock()
						sendStream(process, map[string]any{"jsonrpc": "2.0", "id": "permission-1", "method": "session/request_permission", "params": map[string]any{"sessionId": "acp-session-1", "toolCall": map[string]any{"toolCallId": "tool-1", "title": "Write file"}, "options": []any{map[string]any{"optionId": "once", "name": "Allow", "kind": "allow_once"}}}})
					default:
						if method == "" && hasID && fmt.Sprint(id) == "permission-1" {
							sendStream(process, map[string]any{"jsonrpc": "2.0", "id": "elicitation-1", "method": "elicitation/create", "params": map[string]any{"sessionId": "acp-session-1", "mode": "form", "message": "Name?", "requestedSchema": map[string]any{"type": "object"}}})
						}
						if method == "" && hasID && fmt.Sprint(id) == "elicitation-1" {
							fake.mu.Lock()
							promptID := fake.promptID
							fake.mu.Unlock()
							sendStream(process, map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "acp-session-1", "update": map[string]any{"sessionUpdate": "current_mode_update", "currentModeId": "review"}}})
							sendStream(process, map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "acp-session-1", "update": map[string]any{"sessionUpdate": "config_option_update", "configOptions": []any{map[string]any{"id": "model", "currentValue": "adapter-large", "options": []any{map[string]any{"value": "adapter-large", "name": "Adapter Large"}}}}}}})
							sendStream(process, map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "acp-session-1", "update": map[string]any{"sessionUpdate": "available_commands_update", "availableCommands": []any{map[string]any{"name": "review", "description": "Review changes"}}}}})
							sendStream(process, map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "acp-session-1", "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "done"}}}})
							sendStream(process, map[string]any{"jsonrpc": "2.0", "id": promptID, "result": map[string]any{"stopReason": "end_turn"}})
						}
					}
				}
			}
			response, _ := json.Marshal(map[string]any{"type": "res", "id": frame.ID, "ok": true, "result": result})
			writeMaskedText(t, conn, string(response))
			if after != nil {
				after()
			}
		}
	}()
}

func TestACPPersistentRuntimeNegotiatesUpdatesDecisionsAndRecovery(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	runnerToken := "rnr_acp-live"
	hash := sha256.Sum256([]byte(runnerToken))
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now)
	if err != nil {
		t.Fatal(err)
	}
	node := "node"
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", EnableComputer: true, RuntimeNodeID: &node, WorkspaceKind: "host"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	fake := &fakeACPAdapter{}
	startACPRunner(t, server.URL, runnerToken, fake)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var status string
		_ = d.DB.QueryRow(`SELECT status FROM runtime_nodes WHERE id='node'`).Scan(&status)
		if status == "online" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	code, out := doJSON(t, server.Client(), http.MethodPut, server.URL+"/api/agents/"+agent.ID+"/acp/agents/codex", token, map[string]any{"command": "codex-acp", "args": []string{"--stdio"}, "displayName": "Codex"})
	if code != 200 {
		t.Fatalf("profile: %d %#v", code, out)
	}
	code, out = doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/agents/"+agent.ID+"/acp/draft", token, map[string]any{"profileId": "codex"})
	if code != http.StatusCreated {
		t.Fatalf("draft: %d %#v", code, out)
	}
	session := out["session"].(map[string]any)
	sid := fmt.Sprint(session["id"])
	for time.Now().Before(deadline) {
		code, out = doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agents/"+agent.ID+"/sessions/"+sid+"/acp-runtime", token, nil)
		if code == 200 && out["state"] == "idle" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if out["state"] != "idle" || out["acpSessionId"] != "acp-session-1" {
		fake.mu.Lock()
		methods := append([]string(nil), fake.methods...)
		fake.mu.Unlock()
		t.Fatalf("runtime did not negotiate: %#v methods=%#v", out, methods)
	}
	fake.mu.Lock()
	processes := fake.process
	fake.mu.Unlock()
	if processes != 1 {
		t.Fatalf("concurrent draft/status booted %d adapter processes", processes)
	}
	modes := out["modes"].(map[string]any)
	if modes["currentId"] != "ask" || len(modes["available"].([]any)) != 2 {
		t.Fatalf("adapter modes missing: %#v", modes)
	}
	code, out = doJSON(t, server.Client(), http.MethodPatch, server.URL+"/api/agents/"+agent.ID+"/sessions/"+sid+"/acp-runtime/mode", token, map[string]any{"modeId": "code"})
	if code != 200 || out["modes"].(map[string]any)["currentId"] != "code" || !fake.has("session/set_mode") {
		t.Fatalf("mode was not forwarded: %d %#v", code, out)
	}
	code, out = doJSON(t, server.Client(), http.MethodPatch, server.URL+"/api/agents/"+agent.ID+"/sessions/"+sid+"/acp-runtime/model", token, map[string]any{"modelId": "large"})
	if code != 200 || out["models"].(map[string]any)["currentId"] != "large" || !fake.has("session/set_model") {
		t.Fatalf("model was not forwarded: %d %#v", code, out)
	}
	code, out = doJSON(t, server.Client(), http.MethodPatch, server.URL+"/api/agents/"+agent.ID+"/sessions/"+sid+"/acp-runtime/config", token, map[string]any{"configId": "reasoning", "value": true})
	if code != 200 || out["config"].(map[string]any)["reasoning"] != true || !fake.has("session/set_config_option") {
		t.Fatalf("config was not forwarded: %d %#v", code, out)
	}
	code, out = doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/agents/"+agent.ID+"/cloud/sessions/"+sid+"/messages", token, map[string]any{"content": "do it"})
	if code != http.StatusAccepted {
		t.Fatalf("prompt: %d %#v", code, out)
	}
	for time.Now().Before(deadline) {
		events, _ := store.ListEvents(context.Background(), "tenant", agent.ID, sid, 0, 100)
		for _, event := range events {
			if event.Type == "permission_request" {
				goto permissionReady
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("adapter permission request was not surfaced")

permissionReady:
	code, out = doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/agents/"+agent.ID+"/sessions/"+sid+"/acp/permission", token, map[string]any{"requestId": "permission-1", "optionId": "once"})
	if code != 200 {
		t.Fatalf("permission resolution: %d %#v", code, out)
	}
	for time.Now().Before(deadline) {
		events, _ := store.ListEvents(context.Background(), "tenant", agent.ID, sid, 0, 100)
		for _, event := range events {
			if event.Type == "elicitation_request" {
				goto elicitationReady
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("adapter elicitation request was not surfaced")

elicitationReady:
	code, out = doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/agents/"+agent.ID+"/sessions/"+sid+"/acp/elicitation", token, map[string]any{"requestId": "elicitation-1", "action": "accept", "content": map[string]any{"name": "Zakura"}})
	if code != 200 {
		t.Fatalf("elicitation resolution: %d %#v", code, out)
	}
	for time.Now().Before(deadline) {
		current, _ := store.GetSession(context.Background(), "tenant", agent.ID, sid)
		if current.ActiveRunID == nil {
			events, _ := store.ListEvents(context.Background(), "tenant", agent.ID, sid, 0, 100)
			for _, event := range events {
				if event.Type == "assistant_message" && strings.Contains(string(event.Payload), "done") {
					goto promptDone
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("ACP prompt did not complete")

promptDone:
	code, out = doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agents/"+agent.ID+"/sessions/"+sid+"/acp-runtime", token, nil)
	if code != 200 || out["modes"].(map[string]any)["currentId"] != "review" || out["models"].(map[string]any)["currentId"] != "adapter-large" || len(out["availableCommands"].([]any)) != 1 {
		t.Fatalf("adapter-originated runtime state was not retained: %d %#v", code, out)
	}
	// Simulate server-side process reclamation.  The persisted ACP session id
	// must be loaded into the next selected-runner process.
	h := router
	_ = h
	// Accessing the registered handler isn't exposed, so closing the runner-side
	// process is represented by clearing the process through a fresh server over
	// the same durable database.  RegisterRoutes reconstructs the manager.
	server.Close()
	router2 := chi.NewRouter()
	RegisterRoutes(router2, d)
	server2 := httptest.NewServer(router2)
	defer server2.Close()
	fake2 := &fakeACPAdapter{}
	startACPRunner(t, server2.URL, runnerToken, fake2)
	for time.Now().Before(deadline.Add(2 * time.Second)) {
		code, out = doJSON(t, server2.Client(), http.MethodGet, server2.URL+"/api/agents/"+agent.ID+"/sessions/"+sid+"/acp-runtime", token, nil)
		if code == 200 && out["state"] == "idle" && fake2.loadCount() > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("ACP session was not recovered with session/load: %d %#v", code, out)
}

func TestACPRuntimeCacheRequiresSessionOwnership(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	ctx := context.Background()
	space, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	owner, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "Owner", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	other, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "Other", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	chat, err := h.store.CreateSession(ctx, "tenant", "", owner.ID, Session{Kind: "acp"})
	if err != nil {
		t.Fatal(err)
	}
	key := "tenant\x00" + chat.ID
	rt := &acpLiveRuntime{done: make(chan struct{})}
	for _, pending := range []bool{false, true} {
		m := &acpRuntimeManager{h: h, runtimes: map[string]*acpLiveRuntime{}, starting: map[string]*acpRuntimeStart{}}
		if pending {
			done := make(chan struct{})
			close(done)
			m.starting[key] = &acpRuntimeStart{done: done, rt: rt}
		} else {
			m.runtimes[key] = rt
		}
		if _, err := m.ensure(ctx, "tenant", other.ID, chat.ID); err == nil {
			t.Fatal("cached ACP session exposed to another agent")
		}
		got, err := m.ensure(ctx, "tenant", owner.ID, chat.ID)
		if err != nil || got != rt {
			t.Fatalf("owner cache access: %v", err)
		}
	}
}
