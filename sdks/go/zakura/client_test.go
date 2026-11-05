package zakura

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func client(t *testing.T, config Config) *Client {
	t.Helper()
	c, err := NewClient(config)
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func TestEncodedPathQueryHeadersAndJSONNull(t *testing.T) {
	c := client(t, Config{BaseURL: "https://example.test/prefix", Token: "secret"})
	query := url.Values{"tag": {"one", "two"}}
	headers := http.Header{"X-Trace": {"original"}}
	base := c.GetApiAgentsById("猫 /?%")
	builder := base.WithQuery(query).WithHeaders(headers)
	query.Set("tag", "mutated")
	headers.Set("X-Trace", "mutated")
	req, err := builder.Build(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if req.URL.EscapedPath() != "/prefix/api/agents/%E7%8C%AB%20%2F%3F%25" || req.Header.Get("Authorization") != "Bearer secret" || req.Header.Get("X-Trace") != "original" || len(req.URL.Query()["tag"]) != 2 {
		t.Fatalf("request: %s %#v", req.URL.String(), req.Header)
	}
	original, _ := base.Build(context.Background())
	if original.URL.RawQuery != "" || original.Header.Get("X-Trace") != "" {
		t.Fatal("builder mutated original")
	}
	request, err := c.PostApiAgents().WithJSON(nil).Build(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(request.Body)
	if string(body) != "null" {
		t.Fatalf("JSON null: %q", body)
	}
	for _, id := range []string{"", ".", ".."} {
		if _, err = c.GetApiAgentsById(id).Build(context.Background()); err == nil {
			t.Fatalf("invalid path accepted: %q", id)
		}
	}
}
func TestRetryReadOnlyAndBodyLimit(t *testing.T) {
	var count atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if count.Add(1) == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(503)
			return
		}
		io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()
	c := client(t, Config{BaseURL: server.URL, Retry: RetryPolicy{MaxAttempts: 3}})
	response, err := c.GetApiAgents().Execute(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]bool
	if response.Decode(&value) != nil || !value["ok"] || count.Load() != 2 {
		t.Fatal("read retry or JSON decode failed")
	}
	count.Store(0)
	_, err = c.PostApiAgents().WithJSON(map[string]string{"name": "test"}).Execute(context.Background())
	var api *APIError
	if !errors.As(err, &api) || api.StatusCode != 503 || count.Load() != 1 {
		t.Fatalf("mutation retried: %v %d", err, count.Load())
	}
	small := client(t, Config{BaseURL: server.URL, MaxResponseBytes: 3})
	_, err = small.GetApiAgents().Execute(context.Background())
	if err == nil || !strings.Contains(err.Error(), "byte limit") {
		t.Fatal("response limit ignored")
	}
}
func TestRedirectCredentialsStayOnOrigin(t *testing.T) {
	var redirected atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer source.Close()
	c := client(t, Config{BaseURL: source.URL, Token: "secret"})
	_, err := c.GetApiAgents().Execute(context.Background())
	var api *APIError
	if !errors.As(err, &api) || api.StatusCode != 302 || redirected.Load() != 0 {
		t.Fatal("redirect followed")
	}
}
func TestDeadlineAndCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	c := client(t, Config{BaseURL: server.URL})
	_, err := c.GetApiAgents().WithTimeout(10 * time.Millisecond).Execute(context.Background())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = c.GetApiAgents().Execute(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}
func TestConfigValidationAndCursorGuard(t *testing.T) {
	for _, base := range []string{"relative", "ftp://example.test", "https://user:password@example.test", "https://example.test?q=1", "https://example.test#fragment"} {
		if _, err := NewClient(Config{BaseURL: base}); err == nil {
			t.Fatal("invalid base accepted")
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{}`) }))
	defer server.Close()
	c := client(t, Config{BaseURL: server.URL})
	err := c.Pages(context.Background(), CallOptions{Method: "GET", Path: "/api/agents"}, "cursor", 4, func(*Response) (string, error) { return "same", nil })
	if err == nil || !strings.Contains(err.Error(), "repeated") {
		t.Fatalf("cursor guard: %v", err)
	}
	if (&Response{Body: []byte(`{} {}`)}).Decode(&map[string]any{}) == nil {
		t.Fatal("trailing JSON accepted")
	}
}
