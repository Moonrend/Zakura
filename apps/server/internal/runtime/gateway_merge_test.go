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
)

func TestGatewayHTTPImmediateFollowUpsMerge(t *testing.T) {
	h, p := gatewayTestHandler(t)
	if err := h.deps.Gorm.Exec("UPDATE api_keys SET space_id=?,scopes=? WHERE id=?", p.SpaceID, `["gateway","api"]`, p.APIKeyID).Error; err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"chat\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"好的！\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	up, err := h.store.CreateUpstream(context.Background(), p.TenantID, Upstream{Name: "merge", Protocol: "openai", Config: rawJSON(map[string]any{"baseUrl": upstream.URL})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.CreateRoute(context.Background(), p.TenantID, ModelRoute{Name: "merge", Model: "merge", Capability: "chat", UpstreamID: up.ID, IsDefault: true}); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(httpx.Auth(h.deps))
	router.Post("/v1/chat/completions", h.gateway("chat", "chat"))
	router.Get("/api/spaces/{id}/gateway/sessions", h.gatewaySessionRoute(h.listSessions))
	router.Get("/api/spaces/{id}/gateway/sessions/{sid}", h.gatewaySessionRoute(h.getSession))
	server := httptest.NewServer(router)
	defer server.Close()
	history := []any{}
	for i := 0; i < 4; i++ {
		history = append(history, map[string]any{"role": "user", "content": fmt.Sprint("继续", i)})
		body := rawJSON(map[string]any{"model": "merge", "stream": true, "messages": history})
		req, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/chat/completions", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer zk_tenant")
		if i%2 == 1 {
			req.Header.Set("X-Session-Id", "http-session")
		}
		resp, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		payload, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK || !strings.Contains(string(payload), "[DONE]") {
			t.Fatalf("turn %d: %d %s (%v)", i, resp.StatusCode, payload, err)
		}
		// Follow up as soon as the client response completes; never wait for DB.
		history = append(history, map[string]any{"role": "assistant", "content": "好的！"})
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var count int64
		if err := h.deps.Gorm.Table("gateway_events").Where("type=?", "run_end").Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count == 4 {
			break
		}
		select {
		case <-deadline.C:
			t.Fatalf("recording did not finish: %d runs", count)
		case <-ticker.C:
		}
	}
	status, list := doJSON(t, server.Client(), "GET", server.URL+"/api/spaces/"+p.SpaceID+"/gateway/sessions", "zk_tenant", nil)
	sessions := gwSlice(list["sessions"])
	if status != http.StatusOK || len(sessions) != 1 {
		t.Fatalf("chat list: %d %+v", status, list)
	}
	id := gwStr(gwMap(sessions[0])["id"])
	status, detail := doJSON(t, server.Client(), "GET", server.URL+"/api/spaces/"+p.SpaceID+"/gateway/sessions/"+id, "zk_tenant", nil)
	users, answers := 0, 0
	for _, item := range gwSlice(detail["events"]) {
		switch gwStr(gwMap(item)["type"]) {
		case "user_message":
			users++
		case "assistant_message":
			answers++
		}
	}
	if status != http.StatusOK || users != 4 || answers != 4 {
		data, _ := json.Marshal(detail)
		t.Fatalf("chat history: %d users=%d answers=%d %s", status, users, answers, data)
	}
}

func TestGatewayShortFollowUpsStayInOneSession(t *testing.T) {
	for _, operation := range []string{"chat", "messages", "responses"} {
		t.Run(operation, func(t *testing.T) {
			h, p := gatewayTestHandler(t)
			history := []any{}
			questions := []string{"你好", "你能做什么？", "举个例子"}
			answers := []string{"你好！", "我可以帮你写代码。", "例如修复测试。"}
			var sessionID string
			for i, question := range questions {
				history = append(history, map[string]any{"role": "user", "content": question})
				body := map[string]any{"messages": history}
				response := map[string]any{"id": fmt.Sprint("reply-", i), "choices": []any{map[string]any{"message": map[string]any{"content": answers[i]}, "finish_reason": "stop"}}}
				if operation == "messages" {
					response = map[string]any{"id": fmt.Sprint("reply-", i), "type": "message", "content": []any{map[string]any{"type": "text", "text": answers[i]}}, "stop_reason": "end_turn"}
				} else if operation == "responses" {
					body = map[string]any{"input": history}
					response = map[string]any{"id": fmt.Sprint("reply-", i), "object": "response", "status": "completed", "output": []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": answers[i]}}}}}
				}
				recordGatewayTest(t, h, p, nil, operation, body, string(rawJSON(response)))
				sessions, err := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
				if err != nil || len(sessions) != 1 {
					t.Fatalf("turn %d: expected one session, got %d (%v)", i+1, len(sessions), err)
				}
				if i == 0 {
					sessionID = sessions[0].ID
				}
				if sessions[0].ID != sessionID {
					t.Fatal("continuation changed session ID")
				}
				history = append(history, map[string]any{"role": "assistant", "content": answers[i]})
			}
			messages, err := gatewayStoredMessages(h.deps.Gorm, sessionID)
			if err != nil || len(messages) != 6 {
				t.Fatalf("history duplicated: %+v (%v)", messages, err)
			}
		})
	}
}

func TestGatewayFastFollowUpWithIntermittentSessionID(t *testing.T) {
	for _, firstHasID := range []bool{false, true} {
		t.Run(fmt.Sprint(firstHasID), func(t *testing.T) {
			h, p := gatewayTestHandler(t)
			user := map[string]any{"role": "user", "content": "你好"}
			assistant := map[string]any{"role": "assistant", "content": "你好！"}
			header := http.Header{}
			header.Set("X-Session-Id", "fast-session")
			firstHeaders, secondHeaders := http.Header(nil), header
			if firstHasID {
				firstHeaders, secondHeaders = secondHeaders, firstHeaders
			}
			first := h.captureGateway(httptest.NewRecorder(), p, firstHeaders, "chat", map[string]any{"messages": []any{user}})
			finished := false
			defer func() {
				if !finished {
					first.finish(nil)
				}
				waitGatewayCapture(t, first)
			}()
			// Bytes are already delivered, but final persistence has not happened.
			_, _ = io.WriteString(first, `{"id":"first","choices":[{"message":{"content":"你好！"},"finish_reason":"stop"}]}`)
			second := h.captureGateway(httptest.NewRecorder(), p, secondHeaders, "chat", map[string]any{"messages": []any{user, assistant, map[string]any{"role": "user", "content": "继续"}}})
			_, _ = io.WriteString(second, `{"id":"second","choices":[{"message":{"content":"好的"},"finish_reason":"stop"}]}`)
			second.finish(nil)
			select {
			case <-second.done:
				t.Fatal("follow-up recording overtook pending history")
			case <-time.After(200 * time.Millisecond):
			}
			first.finish(nil)
			finished = true
			waitGatewayCapture(t, second)
			sessions, err := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
			if err != nil || len(sessions) != 1 {
				t.Fatalf("fast continuation split: %d sessions (%v)", len(sessions), err)
			}
			messages, err := gatewayStoredMessages(h.deps.Gorm, sessions[0].ID)
			if err != nil || len(messages) != 4 {
				t.Fatalf("fast continuation duplicated history: %+v (%v)", messages, err)
			}
		})
	}
}

func TestGatewayShortConversationIsolation(t *testing.T) {
	h, p := gatewayTestHandler(t)
	user := map[string]any{"role": "user", "content": "你好"}
	assistant := map[string]any{"role": "assistant", "content": "你好！"}
	response := `{"id":"reply","choices":[{"message":{"content":"你好！"},"finish_reason":"stop"}]}`
	// Two independent requests with the same greeting are still two chats.
	for i := 0; i < 2; i++ {
		recordGatewayTest(t, h, p, nil, "chat", map[string]any{"messages": []any{user}}, response)
	}
	sessions, err := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
	if err != nil || len(sessions) != 2 {
		t.Fatalf("independent greetings merged: %+v (%v)", sessions, err)
	}
	// The replay fits both histories equally: do not choose whichever is newer.
	recordGatewayTest(t, h, p, nil, "chat", map[string]any{"messages": []any{user, assistant, map[string]any{"role": "user", "content": "继续"}}}, response)
	sessions, err = h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
	if err != nil || len(sessions) != 3 {
		t.Fatalf("ambiguous histories merged: %+v (%v)", sessions, err)
	}
}

func TestGatewayClaudeSessionOverridesTransportSession(t *testing.T) {
	h, p := gatewayTestHandler(t)
	for i := 0; i < 3; i++ {
		headers := http.Header{}
		headers.Set("X-Session-Id", fmt.Sprint("transport-", i))
		body := map[string]any{"metadata": map[string]any{"user_id": `{"session_id":"stable-claude-session"}`}, "messages": []any{map[string]any{"role": "user", "content": fmt.Sprint("turn-", i)}}}
		recordGatewayTest(t, h, p, headers, "messages", body, `{"id":"message","type":"message","content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn"}`)
	}
	sessions, err := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("stable harness ID ignored: %d sessions (%v)", len(sessions), err)
	}
}

func TestGatewayContinuationWithIntermittentSessionID(t *testing.T) {
	for _, firstHasID := range []bool{false, true} {
		t.Run(fmt.Sprint(firstHasID), func(t *testing.T) {
			h, p := gatewayTestHandler(t)
			user := map[string]any{"role": "user", "content": "Investigate the failing timezone conversion test"}
			assistant := map[string]any{"role": "assistant", "content": "The timezone conversion needs to retain the UTC offset"}
			header := http.Header{}
			header.Set("X-Session-Id", "client-session")
			first, second := http.Header(nil), header
			if firstHasID {
				first, second = second, first
			}
			response := `{"id":"reply","choices":[{"message":{"content":"The timezone conversion needs to retain the UTC offset"},"finish_reason":"stop"}]}`
			recordGatewayTest(t, h, p, first, "chat", map[string]any{"messages": []any{user}}, response)
			recordGatewayTest(t, h, p, second, "chat", map[string]any{"messages": []any{user, assistant, map[string]any{"role": "user", "content": "Fix it"}}}, response)
			sessions, err := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
			if err != nil || len(sessions) != 1 {
				t.Fatalf("optional session ID split continuation: %d sessions (%v)", len(sessions), err)
			}
			// Once learned, the client ID must also resolve incremental requests.
			recordGatewayTest(t, h, p, header, "chat", map[string]any{"messages": []any{map[string]any{"role": "user", "content": "One more thing"}}}, response)
			after, err := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 100, 0)
			if err != nil || len(after) != 1 || after[0].ID != sessions[0].ID {
				t.Fatalf("learned client ID did not persist: %+v (%v)", after, err)
			}
		})
	}
}
