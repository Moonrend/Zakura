package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSandboxOutputNeverSpillsAndTracksServerTruncation(t *testing.T) {
	for _, tc := range []struct {
		name, mode      string
		size            int
		runnerTruncated bool
	}{
		{"explicit boundary", "sandbox", toolOutputMaxBytes, false},
		{"explicit preview", "sandbox", toolOutputMaxBytes + 1, false},
		{"operator enforced preview", "", toolOutputMaxBytes + 1000, false},
		{"runner truncated", "sandbox", 10, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			store := NewStore(d)
			node := "node"
			space, e := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
			if e != nil {
				t.Fatal(e)
			}
			agent, e := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
			if e != nil {
				t.Fatal(e)
			}
			var writes atomic.Int32
			h := builtinToolHarness(t, d, "rnr_output", func(method string, p map[string]any) (any, error) {
				switch method {
				case "sys.info":
					return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{}, "hostInfo": map[string]any{}}, nil
				case "sandbox.policy":
					return map[string]any{"enforced": tc.mode == "", "sandbox": map[string]any{"enabled": true}}, nil
				case "host.exec", "host.exec.start":
					return map[string]any{"id": "job", "running": false, "executionMode": "sandbox", "isolated": true, "exitCode": 0, "stdout": strings.Repeat("x", tc.size), "stderr": strings.Repeat("e", tc.size), "truncated": tc.runnerTruncated}, nil
				case "host.fs.write", "host.fs.mkdir":
					writes.Add(1)
					return map[string]any{"ok": true}, nil
				default:
					return nil, errors.New("unexpected RPC " + method)
				}
			})
			args := map[string]any{"command": "printf fixture"}
			if tc.mode != "" {
				args["execution_mode"] = tc.mode
			}
			raw, e := h.runShellExec(context.Background(), "tenant", agent.ID, args)
			out := decodeBuiltinResult(t, raw, e)
			want := tc.runnerTruncated || tc.size > toolOutputMaxBytes
			if out["truncated"] != want {
				t.Fatalf("truncation=%v want%v", out["truncated"], want)
			}
			if writes.Load() != 0 {
				t.Fatal("sandbox output wrote to host workspace")
			}
			for _, key := range []string{"stdout", "stderr"} {
				v := out[key].(string)
				if len(v) > toolOutputMaxBytes || strings.Contains(v, "full output:") {
					t.Fatalf("invalid %s preview", key)
				}
			}
		})
	}
}

func TestSandboxExecutionTimeoutKeepsFinalOutput(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	var started time.Time
	h := builtinToolHarness(t, d, "rnr_timeout_output", func(method string, p map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{}, "hostInfo": map[string]any{}}, nil
		case "sandbox.policy":
			return map[string]any{"sandbox": map[string]any{"enabled": true}}, nil
		case "host.exec.start":
			if p["timeoutMs"].(float64) > 1000 {
				t.Error("transport grace increased execution budget")
			}
			started = time.Now()
			return map[string]any{"id": "job", "running": true, "executionMode": "sandbox", "isolated": true}, nil
		case "host.exec.get":
			if time.Since(started) < 1100*time.Millisecond {
				return map[string]any{"id": "job", "running": true, "executionMode": "sandbox", "isolated": true}, nil
			}
			return map[string]any{"id": "job", "running": false, "executionMode": "sandbox", "isolated": true, "exitCode": 137, "stdout": "before timeout", "stderr": "diagnostic", "timedOut": true}, nil
		default:
			return nil, errors.New("unexpected RPC " + method)
		}
	})
	raw, e := h.runShellExec(context.Background(), "tenant", agent.ID, map[string]any{"command": "fixture", "timeout_ms": float64(1000), "execution_mode": "sandbox"})
	out := decodeBuiltinResult(t, raw, e)
	if out["timedOut"] != true || out["stdout"] != "before timeout" || out["stderr"] != "diagnostic" {
		t.Fatalf("lost terminal result: %s", raw)
	}
}

func TestSandboxCallerCancellationKeepsConfirmedBoundedOutput(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := builtinToolHarness(t, d, "rnr_cancel_output", func(method string, p map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{}, "hostInfo": map[string]any{}}, nil
		case "host.exec.start":
			cancel()
			return map[string]any{"id": "job", "running": true, "executionMode": "sandbox", "isolated": true}, nil
		case "host.exec.kill":
			return map[string]any{"id": "job", "running": false, "executionMode": "sandbox", "isolated": true, "exitCode": 137, "stdout": "bounded final", "cancelled": true}, nil
		default:
			return nil, errors.New("unexpected RPC " + method)
		}
	})
	runner, _ := h.hub.get("node")
	out, e := runSandboxCommand(ctx, runner, map[string]any{"spaceId": "space", "executionMode": "sandbox"})
	if !errors.Is(e, context.Canceled) || out["stdout"] != "bounded final" || out["cancelled"] != true {
		raw, _ := json.Marshal(out)
		t.Fatalf("result=%s err=%v", raw, e)
	}
}

func TestLegacyWorkspaceDeadlineRemainsUnchanged(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	h := builtinToolHarness(t, d, "rnr_legacy_deadline", func(method string, p map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{}, "hostInfo": map[string]any{}}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "labels": map[string]string{"zakura.purpose": "workspace"}}}, nil
		case "docker.exec":
			time.Sleep(150 * time.Millisecond)
			return map[string]any{"exitCode": 0}, nil
		default:
			return nil, errors.New("unexpected RPC " + method)
		}
	})
	_, e := h.runtimeExecWithModeTimeout(context.Background(), "tenant", agent.ID, "host", 25, "true")
	if !errors.Is(e, context.DeadlineExceeded) {
		t.Fatalf("legacy deadline changed: %v", e)
	}
}
