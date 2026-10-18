// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAgentLoopPostRunTitleCompareAndSwap(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, textCompletion("Generated title"))
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		service.afterTurn(TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID, Content: "hello"}, agent, session, cloudConfig{AutoTitle: true}, "m", "world")
	}()
	<-started
	if _, err := service.store.UpdateSession(context.Background(), "tenant", agent.ID, session.ID, map[string]any{"title": "My explicit title"}); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-done
	current, _ := service.store.GetSession(context.Background(), "tenant", agent.ID, session.ID)
	if current.Title != "My explicit title" {
		t.Fatalf("manual title overwritten: %s", current.Title)
	}
}

func TestAgentLoopPostRunMemoryDeduplication(t *testing.T) {
	var calls atomic.Int32
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] != false {
			t.Error("postrun requested streaming")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, textCompletion(`[{"content":"User prefers concise answers","layer":"preference"}]`))
	})
	agent.EnableMemory = true
	service.memoryWriter = service.store.CreateMemory
	req := TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID, Content: "Please keep answers concise."}
	for range 2 {
		service.afterTurn(req, agent, session, cloudConfig{AutoMemory: true}, "m", "Understood")
	}
	items, err := service.store.ListMemories(context.Background(), "tenant", agent.ID, "", "", 10)
	if err != nil || len(items) != 1 {
		t.Fatalf("items=%v err=%v", items, err)
	}
	if items[0].Source != "auto" || !strings.Contains(string(items[0].Metadata), session.ID) {
		t.Fatalf("memory metadata missing: %+v", items[0])
	}
	if calls.Load() != 2 {
		t.Fatalf("model calls=%d", calls.Load())
	}
}
