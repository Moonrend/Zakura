package runtime

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

func TestRunnerStreamRetainsStartupOutputAndExit(t *testing.T) {
	conn, peer := net.Pipe()
	defer peer.Close()
	s := &runnerSession{hub: &runnerHub{}, conn: conn, rw: bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn)), writeGate: make(chan struct{}, 1), pending: map[string]chan runnerReply{}, done: make(chan struct{})}
	defer s.close(context.Canceled)
	s.queueStream("fast", "stdout", []byte("startup"))
	s.queueStream("fast", "exit", nil)
	received := make(chan string, 3)
	detach := s.onStream("fast", func(channel string, data []byte) { received <- channel + ":" + string(data) })
	defer detach()
	for _, want := range []string{"stdout:startup", "exit:"} {
		select {
		case got := <-received:
			if got != want {
				t.Fatalf("%q want %q", got, want)
			}
		case <-time.After(time.Second):
			t.Fatal("startup event dropped")
		}
	}
}

func TestRunnerStreamCallbackCanIssueRPC(t *testing.T) {
	conn, peer := net.Pipe()
	defer peer.Close()
	s := &runnerSession{hub: &runnerHub{}, conn: conn, rw: bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn)), writeGate: make(chan struct{}, 1), pending: map[string]chan runnerReply{}, done: make(chan struct{})}
	defer s.close(context.Canceled)
	go s.readLoop()
	result := make(chan error, 1)
	detach := s.onStream("early", func(_ string, _ []byte) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		result <- s.call(ctx, "echo", map[string]any{}, nil)
	})
	defer detach()
	go func() {
		payload, _ := json.Marshal(runnerFrame{Type: "stream", Stream: "early", Chan: "stdout", Data: base64.StdEncoding.EncodeToString([]byte("callback"))})
		writeMaskedText(t, peer, string(payload))
		raw, err := readRunnerServerText(bufio.NewReader(peer))
		if err != nil {
			return
		}
		var frame runnerFrame
		_ = json.Unmarshal([]byte(raw), &frame)
		response, _ := json.Marshal(map[string]any{"type": "res", "id": frame.ID, "ok": true, "result": map[string]any{}})
		writeMaskedText(t, peer, string(response))
	}()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runner read loop deadlocked in callback")
	}
}

func TestRunnerStreamSubscriptionAfterDisconnect(t *testing.T) {
	s := &runnerSession{done: make(chan struct{}), pending: map[string]chan runnerReply{}}
	s.close(context.Canceled)
	received := make(chan string, 1)
	detach := s.onStream("late", func(channel string, _ []byte) { received <- channel })
	defer detach()
	select {
	case channel := <-received:
		if channel != "error" {
			t.Fatalf("disconnected subscription received %q", channel)
		}
	case <-time.After(time.Second):
		t.Fatal("subscription missed runner disconnect")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.streamQueues) != 0 {
		t.Fatal("disconnected runner retained a stream subscription")
	}
}

func TestRunnerStreamBacklogOverflowFailsInsteadOfDropping(t *testing.T) {
	conn, peer := net.Pipe()
	defer peer.Close()
	s := &runnerSession{conn: conn, done: make(chan struct{}), pending: map[string]chan runnerReply{}}
	s.queueStream("unsubscribed", "stdout", []byte(strings.Repeat("x", runnerStreamMaxBytes+1)))
	select {
	case <-s.done:
	case <-time.After(time.Second):
		t.Fatal("overflow silently dropped output")
	}
}
