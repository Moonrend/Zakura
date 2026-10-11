// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestComputerScopedExecutionRouting(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var execIDs []string
	var execCommands [][]string
	var listRoots []string
	var listSpaces []string
	h := builtinToolHarness(t, d, "rnr_computer_exec", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{}}, nil
		case "docker.exec":
			raw, _ := json.Marshal(params["command"])
			var argv []string
			_ = json.Unmarshal(raw, &argv)
			mu.Lock()
			execIDs = append(execIDs, fmt.Sprint(params["id"]))
			execCommands = append(execCommands, argv)
			mu.Unlock()
			return map[string]any{"exitCode": 0, "stdout": "hello", "stderr": ""}, nil
		case "host.fs.list":
			mu.Lock()
			listRoots = append(listRoots, fmt.Sprint(params["root"]))
			listSpaces = append(listSpaces, fmt.Sprint(params["spaceId"]))
			mu.Unlock()
			return map[string]any{"path": "/", "entries": []map[string]any{}}, nil
		default:
			return nil, fmt.Errorf("unexpected method %s", method)
		}
	})
	if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,runtime_node_id,capabilities_json,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES('pc','tenant',?,'PC','server','node','["commands","files"]',900,3600,'now','now')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.computerStore().SetSpaceDefault(ctx, "tenant", space.ID, "pc"); err != nil {
		t.Fatal(err)
	}
	chat, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.StartRun(ctx, "tenant", agent.ID, chat.ID, "hi", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	rootPath := "/srv/zakura/computers/rt1/workspace"
	insertRuntime := func() error {
		return d.Gorm.Exec(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,external_id,state,root_path,created_at,updated_at) VALUES('rt1','tenant',?,'pc','','inc1','op1','computer-ctr','ready',?,'now','now')`, space.ID, rootPath).Error
	}
	if err = insertRuntime(); err != nil {
		t.Fatal(err)
	}
	runCtx := context.WithValue(context.Background(), computerRunKey{}, run.ID)

	raw, err := h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "shell_exec", json.RawMessage(`{"command":"echo hello"}`))
	if err != nil {
		t.Fatal(err)
	}
	var shell map[string]any
	if err := json.Unmarshal(raw, &shell); err != nil {
		t.Fatal(err)
	}
	if shell["stdout"] != "hello" || shell["executionMode"] != "workspace-container" {
		t.Fatalf("computer shell result: %s", raw)
	}
	mu.Lock()
	if len(execIDs) != 1 || execIDs[0] != "computer-ctr" {
		mu.Unlock()
		t.Fatalf("docker.exec target: %v", execIDs)
	}
	if len(execCommands) != 1 || !reflect.DeepEqual(execCommands[0], []string{"bash", "-lc", "echo hello"}) {
		mu.Unlock()
		t.Fatalf("docker.exec command: %v", execCommands)
	}
	mu.Unlock()

	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "fs_list", json.RawMessage(`{"path":"."}`)); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(listRoots) != 1 || listRoots[0] != rootPath || listSpaces[0] != space.ID {
		mu.Unlock()
		t.Fatalf("fs_list scope: %v %v", listRoots, listSpaces)
	}
	mu.Unlock()

	if _, err = h.dispatchAgentTool(context.Background(), "tenant", agent.ID, chat.ID, "call", "shell_exec", json.RawMessage(`{"command":"echo hello"}`)); err == nil || !strings.Contains(err.Error(), "immutable run target") {
		t.Fatalf("missing run accepted: %v", err)
	}

	past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	if err = d.Gorm.Exec(`UPDATE computer_runtimes SET expires_at=? WHERE id='rt1'`, past).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "shell_exec", json.RawMessage(`{"command":"echo hello"}`)); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expired runtime accepted: %v", err)
	}

	if err = d.Gorm.Exec(`UPDATE computer_runtimes SET state='unknown' WHERE id='rt1'`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "shell_exec", json.RawMessage(`{"command":"echo hello"}`)); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("non-ready runtime accepted: %v", err)
	}

	if err = d.Gorm.Exec(`DELETE FROM computer_runtimes WHERE id='rt1'`).Error; err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	execBefore := len(execIDs)
	mu.Unlock()
	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "shell_exec", json.RawMessage(`{"command":"echo hello"}`)); err == nil || !strings.Contains(err.Error(), "no active runtime") {
		t.Fatalf("missing runtime accepted: %v", err)
	}
	mu.Lock()
	if len(execIDs) != execBefore {
		mu.Unlock()
		t.Fatalf("docker.exec reached without an active runtime: %v", execIDs)
	}
	mu.Unlock()

	if err = insertRuntime(); err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES('e2bpc','tenant',?,'E2B','e2b',900,3600,'now','now')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "fs_list", json.RawMessage(`{"computerId":"e2bpc","path":"."}`)); err == nil || !strings.Contains(err.Error(), "no active runtime") {
		t.Fatalf("session computer without runtime accepted: %v", err)
	}

	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "shell_exec", json.RawMessage(`{"command":"echo hi","execution_mode":"sandbox"}`)); err == nil || !strings.Contains(err.Error(), "refusing downgrade") {
		t.Fatalf("sandbox downgrade accepted: %v", err)
	}

	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "computer_screenshot", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "desktop control is not available on this computer") {
		t.Fatalf("desktop control accepted: %v", err)
	}

	var idle sql.NullString
	if err = h.deps.DB.QueryRowContext(ctx, `SELECT idle_deadline FROM computer_runtimes WHERE id='rt1'`).Scan(&idle); err != nil {
		t.Fatal(err)
	}
	if idle.Valid {
		t.Fatalf("persistent computer got an idle deadline: %v", idle.String)
	}
}

func TestLegacyExecutionUnaffected(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	listCalls, listHadRoot := 0, false
	h := builtinToolHarness(t, d, "rnr_legacy_exec", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true}, "hostInfo": map[string]any{}}, nil
		case "host.fs.list":
			mu.Lock()
			if _, hasRoot := params["root"]; hasRoot {
				listHadRoot = true
			}
			listCalls++
			mu.Unlock()
			return map[string]any{"path": "/", "entries": []map[string]any{}}, nil
		case "sandbox.policy":
			return map[string]any{"sandbox": map[string]any{"enabled": true}}, nil
		case "host.exec":
			return map[string]any{"exitCode": 0, "stdout": "legacy", "stderr": ""}, nil
		default:
			return nil, fmt.Errorf("unexpected method %s", method)
		}
	})
	chat, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.StartRun(ctx, "tenant", agent.ID, chat.ID, "hi", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	runCtx := context.WithValue(context.Background(), computerRunKey{}, run.ID)

	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "fs_list", json.RawMessage(`{"path":"."}`)); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if listCalls != 1 || listHadRoot {
		mu.Unlock()
		t.Fatalf("legacy fs_list scoped to a computer root: calls=%d hadRoot=%v", listCalls, listHadRoot)
	}
	mu.Unlock()

	raw, err := h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "shell_exec", json.RawMessage(`{"command":"echo hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	var shell map[string]any
	if err := json.Unmarshal(raw, &shell); err != nil {
		t.Fatal(err)
	}
	if shell["stdout"] != "legacy" {
		t.Fatalf("legacy shell result: %s", raw)
	}
}
