// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestACPInstallDispatchesRegistrySpecAndPersistsProgress(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	runnerToken := "rnr_acp-install"
	hash := sha256.Sum256([]byte(runnerToken))
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now)
	if err != nil {
		t.Fatal(err)
	}
	node := "node"
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	commands := make(chan []any, 4)
	startMigrationRunner(t, server.URL, runnerToken, func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true}, "hostInfo": map[string]any{"platform": "linux"}}, nil
		case "host.exec":
			command, _ := params["command"].([]any)
			commands <- command
			return map[string]any{"exitCode": 0, "stdout": fmt.Sprint(command), "stderr": ""}, nil
		default:
			return nil, fmt.Errorf("unexpected method %s", method)
		}
	})
	deadline := time.Now().Add(2 * time.Second)
	for {
		var status string
		_ = d.DB.QueryRow(`SELECT status FROM runtime_nodes WHERE id='node'`).Scan(&status)
		if status == "online" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runner did not connect")
		}
		time.Sleep(10 * time.Millisecond)
	}
	code, _ := doJSON(t, server.Client(), http.MethodPut, server.URL+"/api/agents/"+agent.ID+"/acp/agents/codex", token, map[string]any{"command": "codex", "displayName": "Codex"})
	if code != 200 {
		t.Fatalf("save ACP profile: %d", code)
	}
	code, accepted := doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/agents/"+agent.ID+"/acp/agents/codex/install", token, map[string]any{})
	if code != http.StatusAccepted || accepted["accepted"] != true {
		t.Fatalf("install accept contract: %d %#v", code, accepted)
	}
	for time.Now().Before(deadline.Add(3 * time.Second)) {
		code, polled := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agents/"+agent.ID+"/acp/installs", token, nil)
		if code == 200 {
			items := polled["installs"].([]any)
			if len(items) == 1 {
				install := items[0].(map[string]any)
				if install["state"] == "completed" {
					first, second := <-commands, <-commands
					if len(first) < 5 || first[0] != "npm" || first[1] != "install" || first[len(first)-1] != "@openai/codex" || len(second) != 2 || second[0] != "codex" || second[1] != "--version" {
						t.Fatalf("ACP install commands: %#v %#v", first, second)
					}
					return
				}
				if install["state"] == "failed" {
					t.Fatalf("ACP install failed: %#v", install)
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("ACP install progress did not complete")
}
