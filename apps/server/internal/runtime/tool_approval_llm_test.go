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

func TestToolApprovalLegacyLLMDecisionMatrix(t *testing.T) {
	for _, scenario := range []string{"allow", "deny", "low-confidence", "malformed", "missing-confidence", "http-error", "deleted-route", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			store := NewStore(d)
			var calls, fallbacks atomic.Int32
			entered := make(chan struct{}, 1)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				select {
				case entered <- struct{}{}:
				default:
				}
				if r.URL.Path != "/v1/chat/completions" {
					t.Errorf("legacy review endpoint=%s", r.URL.Path)
				}
				var body map[string]any
				if json.NewDecoder(r.Body).Decode(&body) != nil || body["tools"] != nil || body["model"] != "review-model" {
					t.Error("reviewer received tools or a different model")
				}
				messages, _ := body["messages"].([]any)
				encoded := string(rawJSON(messages))
				for _, secret := range []string{"private-argument-sentinel", "private-history-sentinel", "request-secret-sentinel"} {
					if strings.Contains(encoded, secret) {
						t.Errorf("legacy reviewer received excluded input: %s", secret)
					}
				}
				if !strings.Contains(encoded, "Read the current note") || !strings.Contains(encoded, "space_workspace") {
					t.Error("legacy reviewer missing request or target context")
				}
				if scenario == "cancel" {
					<-r.Context().Done()
					return
				}
				if scenario == "http-error" {
					w.WriteHeader(503)
					return
				}
				answer := `{"decision":"allow","confidence":0.95}`
				switch scenario {
				case "deny":
					answer = `{"decision":"deny","confidence":0.95}`
				case "low-confidence":
					answer = `{"decision":"allow","confidence":0.2}`
				case "malformed":
					answer = "not a decision"
				case "missing-confidence":
					answer = `{"decision":"allow"}`
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": answer}}}})
			}))
			defer provider.Close()
			fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				fallbacks.Add(1)
				_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"{}"}}]}`)
			}))
			defer fallback.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			upstream, err := store.CreateUpstream(ctx, "tenant", Upstream{Name: "Legacy", Protocol: "openai", Config: rawJSON(map[string]any{"baseUrl": provider.URL})})
			if err != nil {
				t.Fatal(err)
			}
			route, err := store.CreateRoute(ctx, "tenant", ModelRoute{Name: "Review", Capability: "chat", UpstreamID: upstream.ID, Model: "review-model", Priority: 100, Weight: 100})
			if err != nil {
				t.Fatal(err)
			}
			other, err := store.CreateUpstream(ctx, "tenant", Upstream{Name: "Default", Protocol: "openai", Config: rawJSON(map[string]any{"baseUrl": fallback.URL})})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.CreateRoute(ctx, "tenant", ModelRoute{Name: "Default", Capability: "chat", UpstreamID: other.ID, Model: "default-model", IsDefault: true, Priority: 100, Weight: 100}); err != nil {
				t.Fatal(err)
			}
			space, err := store.CreateSpace(ctx, "tenant", Space{Name: "Legacy approval"})
			if err != nil {
				t.Fatal(err)
			}
			a, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID, Config: rawJSON(map[string]any{"cloud": map[string]any{"approvals": map[string]any{"policy": "ai", "aiGate": map[string]any{"provider": "llm", "routeId": route.ID, "escalateOnDeny": false}}}})})
			if err != nil {
				t.Fatal(err)
			}
			session, err := store.CreateSession(ctx, "tenant", "", a.ID, Session{})
			if err != nil {
				t.Fatal(err)
			}
			run, err := store.StartRun(ctx, "tenant", a.ID, session.ID, "test", nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = store.AppendEvent(ctx, "tenant", a.ID, session.ID, "user_message", nil, map[string]any{"content": "private-history-sentinel"}); err != nil {
				t.Fatal(err)
			}
			if _, err = store.AppendEvent(ctx, "tenant", a.ID, session.ID, "user_message", &run.ID, map[string]any{"content": "Read the current note; Bearer request-secret-sentinel"}); err != nil {
				t.Fatal(err)
			}
			if scenario == "deleted-route" {
				if err := d.Gorm.Table("model_routes").Where("id=?", route.ID).Delete(nil).Error; err != nil {
					t.Fatal(err)
				}
			}
			s := NewService(store)
			done := make(chan error, 1)
			go func() {
				done <- s.approveTool(ctx, "tenant", a.ID, session.ID, run.ID, "call", "fs_read", json.RawMessage(`{"path":"/workspace/note","api_key":"private-argument-sentinel"}`), "always_ask", "standard", "")
			}()
			if scenario == "cancel" {
				select {
				case <-entered:
					cancel()
				case <-ctx.Done():
					t.Fatal("review request was not sent")
				}
			} else if scenario != "allow" && scenario != "deny" {
				id := waitApproval(t, store, session.ID)
				if err := store.settleApproval(ctx, "tenant", a.ID, session.ID, id, "denied", "user", false); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				if (err == nil) != (scenario == "allow") {
					t.Fatalf("decision=%v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("review did not settle")
			}
			want := int32(1)
			if scenario == "http-error" {
				want = 3 // The shared gateway retries the same upstream, never a fallback.
			}
			if scenario == "deleted-route" {
				want = 0
			}
			if calls.Load() != want || fallbacks.Load() != 0 {
				t.Fatalf("review/fallback calls=%d/%d want=%d/0", calls.Load(), fallbacks.Load(), want)
			}
		})
	}
}
