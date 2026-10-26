package rpc

import (
	"encoding/json"
	"testing"
)

func TestStreamCleanupExecutorIdentity(t *testing.T) {
	h := New("computer", t.TempDir())
	other := New("computer", t.TempDir())
	if h.streamOwner == "" || h.streamOwner == other.streamOwner {
		t.Fatal("stream executor identities must be unique")
	}
	for _, tc := range []struct {
		name, owner string
		allowed     bool
	}{
		{"legacy", "", true},
		{"same-executor", h.streamOwner, true},
		{"replacement-executor", other.streamOwner, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, _ := json.Marshal(map[string]any{"id": "already-closed-stream", "streamOwner": tc.owner})
			if err := h.ptyClose(raw); (err == nil) != tc.allowed {
				t.Fatalf("close allowed=%v, err=%v", tc.allowed, err)
			}
		})
	}
}
