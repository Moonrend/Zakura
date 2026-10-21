// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodemodeHarnessDiscoveryAndOutput(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not available")
	}
	for _, scenario := range []struct {
		name, code    string
		ok, truncated bool
	}{
		{"discovery", `const match = await searchTools("echo", {limit: 1}); const d = await describeTool(match.tools[0].name); const r = await Promise.all([tools[d.name]({n:1}), tools[d.name]({n:2})]); return r;`, true, false},
		{"partial-error", `text("kept"); throw new Error("boom");`, false, false},
		{"bounded", `text("x".repeat(100000)); text("ignored");`, true, true},
		{"namespace", `text((await tools) === tools); text(tools.then === undefined);`, true, false},
		{"unawaited", `tools.echo({});`, false, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "harness.mjs")
			if err := os.WriteFile(path, []byte(codemodeHarnessJS), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, node, path)
			stdin, _ := cmd.StdinPipe()
			stdout, _ := cmd.StdoutPipe()
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
			write := func(value any) { raw, _ := json.Marshal(value); _, _ = stdin.Write(append(raw, '\n')) }
			write(map[string]any{"op": "run", "code": scenario.code})
			scanner := bufio.NewScanner(stdout)
			scanner.Buffer(make([]byte, 4096), 1<<20)
			calls, discoveries := 0, 0
			for scanner.Scan() {
				var message map[string]any
				if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
					t.Fatal(err)
				}
				switch message["op"] {
				case "discover":
					discoveries++
					write(map[string]any{"op": "result", "id": message["id"], "ok": true, "result": map[string]any{"tools": []map[string]any{{"name": "echo", "inputSchema": map[string]any{"type": "object"}}}}})
				case "call":
					calls++
					if scenario.name != "unawaited" {
						write(map[string]any{"op": "result", "id": message["id"], "ok": true, "result": message["args"]})
					}
				case "done":
					if message["ok"] != scenario.ok || message["truncated"] != scenario.truncated {
						t.Fatalf("completion: %s", scanner.Text())
					}
					if len(scanner.Bytes()) > 25000 {
						t.Fatal("output limit ignored")
					}
					if scenario.name == "partial-error" && !strings.Contains(scanner.Text(), "kept") {
						t.Fatal("partial output discarded")
					}
					if scenario.name == "discovery" && (calls != 2 || discoveries != 2) {
						t.Fatalf("calls=%d discoveries=%d", calls, discoveries)
					}
					return
				}
			}
			t.Fatalf("no completion: %v context=%v", scanner.Err(), ctx.Err())
		})
	}
}
