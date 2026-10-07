package runtime

import (
	"bufio"
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestRunnerWriteDeadlineBoundsStalledPeer(t *testing.T) {
	conn, peer := net.Pipe()
	defer peer.Close()
	defer conn.Close()
	s := &runnerSession{conn: conn, rw: bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn)), writeGate: make(chan struct{}, 1), done: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- s.writeJSONContext(ctx, runnerFrame{Type: "ping"}) }()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("stalled peer succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("socket write exceeded context budget")
	}
}

func TestRunnerWriteQueueHonorsCancellation(t *testing.T) {
	conn, peer := net.Pipe()
	defer peer.Close()
	defer conn.Close()
	s := &runnerSession{conn: conn, rw: bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn)), writeGate: make(chan struct{}, 1), done: make(chan struct{})}
	s.writeGate <- struct{}{} // another writer owns the connection
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	finished := make(chan error, 1)
	go func() { finished <- s.writeJSONContext(ctx, runnerFrame{Type: "ping"}) }()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("writer queue ignored cancellation")
	}
	<-s.writeGate
}
