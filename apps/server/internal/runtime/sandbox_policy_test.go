package runtime

import (
	"context"
	"encoding/json"
	"testing"
)

func TestSandboxAgentPolicyForcesShellAndDeniesOtherTools(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "sandbox"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "sandbox", SpaceID: space.ID, Config: json.RawMessage(`{"executionMode":"sandbox"}`)})
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	raw, err := h.sandboxToolPolicy(context.Background(), "tenant", agent.ID, "shell_exec", json.RawMessage(`{"command":"echo hello","execution_mode":"host"}`))
	if err != nil {
		t.Fatal(err)
	}
	var args map[string]any
	_ = json.Unmarshal(raw, &args)
	if args["execution_mode"] != "sandbox" {
		t.Fatalf("model bypassed sandbox: %s", raw)
	}
	for _, name := range []string{"fs_read", "fs_write", "apply_patch", "codemode", "delegate_agent", "browser_open", "computer_click", "mcp__evil__shell_exec", "instance:shell_exec", " shell_exec", "SHELL_EXEC", "unknown_future_tool"} {
		if _, err := h.dispatchAgentTool(context.Background(), "tenant", agent.ID, "", "", name, json.RawMessage(`{}`)); err == nil {
			t.Fatalf("allowed %s", name)
		}
	}
	if _, err := h.sandboxToolPolicy(context.Background(), "other-tenant", agent.ID, "shell_exec", json.RawMessage(`{}`)); err == nil {
		t.Fatal("cross-tenant agent allowed")
	}
	catalog, err := h.cachedAgentToolCatalog(context.Background(), "tenant", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Tools) != 2 {
		t.Fatalf("unexpected sandbox catalog: %+v", catalog)
	}
	for _, tool := range catalog.Tools {
		if tool.Name != "shell_exec" && tool.Name != "ask_user" {
			t.Fatalf("unsafe tool: %s", tool.Name)
		}
	}
	manager := newACPRuntimeManager(h)
	if _, err := manager.ensure(context.Background(), "tenant", agent.ID, "sid"); err == nil {
		t.Fatal("sandbox ACP allowed")
	}
	for _, bad := range []any{"invalid", false, nil} {
		_, err = store.UpdateAgent(context.Background(), "tenant", agent.ID, map[string]any{"config": map[string]any{"executionMode": bad}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = h.agentSandboxRequired(context.Background(), "tenant", agent.ID); err == nil {
			t.Fatalf("invalid mode accepted: %#v", bad)
		}
	}
}

func TestSandboxShellUsesPreflightAndNeverFallsBack(t *testing.T) {
	for _, scenario := range []string{"supported", "old_runner", "mismatch", "cleanup_error"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			store := NewStore(d)
			node := "node"
			space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
			if err != nil {
				t.Fatal(err)
			}
			agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			h := builtinToolHarness(t, d, "rnr_sandbox", func(method string, p map[string]any) (any, error) {
				switch method {
				case "sys.info":
					return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{}, "hostInfo": map[string]any{}}, nil
				case "sandbox.policy":
					return map[string]any{"sandbox": map[string]any{"enabled": scenario != "old_runner"}}, nil
				case "host.exec.start":
					calls++
					if p["executionMode"] != "sandbox" || p["spaceId"] != space.ID {
						t.Errorf("unsafe dispatch: %#v", p)
					}
					if scenario == "cleanup_error" {
						return map[string]any{"id": "job", "running": false, "executionMode": "sandbox", "isolated": true, "exitCode": 0, "error": "cleanup failure"}, nil
					}
					if scenario == "mismatch" {
						return map[string]any{"id": "job", "running": false, "executionMode": "host", "isolated": false, "exitCode": 0}, nil
					}
					return map[string]any{"id": "job", "running": false, "executionMode": "sandbox", "isolated": true, "exitCode": 0, "stdout": "hello", "stderr": "", "truncated": true}, nil
				case "host.exec.kill":
					return map[string]any{"running": false, "executionMode": "sandbox", "isolated": true}, nil
				default:
					t.Errorf("unexpected RPC: %s", method)
					return nil, nil
				}
			})
			raw, err := h.runShellExec(context.Background(), "tenant", agent.ID, map[string]any{"command": "echo hello", "execution_mode": "sandbox"})
			if scenario == "supported" {
				if err != nil {
					t.Fatal(err)
				}
				var result map[string]any
				_ = json.Unmarshal(raw, &result)
				if result["executionMode"] != "sandbox" || result["truncated"] != true {
					t.Fatalf("lost policy/output state: %s", raw)
				}
				if calls != 1 {
					t.Fatalf("calls %d", calls)
				}
			} else {
				if err == nil {
					t.Fatalf("unconfirmed sandbox result accepted: %s", raw)
				}
				if scenario == "old_runner" && calls != 0 {
					t.Fatal("old runner executed command")
				}
			}
		})
	}
}

func TestSandboxCancellationUsesIndependentCleanupContext(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	killed := make(chan map[string]any, 1)
	h := builtinToolHarness(t, d, "rnr_cancel", func(method string, p map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{}, "hostInfo": map[string]any{}}, nil
		case "host.exec.start":
			cancel()
			return map[string]any{"id": "job", "executionMode": "sandbox", "isolated": true, "running": true, "exitCode": nil}, nil
		case "host.exec.kill":
			killed <- p
			return map[string]any{"id": "job", "executionMode": "sandbox", "isolated": true, "running": false, "exitCode": 137}, nil
		default:
			t.Errorf("unexpected RPC: %s", method)
			return nil, nil
		}
	})
	runner, err := h.hub.get("node")
	if err != nil {
		t.Fatal(err)
	}
	_, err = runSandboxCommand(ctx, runner, map[string]any{"spaceId": "space", "executionMode": "sandbox", "command": []string{"true"}})
	if err == nil {
		t.Fatal("cancelled context succeeded")
	}
	select {
	case p := <-killed:
		if p["spaceId"] != "space" || p["executionMode"] != "sandbox" || p["id"] != "job" {
			t.Fatalf("unscoped cleanup: %#v", p)
		}
	default:
		t.Fatal("cancel did not stop job")
	}
}

func TestRuntimeExecutionClassification(t *testing.T) {
	for _, tc := range []struct {
		name, workspace, requested, reported string
		reportedIsolation                    bool
		expected                             string
		isolated, restricted, wantError      bool
	}{
		{name: "legacy host", workspace: "host", expected: "host"},
		{name: "legacy workspace container", workspace: "container", expected: "workspace-container", isolated: true},
		{name: "workspace container cannot claim restricted policy", workspace: "container", reported: "sandbox", reportedIsolation: true, expected: "workspace-container", isolated: true},
		{name: "restricted sandbox", workspace: "host", requested: "sandbox", reported: "sandbox", reportedIsolation: true, expected: "sandbox", isolated: true, restricted: true},
		{name: "operator enforced sandbox", workspace: "host", reported: "sandbox", reportedIsolation: true, expected: "sandbox", isolated: true, restricted: true},
		{name: "missing sandbox isolation", workspace: "host", requested: "sandbox", reported: "sandbox", wantError: true},
		{name: "container is not restricted sandbox", workspace: "host", requested: "sandbox", reported: "workspace-container", reportedIsolation: true, wantError: true},
		{name: "operator sandbox missing isolation", workspace: "host", reported: "sandbox", wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			store := NewStore(d)
			node := "node"
			space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: tc.workspace})
			if err != nil {
				t.Fatal(err)
			}
			agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
			if err != nil {
				t.Fatal(err)
			}
			h := builtinToolHarness(t, d, "rnr_classification", func(method string, p map[string]any) (any, error) {
				switch method {
				case "sys.info":
					return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{}, "hostInfo": map[string]any{}}, nil
				case "sandbox.policy":
					return map[string]any{"sandbox": map[string]any{"enabled": true}}, nil
				case "docker.list":
					return []map[string]any{{"dockerId": "workspace", "labels": map[string]string{"zakura.purpose": "workspace"}}}, nil
				case "host.exec", "host.exec.start", "docker.exec":
					expectedMethod := "host.exec"
					if tc.workspace != "host" {
						expectedMethod = "docker.exec"
					} else if tc.requested == "sandbox" {
						expectedMethod = "host.exec.start"
					}
					if method != expectedMethod {
						t.Errorf("expected %s, got %s", expectedMethod, method)
					}
					result := map[string]any{"id": "job", "running": false, "exitCode": 0, "stdout": "ok", "stderr": ""}
					if tc.reported != "" {
						result["executionMode"] = tc.reported
						result["isolated"] = tc.reportedIsolation
					}
					return result, nil
				case "host.exec.kill":
					return map[string]any{"running": false, "executionMode": "sandbox", "isolated": true}, nil
				default:
					t.Errorf("unexpected RPC: %s", method)
					return nil, nil
				}
			})
			result, err := h.runtimeExecWithMode(context.Background(), "tenant", agent.ID, tc.requested, "true")
			if tc.wantError {
				if err == nil {
					t.Fatalf("unconfirmed sandbox accepted: %#v", result)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result["executionMode"] != tc.expected || result["isolated"] != tc.isolated || result["restrictedPolicyApplied"] != tc.restricted {
				t.Fatalf("incorrect classification: %#v", result)
			}
			args := map[string]any{"command": "true"}
			if tc.requested != "" {
				args["execution_mode"] = tc.requested
			}
			raw, err := h.runShellExec(context.Background(), "tenant", agent.ID, args)
			if err != nil {
				t.Fatal(err)
			}
			var toolResult map[string]any
			if err := json.Unmarshal(raw, &toolResult); err != nil {
				t.Fatal(err)
			}
			if toolResult["executionMode"] != tc.expected || toolResult["isolated"] != tc.isolated || toolResult["restrictedPolicyApplied"] != tc.restricted {
				t.Fatalf("tool output lost execution classification: %s", raw)
			}
		})
	}
}
