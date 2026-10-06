// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGatewayFailoverAndStreamingCommitBarrier(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	var badCalls atomic.Int32
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		badCalls.Add(1)
		w.WriteHeader(500)
		_, _ = io.WriteString(w, "failed")
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer good.Close()
	u1, _ := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "bad", Protocol: "openai", Config: raw(map[string]any{"baseUrl": bad.URL})})
	u2, _ := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "good", Protocol: "openai", Config: raw(map[string]any{"baseUrl": good.URL})})
	_, _ = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "primary", Capability: "chat", UpstreamID: u1.ID, Model: "m", Priority: 100, Weight: 100, IsDefault: true})
	_, _ = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "fallback", Capability: "chat", UpstreamID: u2.ID, Model: "m", Priority: 200, Weight: 100, IsDefault: true})
	resp, e := NewGateway(store).Do(context.Background(), "tenant", "chat", "chat", "", []byte(`{"messages":[{"role":"user","content":"hi"}]}`))
	if e != nil {
		t.Fatal(e)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), `"ok"`) || badCalls.Load() != 3 {
		t.Fatalf("failover response=%s badCalls=%d", body, badCalls.Load())
	}
	_, _ = d.DB.Exec(`DELETE FROM model_routes`)
	_, _ = d.DB.Exec(`DELETE FROM model_upstreams`)
	partial := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: incomplete\n")
	}))
	defer partial.Close()
	streamOK := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"ok\":true}\n\n")
	}))
	defer streamOK.Close()
	u1, _ = store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "partial", Protocol: "openai", Config: raw(map[string]any{"baseUrl": partial.URL})})
	u2, _ = store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "stream", Protocol: "openai", Config: raw(map[string]any{"baseUrl": streamOK.URL})})
	_, _ = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "primary", Capability: "chat", UpstreamID: u1.ID, Model: "m", Priority: 100, Weight: 100, IsDefault: true})
	_, _ = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "fallback", Capability: "chat", UpstreamID: u2.ID, Model: "m", Priority: 200, Weight: 100, IsDefault: true})
	resp, e = NewGateway(store).Do(context.Background(), "tenant", "chat", "chat", "", []byte(`{"stream":true,"messages":[]}`))
	if e != nil {
		t.Fatal(e)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "data: {\"ok\":true}\n\n" {
		t.Fatalf("stream barrier returned %q", body)
	}
}

func TestCloudRunToolContinuation(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	var modelCalls atomic.Int32
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if modelCalls.Add(1) == 1 {
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"tc1","type":"function","function":{"name":"mcp1:echo","arguments":"{\"value\":\"hello\"}"}}]},"finish_reason":"tool_calls"}]}`)
		} else {
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}`)
		}
	}))
	defer model.Close()
	mcp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": "echoed"}}}})
	}))
	defer mcp.Close()
	up, _ := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "model", Protocol: "openai", Config: raw(map[string]any{"baseUrl": model.URL})})
	_, _ = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "default", Capability: "chat", UpstreamID: up.ID, Model: "m", Priority: 100, Weight: 100, IsDefault: true})
	now := d.Clock()
	_, e := d.DB.Exec(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,created_at,updated_at) VALUES('mcp1','tenant',?,'mcp','echo','Echo',?,'{}','ready',?,?)`, agent.ID, string(raw(map[string]any{"url": mcp.URL})), now, now)
	if e != nil {
		t.Fatal(e)
	}
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	h.service.toolRunner = func(ctx context.Context, tenant, agent, session, toolCallID, name string, args json.RawMessage) (json.RawMessage, error) {
		parts := strings.SplitN(name, ":", 2)
		inst, e := h.getMCPInstance(ctx, tenant, parts[0])
		if e != nil {
			return nil, e
		}
		return h.mcpRPC(ctx, inst, "tools/call", map[string]any{"name": parts[1], "arguments": args})
	}
	session, _ := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	run, _, e := h.service.StartTurn(context.Background(), "tenant", agent.ID, session.ID, "use tool", nil, nil, false)
	if e != nil {
		t.Fatal(e)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current, e := store.GetRun(context.Background(), "tenant", agent.ID, session.ID, run.ID)
		if e == nil && current.Status == "completed" {
			events, _ := store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
			types := map[string]bool{}
			for _, ev := range events {
				types[ev.Type] = true
			}
			if !types["tool_call_start"] || !types["tool_call_result"] || modelCalls.Load() != 2 {
				t.Fatalf("tool continuation events=%v calls=%d", types, modelCalls.Load())
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("tool run did not complete")
}
