// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCodemodeProtocolRejectsReplayAndStreamFailure(t *testing.T) {
	for _, scenario := range []string{"zero", "negative", "repeated", "disconnect", "oversized", "backpressure", "result-write", "nested-result-write"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			store := NewStore(d)
			node := "node"
			space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
			if err != nil {
				t.Fatal(err)
			}
			agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, EnableMemory: true})
			if err != nil {
				t.Fatal(err)
			}
			var closed atomic.Int32
			h := codemodeToolHarness(t, d, "rnr_protocol-guard", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
				switch method {
				case "sys.info":
					return codemodeInfo(), nil
				case "host.fs.write":
					return map[string]any{"ok": true}, nil
				case "docker.list":
					return []map[string]any{{"dockerId": "ws", "status": "running", "labels": map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
				case "docker.exec.start":
					return map[string]any{"id": "protocol-process"}, nil
				case "docker.exec.close":
					closed.Add(1)
					return map[string]any{"ok": true}, nil
				case "docker.exec.write":
					data, _ := base64.StdEncoding.DecodeString(fmt.Sprint(params["base64"]))
					if !strings.Contains(string(data), `"op":"run"`) {
						if scenario == "result-write" || scenario == "nested-result-write" {
							return fmt.Errorf("fixture result write rejected"), nil
						}
						return map[string]any{"ok": true}, nil
					}
					return map[string]any{"ok": true}, func() {
						switch scenario {
						case "disconnect":
							emit("protocol-process", "error", "fixture transport lost")
						case "oversized":
							emit("protocol-process", "stdout", strings.Repeat("x", (4<<20)+1))
						case "backpressure":
							for i := 0; i < 300; i++ {
								emit("protocol-process", "stdout", map[string]any{"op": "done", "ok": true, "output": []any{}})
							}
						default:
							id := 0
							if scenario == "negative" {
								id = -1
							}
							if scenario == "repeated" || scenario == "result-write" || scenario == "nested-result-write" {
								id = 1
							}
							call := map[string]any{"op": "call", "id": id, "name": "memory_remember", "args": map[string]any{"content": "once"}}
							if scenario == "nested-result-write" {
								call["name"] = "codemode"
							}
							emit("protocol-process", "stdout", call)
							if scenario == "repeated" {
								emit("protocol-process", "stdout", call)
							}
						}
					}
				default:
					return nil, nil
				}
			})
			session, err := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
			if err != nil {
				t.Fatal(err)
			}
			run, err := store.StartRun(context.Background(), "tenant", agent.ID, session.ID, "test", nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), computerRunKey{}, run.ID), 10*time.Second)
			defer cancel()
			_, err = h.runCodemodeTool(ctx, "tenant", agent.ID, session.ID, "outer", json.RawMessage(`{"code":"fixture"}`))
			if (err == nil) != (scenario == "backpressure") {
				t.Fatalf("protocol result=%v", err)
			}
			if (scenario == "result-write" || scenario == "nested-result-write") && !strings.Contains(err.Error(), "fixture result write rejected") {
				t.Fatalf("result write failure was hidden: %v", err)
			}
			if ctx.Err() != nil {
				t.Fatal("stream failure waited for the caller timeout")
			}
			wantClosed := int32(1)
			if scenario == "oversized" {
				// The transport's tighter stream bound disconnects first. A lost
				// connection cannot acknowledge remote cleanup.
				wantClosed = 0
				if _, err := h.hub.get("node"); err == nil {
					t.Fatal("oversized stream left the transport usable")
				}
			}
			if closed.Load() != wantClosed {
				t.Fatalf("process cleanup calls=%d want=%d", closed.Load(), wantClosed)
			}
			want := int64(0)
			if scenario == "repeated" || scenario == "result-write" {
				want = 1
			}
			var effects int64
			if err := d.Gorm.Table("memories").Count(&effects).Error; err != nil || effects != want {
				t.Fatalf("effects=%d want=%d err=%v", effects, want, err)
			}
		})
	}
}
