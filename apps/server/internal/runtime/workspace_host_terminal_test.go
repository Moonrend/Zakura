// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSpaceWorkspaceTerminalSelectsHostShell(t *testing.T) {
	for _, platform := range []string{"windows", "linux", "legacy-windows"} {
		t.Run(platform, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			starts := make(chan map[string]any, 1)
			h := builtinToolHarness(t, d, "rnr_host_shell", func(method string, params map[string]any) (any, error) {
				switch method {
				case "sys.info":
					info := codemodeInfo()
					if platform == "legacy-windows" {
						info["hostInfo"] = map[string]any{"platform": "windows"}
					} else {
						info["goos"] = platform
					}
					return info, nil
				case "host.pty.start":
					starts <- params
					return map[string]any{"id": "host-terminal"}, nil
				default:
					return map[string]any{"ok": true}, nil
				}
			})
			runner, err := h.hub.get("node")
			if err != nil {
				t.Fatal(err)
			}
			server, client := net.Pipe()
			defer server.Close()
			defer client.Close()
			bridge := &workspaceBridge{conn: server, rw: bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server))}
			done := make(chan struct{})
			go func() {
				defer close(done)
				h.bridgeTerminalContainer(context.Background(), bridge, runner, "space", "host", "", "")
			}()
			_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
			raw, err := readRunnerServerText(bufio.NewReader(client))
			if err != nil {
				t.Fatal(err)
			}
			var ready struct{ Type, Command string }
			if err := json.Unmarshal([]byte(raw), &ready); err != nil || ready.Type != "ready" {
				t.Fatalf("terminal ready=%s err=%v", raw, err)
			}
			want := []string{"bash", "-l"}
			if platform != "linux" {
				want = []string{"powershell.exe", "-NoLogo", "-NoProfile"}
			}
			params := <-starts
			if !reflect.DeepEqual(stringSlice(params["command"]), want) || ready.Command != strings.Join(want, " ") || params["spaceId"] != "space" || params["workingDir"] != "/workspace" {
				t.Fatalf("shell allocation=%#v ready=%+v want=%v", params, ready, want)
			}
			_ = client.Close()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("host terminal did not close")
			}
		})
	}
}
