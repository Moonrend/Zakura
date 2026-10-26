// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParallelToolsBoundOrderAndCancellation(t *testing.T) {
	for _, cancelBatch := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelBatch), func(t *testing.T) {
			s, a, session, run := approvalFixture(t, map[string]any{"policy": "allow_all"})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			started := make(chan string, 8)
			releases := map[string]chan struct{}{}
			calls := []modelToolCall{}
			for i := 0; i < 6; i++ {
				id := fmt.Sprint(i)
				releases[id] = make(chan struct{})
				calls = append(calls, modelToolCall{ID: id, Name: "fs_read", Arguments: `{"path":"/file"}`})
			}
			var active, peak atomic.Int32
			s.toolRunner = func(ctx context.Context, _, _, _, id, _ string, _ json.RawMessage) (json.RawMessage, error) {
				n := active.Add(1)
				defer active.Add(-1)
				for {
					old := peak.Load()
					if n <= old || peak.CompareAndSwap(old, n) {
						break
					}
				}
				started <- id
				select {
				case <-releases[id]:
					return json.RawMessage(`{"ok":true}`), nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			catalog := agentCatalog{Tools: []agentTool{directBuiltin("fs_read", "", map[string]any{"path": map[string]any{"type": "string"}}, "path")}}
			messages := []chatMessage{}
			done := make(chan error, 1)
			go func() {
				done <- s.runRoundTools(ctx, TurnRequest{Tenant: "tenant", Agent: a.ID, Session: session.ID}, session, run.ID, calls, catalog, true, 8000, &messages)
			}()
			for i := 0; i < 4; i++ {
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal("reads did not overlap")
				}
			}
			select {
			case id := <-started:
				t.Fatalf("more than 4 active: %s", id)
			default:
			}
			if cancelBatch {
				cancel()
			} else {
				close(releases["3"])
				select {
				case id := <-started:
					if id != "4" {
						t.Fatalf("started=%s", id)
					}
				case <-ctx.Done():
					t.Fatal("no replacement worker")
				}
				close(releases["4"])
				select {
				case id := <-started:
					if id != "5" {
						t.Fatalf("started=%s", id)
					}
				case <-ctx.Done():
					t.Fatal("no replacement worker")
				}
				for _, id := range []string{"0", "1", "2", "5"} {
					close(releases[id])
				}
			}
			select {
			case err := <-done:
				if (err != nil) != cancelBatch {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("batch did not settle")
			}
			if peak.Load() != 4 || len(messages) != 6 {
				t.Fatalf("peak=%d messages=%v", peak.Load(), messages)
			}
			for i, message := range messages {
				if message.ToolCallID != fmt.Sprint(i) {
					t.Fatalf("transcript order=%v", messages)
				}
			}
			events, err := s.store.ListEvents(context.Background(), "tenant", a.ID, session.ID, 0, 100)
			if err != nil {
				t.Fatal(err)
			}
			results := map[string]int{}
			firstResult := ""
			for _, ev := range events {
				if ev.Type == "tool_call_result" {
					var p map[string]any
					json.Unmarshal(ev.Payload, &p)
					id := p["toolCallId"].(string)
					results[id]++
					if firstResult == "" {
						firstResult = id
					}
				}
			}
			for _, call := range calls {
				if results[call.ID] != 1 {
					t.Fatalf("unpaired results=%v", results)
				}
			}
			if !cancelBatch && firstResult != "3" {
				t.Fatalf("fast result not persisted first: %s", firstResult)
			}
			replayed := runEventsToMessages(s.loadHistoryEvents(context.Background(), session.ID))
			i := 0
			for _, message := range replayed {
				if message.Role == "tool" {
					if message.ToolCallID != fmt.Sprint(i) {
						t.Fatalf("replay order=%+v", replayed)
					}
					i++
				}
			}
			if i != 6 {
				t.Fatalf("missing replay results: %d", i)
			}
		})
	}
}

func TestParallelToolBatchBarriers(t *testing.T) {
	catalog := agentCatalog{Tools: []agentTool{directBuiltin("fs_read", "", nil), directBuiltin("fs_list", "", nil), directBuiltin("fs_write", "", nil), {Name: "mcp__test__read", Kind: "mcp", Parallel: true}}}
	ctx := context.Background()
	for _, name := range []string{"fs_write", "shell_exec", "tool_execute", "codemode", "mcp__test__read", "unknown"} {
		if parallelToolBatch(ctx, []modelToolCall{{Name: "fs_read"}, {Name: name}, {Name: "fs_list"}}, catalog) {
			t.Fatalf("%s did not serialize batch", name)
		}
	}
	project := &agentProjectContext{hooks: []projectHookPackage{{Events: map[string][]projectHookGroup{"PostToolUse": {{Matcher: "*"}}}}}}
	ctx = context.WithValue(ctx, agentProjectContextKey{}, project)
	if parallelToolBatch(ctx, []modelToolCall{{Name: "fs_read"}, {Name: "fs_list"}}, catalog) {
		t.Fatal("hooks did not serialize batch")
	}
}

func TestParallelToolResultWriteFailureStopsDispatch(t *testing.T) {
	s, a, session, run := approvalFixture(t, map[string]any{"policy": "allow_all"})
	if err := s.store.deps.Gorm.Exec("CREATE TRIGGER fail_result BEFORE INSERT ON cloud_agent_events WHEN NEW.type='tool_call_result' BEGIN SELECT RAISE(ABORT,'result failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	var effects atomic.Int32
	s.toolRunner = func(ctx context.Context, _, _, _, id, _ string, _ json.RawMessage) (json.RawMessage, error) {
		effects.Add(1)
		if id == "0" {
			return json.RawMessage(`{}`), nil
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	calls := []modelToolCall{}
	for i := 0; i < 8; i++ {
		calls = append(calls, modelToolCall{ID: fmt.Sprint(i), Name: "fs_read", Arguments: `{}`})
	}
	messages := []chatMessage{}
	err := s.runRoundTools(context.Background(), TurnRequest{Tenant: "tenant", Agent: a.ID, Session: session.ID}, session, run.ID, calls, agentCatalog{Tools: []agentTool{directBuiltin("fs_read", "", nil)}}, true, 8000, &messages)
	if err == nil || !strings.Contains(err.Error(), "result failure") || effects.Load() > 4 || len(messages) != 0 {
		t.Fatalf("err=%v effects=%d messages=%v", err, effects.Load(), messages)
	}
}
