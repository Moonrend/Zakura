package dial

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"zakura.dev/agent/internal/rpc"
)

func TestHubURL(t *testing.T) {
	got, err := hubURL("https://zakura.example/app")
	if err != nil {
		t.Fatal(err)
	}
	if got != "wss://zakura.example/app/api/runtime-nodes/hub" {
		t.Fatalf("got %s", got)
	}
	got, err = hubURL("http://127.0.0.1:8787")
	if err != nil {
		t.Fatal(err)
	}
	if got != "ws://127.0.0.1:8787/api/runtime-nodes/hub" {
		t.Fatalf("got %s", got)
	}
}

func TestConcurrentRPCAndHeartbeatWritesAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	verified := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			verified <- err
			return
		}
		defer ws.Close()
		_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
		var hello rpc.Msg
		if err := ws.ReadJSON(&hello); err != nil {
			verified <- err
			return
		}
		const count = 200
		for i := 0; i < count; i++ {
			if err := ws.WriteJSON(rpc.Msg{Type: "req", ID: fmt.Sprint(i), Method: "test.unknown"}); err != nil {
				verified <- err
				return
			}
			if err := ws.WriteJSON(rpc.Msg{Type: "ping", ID: fmt.Sprint(i)}); err != nil {
				verified <- err
				return
			}
		}
		replies, pongs := 0, 0
		for replies+pongs < count*2 {
			var msg rpc.Msg
			if err := ws.ReadJSON(&msg); err != nil {
				verified <- err
				return
			}
			switch msg.Type {
			case "res":
				replies++
			case "pong":
				pongs++
			}
		}
		if replies != count || pongs != count {
			verified <- fmt.Errorf("replies=%d pongs=%d", replies, pongs)
			return
		}
		verified <- nil
		// Keep the socket idle until cancellation closes the agent's read loop.
		_, _, _ = ws.ReadMessage()
	}))
	defer server.Close()
	done := make(chan error, 1)
	go func() {
		done <- connectOnce(ctx, Config{ServerURL: server.URL, Token: "test", Kind: "server", Handler: rpc.New("server", t.TempDir())})
	}()
	select {
	case err := <-verified:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("concurrent replies stalled")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation did not close the idle connection")
	}
}
