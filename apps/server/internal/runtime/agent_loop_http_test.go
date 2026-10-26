// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func loopHandlerRequest(h *handler, agent, session, body string, serve http.HandlerFunc) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	route := chi.NewRouteContext()
	route.URLParams.Add("id", agent)
	route.URLParams.Add("sid", session)
	r = r.WithContext(contextWithRoutePrincipal(r.Context(), route, httpx.Principal{TenantID: "tenant", UserID: "user-http"}))
	w := httptest.NewRecorder()
	serve(w, r)
	return w
}

func TestAgentLoopHTTPExplicitRootAndRetryOptions(t *testing.T) {
	var captured map[string]any
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&captured)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, textCompletion("reply"))
	})
	h := &handler{store: service.store, service: service, deps: service.store.deps}
	for _, body := range []string{`{"content":"old branch"}`, `{"content":"new root","parentRunId":null,"options":{"reasoning":{"effort":"high"}}}`} {
		w := loopHandlerRequest(h, agent.ID, session.ID, body, h.sendMessage)
		if w.Code != 202 {
			t.Fatalf("send=%d %s", w.Code, w.Body.String())
		}
		var accepted struct {
			RunID string `json:"runId"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &accepted)
		waitForAgentRun(t, service.store, agent.ID, session.ID, accepted.RunID)
	}
	if strings.Contains(strings.Join(messageContents(captured), "|"), "old branch") {
		t.Fatalf("explicit null root kept prior branch: %v", captured)
	}
	events, _ := service.store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
	var messageID string
	for _, event := range events {
		if event.Type != "user_message" {
			continue
		}
		var p map[string]any
		_ = json.Unmarshal(event.Payload, &p)
		if p["content"] == "new root" {
			messageID, _ = p["messageId"].(string)
			if _, ok := p["parentRunId"]; !ok || p["parentRunId"] != nil {
				t.Fatalf("root link missing: %v", p)
			}
			if p["userId"] != "user-http" {
				t.Fatalf("user missing: %v", p)
			}
		}
	}
	w := loopHandlerRequest(h, agent.ID, session.ID, `{"messageId":"`+messageID+`","options":{"reasoning":{"effort":"low"}}}`, h.retryRun)
	if w.Code != 202 {
		t.Fatalf("retry=%d %s", w.Code, w.Body.String())
	}
	var accepted struct {
		RunID string `json:"runId"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &accepted)
	waitForAgentRun(t, service.store, agent.ID, session.ID, accepted.RunID)
	if captured["reasoning_effort"] != "low" {
		t.Fatalf("retry options lost: %v", captured)
	}
	events, _ = service.store.ListEvents(context.Background(), "tenant", agent.ID, session.ID, 0, 100)
	users := 0
	for _, event := range events {
		if event.Type == "user_message" {
			users++
		}
	}
	if users != 2 {
		t.Fatalf("retry duplicated user events: %d", users)
	}
	w = loopHandlerRequest(h, agent.ID, session.ID, `{"content":"bad","unknown":true}`, h.sendMessage)
	if w.Code != 400 {
		t.Fatalf("unknown field accepted: %d", w.Code)
	}
}

func TestAgentLoopHTTPFollowUpModes(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	service, agent, session := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, ": ping\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-started:
		default:
			close(started)
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	})
	h := &handler{store: service.store, service: service, deps: service.store.deps}
	w := loopHandlerRequest(h, agent.ID, session.ID, `{"content":"first"}`, h.sendMessage)
	if w.Code != 202 {
		t.Fatalf("send=%d %s", w.Code, w.Body.String())
	}
	<-started
	for _, mode := range []string{"queue", "steer"} {
		w := loopHandlerRequest(h, agent.ID, session.ID, `{"content":"follow-up","followUpMode":"`+mode+`"}`, h.sendMessage)
		if w.Code != 202 {
			t.Fatalf("queue=%d %s", w.Code, w.Body.String())
		}
		var accepted map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &accepted)
		if accepted["queued"] != true || accepted["mode"] != mode {
			t.Fatalf("mode response=%v", accepted)
		}
	}
	pending, _ := service.store.PendingQueue(context.Background(), "tenant", agent.ID, session.ID)
	if len(pending) != 2 || pending[0].Mode != "queue" || pending[1].Mode != "steer" {
		t.Fatalf("pending=%v", pending)
	}
	for _, item := range pending {
		_ = service.store.DeleteQueued(context.Background(), "tenant", agent.ID, session.ID, item.ID)
	}
	once.Do(func() { close(release) })
	_, _ = service.Cancel(context.Background(), "tenant", agent.ID, session.ID)
}
