// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCodemodeConcurrentCallsKeepStructuredResults(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	var active, peak, finished atomic.Int32
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcEnvelope
		_ = json.NewDecoder(r.Body).Decode(&req)
		var result any = map[string]any{}
		if req.Method == "tools/list" {
			result = map[string]any{"tools": []map[string]any{{"name": "echo", "inputSchema": map[string]any{"type": "object"}}}}
		}
		if req.Method == "tools/call" {
			n := active.Add(1)
			if n == codemodeWorkers {
				peak.Store(n)
				close(release)
			}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			defer active.Add(-1)
			finished.Add(1)
			result = map[string]any{"structuredContent": map[string]any{"value": strings.Repeat("x", 80000)}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}))
	defer upstream.Close()
	insertAgentMCPInstance(t, d, "parallel", "parallel", "Parallel", upstream.URL, agent.ID, nil)
	var received atomic.Int32
	var input []byte
	h := codemodeToolHarness(t, d, "rnr_concurrent", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
		switch method {
		case "sys.info":
			return codemodeInfo(), nil
		case "host.fs.write", "docker.exec.close":
			return map[string]any{"ok": true}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "status": "running", "labels": map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.exec.start":
			return map[string]any{"id": "parallel-process"}, nil
		case "docker.exec.write":
			chunk, _ := base64.StdEncoding.DecodeString(fmt.Sprint(params["base64"]))
			if len(chunk) > 32<<10 {
				return fmt.Errorf("runner frame too large"), nil
			}
			input = append(input, chunk...)
			if !bytes.Contains(input, []byte{'\n'}) {
				return map[string]any{"ok": true}, nil
			}
			data := input
			input = nil
			var message map[string]any
			if json.Unmarshal(data, &message) != nil {
				return fmt.Errorf("invalid protocol message"), nil
			}
			if message["op"] == "run" {
				return map[string]any{"ok": true}, func() {
					for i := 1; i <= codemodeWorkers; i++ {
						emit("parallel-process", "stdout", map[string]any{"op": "call", "id": i, "name": "mcp__parallel__echo", "args": map[string]any{}})
					}
				}
			}
			if message["op"] == "result" {
				if message["ok"] != true || !strings.Contains(string(data), "structuredContent") || strings.Contains(string(data), "fullOutputPath") {
					return fmt.Errorf("lost structured result: %.200s", data), nil
				}
				if received.Add(1) == codemodeWorkers {
					return map[string]any{"ok": true}, func() {
						emit("parallel-process", "stdout", map[string]any{"op": "done", "ok": true, "output": []string{"done"}})
					}
				}
			}
			return map[string]any{"ok": true}, nil
		}
		return nil, nil
	})
	session, _ := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	run, _ := store.StartRun(context.Background(), "tenant", agent.ID, session.ID, "test", nil, nil)
	ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), computerRunKey{}, run.ID), 5*time.Second)
	defer cancel()
	_, err := h.runCodemodeTool(ctx, "tenant", agent.ID, session.ID, "outer", json.RawMessage(`{"code":"fixture"}`))
	if err != nil {
		t.Fatal(err)
	}
	if peak.Load() != codemodeWorkers || finished.Load() != codemodeWorkers || received.Load() != codemodeWorkers {
		t.Fatalf("peak=%d finished=%d received=%d", peak.Load(), finished.Load(), received.Load())
	}
	events, err := store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	results := 0
	for _, event := range events {
		if event.Type == "tool_call_result" {
			results++
		}
	}
	if results != codemodeWorkers {
		t.Fatalf("lost nested audit results: %d", results)
	}
}
