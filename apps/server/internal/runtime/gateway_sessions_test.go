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
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

func gatewayTestHandler(t *testing.T) (*handler, httpx.Principal) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Gateway", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	return &handler{deps: d, store: store, service: NewService(store)}, httpx.Principal{TenantID: "tenant", SpaceID: space.ID, APIKey: true, APIKeyID: "key-tenant", APIKeyScopes: `["gateway"]`}
}
func waitGatewayCapture(t *testing.T, c *gatewayCapture) {
	t.Helper()
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		t.Fatal("recording did not finish")
	}
}
func recordGatewayTest(t *testing.T, h *handler, p httpx.Principal, header http.Header, operation string, input map[string]any, response string) {
	t.Helper()
	w := httptest.NewRecorder()
	c := h.captureGateway(w, p, header, operation, input)
	if c == nil {
		t.Fatal("no capture")
	}
	_, err := io.WriteString(c, response)
	c.finish(err)
	waitGatewayCapture(t, c)
	if w.Body.String() != response {
		t.Fatal("forwarded response changed")
	}
}
func TestGatewayClientSessionAndCompaction(t *testing.T) {
	h, p := gatewayTestHandler(t)
	header := http.Header{"Session_id": []string{"codex-thread"}, "User-Agent": []string{"codex_cli_rs/1"}}
	body := map[string]any{"model": "model", "instructions": "developer rules", "input": []any{map[string]any{"role": "user", "content": "<environment_context>cwd: /repo</environment_context>\nFix the tests"}}}
	response := `{"id":"resp-1","object":"response","model":"m","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I fixed the tests"}]}]}`
	recordGatewayTest(t, h, p, header, "responses", body, response)
	sessions, err := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("sessions=%+v err=%v", sessions, err)
	}
	session := sessions[0]
	if session.Title != "Fix the tests" {
		t.Fatal(session)
	}
	var origin map[string]any
	_ = json.Unmarshal(session.Origin, &origin)
	if origin["harness"] != "codex" || origin["clientSessionKey"] != "codex-thread" {
		t.Fatal(origin)
	}
	body["input"] = []any{map[string]any{"role": "user", "content": "This session is being continued from a previous conversation. Tests were fixed."}, map[string]any{"role": "user", "content": "Now add coverage"}}
	recordGatewayTest(t, h, p, header, "responses", body, strings.ReplaceAll(response, "resp-1", "resp-2"))
	sessions, _ = h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
	if len(sessions) != 1 {
		t.Fatal(sessions)
	}
	events, err := h.store.gatewayEvents(context.Background(), p.TenantID, p.SpaceID, session.ID, 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	users, compactions, contexts := 0, 0, 0
	for _, ev := range events {
		switch ev.Type {
		case "user_message":
			users++
		case "context_compacted":
			compactions++
		case "context_sources":
			contexts++
		}
	}
	if users != 2 || compactions != 1 || contexts != 1 {
		t.Fatalf("users=%d compact=%d contexts=%d events=%+v", users, compactions, contexts, events)
	}
	header.Set("session_id", "other-thread")
	recordGatewayTest(t, h, p, header, "responses", body, response)
	sessions, _ = h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
	if len(sessions) != 2 {
		t.Fatal("explicit sessions merged", sessions)
	}
	var agents int64
	h.deps.Gorm.Table("agents").Count(&agents)
	if agents != 0 {
		t.Fatal("created a hidden agent")
	}
}
func TestGatewayContextMatchingIsolationAndRestart(t *testing.T) {
	h, p := gatewayTestHandler(t)
	user := map[string]any{"role": "user", "content": "Please investigate this particular failing unit test"}
	assistant := map[string]any{"role": "assistant", "content": "The test failure comes from the timezone conversion"}
	response := `{"id":"c1","choices":[{"message":{"content":"The test failure comes from the timezone conversion"},"finish_reason":"stop"}]}`
	recordGatewayTest(t, h, p, nil, "chat", map[string]any{"messages": []any{user}}, response)
	// No in-memory matching state survives this replacement.
	h.store = NewStore(h.deps)
	recordGatewayTest(t, h, p, nil, "chat", map[string]any{"messages": []any{user, assistant, map[string]any{"role": "user", "content": "Fix it"}}}, response)
	sessions, _ := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
	if len(sessions) != 1 {
		t.Fatal("continuation split", sessions)
	}
	recordGatewayTest(t, h, p, nil, "chat", map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hello"}}}, response)
	sessions, _ = h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
	if len(sessions) != 2 {
		t.Fatal("unrelated conversation merged")
	}
	p.APIKeyID = "other-key"
	recordGatewayTest(t, h, p, nil, "chat", map[string]any{"messages": []any{user, assistant}}, response)
	sessions, _ = h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
	if len(sessions) != 3 {
		t.Fatal("key scopes merged")
	}
	if _, err := h.store.gatewayEvents(context.Background(), "another-tenant", p.SpaceID, sessions[0].ID, 0, 100); err == nil {
		t.Fatal("tenant isolation lost")
	}
}
func TestGatewayLiveCaptureAndBackpressure(t *testing.T) {
	h, p := gatewayTestHandler(t)
	w := httptest.NewRecorder()
	c := h.captureGateway(w, p, nil, "messages", map[string]any{"stream": true, "messages": []any{map[string]any{"role": "user", "content": "Hello"}}})
	prefix := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"m\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"live answer\"}}\n\n"
	// Exercise arbitrary byte boundaries, including UTF-8 and SSE framing.
	for _, b := range []byte(prefix) {
		if _, err := c.Write([]byte{b}); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.After(3 * time.Second)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	live := false
	for !live {
		select {
		case <-deadline:
			t.Fatal("no live delta before response completion")
		case <-ticker.C:
			var count int64
			h.deps.Gorm.Table("gateway_events").Where("type=?", "assistant_delta").Count(&count)
			live = count > 0
		}
	}
	_, _ = io.WriteString(c, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	c.finish(nil)
	waitGatewayCapture(t, c)
	if !strings.HasPrefix(w.Body.String(), prefix) {
		t.Fatal("stream mutated")
	}
	blocked := &gatewayCapture{ResponseWriter: httptest.NewRecorder(), chunks: make(chan []byte, 1)}
	payload := strings.Repeat("x", gatewayCaptureChunk*4)
	started := time.Now()
	n, err := io.WriteString(blocked, payload)
	if err != nil || n != len(payload) || !blocked.failed.Load() || time.Since(started) > time.Second {
		t.Fatal("capture blocked forwarding")
	}
}
func TestGatewayTranscriptNormalization(t *testing.T) {
	body := map[string]any{}
	_ = json.Unmarshal([]byte(`{"system":"rules","metadata":{"user_id":"user_abc_account_def_session_session-123"},"messages":[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"thinking","thinking":"plan","signature":"opaque"},{"type":"tool_use","id":"call1","name":"Read","input":{"path":"x"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call1","content":[{"type":"text","text":"contents"}]},{"type":"text","text":"continue"}]}]}`), &body)
	identity := gatewayClientIdentity(nil, body, "messages")
	if identity.ClientKey != "session-123" || identity.Harness != "claude-code" {
		t.Fatal(identity)
	}
	got := gatewayInputMessages("messages", body)
	kinds := []string{}
	for _, m := range got {
		kinds = append(kinds, m.Kind)
	}
	if strings.Join(kinds, ",") != "context,user,reasoning,tool,result,user" {
		t.Fatal(got)
	}
	if gatewayMatchScore([]gatewayMessage{{Kind: "user", Text: "hello"}}, got) != 0 {
		t.Fatal("matched greeting")
	}
}
func TestGatewaySessionHistoryPagination(t *testing.T) {
	h, p := gatewayTestHandler(t)
	c, err := h.store.beginGatewayConversation(context.Background(), p, gatewayIdentity{Harness: "chat", ClientKey: "history"}, []gatewayMessage{{Kind: "user", Text: "hello"}}, "m")
	if err != nil {
		t.Fatal(err)
	}
	err = h.deps.Gorm.Transaction(func(tx *gorm.DB) error {
		for i := 0; i < 550; i++ {
			if e := h.store.appendGatewayEvent(tx, c.session, c.run, "assistant_delta", map[string]any{"messageId": "m", "delta": "x"}); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/api/spaces/{id}/gateway/sessions/{sid}", h.gatewaySessionRoute(h.getSession))
	get := func(query string) map[string]any {
		r := httptest.NewRequest("GET", "/api/spaces/"+p.SpaceID+"/gateway/sessions/"+c.session+query, nil)
		r = r.WithContext(httpx.WithPrincipal(r.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		var body map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		return body
	}
	page := get("?afterSeq=0")
	if page["hasMore"] != true || len(gwSlice(page["events"])) != 500 {
		t.Fatal(page)
	}
	first := gwInt(gwMap(gwSlice(page["events"])[0])["seq"])
	earlier := get("?beforeSeq=" + fmt.Sprint(first))
	if earlier["hasMore"] != false || len(gwSlice(earlier["events"])) != first-1 {
		t.Fatal(earlier)
	}
}

func TestGatewayRepeatedMessagesAndCompactionAnchors(t *testing.T) {
	stored := []gatewayMessage{{Kind: "user", Text: "yes"}, {Kind: "assistant", Text: "The first operation has finished successfully"}, {Kind: "user", Text: "next"}, {Kind: "assistant", Text: "The second operation has finished successfully"}}
	incoming := []gatewayMessage{{Kind: "compaction", Text: "Summary of earlier tasks"}, stored[3], {Kind: "user", Text: "yes"}}
	fresh := gatewayNewMessages(incoming, stored)
	if len(fresh) != 2 || fresh[1].Text != "yes" {
		t.Fatal("lost repeated user turn", fresh)
	}
	if gatewayMatchScore([]gatewayMessage{{Kind: "result", ID: "unique-call", Text: "ok"}}, []gatewayMessage{{Kind: "tool", ID: "unique-call", Name: "Read"}}) == 0 {
		t.Fatal("tool continuation not matched")
	}
	if gatewayMatchScore([]gatewayMessage{{Kind: "compaction", Text: stored[1].Text}, stored[3]}, stored) == 0 {
		t.Fatal("compacted history not matched")
	}
	if gatewayMatchScore([]gatewayMessage{{Kind: "compaction", Text: stored[1].Text + "\n" + stored[3].Text}}, stored) == 0 {
		t.Fatal("summary-only continuation with two exact anchors not matched")
	}
	if gatewayMatchScore([]gatewayMessage{{Kind: "tool", Name: "Read", Arguments: "{}"}}, []gatewayMessage{{Kind: "tool", Name: "Read", Arguments: "{}"}}) != 0 {
		t.Fatal("generic tool without call ID matched")
	}
	greeting := []gatewayMessage{{Kind: "user", Text: "hello"}, {Kind: "assistant", Text: "Hi!"}}
	if gatewayMatchScore(greeting, greeting) != 0 {
		t.Fatal("generic greeting exchange matched")
	}
	if fresh := gatewayNewMessages([]gatewayMessage{{Kind: "user", Text: "yes"}}, stored); len(fresh) != 1 {
		t.Fatal("lost incremental repeated user turn", fresh)
	}
}

func TestGatewayCaptureOrderingAndIndependentStreams(t *testing.T) {
	h, p := gatewayTestHandler(t)
	user := map[string]any{"role": "user", "content": "Investigate the failing timezone conversion test"}
	answer := "The timezone conversion needs to retain the UTC offset"
	first := h.captureGateway(httptest.NewRecorder(), p, nil, "chat", map[string]any{"messages": []any{user}})
	second := h.captureGateway(httptest.NewRecorder(), p, nil, "chat", map[string]any{"messages": []any{user, map[string]any{"role": "assistant", "content": answer}, map[string]any{"role": "user", "content": "Fix it"}}})
	_, _ = io.WriteString(second, `{"id":"second","choices":[{"message":{"content":"Fixed"},"finish_reason":"stop"}]}`)
	second.finish(nil)
	// An unrelated anonymous stream must not wait for the first request.
	independent := h.captureGateway(httptest.NewRecorder(), p, nil, "chat", map[string]any{"messages": []any{map[string]any{"role": "user", "content": "Unrelated question"}}})
	_, _ = io.WriteString(independent, `{"id":"other","choices":[{"message":{"content":"Separate"},"finish_reason":"stop"}]}`)
	independent.finish(nil)
	waitGatewayCapture(t, independent)
	_, _ = io.WriteString(first, string(rawJSON(map[string]any{"id": "first", "choices": []any{map[string]any{"message": map[string]any{"content": answer}, "finish_reason": "stop"}}})))
	first.finish(nil)
	waitGatewayCapture(t, first)
	waitGatewayCapture(t, second)
	sessions, err := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
	if err != nil || len(sessions) != 2 {
		t.Fatalf("sessions=%+v err=%v", sessions, err)
	}
	for _, session := range sessions {
		if session.Title != user["content"] {
			continue
		}
		messages, err := gatewayStoredMessages(h.deps.Gorm, session.ID)
		if err != nil || len(messages) != 4 {
			t.Fatalf("replayed history duplicated: %+v %v", messages, err)
		}
	}
}

func TestGatewayCompactionOutputCapture(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmt.Sprint(streaming), func(t *testing.T) {
			h, p := gatewayTestHandler(t)
			body := map[string]any{"stream": streaming, "messages": []any{map[string]any{"role": "user", "content": "Continue work"}}}
			response := `{"type":"message","id":"compact","content":[{"type":"compaction","content":"Previous work summarized"}],"stop_reason":"end_turn"}`
			if streaming {
				response = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"compact\"}}\n\n" +
					"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"compaction\",\"content\":\"Previous \"}}\n\n" +
					"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"compaction_delta\",\"content\":\"work summarized\"}}\n\n" +
					"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
			}
			recordGatewayTest(t, h, p, nil, "messages", body, response)
			sessions, _ := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
			messages, err := gatewayStoredMessages(h.deps.Gorm, sessions[0].ID)
			if err != nil || len(messages) != 2 || messages[1].Kind != "compaction" || messages[1].Text != "Previous work summarized" {
				t.Fatalf("messages=%+v err=%v", messages, err)
			}
		})
	}
}

func TestGatewaySearchAndDelete(t *testing.T) {
	h, p := gatewayTestHandler(t)
	recordGatewayTest(t, h, p, nil, "chat", map[string]any{"messages": []any{map[string]any{"role": "user", "content": "Question"}}}, `{"id":"search","choices":[{"message":{"content":"unique gateway answer"},"finish_reason":"stop"}]}`)
	ctx := context.Background()
	found, err := h.store.SearchSessions(ctx, p.TenantID, "unique gateway answer", 30)
	if err != nil || len(found) != 1 || found[0].AgentID != gatewayOwner(p.SpaceID) {
		t.Fatalf("found=%+v err=%v", found, err)
	}
	other, err := h.store.SearchSessions(ctx, "other-tenant", "unique gateway answer", 30)
	if err != nil || len(other) != 0 {
		t.Fatalf("tenant search isolation: %+v %v", other, err)
	}
	if err := h.store.DeleteSession(ctx, p.TenantID, gatewayOwner(p.SpaceID), found[0].ID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"gateway_sessions", "gateway_messages", "gateway_events", "gateway_response_links"} {
		var count int64
		if err := h.deps.Gorm.Table(table).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("%s count=%d err=%v", table, count, err)
		}
	}
}

func TestGatewayResponsesTerminalTools(t *testing.T) {
	d := &gwStreamDecoder{}
	_, err := d.consumeResponses(gwSSEEvent{Data: `{"type":"response.completed","response":{"id":"response","object":"response","output":[{"type":"function_call","call_id":"empty","name":"status","arguments":"{}"}],"status":"completed"}}`})
	if err != nil || len(d.final().ToolCalls) != 1 || d.final().ToolCalls[0].Arguments != "{}" {
		t.Fatalf("result=%+v err=%v", d.final(), err)
	}
}

func TestGatewayConcurrentPersistencePositions(t *testing.T) {
	h, p := gatewayTestHandler(t)
	ctx := context.Background()
	identity := gatewayIdentity{Harness: "codex", ClientKey: "one"}
	first, err := h.store.beginGatewayConversation(ctx, p, identity, []gatewayMessage{{Kind: "user", Text: "first"}}, "m")
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.store.beginGatewayConversation(ctx, p, identity, []gatewayMessage{{Kind: "user", Text: "second"}}, "m")
	if err != nil {
		t.Fatal(err)
	}
	if first.session != second.session {
		t.Fatal("session split")
	}
	err = h.deps.Gorm.Transaction(func(tx *gorm.DB) error {
		return h.store.storeGatewayMessage(tx, first, gatewayMessage{Kind: "assistant", Text: "response"})
	})
	if err != nil {
		t.Fatal(err)
	}
}
