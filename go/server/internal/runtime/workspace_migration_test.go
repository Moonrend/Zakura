// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func startMigrationRunner(t *testing.T, serverURL, token string, handle func(string, map[string]any) (any, error)) {
	t.Helper()
	go func() {
		u, _ := url.Parse(serverURL)
		conn, err := net.Dial("tcp", u.Host)
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = fmt.Fprintf(conn, "GET /api/runtime-nodes/hub HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", u.Host, token)
		reader := bufio.NewReader(conn)
		status, _ := reader.ReadString('\n')
		if !strings.Contains(status, "101") {
			return
		}
		for {
			line, _ := reader.ReadString('\n')
			if line == "\r\n" {
				break
			}
		}
		for {
			raw, err := readRunnerServerText(reader)
			if err != nil {
				return
			}
			var frame struct {
				Type   string         `json:"type"`
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.Unmarshal([]byte(raw), &frame) != nil || frame.Type != "req" {
				continue
			}
			result, callErr := handle(frame.Method, frame.Params)
			ok := callErr == nil
			response := map[string]any{"type": "res", "id": frame.ID, "ok": ok, "result": result}
			if callErr != nil {
				response["error"] = callErr.Error()
			}
			encoded, _ := json.Marshal(response)
			writeMaskedText(t, conn, string(encoded))
		}
	}()
}

func TestWorkspaceMigrationTransfersBetweenSelectedRunners(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	now := d.Clock()
	for _, node := range []struct{ id, token string }{{"source", "rnr_source-token"}, {"target", "rnr_target-token"}} {
		hash := sha256.Sum256([]byte(node.token))
		_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES(?,?,?,?,?,'offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, node.id, "tenant", node.id, node.id, "computer", hex.EncodeToString(hash[:]), now, now)
		if err != nil {
			t.Fatal(err)
		}
	}
	sourceID := "source"
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &sourceID, WorkspaceKind: "host"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	info := func(kind string) map[string]any {
		return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true}, "hostInfo": map[string]any{"platform": "linux"}, "node": kind}
	}
	startMigrationRunner(t, server.URL, "rnr_source-token", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return info("source"), nil
		case "host.fs.stat":
			path := fmt.Sprint(params["path"])
			return map[string]any{"name": strings.Trim(path, "/"), "path": path, "isDir": path == "/", "size": 5, "mode": "0640", "modTime": "2026-01-01T00:00:00Z"}, nil
		case "host.fs.list":
			return map[string]any{"path": "/", "entries": []map[string]any{{"name": "a.txt", "path": "/a.txt", "isDir": false, "size": 5}}}, nil
		case "host.fs.read":
			return map[string]any{"path": "/a.txt", "base64": base64.StdEncoding.EncodeToString([]byte("hello")), "size": 5}, nil
		default:
			return nil, fmt.Errorf("unexpected source method %s", method)
		}
	})
	var mu sync.Mutex
	var archive []byte
	written := map[string][]byte{}
	startMigrationRunner(t, server.URL, "rnr_target-token", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return info("target"), nil
		case "host.fs.write":
			path := fmt.Sprint(params["path"])
			raw, _ := base64.StdEncoding.DecodeString(fmt.Sprint(params["base64"]))
			mu.Lock()
			if strings.Contains(path, ".zakura-migration-") {
				archive = append([]byte(nil), raw...)
			} else {
				written[path] = append([]byte(nil), raw...)
			}
			mu.Unlock()
			return map[string]any{"ok": true, "path": path}, nil
		case "host.fs.read":
			mu.Lock()
			data := append([]byte(nil), archive...)
			mu.Unlock()
			return map[string]any{"path": params["path"], "base64": base64.StdEncoding.EncodeToString(data), "size": len(data)}, nil
		case "host.fs.remove", "host.fs.mkdir":
			return map[string]any{"ok": true, "path": params["path"]}, nil
		default:
			return nil, fmt.Errorf("unexpected target method %s", method)
		}
	})
	deadline := time.Now().Add(2 * time.Second)
	for {
		var online int
		_ = d.DB.QueryRow(`SELECT COUNT(*) FROM runtime_nodes WHERE status='online'`).Scan(&online)
		if online == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runners did not connect")
		}
		time.Sleep(10 * time.Millisecond)
	}
	code, started := doJSON(t, server.Client(), "POST", server.URL+"/api/agents/"+agent.ID+"/migrations", token, map[string]any{"targetRuntimeNodeId": "target"})
	if code != http.StatusCreated {
		t.Fatalf("start migration: %d %#v", code, started)
	}
	migration := started["migration"].(map[string]any)
	id := migration["id"].(string)
	for time.Now().Before(deadline.Add(3 * time.Second)) {
		code, status := doJSON(t, server.Client(), "GET", server.URL+"/api/migrations/"+id, token, nil)
		if code == 200 {
			state := status["migration"].(map[string]any)
			if state["Status"] == "completed" || state["status"] == "completed" {
				mu.Lock()
				content := string(written["/a.txt"])
				mu.Unlock()
				if content != "hello" {
					t.Fatalf("migrated file: %q", content)
				}
				var node string
				_ = d.DB.QueryRow(`SELECT runtime_node_id FROM spaces WHERE id=?`, space.ID).Scan(&node)
				if node != "target" {
					t.Fatalf("space not rebound: %q", node)
				}
				return
			}
			if state["Status"] == "failed" || state["status"] == "failed" {
				t.Fatalf("migration failed: %#v", state)
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("migration did not complete")
}
