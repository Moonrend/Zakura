// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGatewayKeepaliveDuringUpstreamSilence(t *testing.T) {
	first, second := make(chan struct{}), make(chan struct{})
	defer func() { close(second) }()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		stream := newGatewayStreamWriter(ctx, w, cancel, 10*time.Millisecond)
		defer stream.close()
		select {
		case <-first:
		case <-ctx.Done():
			return
		}
		stream.Header().Set("Content-Type", "text/event-stream")
		stream.Header().Set("X-Request-Id", "provider-request")
		_, _ = io.WriteString(stream, "data: first\n\n")
		_ = stream.FlushError()
		select {
		case <-second:
		case <-ctx.Done():
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !isEventStream(resp.Header.Get("Content-Type")) || resp.StatusCode != http.StatusOK {
		t.Fatalf("headers: %d %v", resp.StatusCode, resp.Header)
	}
	reader := bufio.NewReader(resp.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != ": keep-alive\n" {
		t.Fatalf("before first event: %q %v", line, err)
	}
	close(first)
	for {
		line, err = reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "data: first\n" {
			break
		}
	}
	for {
		line, err = reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == ": keep-alive\n" {
			break
		}
	}
}

func TestGatewayKeepaliveTranscriptIgnoresComments(t *testing.T) {
	h, p := gatewayTestHandler(t)
	body := map[string]any{"model": "m", "stream": true, "messages": []any{map[string]any{"role": "user", "content": "hello"}}}
	response := ": keep-alive\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\n: keep-alive\n\ndata: [DONE]\n\n"
	recordGatewayTest(t, h, p, http.Header{}, "chat", body, response)
	sessions, err := h.store.listGatewaySessions(context.Background(), p.TenantID, p.SpaceID, 10, 0)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("sessions: %+v %v", sessions, err)
	}
	events, err := h.store.gatewayEvents(context.Background(), p.TenantID, p.SpaceID, sessions[0].ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	completed := false
	for _, event := range events {
		if event.Type == "run_error" {
			t.Fatalf("heartbeat caused transcript error: %+v", event)
		}
		if event.Type == "run_end" {
			completed = strings.Contains(string(event.Payload), "completed")
		}
	}
	if !completed {
		t.Fatal("stream transcript did not complete")
	}
}

func TestGatewayKeepalivePreservesEventBoundaries(t *testing.T) {
	w := httptest.NewRecorder()
	stream := newGatewayStreamWriter(context.Background(), w, func() {}, time.Hour)
	defer stream.close()
	stream.Header().Set("Content-Type", "text/event-stream")
	parts := []string{"data: {\"text\":\"", "hello\"}", "\r", "\n", "\r", "\n"}
	for _, part := range parts {
		_, _ = io.WriteString(stream, part)
		if err := stream.keepalive(); err != nil {
			t.Fatal(err)
		}
	}
	want := strings.Join(parts, "") + ": keep-alive\n\n"
	if w.Body.String() != want {
		t.Fatalf("SSE frame was split: %q", w.Body.String())
	}
}

func TestGatewayKeepaliveErrors(t *testing.T) {
	for _, operation := range []string{"chat", "messages", "responses"} {
		for _, heartbeat := range []bool{false, true} {
			t.Run(operation+map[bool]string{false: "_before_heartbeat", true: "_after_heartbeat"}[heartbeat], func(t *testing.T) {
				w := httptest.NewRecorder()
				stream := newGatewayStreamWriter(context.Background(), w, func() {}, time.Hour)
				defer stream.close()
				if heartbeat {
					if err := stream.keepalive(); err != nil {
						t.Fatal(err)
					}
				}
				writeGatewayFailure(stream, operation, &gatewayRouteError{Status: http.StatusTooManyRequests, RetryAfter: "2", Body: []byte(`{"error":{"message":"busy"}}`)})
				if heartbeat {
					if w.Code != http.StatusOK || !isEventStream(w.Header().Get("Content-Type")) {
						t.Fatalf("committed SSE changed: %d %v", w.Code, w.Header())
					}
					ev, err := gwNewSSEReader(strings.NewReader(w.Body.String())).Next()
					if err != nil || ev.Event != "error" || !strings.Contains(ev.Data, "busy") {
						t.Fatalf("stream error: %+v %v", ev, err)
					}
				} else if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "2" || !strings.Contains(w.Body.String(), "busy") {
					t.Fatalf("HTTP error: %d %v %s", w.Code, w.Header(), w.Body.String())
				}
			})
		}
	}
}

func TestGatewayKeepaliveUpstreamHTTPError(t *testing.T) {
	w := httptest.NewRecorder()
	stream := newGatewayStreamWriter(context.Background(), w, func() {}, time.Hour)
	defer stream.close()
	if err := stream.keepalive(); err != nil {
		t.Fatal(err)
	}
	resp := &ProviderResponse{Status: http.StatusBadRequest, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"message":"invalid input"}}`)), Stream: true, Operation: "chat"}
	if err := copyProviderResponse(stream, resp); err != nil {
		t.Fatal(err)
	}
	ev, err := gwNewSSEReader(strings.NewReader(w.Body.String())).Next()
	if err != nil || ev.Event != "error" || !strings.Contains(ev.Data, "invalid input") {
		t.Fatalf("HTTP error after heartbeat: %+v %v", ev, err)
	}
}

func TestGatewayKeepaliveInvalidCompletion(t *testing.T) {
	w := httptest.NewRecorder()
	stream := newGatewayStreamWriter(context.Background(), w, func() {}, time.Hour)
	defer stream.close()
	if err := stream.keepalive(); err != nil {
		t.Fatal(err)
	}
	resp := &ProviderResponse{Status: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`not JSON`)), Stream: true, Operation: "chat", Protocol: "openai"}
	if err := copyProviderResponse(stream, resp); err == nil {
		t.Fatal("invalid completion was accepted")
	}
	ev, err := gwNewSSEReader(strings.NewReader(w.Body.String())).Next()
	if err != nil || ev.Event != "error" || !strings.Contains(ev.Data, "invalid completion") {
		t.Fatalf("invalid completion after heartbeat: %+v %v", ev, err)
	}
}

func TestGatewayKeepaliveDoesNotCorruptJSON(t *testing.T) {
	w := httptest.NewRecorder()
	stream := newGatewayStreamWriter(context.Background(), w, func() {}, time.Hour)
	defer stream.close()
	stream.Header().Set("Content-Type", "application/json")
	stream.WriteHeader(http.StatusBadRequest)
	_, _ = io.WriteString(stream, `{"error":`)
	if err := stream.keepalive(); err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(stream, `"invalid"}`)
	if w.Body.String() != `{"error":"invalid"}` {
		t.Fatalf("heartbeat corrupted JSON: %s", w.Body)
	}
}

type gatewayFailedWriter struct{ header http.Header }

func (w gatewayFailedWriter) Header() http.Header { return w.header }
func (w gatewayFailedWriter) WriteHeader(int)     {}
func (w gatewayFailedWriter) Write([]byte) (int, error) {
	return 0, errors.New("client disconnected")
}

func TestGatewayKeepaliveCancelsDisconnectedClient(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := newGatewayStreamWriter(ctx, gatewayFailedWriter{header: http.Header{}}, cancel, time.Millisecond)
	defer stream.close()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("heartbeat write failure did not cancel upstream")
	}
}
