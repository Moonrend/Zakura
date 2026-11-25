// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

func TestSpaceWorkspaceTerminalRejectsHostMode(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	hostCalls := make(chan string, 1)
	h := builtinToolHarness(t, d, "rnr_host_shell", func(method string, params map[string]any) (any, error) {
		if strings.HasPrefix(method, "host.pty.") {
			select {
			case hostCalls <- method:
			default:
			}
		}
		return map[string]any{"ok": true}, nil
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
	var response struct{ Type, Message string }
	if err := json.Unmarshal([]byte(raw), &response); err != nil || response.Type != "error" || !strings.Contains(response.Message, "migration") {
		t.Fatalf("host terminal response=%s err=%v", raw, err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("host terminal refusal did not complete")
	}
	select {
	case method := <-hostCalls:
		t.Fatalf("host terminal reached runner method %s", method)
	default:
	}
}
