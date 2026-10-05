// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestACPDispatchesThroughSelectedRuntimeNode(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	runnerToken := "rnr_test-runner-token"
	runnerHash := sha256.Sum256([]byte(runnerToken))
	store := NewStore(d)
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/tmp','{}',false,?,?)`, hex.EncodeToString(runnerHash[:]), now, now)
	if err != nil {
		t.Fatal(err)
	}
	node := "node"
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

	seen := make(chan map[string]any, 1)
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
			if err := json.Unmarshal([]byte(raw), &frame); err != nil {
				runnerErrors <- err
				return
			}
			if frame.Type != "req" {
				continue
			}
			var result any
			switch frame.Method {
			case "sys.info":
				result = map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true}, "hostInfo": map[string]any{}}
			case "host.fs.mkdir":
				result = map[string]any{"ok": true, "path": "/", "abs": "/srv/zakura/spaces/" + space.ID + "/workspace"}
			case "host.exec":
				seen <- frame.Params
				result = map[string]any{"exitCode": 0, "stdout": "codex 1.2.3", "stderr": ""}
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
	code, out := doJSON(t, server.Client(), "POST", server.URL+"/api/agents/"+agent.ID+"/start", token, map[string]any{})
	if code != 200 || out["starting"] != true || out["workspaceStatus"] != "running" {
		t.Fatalf("runner workspace start: %d %#v", code, out)
	}
	code, out = doJSON(t, server.Client(), "POST", server.URL+"/api/agents/"+agent.ID+"/stop", token, map[string]any{})
	if code != 200 || out["workspaceStatus"] != "stopped" {
		t.Fatalf("runner workspace stop: %d %#v", code, out)
	}
	code, out = doJSON(t, server.Client(), "PUT", server.URL+"/api/agents/"+agent.ID+"/acp/agents/codex", token, map[string]any{"command": "codex"})
	if code != 200 {
		t.Fatalf("profile: %d %#v", code, out)
	}
	code, out = doJSON(t, server.Client(), "POST", server.URL+"/api/agents/"+agent.ID+"/acp/agents/codex/probe", token, map[string]any{})
	if code != 200 || out["installed"] != true || out["output"] != "codex 1.2.3" {
		t.Fatalf("probe: %d %#v", code, out)
	}
	select {
	case params := <-seen:
		command, _ := params["command"].([]any)
		if len(command) != 2 || command[0] != "codex" || command[1] != "--version" || params["spaceId"] != space.ID || params["workingDir"] != "/workspace" {
			t.Fatalf("runtime exec contract: %#v", params)
		}
	case err := <-runnerErrors:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("runner did not receive exec")
	}
}
