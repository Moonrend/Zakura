// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestModelIncompleteResponses(t *testing.T) {
	for _, tc := range []struct {
		name, body, finish, reason string
		stream                     bool
	}{
		{"openai-json", `{"choices":[{"message":{"tool_calls":[{"id":"a","function":{"name":"fs_read","arguments":"{}"}}]},"finish_reason":"length"}]}`, "length", "", false},
		{"anthropic-json", `{"content":[{"type":"tool_use","id":"a","name":"fs_read","input":{}}],"stop_reason":"max_tokens"}`, "max_tokens", "", false},
		{"responses-json", `{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"function_call","call_id":"a","name":"fs_read","arguments":"{}"}]}`, "incomplete", "max_output_tokens", false},
		{"openai-stream", "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"fs_read\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"length\"}]}\n\n", "length", "", true},
		{"anthropic-stream", "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"a\",\"name\":\"fs_read\"}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n", "max_tokens", "", true},
		{"responses-stream", "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"i\",\"call_id\":\"a\",\"name\":\"fs_read\"}}\n\ndata: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n", "incomplete", "max_output_tokens", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var result modelRoundResult
			var err error
			if tc.stream {
				result, err = parseModelStream(strings.NewReader(tc.body), nil)
			} else {
				result, err = parseCompletionJSON([]byte(tc.body))
			}
			if err != nil || result.FinishReason != tc.finish || result.IncompleteReason != tc.reason || len(result.ToolCalls) != 1 {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		})
	}
}

func TestAgentIncompleteToolBatchNeverExecutes(t *testing.T) {
	for _, scenario := range []string{"recover", "repeat", "duplicate", "text"} {
		t.Run(scenario, func(t *testing.T) {
			var requests, effects atomic.Int32
			s, a, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
				n := requests.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if n > 1 && scenario == "recover" {
					var payload map[string]any
					_ = json.NewDecoder(r.Body).Decode(&payload)
					if !strings.Contains(strings.Join(messageContents(payload), "|"), "no tools in this batch") {
						t.Error("missing corrective tool results")
					}
					io.WriteString(w, textCompletion("recovered"))
					return
				}
				if scenario == "text" {
					io.WriteString(w, `{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}`)
					return
				}
				id1, id2, finish := fmt.Sprintf("first%d", n), fmt.Sprintf("second%d", n), "length"
				if scenario == "duplicate" {
					id2, finish = id1, "tool_calls"
				}
				fmt.Fprintf(w, `{"choices":[{"message":{"tool_calls":[{"id":%q,"function":{"name":"effect","arguments":"{}"}},{"id":%q,"function":{"name":"effect","arguments":"{}"}}]},"finish_reason":%q}]}`, id1, id2, finish)
			})
			s.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
				effects.Add(1)
				return json.RawMessage(`{}`), nil
			}
			run, _, err := s.StartTurn(context.Background(), "tenant", a.ID, session.ID, "test", nil, nil, false)
			if err != nil {
				t.Fatal(err)
			}
			var current Run
			for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
				current, _ = s.store.GetRun(context.Background(), "tenant", a.ID, session.ID, run.ID)
				if current.Status != "running" {
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
			want := "failed"
			if scenario == "recover" {
				want = "completed"
			}
			if current.Status != want || effects.Load() != 0 || requests.Load() > 2 {
				t.Fatalf("run=%+v effects=%d requests=%d", current, effects.Load(), requests.Load())
			}
		})
	}
}

func TestResponsesToolItemIdentity(t *testing.T) {
	acc := newStreamAccumulator(nil)
	for _, event := range []map[string]any{
		{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"type": "function_call", "name": "fs_read"}},
		{"type": "response.function_call_arguments.delta", "output_index": 0, "delta": "{}"},
		{"type": "response.output_item.done", "output_index": 0, "item": map[string]any{"type": "function_call", "id": "item", "call_id": "call", "name": "fs_read", "arguments": "{}"}},
	} {
		if _, err := acc.handleResponses(event["type"].(string), event); err != nil {
			t.Fatal(err)
		}
	}
	result := acc.result()
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].ID != "call" || result.ToolCalls[0].Arguments != "{}" {
		t.Fatalf("result=%+v", result)
	}
	if _, err := acc.handleResponses("response.output_item.done", map[string]any{"output_index": 0, "item": map[string]any{"type": "function_call", "id": "different", "name": "fs_read"}}); err == nil {
		t.Fatal("conflicting item accepted")
	}
	if _, err := newStreamAccumulator(nil).handleResponses("response.output_item.added", map[string]any{"item": map[string]any{"type": "function_call", "name": "fs_read"}}); err == nil {
		t.Fatal("unidentifiable item accepted")
	}
}

func TestModelToolIdentityAndFragments(t *testing.T) {
	body := "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"b\",\"function\":{\"name\":\"fs_\",\"arguments\":\"{\"}},{\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"fs_list\",\"arguments\":\"{}\"}}]}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"name\":\"read\",\"arguments\":\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n"
	result, err := parseModelStream(strings.NewReader(body), nil)
	if err != nil || len(result.ToolCalls) != 2 || result.ToolCalls[0].ID != "a" || result.ToolCalls[1].Name != "fs_read" || result.ToolCalls[1].Arguments != "{}" {
		t.Fatalf("%+v %v", result, err)
	}
	conflict := strings.Replace(body, `"index":1,"function"`, `"index":1,"id":"other","function"`, 1)
	if _, err := parseModelStream(strings.NewReader(conflict), nil); err == nil {
		t.Fatal("conflicting ID accepted")
	}
	calls := []modelToolCall{{Name: "one"}, {Name: "two"}}
	if err := prepareToolCallIDs(calls, "run", 0, map[string]bool{}); err != nil || calls[0].ID == calls[1].ID {
		t.Fatal("missing IDs not repaired uniquely")
	}
}
