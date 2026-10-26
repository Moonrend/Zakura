//go:build !windows

package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDockerStdioDefaultsNonTTYAndReportsExit(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "docker")
	script := `#!/bin/sh
if [ "$1" = version ]; then printf 'test\n'; exit 0; fi
if [ "$1" = inspect ]; then
  [ "$#" = 2 ] && [ "$2" = login-container ] || exit 97
  printf '[{"Id":"login-container","Config":{"Labels":{}}}]\n'
  exit 0
fi
[ "$1" = exec ] && [ "$2" = -i ] && [ "$3" = login-container ] || exit 99
[ ! -t 0 ] && [ ! -t 1 ] || exit 98
printf '{"jsonrpc":"2.0"}\n'
exit 7
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", bin)
	h := New("computer", t.TempDir())
	events := make(chan Msg, 20)
	h.Dispatch(context.Background(), Msg{ID: "start", Method: "docker.exec.start", Params: json.RawMessage(`{"id":"login-container","command":["json-rpc"]}`)}, func(msg Msg) { events <- msg })
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	gotPipe, gotOutput, gotExit := false, false, false
	for !gotPipe || !gotOutput || !gotExit {
		select {
		case msg := <-events:
			if msg.Error != "" {
				t.Fatal(msg.Error)
			}
			if msg.ID == "start" {
				var out struct{ Mode string }
				_ = json.Unmarshal(msg.Result, &out)
				if out.Mode != "pipe" {
					t.Fatalf("default transport=%q", out.Mode)
				}
				gotPipe = true
			}
			if msg.Chan == "stdout" {
				data, _ := base64.StdEncoding.DecodeString(msg.Data)
				gotOutput = gotOutput || strings.Contains(string(data), `"jsonrpc":"2.0"`)
			}
			if msg.Chan == "exit" {
				data, _ := base64.StdEncoding.DecodeString(msg.Data)
				var out struct {
					ExitCode int `json:"exitCode"`
				}
				if json.Unmarshal(data, &out) != nil || out.ExitCode != 7 {
					t.Fatalf("exit=%s", data)
				}
				gotExit = true
			}
		case <-deadline.C:
			t.Fatalf("missing stream events pipe=%v output=%v exit=%v", gotPipe, gotOutput, gotExit)
		}
	}
}
