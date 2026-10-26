// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"sync/atomic"
	"testing"
)

func TestACPCustomRuntimeRequiresCanonicalWorkspace(t *testing.T) {
	for _, scenario := range []string{"canonical", "multiple", "foreign-tenant", "foreign-space", "incomplete", "stopped"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			ctx := context.Background()
			store := NewStore(d)
			node := "node"
			space, err := store.CreateSpace(ctx, "tenant", Space{Name: "ACP target", RuntimeNodeID: &node, WorkspaceKind: "container"})
			if err != nil {
				t.Fatal(err)
			}
			a, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
			if err != nil {
				t.Fatal(err)
			}
			session, err := store.CreateSession(ctx, "tenant", "", a.ID, Session{Kind: "acp"})
			if err != nil {
				t.Fatal(err)
			}
			container := computerContainer{DockerID: "canonical", Status: "running", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}
			switch scenario {
			case "foreign-tenant":
				container.Labels["zakura.tenant"] = "other"
			case "foreign-space":
				container.Labels["zakura.space"] = "other"
			case "incomplete":
				container.DockerID = ""
			case "stopped":
				container.Status = "exited"
			}
			containers := []computerContainer{container}
			if scenario == "multiple" {
				other := container
				other.DockerID = "ambiguous"
				containers = append(containers, other)
			}
			var starts atomic.Int32
			h := codemodeToolHarness(t, d, "rnr_acp_canonical", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
				switch method {
				case "sys.info":
					return codemodeInfo(), nil
				case "docker.list":
					return containers, nil
				case "docker.exec.start":
					starts.Add(1)
					if params["id"] != "canonical" {
						t.Errorf("ACP selected wrong container: %#v", params)
					}
					return map[string]any{"id": "adapter"}, nil
				case "docker.exec.write":
					rpc := decodeCodemodeParams(params)
					result := map[string]any{}
					if rpc["method"] == "session/new" {
						result["sessionId"] = "protocol-session"
					}
					return map[string]any{}, func() {
						if rpc["id"] != nil {
							emit("adapter", "stdout", map[string]any{"jsonrpc": "2.0", "id": rpc["id"], "result": result})
						}
					}
				default:
					return map[string]any{"ok": true}, nil
				}
			})
			manager := newACPRuntimeManager(h)
			defer manager.closeAll()
			rt, err := manager.start(ctx, "tenant", a.ID, session.ID, "codex", "", session, map[string]any{"command": "fake-adapter", "args": []string{"--stdio"}})
			if scenario == "canonical" {
				if err != nil || rt == nil || starts.Load() != 1 {
					t.Fatalf("canonical launch starts=%d runtime=%v err=%v", starts.Load(), rt != nil, err)
				}
				rt.close(nil)
			} else if err == nil || starts.Load() != 0 {
				t.Fatalf("unverified workspace started ACP: starts=%d err=%v", starts.Load(), err)
			}
		})
	}
}

func decodeCodemodeParams(params map[string]any) map[string]any {
	raw, _ := base64.StdEncoding.DecodeString(builtinStringArg(params, "base64"))
	var message map[string]any
	_ = json.Unmarshal(raw, &message)
	return message
}
