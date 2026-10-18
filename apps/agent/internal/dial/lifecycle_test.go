package dial

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/internal/rpc"
	"github.com/gorilla/websocket"
)

func TestDialFixtureProcess(t *testing.T) {
	if os.Getenv("ZAKURA_DIAL_FIXTURE") == "" {
		return
	}
	fmt.Println("fixture-ready")
	if os.Getenv("ZAKURA_DIAL_FIXTURE") == "sleep" {
		time.Sleep(10 * time.Second)
		os.Exit(0)
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		fmt.Println("echo:" + scanner.Text())
	}
	os.Exit(0)
}

func TestRemoteInteractiveAndRequestCancellation(t *testing.T) {
	t.Setenv("ZAKURA_SANDBOX_ENABLED", "0")
	verified := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			verified <- err
			return
		}
		defer ws.Close()
		_ = ws.SetReadDeadline(time.Now().Add(8 * time.Second))
		var hello rpc.Msg
		if err := ws.ReadJSON(&hello); err != nil {
			verified <- err
			return
		}
		params := func(mode string) json.RawMessage {
			p, _ := json.Marshal(map[string]any{"command": []string{os.Args[0], "-test.run=^TestDialFixtureProcess$"}, "env": map[string]string{"ZAKURA_DIAL_FIXTURE": mode}})
			return p
		}
		if err := ws.WriteJSON(rpc.Msg{Type: "req", ID: "start", Method: "host.pty.start", Params: params("echo")}); err != nil {
			verified <- err
			return
		}
		stream := ""
		output := ""
		wrote := false
		closed := false
		for {
			var m rpc.Msg
			if err := ws.ReadJSON(&m); err != nil {
				verified <- err
				return
			}
			if m.Type == "res" && m.ID == "start" {
				var result struct{ ID string }
				_ = json.Unmarshal(m.Result, &result)
				stream = result.ID
				if m.OK == nil || !*m.OK || stream == "" {
					verified <- fmt.Errorf("start failed: %s", m.Error)
					return
				}
			}
			if m.Type == "stream" {
				data, err := base64.StdEncoding.DecodeString(m.Data)
				if err != nil {
					verified <- err
					return
				}
				output += string(data)
			}
			if stream != "" && !wrote {
				input := "remote-roundtrip\n"
				if runtime.GOOS == "windows" {
					input = "remote-roundtrip\r"
				}
				raw, _ := json.Marshal(map[string]any{"id": stream, "data": input})
				_ = ws.WriteJSON(rpc.Msg{Type: "req", ID: "write", Method: "host.pty.write", Params: raw})
				wrote = true
			}
			if strings.Contains(output, "echo:remote-roundtrip") && !closed {
				raw, _ := json.Marshal(map[string]any{"id": stream})
				_ = ws.WriteJSON(rpc.Msg{Type: "req", ID: "close", Method: "host.pty.close", Params: raw})
				closed = true
			}
			if closed && m.Type == "stream" && m.Chan == "exit" {
				break
			}
		}
		_ = ws.WriteJSON(rpc.Msg{Type: "req", ID: "cancel", Method: "host.exec", Params: params("sleep")})
		_ = ws.WriteJSON(rpc.Msg{Type: "cancel", ID: "cancel"})
		for {
			var m rpc.Msg
			if err := ws.ReadJSON(&m); err != nil {
				verified <- err
				return
			}
			if m.Type == "res" && m.ID == "cancel" {
				if m.OK == nil || *m.OK {
					verified <- fmt.Errorf("cancelled exec succeeded")
					return
				}
				break
			}
		}
		verified <- nil
	}))
	defer server.Close()
	done := make(chan error, 1)
	go func() {
		done <- connectOnce(context.Background(), Config{ServerURL: server.URL, Token: "rnr_fixture", Kind: "computer", Handler: rpc.New("computer", t.TempDir())})
	}()
	select {
	case err := <-verified:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("remote interactive fixture stalled")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("remote disconnect did not stop transport")
	}
}
