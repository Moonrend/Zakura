package rpc

import (
	"bytes"
	"encoding/base64"
	"io"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/agent/internal/host"
)

type workspaceStreamInput struct {
	bytes.Buffer
	closed bool
}

func (s *workspaceStreamInput) Close() error { s.closed = true; return nil }

func TestPinnedWorkspaceStreamInputAndRetiredClose(t *testing.T) {
	h, binding := workspaceRPCFixture(t)
	input := &workspaceStreamInput{}
	var cols, rows int
	h.ptys["old-stream"] = &host.LiveStream{ID: "old-stream", In: input, Out: io.NopCloser(strings.NewReader("")), ResizeFn: func(c, r int) error { cols, rows = c, r; return nil }}
	h.workspaceStreams["old-stream"] = binding
	params := map[string]any{"workspace": binding, "id": "old-stream", "base64": base64.StdEncoding.EncodeToString([]byte("hello\n")), "streamOwner": h.streamOwner}
	if response := createReceiptRPCCall(t, h, "docker.exec.write", params); response.Error != "" || input.String() != "hello\n" {
		t.Fatalf("pinned base64 input: %+v %q", response, input.String())
	}
	if response := createReceiptRPCCall(t, h, "docker.exec.resize", map[string]any{"workspace": binding, "id": "old-stream", "cols": 132, "rows": 44}); response.Error != "" || cols != 132 || rows != 44 {
		t.Fatalf("pinned resize: %+v %d %d", response, cols, rows)
	}
	if response := createReceiptRPCCall(t, h, "workspace.revoke", binding); response.Error != "" {
		t.Fatal(response.Error)
	}
	if response := createReceiptRPCCall(t, h, "docker.exec.write", params); !strings.Contains(response.Error, "revoked") || input.String() != "hello\n" {
		t.Fatalf("revoked input dispatched: %+v", response)
	}
	other := binding
	other.Target.InstanceID, other.Target.Generation = "new-instance", 2
	for _, request := range []map[string]any{
		{"workspace": other, "id": "old-stream", "streamOwner": h.streamOwner},
		{"workspace": binding, "id": "old-stream", "streamOwner": "wrong-owner"},
		{"workspace": binding, "id": "old-stream"},
		{"id": "old-stream", "streamOwner": h.streamOwner},
	} {
		if response := createReceiptRPCCall(t, h, "docker.exec.close", request); response.Error == "" || input.closed {
			t.Fatalf("unowned close accepted: %+v", response)
		}
	}
	newInput := &workspaceStreamInput{}
	h.ptys["new-stream"] = &host.LiveStream{ID: "new-stream", In: newInput, Out: io.NopCloser(strings.NewReader(""))}
	h.workspaceStreams["new-stream"] = other
	for range 2 {
		if response := createReceiptRPCCall(t, h, "docker.exec.close", map[string]any{"workspace": binding, "id": "old-stream", "streamOwner": h.streamOwner}); response.Error != "" || !input.closed || newInput.closed {
			t.Fatalf("retired cleanup: %+v", response)
		}
	}
	h.CloseStreams()
}

func TestPinnedWorkspaceStreamCloseDoesNotCloseLegacyStream(t *testing.T) {
	h, binding := workspaceRPCFixture(t)
	input := &workspaceStreamInput{}
	h.ptys["legacy-stream"] = &host.LiveStream{ID: "legacy-stream", In: input, Out: io.NopCloser(strings.NewReader(""))}
	if response := createReceiptRPCCall(t, h, "docker.exec.close", map[string]any{"workspace": binding, "id": "legacy-stream", "streamOwner": h.streamOwner}); response.Error == "" || input.closed {
		t.Fatalf("pinned close affected unrelated stream: %+v", response)
	}
	// A replacement handler cannot attest a previous executor's missing stream.
	restarted := New("server", h.StorageRoot)
	if response := createReceiptRPCCall(t, restarted, "docker.exec.close", map[string]any{"workspace": binding, "id": "old-stream", "streamOwner": h.streamOwner}); response.Error == "" {
		t.Fatal("replacement executor claimed old cleanup")
	}
	h.CloseStreams()
}
