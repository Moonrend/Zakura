// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"gorm.io/gorm"
)

func TestGatewayStreamCommitFramingAndReplay(t *testing.T) {
	for _, first := range []string{
		"data: first\n\n", "data: first\r\n\r\n",
		"data: " + strings.Repeat("x", 4096-6) + "\n\n",
		"data: " + strings.Repeat("x", (64<<10)-8) + "\n\n",
	} {
		reader := bufio.NewReader(strings.NewReader(first + "data: second\n\n"))
		prefix, err := readStreamCommit(reader)
		if err != nil || string(prefix) != first {
			t.Fatalf("first length=%d prefix length=%d err=%v", len(first), len(prefix), err)
		}
		replayed, err := io.ReadAll(io.MultiReader(bytes.NewReader(prefix), reader))
		if err != nil || string(replayed) != first+"data: second\n\n" {
			t.Fatalf("lost prefetched stream data: %v", err)
		}
	}
	for _, invalid := range []string{"data: partial\n", "data: " + strings.Repeat("x", 64<<10) + "\n\n"} {
		if _, err := readStreamCommit(bufio.NewReader(strings.NewReader(invalid))); err == nil {
			t.Fatalf("accepted incomplete/oversized event (%d bytes)", len(invalid))
		}
	}
}

// The upstream waits for the downstream to receive its first event. This proves
// token delivery while the connection is open, without depending on sleep timing.
func TestGatewayHTTPStreamFlushesBeforeUpstreamFinishes(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\r\n\r\ndata: prefetched\r\n\r\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
			_, _ = io.WriteString(w, "data: last\r\n\r\n")
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	u, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "stream", Config: raw(map[string]any{"baseUrl": upstream.URL})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "route", Model: "m", UpstreamID: u.ID}); err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store, service: NewService(store)}
	defer h.service.gateway.client.CloseIdleConnections()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(httpx.WithPrincipal(r.Context(), httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: "agent", APIKeyScopes: `["gateway"]`}))
		h.gateway("chat", "chat")(w, r)
	}))
	defer proxy.Close()
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Post(proxy.URL, "application/json", strings.NewReader(`{"model":"m","stream":true,"messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("unexpected response: %v", resp)
	}
	reader := bufio.NewReader(resp.Body)
	for _, want := range []string{"data: first\r\n", "\r\n", "data: prefetched\r\n", "\r\n"} {
		line, err := reader.ReadString('\n')
		if err != nil || line != want {
			t.Fatalf("got %q want %q err=%v", line, want, err)
		}
	}
	release <- struct{}{}
	rest, err := io.ReadAll(reader)
	if err != nil || string(rest) != "data: last\r\n\r\n" {
		t.Fatalf("tail=%q err=%v", rest, err)
	}
}

type gatewayCountingWriter struct{ size int64 }

func (w *gatewayCountingWriter) Header() http.Header { return make(http.Header) }
func (w *gatewayCountingWriter) WriteHeader(int)     {}
func (w *gatewayCountingWriter) Write(p []byte) (int, error) {
	w.size += int64(len(p))
	return len(p), nil
}
func (w *gatewayCountingWriter) Flush() {}

func TestGatewayStreamHasNoLifetimeResponseLimit(t *testing.T) {
	const size = maxProviderResponse + 4096
	writer := &gatewayCountingWriter{}
	reader := io.LimitReader(&gatewayRepeatingReader{}, size)
	if err := copyProviderResponse(writer, &ProviderResponse{Status: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(reader)}); err != nil {
		t.Fatal(err)
	}
	if writer.size != size {
		t.Fatalf("stream truncated to %d bytes", writer.size)
	}
}

type gatewayRepeatingReader struct{}

func (*gatewayRepeatingReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func TestGatewayPayloadPreservesNumbersAndNormalizesProtocols(t *testing.T) {
	for _, tc := range []struct{ protocol, operation string }{{"openai", "chat"}, {"openai", "responses"}, {"anthropic", "chat"}, {"openai", "messages"}} {
		original := []byte(`{"model":"alias","stream":true,"messages":[{"role":"system","content":"rules"},{"role":"user","content":"hi"}],"metadata":{"id":9007199254740993},"max_completion_tokens":9007199254740993,"tools":[{"name":"echo","input_schema":{"type":"object"}}],"odd\u0000key":"value"}`)
		before := append([]byte(nil), original...)
		payload, stream, err := prepareProviderPayload(tc.protocol, tc.operation, "real-model", original)
		if err != nil || !stream || !bytes.Equal(before, original) || !json.Valid(payload) {
			t.Fatalf("%+v stream=%v err=%v", tc, stream, err)
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal(payload, &body); err != nil {
			t.Fatal(err)
		}
		if string(body["model"]) != `"real-model"` || !bytes.Contains(body["metadata"], []byte("9007199254740993")) {
			t.Fatalf("corrupted payload: %s", payload)
		}
		if tc.protocol == "anthropic" && (string(body["max_tokens"]) != "9007199254740993" || string(body["system"]) != `"rules"`) {
			t.Fatalf("normalization failed: %s", payload)
		}
		if tc.operation == "messages" && !bytes.Contains(body["tools"], []byte(`"function"`)) {
			t.Fatalf("tools not converted: %s", payload)
		}
	}
	for _, payload := range []string{"null", "[]", "{} {}", "{", "1"} {
		for _, protocol := range []string{"openai", "anthropic"} {
			if _, _, err := prepareProviderPayload(protocol, "chat", "m", []byte(payload)); err == nil {
				t.Fatalf("accepted %s", payload)
			}
		}
	}
}

type gatewayRoundTripFunc func(*http.Request) (*http.Response, error)

func (f gatewayRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestGatewayTransportRetryCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls atomic.Int32
	called := make(chan struct{})
	gateway := &Gateway{client: &http.Client{Transport: gatewayRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		close(called)
		return nil, errors.New("dial failed")
	})}}
	done := make(chan error, 1)
	go func() {
		_, err := gateway.doCandidate(ctx, "tenant", "chat", []byte(`{}`), ModelRoute{Model: "m"}, Upstream{Config: raw(map[string]any{"baseUrl": "http://example.test"})})
		done <- err
	}()
	<-called
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || calls.Load() != 1 {
			t.Fatalf("calls=%d err=%v", calls.Load(), err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt retry")
	}
}

func TestGatewayFailedResponseDoesNotWaitForBody(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.(http.Flusher).Flush()
		<-r.Context().Done() // Never produce a body or finish independently.
	}))
	defer bad.Close()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	u, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "bad", Config: raw(map[string]any{"baseUrl": bad.URL})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "route", Model: "m", UpstreamID: u.ID}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	gateway := NewGateway(store)
	defer gateway.client.CloseIdleConnections()
	_, err = gateway.Do(ctx, "tenant", "chat", "chat", "m", []byte(`{}`))
	if err == nil || ctx.Err() != nil || !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("blocked reading error body: %v", err)
	}
}

func TestGatewayCandidateQueriesIsolationAndUpdates(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	seedTenant(t, d, "other")
	store := NewStore(d)
	ctx := context.Background()
	for i := 0; i < 32; i++ {
		u, err := store.CreateUpstream(ctx, "tenant", Upstream{Name: fmt.Sprint(i)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = store.CreateRoute(ctx, "tenant", ModelRoute{Name: fmt.Sprint(i), Model: "m", UpstreamID: u.ID, Priority: 100 + i}); err != nil {
			t.Fatal(err)
		}
	}
	foreign, err := store.CreateUpstream(ctx, "other", Upstream{Name: "foreign"})
	if err != nil {
		t.Fatal(err)
	}
	// Even a malformed route pointing across tenants must not leak credentials.
	if _, err = store.CreateRoute(ctx, "tenant", ModelRoute{Name: "foreign", Model: "m", UpstreamID: foreign.ID}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross tenant route accepted: %v", err)
	}
	var queries atomic.Int32
	if err = d.Gorm.Callback().Query().After("gorm:query").Register("gateway_count_queries", func(*gorm.DB) { queries.Add(1) }); err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Callback().Row().After("gorm:row").Register("gateway_count_rows", func(*gorm.DB) { queries.Add(1) }); err != nil {
		t.Fatal(err)
	}
	candidates, err := store.ResolveCandidates(ctx, "tenant", "chat", "m")
	if err != nil || len(candidates) != 32 || queries.Load() != 2 {
		t.Fatalf("candidates=%d queries=%d err=%v", len(candidates), queries.Load(), err)
	}
	for i, candidate := range candidates {
		if candidate.Route.Priority != 100+i || candidate.Upstream.Name != fmt.Sprint(i) {
			t.Fatalf("unexpected ordering %+v", candidate)
		}
	}
	if _, err = d.DB.Exec(`UPDATE model_upstreams SET status='disabled' WHERE id=?`, candidates[0].Upstream.ID); err != nil {
		t.Fatal(err)
	}
	queries.Store(0)
	candidates, err = store.ResolveCandidates(ctx, "tenant", "chat", "m")
	if err != nil || len(candidates) != 31 || candidates[0].Route.Priority != 101 || queries.Load() != 2 {
		t.Fatalf("stale candidates=%d queries=%d err=%v", len(candidates), queries.Load(), err)
	}
	if _, err = store.ResolveCandidates(ctx, "other", "chat", "m"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tenant isolation failed: %v", err)
	}
	if _, err = d.DB.Exec(`UPDATE model_routes SET upstream_id=? WHERE id=?`, foreign.ID, candidates[0].Route.ID); err != nil {
		t.Fatal(err)
	}
	candidates, err = store.ResolveCandidates(ctx, "tenant", "chat", "m")
	if err != nil || len(candidates) != 30 {
		t.Fatalf("malformed cross-tenant reference: candidates=%d err=%v", len(candidates), err)
	}
}

type gatewayErrorReader struct{}

func (gatewayErrorReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestGatewayHTTPResponseReadFailures(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprint(stream), func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			store := NewStore(d)
			u, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "broken", Config: raw(map[string]any{"baseUrl": "http://example.test"})})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: "route", Model: "m", UpstreamID: u.ID}); err != nil {
				t.Fatal(err)
			}
			h := &handler{deps: d, store: store, service: NewService(store)}
			var calls atomic.Int32
			h.service.gateway.client = &http.Client{Transport: gatewayRoundTripFunc(func(*http.Request) (*http.Response, error) {
				calls.Add(1)
				contentType, prefix := "application/json", `{"partial":`
				if stream {
					contentType, prefix = "text/event-stream", "data: first\n\n"
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {contentType}}, Body: io.NopCloser(io.MultiReader(strings.NewReader(prefix), gatewayErrorReader{}))}, nil
			})}
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r = r.WithContext(httpx.WithPrincipal(r.Context(), httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: "agent", APIKeyScopes: `["gateway"]`}))
				h.gateway("chat", "chat")(w, r)
			}))
			defer proxy.Close()
			client := &http.Client{Timeout: 3 * time.Second}
			resp, err := client.Post(proxy.URL, "application/json", strings.NewReader(fmt.Sprintf(`{"model":"m","stream":%t}`, stream)))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, readErr := io.ReadAll(resp.Body)
			if stream {
				if resp.StatusCode != 200 || string(body) != "data: first\n\n" || readErr == nil {
					t.Fatalf("partial stream looked successful: status=%d body=%q err=%v", resp.StatusCode, body, readErr)
				}
			} else if resp.StatusCode != 502 || readErr != nil {
				t.Fatalf("failed non-stream read: status=%d err=%v", resp.StatusCode, readErr)
			}
			if calls.Load() != 1 {
				t.Fatalf("retried after commit: calls=%d", calls.Load())
			}
		})
	}
}

func TestGatewayLargeCatalogAndSharedUpstreams(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	ctx := context.Background()
	for i := 0; i < 501; i++ {
		u, err := store.CreateUpstream(ctx, "tenant", Upstream{Name: fmt.Sprint(i)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = store.CreateRoute(ctx, "tenant", ModelRoute{Name: fmt.Sprint(i), Model: "m", UpstreamID: u.ID}); err != nil {
			t.Fatal(err)
		}
	}
	candidates, err := store.ResolveCandidates(ctx, "tenant", "chat", "m")
	if err != nil || len(candidates) != 501 {
		t.Fatalf("large catalog: candidates=%d err=%v", len(candidates), err)
	}
	if _, err = store.CreateRoute(ctx, "tenant", ModelRoute{Name: "shared", Model: "m", UpstreamID: candidates[0].Upstream.ID}); err != nil {
		t.Fatal(err)
	}
	candidates, err = store.ResolveCandidates(ctx, "tenant", "chat", "m")
	if err != nil || len(candidates) != 502 {
		t.Fatalf("shared upstream route lost: candidates=%d err=%v", len(candidates), err)
	}
}
