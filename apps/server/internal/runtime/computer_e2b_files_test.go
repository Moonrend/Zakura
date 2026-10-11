package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

func e2bFilesContext(t *testing.T, credentials string) (context.Context, *handler, *resolvedExecution) {
	t.Helper()
	h, exec := e2bExecHarness(t, credentials)
	exec.computer.Capabilities = []computers.Capability{computers.Commands, computers.Files}
	ctx := context.WithValue(context.Background(), computerExecKey{}, exec)
	return ctx, h, exec
}

func TestE2BFilesPathMapping(t *testing.T) {
	cases := map[string]string{
		".":                   "/workspace",
		"/note.txt":           "/workspace/note.txt",
		"sub/notes.txt":       "/workspace/sub/notes.txt",
		"/.zakura/patch.diff": "/workspace/.zakura/patch.diff",
	}
	for target, want := range cases {
		got, err := e2bFilesPath(target)
		if err != nil {
			t.Fatalf("e2bFilesPath(%q): %v", target, err)
		}
		if got != want {
			t.Fatalf("e2bFilesPath(%q) = %q, want %q", target, got, want)
		}
	}
	if _, err := e2bFilesPath("../escape"); err == nil {
		t.Fatal("path escape was accepted")
	}
}

func TestE2BComputerFilesList(t *testing.T) {
	ctx, h, _ := e2bFilesContext(t, `{"apiKey":"test-key","envdAccessToken":"envd-token"}`)
	server, rec := newE2BEnvdServer(t, e2bEnvdResult{listBody: `{"entries":[
		{"name":"note.txt","type":"FILE_TYPE_FILE","path":"/workspace/sub/note.txt","size":"5","mode":420,"modifiedTime":{"seconds":"1700000000","nanos":0}},
		{"name":"nested","type":"FILE_TYPE_DIRECTORY","path":"/workspace/sub/nested","size":"0","mode":493}
	]}`})
	useE2BEnvdServer(t, server.URL)

	raw, err := h.runBuiltinTool(ctx, "tenant", "agent", "fs_list", json.RawMessage(`{"path":"/sub"}`))
	if err != nil {
		t.Fatal(err)
	}
	out := decodeBuiltinResult(t, raw, nil)
	if out["path"] != "/workspace/sub" {
		t.Fatalf("resolved path = %v", out["path"])
	}
	entries, ok := out["entries"].([]any)
	if !ok || len(entries) != 2 {
		t.Fatalf("entries = %#v", out["entries"])
	}
	first := entries[0].(map[string]any)
	if first["name"] != "note.txt" || first["path"] != "/workspace/sub/note.txt" || first["size"] != float64(5) || first["mode"] != "0644" || first["isDir"] != false {
		t.Fatalf("file entry = %#v", first)
	}
	if first["modTime"] == nil || !strings.Contains(first["modTime"].(string), "2023-11-14") {
		t.Fatalf("modTime = %#v", first["modTime"])
	}
	second := entries[1].(map[string]any)
	if second["isDir"] != true || second["mode"] != "0755" {
		t.Fatalf("dir entry = %#v", second)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.fileMethod != "list" || rec.filePath != "/workspace/sub" {
		t.Fatalf("list request = %q %q", rec.fileMethod, rec.filePath)
	}
	if rec.token != "envd-token" || rec.sandboxID != "sbx-123" {
		t.Fatalf("headers = token %q sandbox %q", rec.token, rec.sandboxID)
	}
}

func TestE2BComputerFilesRead(t *testing.T) {
	ctx, h, _ := e2bFilesContext(t, `{"apiKey":"test-key","envdAccessToken":"envd-token"}`)
	server, rec := newE2BEnvdServer(t, e2bEnvdResult{fileContent: []byte("one\ntwo\nthree\n")})
	useE2BEnvdServer(t, server.URL)

	raw, err := h.runBuiltinTool(ctx, "tenant", "agent", "fs_read", json.RawMessage(`{"path":"/note.txt","offset":1,"limit":5}`))
	if err != nil {
		t.Fatal(err)
	}
	out := decodeBuiltinResult(t, raw, nil)
	if out["path"] != "/workspace/note.txt" || out["content"] != "two" || out["size"] != float64(3) {
		t.Fatalf("read result = %#v", out)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.fileMethod != "GET" || rec.filePath != "/workspace/note.txt" || rec.token != "envd-token" {
		t.Fatalf("read request = %q %q token %q", rec.fileMethod, rec.filePath, rec.token)
	}
}

func TestE2BComputerFilesReadBound(t *testing.T) {
	ctx, h, _ := e2bFilesContext(t, `{"apiKey":"test-key"}`)
	server, _ := newE2BEnvdServer(t, e2bEnvdResult{fileContent: []byte(strings.Repeat("x", agentFSReadMaxBytes+5000))})
	useE2BEnvdServer(t, server.URL)

	raw, err := h.runBuiltinTool(ctx, "tenant", "agent", "fs_read", json.RawMessage(`{"path":"/big.txt","limit":262144}`))
	if err != nil {
		t.Fatal(err)
	}
	out := decodeBuiltinResult(t, raw, nil)
	if size, _ := out["size"].(float64); int(size) > agentFSReadMaxBytes {
		t.Fatalf("read was not bounded: %v", out["size"])
	}
}

func TestE2BComputerFilesWrite(t *testing.T) {
	ctx, h, _ := e2bFilesContext(t, `{"apiKey":"test-key","envdAccessToken":"envd-token"}`)
	server, rec := newE2BEnvdServer(t, e2bEnvdResult{writeBody: `[{"name":"note.txt","type":"FILE_TYPE_FILE","path":"/workspace/note.txt"}]`})
	useE2BEnvdServer(t, server.URL)

	raw, err := h.runBuiltinTool(ctx, "tenant", "agent", "fs_write", json.RawMessage(`{"path":"/note.txt","content":"hello world"}`))
	if err != nil {
		t.Fatal(err)
	}
	out := decodeBuiltinResult(t, raw, nil)
	if out["path"] != "/workspace/note.txt" || out["written"] != true {
		t.Fatalf("write result = %#v", out)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.fileMethod != "POST" || rec.filePath != "/workspace/note.txt" {
		t.Fatalf("write request = %q %q", rec.fileMethod, rec.filePath)
	}
	if !strings.Contains(string(rec.fileBody), "hello world") || !strings.Contains(string(rec.fileBody), "/workspace/note.txt") {
		t.Fatalf("write body = %q", rec.fileBody)
	}
	if rec.token != "envd-token" {
		t.Fatalf("write token = %q", rec.token)
	}
}

func TestE2BComputerFilesErrorRedacted(t *testing.T) {
	ctx, h, _ := e2bFilesContext(t, `{"apiKey":"test-key","envdAccessToken":"super-secret"}`)
	server, _ := newE2BEnvdServer(t, e2bEnvdResult{fileStatus: 404, errorBody: "super-secret leaked"})
	useE2BEnvdServer(t, server.URL)

	_, err := h.runBuiltinTool(ctx, "tenant", "agent", "fs_read", json.RawMessage(`{"path":"/missing.txt"}`))
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("expected a status error: %v", err)
	}
	if strings.Contains(err.Error(), "super-secret") {
		t.Fatalf("error leaked the response body: %v", err)
	}
}

func TestE2BComputerApplyPatch(t *testing.T) {
	ctx, h, _ := e2bFilesContext(t, `{"apiKey":"test-key","envdAccessToken":"envd-token"}`)
	server, rec := newE2BEnvdServer(t, e2bEnvdResult{writeBody: `[{"path":"/workspace/.zakura/patches/p.patch"}]`})
	useE2BEnvdServer(t, server.URL)

	raw, err := h.runBuiltinTool(ctx, "tenant", "agent", "apply_patch", json.RawMessage(`{"patch":"diff --git a/x b/x\n"}`))
	if err != nil {
		t.Fatal(err)
	}
	out := decodeBuiltinResult(t, raw, nil)
	if out["applied"] != true {
		t.Fatalf("apply_patch result = %#v", out)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.fileMethod != "POST" || !strings.Contains(rec.filePath, "/.zakura/patches/") {
		t.Fatalf("apply_patch write = %q %q", rec.fileMethod, rec.filePath)
	}
}

func TestE2BComputerFilesMissingCredentials(t *testing.T) {
	ctx, h, _ := e2bFilesContext(t, "")
	server, rec := newE2BEnvdServer(t, e2bEnvdResult{listBody: `{"entries":[]}`})
	useE2BEnvdServer(t, server.URL)

	_, err := h.runBuiltinTool(ctx, "tenant", "agent", "fs_list", json.RawMessage(`{"path":"."}`))
	if err == nil || !strings.Contains(err.Error(), "configuration") {
		t.Fatalf("expected a credential error: %v", err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.calls != 0 {
		t.Fatalf("credential-less fs call contacted the sandbox %d times", rec.calls)
	}
}
