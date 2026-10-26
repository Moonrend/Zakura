package httpx

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRecovererPreservesHTTPAbort(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewServer(Recoverer(log)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "partial")
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	})))
	defer server.Close()
	resp, err := server.Client().Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if string(body) != "partial" || err == nil {
		t.Fatalf("aborted response was corrupted or completed: body=%q err=%v", body, err)
	}
	response := httptest.NewRecorder()
	Recoverer(log)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("ordinary panic") })).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("ordinary panic status=%d", response.Code)
	}
}

func TestSafeLogPathRedactsBearerURLs(t *testing.T) {
	cases := map[string]string{
		"/api/files/shared/high-entropy-token": "/api/files/shared/[redacted]",
		"/api/invites/invite-secret":           "/api/invites/[redacted]",
		"/api/invites/invite-secret/accept":    "/api/invites/[redacted]/accept",
		"/api/agents/agent-id":                 "/api/agents/agent-id",
	}
	for input, want := range cases {
		if got := safeLogPath(input); got != want {
			t.Errorf("safeLogPath(%q)=%q want %q", input, got, want)
		}
	}
}
