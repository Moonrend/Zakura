// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

type recordedFSCall struct {
	method  string
	root    string
	spaceID string
	path    string
}

func recordingFSRunner(record *[]recordedFSCall, mu *sync.Mutex) func(string, map[string]any) (any, error) {
	capture := func(method string, params map[string]any) {
		mu.Lock()
		*record = append(*record, recordedFSCall{method: method, root: fmt.Sprint(params["root"]), spaceID: fmt.Sprint(params["spaceId"]), path: fmt.Sprint(params["path"])})
		mu.Unlock()
	}
	return func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true}, "hostInfo": map[string]any{}}, nil
		case "host.fs.stat":
			capture(method, params)
			return map[string]any{"name": "note.txt", "path": fmt.Sprint(params["path"]), "size": 5, "mode": "0640", "isDir": false}, nil
		case "host.fs.list":
			capture(method, params)
			return map[string]any{"path": fmt.Sprint(params["path"]), "entries": []map[string]any{}}, nil
		case "host.fs.write":
			capture(method, params)
			return map[string]any{"ok": true, "path": fmt.Sprint(params["path"])}, nil
		case "host.fs.read":
			return map[string]any{"path": fmt.Sprint(params["path"]), "content": "hello", "base64": base64.StdEncoding.EncodeToString([]byte("hello")), "size": 5}, nil
		default:
			return nil, fmt.Errorf("unexpected RPC %s", method)
		}
	}
}

// computerExecRig pins a chat's run to a dedicated computer and drives a runtime
// through reserve/approve/complete so dispatch resolves a pinned, non-legacy
// execution with the provider's verified capability set.
func computerExecRig(t *testing.T, token string, provider computers.Provider, rootPath string, record *[]recordedFSCall, mu *sync.Mutex) (*handler, string, string, string, context.Context) {
	t.Helper()
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
	h := builtinToolHarness(t, d, token, recordingFSRunner(record, mu))
	cs := h.computerStore()
	sealed, err := computers.SealCredentials(d.Secret, "tenant", space.ID, "pc", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	c := computers.Computer{ID: "pc", TenantID: "tenant", SpaceID: space.ID, Name: "C", Provider: provider, IdleSeconds: 900, MaxLifetimeSeconds: 3600}
	if provider == computers.Server {
		c.RuntimeNodeID = "node"
	}
	if err = cs.Create(ctx, c, sealed); err != nil {
		t.Fatal(err)
	}
	chat, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	if err = cs.SetSessionDefault(ctx, "tenant", space.ID, chat.ID, "pc"); err != nil {
		t.Fatal(err)
	}
	run, err := store.StartRun(ctx, "tenant", agent.ID, chat.ID, "hi", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	rt, err := cs.ReserveRuntime(ctx, "tenant", space.ID, "pc", chat.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	target := computers.Target{TenantID: "tenant", SpaceID: space.ID, ComputerID: "pc", RuntimeID: rt.ID, Incarnation: rt.Incarnation}
	if err = cs.ApproveCreation(ctx, target, rt.CreateOperationID, "system", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err = cs.CompleteCreation(ctx, target, rt.CreateOperationID, computers.CreationResult{ExternalID: "container-1", RootPath: rootPath}, time.Now()); err != nil {
		t.Fatal(err)
	}
	runCtx := context.WithValue(context.Background(), computerRunKey{}, run.ID)
	return h, space.ID, agent.ID, chat.ID, runCtx
}

func TestComputerFilesystemCarriesHostRoot(t *testing.T) {
	var record []recordedFSCall
	var mu sync.Mutex
	rootPath := "/srv/zakura/computers/rt/workspace"
	h, spaceID, agentID, chatID, runCtx := computerExecRig(t, "rnr_fs_root", computers.Server, rootPath, &record, &mu)

	if _, err := h.dispatchAgentTool(runCtx, "tenant", agentID, chatID, "call", "fs_write", json.RawMessage(`{"path":"/note.txt","content":"hello"}`)); err != nil {
		t.Fatalf("fs_write: %v", err)
	}
	if _, err := h.dispatchAgentTool(runCtx, "tenant", agentID, chatID, "call", "fs_list", json.RawMessage(`{"path":"."}`)); err != nil {
		t.Fatalf("fs_list: %v", err)
	}
	mu.Lock()
	if len(record) != 2 {
		mu.Unlock()
		t.Fatalf("fs RPC count = %d (%#v)", len(record), record)
	}
	for _, call := range record {
		if call.root != rootPath {
			mu.Unlock()
			t.Fatalf("%s carried root %q, want %q", call.method, call.root, rootPath)
		}
		if call.spaceID != spaceID {
			mu.Unlock()
			t.Fatalf("%s carried spaceId %q, want %q", call.method, call.spaceID, spaceID)
		}
	}
	mu.Unlock()

	// The archive helper must scope every RPC (including its stat) to the same
	// computer root rather than the legacy Space workspace.
	exec := &resolvedExecution{
		spaceID:  spaceID,
		nodeID:   "node",
		hostRoot: rootPath,
		computer: computers.Computer{ID: "pc", TenantID: "tenant", SpaceID: spaceID, Provider: computers.Server, RuntimeNodeID: "node", Capabilities: []computers.Capability{computers.Commands, computers.Files}},
	}
	archiveCtx := context.WithValue(context.Background(), computerExecKey{}, exec)
	remote, selected, err := h.remoteWorkspace(archiveCtx, "tenant", agentID)
	if err != nil || !selected || remote.root != rootPath {
		t.Fatalf("remote workspace: selected=%v root=%q err=%v", selected, remote.root, err)
	}
	mu.Lock()
	record = nil
	mu.Unlock()
	if _, err = remote.archive(archiveCtx, []string{"/note.txt"}); err != nil {
		t.Fatalf("archive: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	sawStat := false
	for _, call := range record {
		if call.method == "host.fs.stat" {
			sawStat = true
		}
		if call.root != rootPath {
			t.Fatalf("archive %s carried root %q, want %q", call.method, call.root, rootPath)
		}
	}
	if !sawStat {
		t.Fatalf("archive recorded no stat RPC: %#v", record)
	}
}

func TestComputerFilesystemRefusesMissingRoot(t *testing.T) {
	var record []recordedFSCall
	var mu sync.Mutex
	h, _, agentID, chatID, runCtx := computerExecRig(t, "rnr_fs_noroot", computers.Server, "", &record, &mu)

	_, err := h.dispatchAgentTool(runCtx, "tenant", agentID, chatID, "call", "fs_list", json.RawMessage(`{"path":"."}`))
	if err == nil || !strings.Contains(err.Error(), "files are not available on this computer") {
		t.Fatalf("fs_list without a computer root: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(record) != 0 {
		t.Fatalf("fs RPCs reached the runner without a pinned root: %#v", record)
	}
}

func TestComputerFilesystemRefusesProviderWithoutFiles(t *testing.T) {
	// A pinned computer that has not been granted the Files channel must be
	// refused before any transport is contacted; it never falls back to the
	// runner or a provider file API.
	exec := &resolvedExecution{
		spaceID:     "space",
		containerID: "container-1",
		computer:    computers.Computer{ID: "pc", TenantID: "tenant", SpaceID: "space", Provider: computers.E2B, Capabilities: []computers.Capability{computers.Commands}},
	}
	h := &handler{}
	ctx := context.WithValue(context.Background(), computerExecKey{}, exec)
	_, err := h.runBuiltinTool(ctx, "tenant", "agent", "fs_list", json.RawMessage(`{"path":"."}`))
	if err == nil || err.Error() != "files are not available on this computer" {
		t.Fatalf("fs_list without the files capability: %v", err)
	}
}
