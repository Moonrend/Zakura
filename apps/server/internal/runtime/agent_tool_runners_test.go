// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/go-chi/chi/v5"
)

func builtinToolHarness(t *testing.T, d *appdeps.Dependencies, runnerToken string, handle func(string, map[string]any) (any, error)) *handler {
	t.Helper()
	now := d.Clock()
	hash := sha256.Sum256([]byte(runnerToken))
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now); err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: NewStore(d), mcpSessions: map[string]spaceMCPSession{}}
	h.hub = newRunnerHub(d)
	h.service = NewService(h.store)
	router := chi.NewRouter()
	router.Handle("/api/runtime-nodes/hub", http.HandlerFunc(h.runnerHubHTTP))
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	startMigrationRunner(t, server.URL, runnerToken, handle)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := h.hub.get("node"); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := h.hub.get("node"); err != nil {
		t.Fatalf("runner did not come online: %v", err)
	}
	return h
}

func decodeBuiltinResult(t *testing.T, raw json.RawMessage, err error) map[string]any {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out := map[string]any{}
	if jsonErr := json.Unmarshal(raw, &out); jsonErr != nil {
		t.Fatalf("invalid result JSON: %v", jsonErr)
	}
	return out
}

func TestRunBuiltinToolShellExec(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	node := "node"
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	h := builtinToolHarness(t, d, "rnr_shell", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{}}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "ws", "labels": map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.exec":
			command, _ := params["command"].([]any)
			script := ""
			if len(command) >= 3 {
				script = fmt.Sprint(command[2])
			}
			if script == "fail" {
				return map[string]any{"exitCode": 1, "stdout": "", "stderr": "boom"}, nil
			}
			return map[string]any{"exitCode": 0, "stdout": "hello", "stderr": ""}, nil
		default:
			return nil, fmt.Errorf("unexpected method %s", method)
		}
	})
	ctx := context.Background()
	helloRaw, helloErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "shell_exec", json.RawMessage(`{"command":"echo hello"}`))
	out := decodeBuiltinResult(t, helloRaw, helloErr)
	if out["stdout"] != "hello" || out["exitCode"] != float64(0) {
		t.Fatalf("shell_exec result: %#v", out)
	}
	raw, err := h.runBuiltinTool(ctx, "tenant", agent.ID, "shell_exec", json.RawMessage(`{"command":"fail"}`))
	if err != nil {
		t.Fatalf("nonzero exit should not error: %v", err)
	}
	failed := decodeBuiltinResult(t, raw, nil)
	if failed["exitCode"] != float64(1) || failed["stderr"] != "boom" {
		t.Fatalf("failing shell_exec result: %#v", failed)
	}
}

func TestRunBuiltinToolFilesystem(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	node := "node"
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	h := builtinToolHarness(t, d, "rnr_fs", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true}, "hostInfo": map[string]any{}}, nil
		case "host.fs.write":
			path := fmt.Sprint(params["path"])
			data, decodeErr := base64.StdEncoding.DecodeString(fmt.Sprint(params["base64"]))
			if decodeErr != nil {
				return nil, decodeErr
			}
			files[path] = string(data)
			return map[string]any{"ok": true, "path": path}, nil
		case "host.fs.read":
			path := fmt.Sprint(params["path"])
			content := files[path]
			return map[string]any{"path": path, "content": content, "size": len(content)}, nil
		case "host.fs.list":
			path := fmt.Sprint(params["path"])
			return map[string]any{"path": path, "entries": []map[string]any{{"name": "note.txt", "path": path + "/note.txt", "isDir": false, "size": 4}}}, nil
		default:
			return nil, fmt.Errorf("unexpected method %s", method)
		}
	})
	ctx := context.Background()
	writeRaw, writeErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "fs_write", json.RawMessage(`{"path":"/note.txt","content":"alpha\nbeta\ngamma\n"}`))
	writeResult := decodeBuiltinResult(t, writeRaw, writeErr)
	if writeResult["written"] != true {
		t.Fatalf("fs_write result: %#v", writeResult)
	}
	readRaw, readErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "fs_read", json.RawMessage(`{"path":"/note.txt"}`))
	readResult := decodeBuiltinResult(t, readRaw, readErr)
	if readResult["content"] != "alpha\nbeta\ngamma\n" || readResult["size"] != float64(17) {
		t.Fatalf("fs_read result: %#v", readResult)
	}
	offsetRaw, offsetErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "fs_read", json.RawMessage(`{"path":"/note.txt","offset":1}`))
	offsetResult := decodeBuiltinResult(t, offsetRaw, offsetErr)
	if offsetResult["content"] != "beta\ngamma\n" {
		t.Fatalf("fs_read offset result: %#v", offsetResult)
	}
	listRaw, listErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "fs_list", json.RawMessage(`{"path":"."}`))
	listResult := decodeBuiltinResult(t, listRaw, listErr)
	entries, _ := listResult["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("fs_list result: %#v", listResult)
	}
	if _, traversalErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "fs_list", json.RawMessage(`{"path":".."}`)); traversalErr == nil || !strings.Contains(traversalErr.Error(), "escapes workspace") {
		t.Fatalf("fs_list traversal should fail: %v", traversalErr)
	}
}

func TestRunBuiltinToolMemory(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, EnableMemory: true})
	if err != nil {
		t.Fatal(err)
	}
	plain, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "B", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	ctx := context.Background()
	rememberRaw, rememberErr := h.runBuiltinTool(ctx, "tenant", agent.ID, "memory_remember", json.RawMessage(`{"content":"the pineapple code is 42","title":"codes"}`))
	remembered := decodeBuiltinResult(t, rememberRaw, rememberErr)
	if remembered["stored"] != true || fmt.Sprint(remembered["id"]) == "" {
		t.Fatalf("memory_remember result: %#v", remembered)
	}
	searchRaw, searchErrValue := h.runBuiltinTool(ctx, "tenant", agent.ID, "memory_search", json.RawMessage(`{"query":"pineapple"}`))
	searchResult := decodeBuiltinResult(t, searchRaw, searchErrValue)
	results, _ := searchResult["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("memory_search results: %#v", searchResult)
	}
	entry, _ := results[0].(map[string]any)
	if entry["content"] != "the pineapple code is 42" || entry["layer"] != "note" || entry["pinned"] != false || entry["importance"] == nil {
		t.Fatalf("memory_search entry: %#v", entry)
	}
	tags, _ := entry["tags"].([]any)
	if len(tags) != 2 || tags[0] != "note" || tags[1] != "codes" {
		t.Fatalf("memory tags: %#v", entry["tags"])
	}
	if _, searchErr := h.runBuiltinTool(ctx, "tenant", plain.ID, "memory_search", json.RawMessage(`{"query":"pineapple"}`)); searchErr == nil || searchErr.Error() != "memory is not enabled for this agent" {
		t.Fatalf("disabled memory search should fail: %v", searchErr)
	}
}

func TestRunBuiltinToolUnknown(t *testing.T) {
	h := &handler{}
	if _, err := h.runBuiltinTool(context.Background(), "tenant", "agent", "nope", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "unknown builtin tool") {
		t.Fatalf("unknown tool should fail: %v", err)
	}
}
