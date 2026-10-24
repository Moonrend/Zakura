// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

const gatewayKeepaliveInterval = 15 * time.Second

// The upstream may be silent while reasoning or retrying. Keep the downstream
// alive independently, without allowing concurrent writes or splitting SSE frames.
// Headers stay private to the forwarding goroutine until it commits a response.
type gatewayStreamWriter struct {
	http.ResponseWriter
	headers   http.Header
	mu        sync.Mutex
	status    int
	streaming bool
	lineBlank bool
	boundary  bool
	stop      chan struct{}
	done      chan struct{}
}

func newGatewayStreamWriter(ctx context.Context, w http.ResponseWriter, cancel context.CancelFunc, interval time.Duration) *gatewayStreamWriter {
	s := &gatewayStreamWriter{ResponseWriter: w, headers: w.Header().Clone(), lineBlank: true, boundary: true, stop: make(chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(s.done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-s.stop:
				return
			case <-ticker.C:
				if err := s.keepalive(); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	return s
}

func (s *gatewayStreamWriter) close() {
	close(s.stop)
	<-s.done
}

func (s *gatewayStreamWriter) Header() http.Header         { return s.headers }
func (s *gatewayStreamWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *gatewayStreamWriter) writeHeader(status int) {
	if s.status != 0 {
		return
	}
	for key, values := range s.headers {
		s.ResponseWriter.Header()[key] = append([]string(nil), values...)
	}
	s.status = status
	s.streaming = isEventStream(s.headers.Get("Content-Type"))
	s.ResponseWriter.WriteHeader(status)
}

func (s *gatewayStreamWriter) WriteHeader(status int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writeHeader(status)
}

func (s *gatewayStreamWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writeHeader(http.StatusOK)
	n, err := s.ResponseWriter.Write(p)
	for _, b := range p[:n] {
		switch b {
		case '\n':
			s.boundary = s.lineBlank
			s.lineBlank = true
		case '\r':
			s.boundary = false
		default:
			s.boundary = false
			s.lineBlank = false
		}
	}
	return n, err
}

func (s *gatewayStreamWriter) flush() error {
	err := http.NewResponseController(s.ResponseWriter).Flush()
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}

func (s *gatewayStreamWriter) FlushError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writeHeader(http.StatusOK)
	return s.flush()
}

func (s *gatewayStreamWriter) keepalive() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status == 0 {
		// Do not inspect s.headers here: the forwarding goroutine owns that map.
		h := s.ResponseWriter.Header()
		h.Set("Content-Type", "text/event-stream; charset=utf-8")
		h.Set("Cache-Control", "no-cache")
		h.Set("X-Accel-Buffering", "no")
		s.status, s.streaming = http.StatusOK, true
		s.ResponseWriter.WriteHeader(http.StatusOK)
	}
	if !s.streaming || !s.boundary {
		return nil
	}
	if _, err := io.WriteString(s.ResponseWriter, ": keep-alive\n\n"); err != nil {
		return err
	}
	return s.flush()
}

func (s *gatewayStreamWriter) writeError(operation string, status int, message, code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	body := gwErrorBody(operation, status, message, code)
	if s.streaming {
		// A heartbeat has already committed HTTP 200. Report later failures in
		// the requested SSE dialect; emitting a JSON response would corrupt it.
		if operation == "responses" {
			var event map[string]any
			_ = json.Unmarshal(body, &event)
			event["type"] = "error"
			body = rawJSON(event)
		}
		if _, err := fmt.Fprintf(s.ResponseWriter, "event: error\ndata: %s\n\n", body); err != nil {
			return err
		}
		return s.flush()
	}
	s.headers.Set("Content-Type", "application/json")
	s.writeHeader(status)
	_, err := s.ResponseWriter.Write(body)
	return err
}
