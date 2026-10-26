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

func TestACPSpaceCustomProbeUsesServerComputer(t *testing.T) {
	for _, tc := range []struct {
		name       string
		kind       string
		running    bool
		exitCode   int
		installed  bool
		wantMethod string
	}{
		{"host", "host", true, 0, true, "host.exec"},
		{"container", "container", true, 0, true, "docker.exec"},
		{"stopped", "container", false, 0, false, ""},
		{"failed_command", "host", true, 2, false, "host.exec"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := testDeps(t)
			token := seedTenant(t, d, "tenant")
			runnerToken := "rnr_acp-probe"
			hash := sha256.Sum256([]byte(runnerToken))
			now := d.Clock()
			_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now)
			if err != nil {
				t.Fatal(err)
			}
			node := "node"
			store := NewStore(d)
			space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: tc.kind})
			if err != nil {
				t.Fatal(err)
			}
			router := chi.NewRouter()
			RegisterRoutes(router, d)
			server := httptest.NewServer(router)
			defer server.Close()
			calls := make(chan map[string]any, 1)
			startMigrationRunner(t, server.URL, runnerToken, func(method string, params map[string]any) (any, error) {
				switch method {
				case "sys.info":
					return map[string]any{"kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}}, nil
				case "docker.list":
					status := "stopped"
					if tc.running {
						status = "running"
					}
					return []map[string]any{
						{"dockerId": "adapter-decoy", "status": "running", "labels": map[string]string{"zakura.purpose": "acp-adapter"}},
						{"dockerId": "workspace", "status": status, "labels": map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}},
					}, nil
				case "host.exec", "docker.exec":
					params["method"] = method
					calls <- params
					return map[string]any{"stdout": "custom-acp 1.0", "exitCode": tc.exitCode}, nil
				default:
					return nil, fmt.Errorf("unexpected method %s", method)
				}
			})
			deadline := time.Now().Add(3 * time.Second)
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
			base := server.URL + "/api/spaces/" + space.ID + "/acp"
			code, out := doJSON(t, server.Client(), http.MethodPut, base+"/config", token, map[string]any{"agents": map[string]any{"custom": map[string]any{"enabled": true, "command": "custom-acp", "setupMode": "self"}}})
			if code != http.StatusOK {
				t.Fatalf("save: %d %#v", code, out)
			}
			code, out = doJSON(t, server.Client(), http.MethodPost, base+"/agents/custom/probe", token, map[string]any{})
			if code != http.StatusOK || out["installed"] != tc.installed {
				t.Fatalf("probe: %d %#v", code, out)
			}
			if tc.wantMethod == "" {
				select {
				case got := <-calls:
					t.Fatalf("executed outside a running workspace: %#v", got)
				default:
				}
				return
			}
			select {
			case got := <-calls:
				if got["method"] != tc.wantMethod || got["workingDir"] != "/workspace" || fmt.Sprint(got["command"]) != "[custom-acp --version]" {
					t.Fatalf("wrong probe command: %#v", got)
				}
				if tc.kind == "host" && got["spaceId"] != space.ID || tc.kind == "container" && got["id"] != "workspace" {
					t.Fatalf("wrong server computer: %#v", got)
				}
			case <-time.After(time.Second):
				t.Fatal("no probe executed")
			}
		})
	}
}
