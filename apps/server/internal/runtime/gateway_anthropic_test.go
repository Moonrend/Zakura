// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestGatewayAnthropicHTTPAuthenticationAndTranslation(t *testing.T) {
	h, p := gatewayTestHandler(t)
	if err := h.deps.Gorm.Exec("UPDATE api_keys SET space_id=?,scopes=? WHERE id=?", p.SpaceID, `["gateway","api"]`, p.APIKeyID).Error; err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Error(r.URL.Path)
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid request")
		}
		if gwStr(body["reasoning_effort"]) != "high" || gwMap(gwMap(body["response_format"])["json_schema"])["schema"] == nil {
			t.Error(body)
		}
		tools := gwSlice(body["tools"])
		if len(tools) != 1 || gwMap(gwMap(tools[0])["function"])["strict"] != true {
			t.Error(tools)
		}
		messages := gwSlice(body["messages"])
		if gwMap(messages[2])["role"] != "system" {
			t.Error(messages)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chat1","model":"native","choices":[{"message":{"content":"hello","tool_calls":[{"id":"call1","function":{"name":"Read","arguments":"{\"path\":\"x\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}`)
	}))
	defer upstream.Close()
	up, err := h.store.CreateUpstream(context.Background(), p.TenantID, Upstream{Name: "native", Protocol: "openai", Config: raw(map[string]any{"baseUrl": upstream.URL})})
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.store.CreateRoute(context.Background(), p.TenantID, ModelRoute{Name: "native", Model: "native", Capability: "chat", UpstreamID: up.ID, IsDefault: true})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(httpx.Auth(h.deps))
	router.Post("/v1/messages", h.gateway("chat", "messages"))
	body := `{"model":"native","system":"instructions","max_tokens":100,"output_config":{"effort":"high","format":{"type":"json_schema","schema":{"type":"object"}}},"tools":[{"name":"Read","strict":true,"input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"hello"},{"role":"system","content":"new instruction"}]}`
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("x-api-key", "zk_tenant")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var result map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if result["type"] != "message" || result["stop_reason"] != "tool_use" || len(gwSlice(result["content"])) != 2 {
		t.Fatal(result)
	}
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			t.Fatal("recording did not finish")
		case <-tick.C:
			var count int64
			h.deps.Gorm.Table("gateway_events").Where("type=?", "run_end").Count(&count)
			if count == 1 {
				return
			}
		}
	}
}

func TestGatewayAnthropicStreamingBlockOrder(t *testing.T) {
	w := httptest.NewRecorder()
	encoder := &gwStreamEncoder{w: w, operation: "messages"}
	if err := encoder.start(gwResult{ID: "stream", Model: "m"}); err != nil {
		t.Fatal(err)
	}
	first := &gwStreamTool{gwToolCall: gwToolCall{ID: "first", Name: "Read", Arguments: `{"path":`}}
	second := &gwStreamTool{gwToolCall: gwToolCall{ID: "second", Name: "Read", Arguments: `{"path":"b"}`}}
	for _, delta := range []gwStreamDelta{
		{reasoning: "Planning"}, {text: "Checking files"},
		{tool: first, arguments: first.Arguments},
		{tool: second, arguments: second.Arguments},
		{tool: first, arguments: `"a"}`},
		{text: "Waiting for results"},
	} {
		if err := encoder.delta(delta); err != nil {
			t.Fatal(err)
		}
	}
	if err := encoder.finish(gwResult{Finish: "tool_calls", ToolCalls: []gwToolCall{first.gwToolCall, second.gwToolCall}}); err != nil {
		t.Fatal(err)
	}
	reader := gwNewSSEReader(strings.NewReader(w.Body.String()))
	active, count := -1, 0
	arguments := map[int]string{}
	for {
		ev, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		_ = json.Unmarshal([]byte(ev.Data), &body)
		index := gwInt(body["index"])
		switch ev.Event {
		case "content_block_start":
			if active != -1 || index != count {
				t.Fatalf("overlapping/out-of-order blocks: active=%d next=%d", active, index)
			}
			active = index
			count++
		case "content_block_delta":
			if active != index {
				t.Fatalf("delta for closed block %d (active %d)", index, active)
			}
			arguments[index] += gwStr(gwMap(body["delta"])["partial_json"])
		case "content_block_stop":
			if active != index {
				t.Fatalf("unexpected block stop %d", index)
			}
			active = -1
		}
	}
	if active != -1 || count != 5 || arguments[2] != `{"path":"a"}` || arguments[3] != `{"path":"b"}` {
		t.Fatalf("blocks=%d active=%d arguments=%v", count, active, arguments)
	}
}

func TestGatewayAnthropicAuthenticationErrors(t *testing.T) {
	h, _ := gatewayTestHandler(t)
	router := chi.NewRouter()
	router.Use(httpx.Auth(h.deps))
	router.Post("/v1/messages", h.gateway("chat", "messages"))
	for _, key := range []string{"", "invalid-key"} {
		req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{}`))
		req.Header.Set("x-api-key", key)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		var body map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != http.StatusUnauthorized || body["type"] != "error" || gwMap(body["error"])["type"] != "authentication_error" {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	}
}

func TestGatewayAnthropicThinkingOnlyHistory(t *testing.T) {
	body := map[string]any{"messages": []any{map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "thinking", "thinking": "unfinished plan", "signature": "opaque"}}}}}
	converted := anthropicRequestToChat(body)
	messages := gwSlice(converted["messages"])
	if len(messages) != 1 || gwMap(messages[0])["reasoning_content"] != "unfinished plan" {
		t.Fatal(converted)
	}
}

func TestGatewayAnthropicStructuredOutputRoundTrip(t *testing.T) {
	body := map[string]any{"model": "m", "messages": []any{map[string]any{"role": "user", "content": "hello"}}, "reasoning_effort": "high", "response_format": map[string]any{"type": "json_schema", "json_schema": map[string]any{"schema": map[string]any{"type": "object"}}}}
	converted := chatRequestToAnthropic(body, gwRouteDefaults{})
	if gwMap(converted["thinking"])["type"] != "adaptive" || gwMap(converted["output_config"])["effort"] != "high" {
		t.Fatal(converted)
	}
	back := anthropicRequestToChat(converted)
	if back["reasoning_effort"] != "high" || gwMap(back["response_format"])["type"] != "json_schema" {
		t.Fatal(back)
	}
}
