package httpx

import "testing"

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
