// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSteeringAtomicConsumption(t *testing.T) {
	for _, scenario := range []string{"append-failure", "queue-failure", "edited", "cancelled", "success"} {
		t.Run(scenario, func(t *testing.T) {
			s, a, session, run := approvalFixture(t, map[string]any{"policy": "allow_all"})
			ctx := context.Background()
			first, _ := s.store.Enqueue(ctx, "tenant", a.ID, session.ID, QueueMessage{Content: "one", Mode: queueModeSteer})
			second, _ := s.store.Enqueue(ctx, "tenant", a.ID, session.ID, QueueMessage{Content: "two", Mode: queueModeSteer})
			selected := []QueueMessage{first, second}
			if scenario == "edited" {
				_, _ = s.store.UpdateQueued(ctx, "tenant", a.ID, session.ID, second.ID, QueueMessage{Content: "edited"})
			}
			if scenario == "cancelled" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if scenario == "append-failure" || scenario == "queue-failure" {
				condition := "NEW.type='user_message' AND json_extract(NEW.payload_json,'$.content')='two'"
				if scenario == "queue-failure" {
					condition = "NEW.type='queue_update'"
				}
				if err := s.store.deps.Gorm.Exec("CREATE TRIGGER fail_steer BEFORE INSERT ON cloud_agent_events WHEN " + condition + " BEGIN SELECT RAISE(ABORT,'injected failure'); END").Error; err != nil {
					t.Fatal(err)
				}
			}
			err := s.store.consumeSteers(ctx, "tenant", a.ID, session.ID, run.ID, selected)
			if (err == nil) != (scenario == "success") {
				t.Fatalf("err=%v", err)
			}
			pending, e := s.store.PendingQueue(context.Background(), "tenant", a.ID, session.ID)
			if e != nil {
				t.Fatal(e)
			}
			var events int64
			s.store.deps.Gorm.Table("cloud_agent_events").Where("session_id=? AND type='user_message' AND json_extract(payload_json,'$.steer')=true", session.ID).Count(&events)
			if scenario == "success" {
				if len(pending) != 0 || events != 2 {
					t.Fatalf("pending=%v events=%d", pending, events)
				}
			} else if len(pending) != 2 || events != 0 {
				t.Fatalf("partial commit: pending=%v events=%d", pending, events)
			}
		})
	}
}

func TestSteeringOptionsAndConcurrentEnqueue(t *testing.T) {
	s, a, session, run := approvalFixture(t, map[string]any{"policy": "allow_all"})
	ctx := context.Background()
	for _, item := range []QueueMessage{{Content: "first", Mode: queueModeSteer}, {Content: "settings", Mode: queueModeSteer, Options: json.RawMessage(`{"disabledTools":["shell_exec"]}`)}, {Content: "later", Mode: queueModeSteer}} {
		if _, err := s.store.Enqueue(ctx, "tenant", a.ID, session.ID, item); err != nil {
			t.Fatal(err)
		}
	}
	project := &agentProjectContext{hooks: []projectHookPackage{{Events: map[string][]projectHookGroup{"UserPromptSubmit": {{Actions: []projectHookAction{{Type: "command", Command: "enqueue"}}}}}}}, exec: func(context.Context, projectHookPackage, projectHookAction, projectHookInput) (string, error) {
		_, err := s.store.Enqueue(ctx, "tenant", a.ID, session.ID, QueueMessage{Content: "concurrent", Mode: queueModeSteer})
		return "context", err
	}}
	ctx = context.WithValue(ctx, agentProjectContextKey{}, project)
	messages := []chatMessage{}
	n, err := s.injectSteers(ctx, TurnRequest{Tenant: "tenant", Agent: a.ID, Session: session.ID}, run.ID, &messages)
	if err != nil || n != 1 {
		t.Fatalf("count=%d err=%v", n, err)
	}
	pending, _ := s.store.PendingQueue(ctx, "tenant", a.ID, session.ID)
	if len(pending) != 3 || pending[0].Content != "settings" || pending[2].Content != "concurrent" {
		t.Fatalf("queue=%+v", pending)
	}
	if !steerOptionsCompatible(json.RawMessage(`{"reasoning":{"effort":"high"}}`), json.RawMessage(`{"reasoning":{"effort":"high"}}`)) {
		t.Fatal("equal options rejected")
	}
}

func TestSteeringBeforeFirstModelRequest(t *testing.T) {
	var sawSteer atomic.Bool
	s, a, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sawSteer.Store(strings.Contains(string(body), "early steer"))
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, textCompletion("done"))
	})
	s.catalogProvider = func(ctx context.Context, _, _ string) (agentCatalog, error) {
		_, err := s.store.Enqueue(ctx, "tenant", a.ID, session.ID, QueueMessage{Content: "early steer", Mode: queueModeSteer})
		return agentCatalog{}, err
	}
	run, _, err := s.StartTurn(context.Background(), "tenant", a.ID, session.ID, "first", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, s.store, a.ID, session.ID, run.ID)
	if !sawSteer.Load() {
		t.Fatal("steering was delayed until after first model request")
	}
}

func TestSteeringImageVisibleNextRequest(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var requests atomic.Int32
	var imageSeen atomic.Bool
	s, a, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if requests.Add(1) == 1 {
			io.WriteString(w, `{"choices":[{"message":{"tool_calls":[{"id":"call","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		imageSeen.Store(strings.Contains(string(body), "data:image/png;base64,"))
		io.WriteString(w, textCompletion("seen"))
	})
	s.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
		close(started)
		<-release
		return json.RawMessage(`{}`), nil
	}
	s.attachmentReader = func(_ context.Context, _, _, path string, _ int64) ([]byte, error) {
		if path != "/image.png" {
			return nil, errors.New("unexpected path")
		}
		return []byte("image"), nil
	}
	run, _, err := s.StartTurn(context.Background(), "tenant", a.ID, session.ID, "first", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	_, err = s.store.Enqueue(context.Background(), "tenant", a.ID, session.ID, QueueMessage{Content: "look", Mode: queueModeSteer, Attachments: json.RawMessage(`[{"path":"/image.png","kind":"image","mime":"image/png"}]`)})
	close(release)
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, s.store, a.ID, session.ID, run.ID)
	if !imageSeen.Load() {
		t.Fatal("steering image not included in next request")
	}
}
