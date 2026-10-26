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
	pulls := make(chan string, 4)
	startMigrationRunner(t, server.URL, runnerToken, func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{"platform": "linux"}}, nil
		case "docker.pull":
			pulls <- fmt.Sprint(params["image"])
			return map[string]any{"ok": true}, nil
		default:
			return nil, fmt.Errorf("unexpected method %s", method)
		}
	})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var status string
		_ = d.DB.QueryRow(`SELECT status FROM runtime_nodes WHERE id='node'`).Scan(&status)
		if status == "online" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	code, accepted := doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/spaces/"+space.ID+"/acp/agents/codex/install", token, map[string]any{})
	if code != http.StatusAccepted || accepted["accepted"] != true {
		t.Fatalf("install accept contract: %d %#v", code, accepted)
	}
	for time.Now().Before(deadline.Add(3 * time.Second)) {
		code, polled := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agents/"+agent.ID+"/acp/installs", token, nil)
		if code == 200 {
			items := polled["installs"].([]any)
			if len(items) == 1 {
				install := items[0].(map[string]any)
				if install["state"] == "failed" {
					t.Fatalf("install failed: %#v", install)
				}
				if install["state"] == "completed" {
					select {
					case image := <-pulls:
						if image != acpAdapterImage("codex", "") {
							t.Fatalf("wrong adapter image: %s", image)
						}
					case <-time.After(time.Second):
						t.Fatal("no image pulled")
					}
					fresh, _ := store.GetAgent(context.Background(), "tenant", agent.ID)
					if string(fresh.Config) != "{}" {
						t.Fatalf("install leaked into Agent config: %s", fresh.Config)
					}
					return
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("ACP install progress did not complete")
}
