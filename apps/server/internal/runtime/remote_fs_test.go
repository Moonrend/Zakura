// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestAgentFilesystemUsesSelectedRunner(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	runnerToken := "rnr_fs-runner-token"
	hash := sha256.Sum256([]byte(runnerToken))
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now)
	if err != nil {
		t.Fatal(err)
	}
	node := "node"
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	content := []byte("from archive")
	_ = tw.WriteHeader(&tar.Header{Name: "nested/a.txt", Typeflag: tar.TypeReg, Mode: 0o640, Size: int64(len(content))})
	_, _ = tw.Write(content)
	_ = tw.Close()
	_ = gz.Close()
	calls := make(chan string, 32)
	runnerErrors := make(chan error, 1)
	go func() {
		u, _ := url.Parse(server.URL)
		conn, err := net.Dial("tcp", u.Host)
		if err != nil {
			runnerErrors <- err
			return
		}
		defer conn.Close()
		_, _ = fmt.Fprintf(conn, "GET /api/runtime-nodes/hub HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", u.Host, runnerToken)
		reader := bufio.NewReader(conn)
		status, _ := reader.ReadString('\n')
		if !strings.Contains(status, "101") {
			runnerErrors <- fmt.Errorf("upgrade status %q", status)
			return
		}
		for {
			line, _ := reader.ReadString('\n')
			if line == "\r\n" {
				break
			}
		}
		for {
			raw := readServerText(t, reader)
			var frame struct {
				Type   string         `json:"type"`
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.Unmarshal([]byte(raw), &frame) != nil || frame.Type != "req" {
				continue
			}
			var result any
			switch frame.Method {
			case "sys.info":
				result = map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true}, "hostInfo": map[string]any{}}
			case "host.fs.stat":
				path, _ := frame.Params["path"].(string)
				isDir := path == "/" || path == "/dir"
				result = map[string]any{"name": strings.Trim(path, "/"), "path": path, "size": 5, "mode": "0640", "modTime": "2026-01-01T00:00:00Z", "isDir": isDir}
			case "host.fs.list":
				result = map[string]any{"path": frame.Params["path"], "entries": []map[string]any{{"name": "note.txt", "path": "/note.txt", "size": 5, "mode": "0640", "modTime": "2026-01-01T00:00:00Z", "isDir": false}}}
			case "host.fs.read":
				path, _ := frame.Params["path"].(string)
				data := []byte("hello")
				if path == "/bundle.tar.gz" {
					data = archive.Bytes()
				}
				result = map[string]any{"path": path, "content": string(data), "base64": base64.StdEncoding.EncodeToString(data), "size": len(data)}
			case "host.fs.write", "host.fs.mkdir", "host.fs.remove", "host.fs.rename":
				calls <- frame.Method + ":" + fmt.Sprint(frame.Params["path"], frame.Params["newPath"])
				result = map[string]any{"ok": true, "path": frame.Params["path"]}
			default:
				runnerErrors <- fmt.Errorf("unexpected method %s", frame.Method)
				return
			}
			response, _ := json.Marshal(map[string]any{"type": "res", "id": frame.ID, "ok": true, "result": result})
			writeMaskedText(t, conn, string(response))
		}
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var status string
		_ = d.DB.QueryRow(`SELECT status FROM runtime_nodes WHERE id='node'`).Scan(&status)
		if status == "online" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runner did not become online")
		}
		time.Sleep(10 * time.Millisecond)
	}

	base := server.URL + "/api/agents/" + agent.ID + "/fs"
	code, listed := doJSON(t, server.Client(), "GET", base+"/list?path=%2F", token, nil)
	if code != 200 || listed["path"] != "/" || len(listed["entries"].([]any)) != 1 {
		t.Fatalf("remote list: %d %#v", code, listed)
	}
	code, read := doJSON(t, server.Client(), "GET", base+"/read?path=%2Fnote.txt", token, nil)
	if code != 200 || read["content"] != "hello" || read["revision"] == "" {
		t.Fatalf("remote read: %d %#v", code, read)
	}
	code, wrote := doJSON(t, server.Client(), "POST", base+"/write", token, map[string]any{"path": "/new.txt", "content": "saved"})
	if code != 200 || wrote["ok"] != true || wrote["revision"] == "" {
		t.Fatalf("remote write: %d %#v", code, wrote)
	}
	code, _ = doJSON(t, server.Client(), "POST", base+"/extract", token, map[string]any{"path": "/bundle.tar.gz", "destination": "/out"})
	if code != 200 {
		t.Fatalf("remote extract: %d", code)
	}
	requestBody := bytes.NewBufferString(`{"paths":["/note.txt"]}`)
	req, _ := http.NewRequest(http.MethodPost, base+"/archive", requestBody)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	archiveResponse, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/gzip" || len(archiveResponse) == 0 {
		t.Fatalf("remote archive response: %d %q bytes=%d", resp.StatusCode, resp.Header.Get("Content-Type"), len(archiveResponse))
	}
	code, project := doJSON(t, server.Client(), "POST", server.URL+"/api/agents/"+agent.ID+"/projects", token, map[string]any{"name": "demo", "withWorkspace": true})
	if code != 200 || project["project"].(map[string]any)["hasWorkspace"] != true {
		t.Fatalf("remote project create: %d %#v", code, project)
	}
	code, instructions := doJSON(t, server.Client(), "PUT", server.URL+"/api/agents/"+agent.ID+"/projects/demo/instructions", token, map[string]any{"content": "rules"})
	if code != 200 || instructions["config"] == nil {
		t.Fatalf("remote project instructions: %d %#v", code, instructions)
	}
	code, hooks := doJSON(t, server.Client(), "PUT", server.URL+"/api/agents/"+agent.ID+"/projects/demo/hooks", token, map[string]any{"events": map[string]any{"stop": []any{}}})
	if code != 200 || hooks["config"] == nil {
		t.Fatalf("remote project hooks: %d %#v", code, hooks)
	}
	code, skill := doJSON(t, server.Client(), "POST", server.URL+"/api/agents/"+agent.ID+"/projects/demo/skills", token, map[string]any{"name": "review", "content": "# review"})
	if code != 200 || skill["skill"] == nil {
		t.Fatalf("remote project skill: %d %#v", code, skill)
	}
	code, renamed := doJSON(t, server.Client(), "PATCH", server.URL+"/api/agents/"+agent.ID+"/projects/demo", token, map[string]any{"slug": "renamed"})
	if code != 200 || renamed["project"].(map[string]any)["slug"] != "renamed" {
		t.Fatalf("remote project rename: %d %#v", code, renamed)
	}
	code, deleted := doJSON(t, server.Client(), "DELETE", server.URL+"/api/agents/"+agent.ID+"/projects/renamed", token, nil)
	if code != 200 || deleted["deleted"] != true {
		t.Fatalf("remote project delete: %d %#v", code, deleted)
	}
	code, _ = doJSON(t, server.Client(), "GET", base+"/read?path=..%2Fsecret", token, nil)
	if code == 200 {
		t.Fatal("remote path traversal was accepted")
	}
	select {
	case err := <-runnerErrors:
		t.Fatal(err)
	default:
	}
	if len(calls) < 2 {
		t.Fatalf("expected remote writes, got %d", len(calls))
	}
}
