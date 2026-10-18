// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestGatewayResponseDialectsAndStreamingTools(t *testing.T) {
	chatStream := `data: {"id":"chat1","model":"native","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi "},"finish_reason":null}]}

data: {"id":"chat1","model":"native","choices":[{"index":0,"delta":{"content":"there","tool_calls":[{"index":0,"id":"call1","type":"function","function":{"name":"echo","arguments":""}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"value\":"}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ok\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}

data: [DONE]

`
	anthropicStream := `event: message_start
data: {"type":"message_start","message":{"id":"msg1","model":"native","usage":{"input_tokens":7,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi there"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call1","name":"echo","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"value\":\"ok\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}

`
	for _, tc := range []struct{ protocol, operation, body string }{
		{"openai", "messages", chatStream},
		{"openai", "responses", chatStream},
		{"anthropic", "chat", anthropicStream},
		{"anthropic", "responses", anthropicStream},
	} {
		t.Run(tc.protocol+"_to_"+tc.operation, func(t *testing.T) {
			w := httptest.NewRecorder()
			resp := &ProviderResponse{Status: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(tc.body)), Protocol: tc.protocol, Operation: tc.operation, Stream: true, Model: "native"}
			if err := copyProviderResponse(w, resp); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") {
				t.Fatal(w.Header())
			}
			var text, args string
			var usage bool
			var terminal bool
			reader := gwNewSSEReader(strings.NewReader(w.Body.String()))
			for {
				ev, err := reader.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				if ev.Data == "[DONE]" {
					terminal = true
					continue
				}
				var m map[string]any
				if err := json.Unmarshal([]byte(ev.Data), &m); err != nil {
					t.Fatal(err)
				}
				switch tc.operation {
				case "chat":
					for _, c := range gwSlice(m["choices"]) {
						d := gwMap(gwMap(c)["delta"])
						text += gwStr(d["content"])
						for _, v := range gwSlice(d["tool_calls"]) {
							args += gwStr(gwMap(gwMap(v)["function"])["arguments"])
						}
					}
					usage = usage || gwInt(gwMap(m["usage"])["prompt_tokens"]) == 7
				case "messages":
					d := gwMap(m["delta"])
					text += gwStr(d["text"])
					args += gwStr(d["partial_json"])
					terminal = terminal || ev.Event == "message_stop"
					usage = usage || (ev.Event == "message_delta" && gwInt(gwMap(m["usage"])["output_tokens"]) == 3)
				case "responses":
					if ev.Event == "response.output_text.delta" {
						text += gwStr(m["delta"])
					}
					if ev.Event == "response.function_call_arguments.delta" {
						args += gwStr(m["delta"])
					}
					if ev.Event == "response.completed" {
						terminal = true
						usage = gwInt(gwMap(gwMap(m["response"])["usage"])["input_tokens"]) == 7
					}
				}
			}
			if text != "Hi there" || args != `{"value":"ok"}` || !terminal || !usage {
				t.Fatalf("text=%q args=%q terminal=%t usage=%t\n%s", text, args, terminal, usage, w.Body.String())
			}
		})
	}
}

func TestGatewayNonStreamingConversion(t *testing.T) {
	for _, tc := range []struct{ protocol, operation, body, contains string }{
		{"openai", "messages", `{"id":"c","model":"m","choices":[{"message":{"content":"Hello","tool_calls":[{"id":"call1","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`, `"tool_use"`},
		{"anthropic", "chat", `{"id":"m","type":"message","model":"m","content":[{"type":"text","text":"Hello"}],"stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":1}}`, `"chat.completion"`},
		{"openai", "responses", `{"choices":[{"message":{"content":"Hello"},"finish_reason":"stop"}]}`, `"output_text"`},
	} {
		w := httptest.NewRecorder()
		if err := copyProviderResponse(w, &ProviderResponse{Status: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(tc.body)), Protocol: tc.protocol, Operation: tc.operation}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(w.Body.String(), tc.contains) || !strings.Contains(w.Body.String(), "Hello") {
			t.Fatalf("%s %s: %s", tc.protocol, tc.operation, w.Body.String())
		}
	}
}

func TestGatewayStreamRejectsTruncationAndFirstError(t *testing.T) {
	if _, err := commitStream(io.NopCloser(strings.NewReader("event: error\ndata: {\"error\":{\"message\":\"overloaded\"}}\n\n"))); err == nil {
		t.Fatal("accepted first error event")
	}
	w := httptest.NewRecorder()
	err := copyProviderResponse(w, &ProviderResponse{Status: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n")), Protocol: "openai", Operation: "messages", Stream: true})
	if err == nil || !strings.Contains(w.Body.String(), "event: error") || strings.Contains(w.Body.String(), "message_stop") {
		t.Fatalf("err=%v body=%s", err, w.Body.String())
	}
}

func TestGatewayRouteIDsAndUnknownModels(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	up, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Up", Protocol: "openai", Config: raw(map[string]any{"baseUrl": "https://example.com"})})
	if err != nil {
		t.Fatal(err)
	}
	route, err := store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "Default", Capability: "chat", UpstreamID: up.ID, Model: "native", IsDefault: true})
	if err != nil {
		t.Fatal(err)
	}
	gateway := NewGateway(store)
	candidates, err := gateway.resolveCandidates(context.Background(), "tenant", "chat", route.ID)
	if err != nil || len(candidates) != 1 || candidates[0].Route.ID != route.ID {
		t.Fatalf("candidates=%v err=%v", candidates, err)
	}
	if _, err = gateway.resolveCandidates(context.Background(), "tenant", "chat", "typo-model"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown model fallback: %v", err)
	}
}

func TestGatewaySpaceMappingAndEndpointScopes(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Space", WorkspaceKind: "local", Config: raw(map[string]any{"cloud": map[string]any{"gatewayModelMap": map[string]any{"client": "actual"}}})})
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "native" {
			t.Errorf("model=%v", body["model"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"mapped"},"finish_reason":"stop"}]}`)
	}))
	defer upstream.Close()
	up, _ := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Up", Protocol: "openai", Config: raw(map[string]any{"baseUrl": upstream.URL})})
	alias := "actual"
	_, _ = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "Route", Capability: "chat", Alias: &alias, Model: "native", UpstreamID: up.ID})
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	for _, tc := range []struct {
		scope string
		want  int
	}{{`["gateway"]`, 200}, {`["gateway:chat"]`, 200}, {`["gateway:models"]`, 403}} {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"client","messages":[{"role":"user","content":"hi"}]}`))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: space.ID, APIKeyScopes: tc.scope}))
		w := httptest.NewRecorder()
		h.gateway("chat", "chat")(w, req)
		if w.Code != tc.want {
			t.Fatalf("scope=%s code=%d body=%s", tc.scope, w.Code, w.Body.String())
		}
	}
	for _, p := range []httpx.Principal{{TenantID: "tenant", APIKey: true, AgentID: "agent", APIKeyScopes: `["gateway"]`}, {TenantID: "tenant", APIKey: true, APIKeyScopes: `["*"]`}} {
		req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
		req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
		w := httptest.NewRecorder()
		h.listGatewayModels(w, req)
		if w.Code != 403 {
			t.Fatalf("unbound key code=%d", w.Code)
		}
	}
}

func TestGatewaySplitToolNameAndInterleavedToolIndices(t *testing.T) {
	body := ""
	for _, chunk := range []map[string]any{
		{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call0", "function": map[string]any{"name": "get_", "arguments": ""}}, map[string]any{"index": 1, "id": "call1", "function": map[string]any{"name": "set_", "arguments": ""}}}}}}},
		{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]any{"name": "time", "arguments": "{}"}}, map[string]any{"index": 1, "function": map[string]any{"name": "time", "arguments": "{}"}}}}}}},
		{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"}}},
	} {
		body += "data: " + string(rawJSON(chunk)) + "\n\n"
	}
	body += "data: [DONE]\n\n"
	for _, operation := range []string{"messages", "responses"} {
		w := httptest.NewRecorder()
		if err := copyProviderResponse(w, &ProviderResponse{Status: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(body)), Protocol: "openai", Operation: operation, Stream: true}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(w.Body.String(), `"name":"get_time"`) || !strings.Contains(w.Body.String(), `"name":"set_time"`) || strings.Contains(w.Body.String(), `"name":"get_"`) {
			t.Fatalf("operation=%s body=%s", operation, w.Body.String())
		}
	}
}

func TestGatewayModelsExposeMetadataAndDeduplicateAliases(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "Space", WorkspaceKind: "local"})
	up, _ := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Up", Protocol: "openai", Config: raw(map[string]any{"baseUrl": "https://example.com"})})
	alias := "alias"
	for _, name := range []string{"primary", "fallback"} {
		if _, err := store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: name, Alias: &alias, Capability: "chat", Model: "native", UpstreamID: up.ID}); err != nil {
			t.Fatal(err)
		}
	}
	_, err := d.DB.Exec(`INSERT INTO upstream_models(id,tenant_id,upstream_id,native_model,canonical_model,capability,weight,is_default,options_json,meta_json,status,created_at,updated_at) VALUES('metadata','tenant',?,'native','native','chat',100,FALSE,'{}',?,'ready',?,?)`, up.ID, `{"contextWindow":200000,"max_output_tokens":16000,"reasoning":true}`, d.Clock(), d.Clock())
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: space.ID, APIKeyScopes: `["gateway"]`}))
	w := httptest.NewRecorder()
	(&handler{deps: d, store: store}).listGatewayModels(w, req)
	var result map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	items := gwSlice(result["data"])
	if w.Code != 200 || len(items) != 1 {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	item := gwMap(items[0])
	if gwInt(item["contextLimit"]) != 200000 || gwInt(item["outputLimit"]) != 16000 || item["reasoning"] != true {
		t.Fatalf("metadata=%v", item)
	}
	models, _, err := (&handler{deps: d, store: store}).acpGatewayModels(context.Background(), "tenant")
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != alias || models[0].ContextLimit != 200000 || models[0].OutputLimit != 16000 || models[0].Reasoning == nil || !*models[0].Reasoning {
		t.Fatalf("ACP metadata diverged from gateway: %+v", models)
	}
}

func TestSpaceGatewayConfigPreservesOtherSpaceSettings(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Space", WorkspaceKind: "local", Config: raw(map[string]any{"acp": map[string]any{"enabled": true}})})
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	req := httptest.NewRequest(http.MethodPut, "/api/spaces/"+space.ID+"/gateway/config", strings.NewReader(`{"model":"alias","gatewayModelMap":{"client":"alias"}}`))
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", space.ID)
	req = req.WithContext(context.WithValue(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant"}), chi.RouteCtxKey, ctx))
	w := httptest.NewRecorder()
	h.spaceGatewayConfig(w, req)
	if w.Code != 200 {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	updated, _ := store.GetSpace(context.Background(), "tenant", space.ID)
	var config map[string]any
	_ = json.Unmarshal(updated.Config, &config)
	if gwMap(config["acp"])["enabled"] != true || gwStr(gwMap(config["cloud"])["model"]) != "alias" {
		t.Fatalf("config=%s", updated.Config)
	}
}
