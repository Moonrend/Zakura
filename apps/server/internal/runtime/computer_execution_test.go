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

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
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
		if err := d.Gorm.Exec(`DELETE FROM computer_runtimes WHERE computer_id='pc'`).Error; err != nil {
			return err
		}
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
	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "shell_exec", json.RawMessage(`{"command":"echo hello"}`)); err == nil || !strings.Contains(err.Error(), "awaiting creation approval") {
		t.Fatalf("missing runtime accepted: %v", err)
	}
	mu.Lock()
	if len(execIDs) != execBefore {
		mu.Unlock()
		t.Fatalf("docker.exec reached without an active runtime: %v", execIDs)
	}
	mu.Unlock()
	var reservedState string
	if err = h.deps.DB.QueryRowContext(ctx, `SELECT state FROM computer_runtimes WHERE computer_id='pc'`).Scan(&reservedState); err != nil {
		t.Fatal(err)
	}
	if reservedState != "pending_approval" {
		t.Fatalf("execution did not reserve intent: %q", reservedState)
	}

	if err = insertRuntime(); err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES('e2bpc','tenant',?,'E2B','e2b',900,3600,'now','now')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "fs_list", json.RawMessage(`{"computerId":"e2bpc","path":"."}`)); err == nil || !strings.Contains(err.Error(), "awaiting creation approval") {
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

// temporaryExecutionRig builds a Space whose default computer is a temporary
// (self-hosted container) computer, a chat pinned to it and a run context, so a
// dispatch exercises the computer-scoped execution guard end to end.
func temporaryExecutionRig(t *testing.T, token string, handle func(string, map[string]any) (any, error)) (*handler, string, string, string, context.Context) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "temporary"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	h := builtinToolHarness(t, d, token, handle)
	if err = d.Gorm.Exec(`UPDATE runtime_nodes SET kind='server' WHERE id='node'`).Error; err != nil {
		t.Fatal(err)
	}
	cs := h.computerStore()
	c := computers.Computer{ID: "temp", TenantID: "tenant", SpaceID: space.ID, Name: "Temporary", Provider: computers.Temporary, RuntimeNodeID: "node", IdleSeconds: 900, MaxLifetimeSeconds: 3600}
	sealed, err := computers.SealCredentials(d.Secret, c.TenantID, c.SpaceID, c.ID, []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if err = cs.Create(ctx, c, sealed); err != nil {
		t.Fatal(err)
	}
	if err = cs.SetSpaceDefault(ctx, "tenant", space.ID, c.ID); err != nil {
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
	runCtx := context.WithValue(context.Background(), computerRunKey{}, run.ID)
	return h, space.ID, agent.ID, chat.ID, runCtx
}

func TestTemporaryComputerAutoProvisionsOnExecution(t *testing.T) {
	var mu sync.Mutex
	creates := 0
	execTarget := ""
	var instance computerContainer
	h, _, agentID, chatID, runCtx := temporaryExecutionRig(t, "rnr_temp_autoprovision", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "server", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"docker": true}}, nil
		case "docker.images":
			return []computerImageStatus{{Image: serverComputerImage, ID: "sha256:present"}}, nil
		case "host.fs.mkdir":
			root := fmt.Sprint(params["root"])
			rel := fmt.Sprint(params["path"])
			if root != "/srv/zakura" || !strings.HasPrefix(rel, "computers/") || !strings.HasSuffix(rel, "/workspace") {
				return nil, fmt.Errorf("unscoped computer root")
			}
			return map[string]any{"abs": fmt.Sprintf("/srv/zakura/%s", rel)}, nil
		case "docker.create":
			mu.Lock()
			defer mu.Unlock()
			creates++
			raw, _ := json.Marshal(params["labels"])
			var labels map[string]string
			_ = json.Unmarshal(raw, &labels)
			instance = computerContainer{DockerID: "container", Name: "/" + fmt.Sprint(params["name"]), Image: serverComputerImage, Status: "running", Labels: labels}
			return instance, nil
		case "docker.exec":
			mu.Lock()
			defer mu.Unlock()
			execTarget = fmt.Sprint(params["id"])
			return map[string]any{"exitCode": 0, "stdout": "ok", "stderr": ""}, nil
		default:
			return nil, fmt.Errorf("unexpected RPC %s", method)
		}
	})
	raw, err := h.dispatchAgentTool(runCtx, "tenant", agentID, chatID, "call", "shell_exec", json.RawMessage(`{"command":"echo hello"}`))
	if err != nil {
		t.Fatal(err)
	}
	var shell map[string]any
	if err := json.Unmarshal(raw, &shell); err != nil {
		t.Fatal(err)
	}
	if shell["stdout"] != "ok" || shell["executionMode"] != "workspace-container" {
		t.Fatalf("auto-provisioned shell result: %s", raw)
	}
	var state, external string
	if err = h.deps.DB.QueryRowContext(runCtx, `SELECT state,COALESCE(external_id,'') FROM computer_runtimes WHERE computer_id='temp'`).Scan(&state, &external); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || external != "container" {
		t.Fatalf("runtime after auto-provision: state=%q external=%q", state, external)
	}
	mu.Lock()
	if creates != 1 || execTarget != "container" {
		mu.Unlock()
		t.Fatalf("creates=%d execTarget=%q", creates, execTarget)
	}
	mu.Unlock()

	// A second dispatch reuses the same ready runtime and never provisions again.
	if _, err = h.dispatchAgentTool(runCtx, "tenant", agentID, chatID, "call", "shell_exec", json.RawMessage(`{"command":"echo again"}`)); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if creates != 1 {
		t.Fatalf("runtime was recreated on reuse: creates=%d", creates)
	}
}

func TestE2BComputerReservesApprovalOnExecution(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "computers"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	h := builtinToolHarness(t, d, "rnr_e2b_reserve", func(method string, params map[string]any) (any, error) {
		if method == "sys.info" {
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{}, "hostInfo": map[string]any{}}, nil
		}
		return nil, fmt.Errorf("unexpected RPC %s", method)
	})
	cs := h.computerStore()
	sealed, err := computers.SealCredentials(d.Secret, "tenant", space.ID, "e2bpc", []byte(`{"apiKey":"k","template":"base"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err = cs.Create(ctx, computers.Computer{ID: "e2bpc", TenantID: "tenant", SpaceID: space.ID, Name: "E2B", Provider: computers.E2B, IdleSeconds: 900, MaxLifetimeSeconds: 3600}, sealed); err != nil {
		t.Fatal(err)
	}
	if err = cs.SetSpaceDefault(ctx, "tenant", space.ID, "e2bpc"); err != nil {
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
	runCtx := context.WithValue(context.Background(), computerRunKey{}, run.ID)

	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "shell_exec", json.RawMessage(`{"command":"echo hi"}`)); err == nil || !strings.Contains(err.Error(), "awaiting creation approval") {
		t.Fatalf("e2b execution without a runtime accepted: %v", err)
	}
	var state string
	if err = h.deps.DB.QueryRowContext(ctx, `SELECT state FROM computer_runtimes WHERE computer_id='e2bpc'`).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "pending_approval" {
		t.Fatalf("e2b runtime was not reserved: %q", state)
	}
	// Reservation is idempotent: a second dispatch reports the same state without
	// spending an external resource.
	if _, err = h.dispatchAgentTool(runCtx, "tenant", agent.ID, chat.ID, "call", "shell_exec", json.RawMessage(`{"command":"echo hi"}`)); err == nil || !strings.Contains(err.Error(), "awaiting creation approval") {
		t.Fatalf("e2b second execution accepted: %v", err)
	}
	var count int
	if err = h.deps.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM computer_runtimes WHERE computer_id='e2bpc'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("e2b reserved %d runtimes", count)
	}
}

func TestTemporaryComputerAutoProvisionFailureIsUncertain(t *testing.T) {
	var mu sync.Mutex
	creates := 0
	h, _, agentID, chatID, runCtx := temporaryExecutionRig(t, "rnr_temp_autoprovision_fail", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "server", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"docker": true}}, nil
		case "docker.images":
			return []computerImageStatus{{Image: serverComputerImage, ID: "sha256:present"}}, nil
		case "host.fs.mkdir":
			return map[string]any{"abs": fmt.Sprintf("/srv/zakura/%s", fmt.Sprint(params["path"]))}, nil
		case "docker.create":
			mu.Lock()
			defer mu.Unlock()
			creates++
			return nil, fmt.Errorf("provider leaked detail: secret-token")
		default:
			return nil, fmt.Errorf("unexpected RPC %s", method)
		}
	})
	_, dispatchErr := h.dispatchAgentTool(runCtx, "tenant", agentID, chatID, "call", "shell_exec", json.RawMessage(`{"command":"echo hi"}`))
	if dispatchErr == nil || !strings.Contains(dispatchErr.Error(), "uncertain") {
		t.Fatalf("uncertain provisioning was not reported: %v", dispatchErr)
	}
	if strings.Contains(dispatchErr.Error(), "secret-token") {
		t.Fatalf("provider error detail leaked to the caller: %v", dispatchErr)
	}
	var state string
	if err := h.deps.DB.QueryRowContext(runCtx, `SELECT state FROM computer_runtimes WHERE computer_id='temp'`).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "unknown" {
		t.Fatalf("failed provisioning runtime state: %q", state)
	}
	// The ambiguous slot is retained, so a retry is refused rather than creating
	// a second container.
	if _, err := h.dispatchAgentTool(runCtx, "tenant", agentID, chatID, "call", "shell_exec", json.RawMessage(`{"command":"echo hi"}`)); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("uncertain runtime was retried: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if creates != 1 {
		t.Fatalf("uncertain provisioning was retried: creates=%d", creates)
	}
}

func TestTemporaryComputerTerminalRuntimeNotRecreated(t *testing.T) {
	var mu sync.Mutex
	providerCalls := 0
	h, spaceID, agentID, chatID, runCtx := temporaryExecutionRig(t, "rnr_temp_terminal", func(method string, params map[string]any) (any, error) {
		if method == "sys.info" {
			return map[string]any{"version": "test", "kind": "server", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"docker": true}}, nil
		}
		mu.Lock()
		defer mu.Unlock()
		providerCalls++
		return nil, fmt.Errorf("unexpected RPC %s", method)
	})
	if err := h.deps.Gorm.Exec(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at) VALUES('rt-exp','tenant',?,'temp',?,'inc-exp','op-exp','expired','now','now')`, spaceID, chatID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := h.dispatchAgentTool(runCtx, "tenant", agentID, chatID, "call", "shell_exec", json.RawMessage(`{"command":"echo hi"}`)); err == nil || !strings.Contains(err.Error(), "runtime ended") {
		t.Fatalf("terminal runtime was not refused: %v", err)
	}
	var count int
	var state string
	if err := h.deps.DB.QueryRowContext(runCtx, `SELECT COUNT(*),COALESCE(MAX(state),'') FROM computer_runtimes WHERE computer_id='temp'`).Scan(&count, &state); err != nil {
		t.Fatal(err)
	}
	if count != 1 || state != "expired" {
		t.Fatalf("terminal runtime was recreated: count=%d state=%q", count, state)
	}
	mu.Lock()
	defer mu.Unlock()
	if providerCalls != 0 {
		t.Fatalf("terminal runtime contacted a provider %d times", providerCalls)
	}
}
