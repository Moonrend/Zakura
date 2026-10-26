// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/go-chi/chi/v5"
)

func newACPResolveHandler(d *appdeps.Dependencies) *handler {
	return &handler{deps: d, store: NewStore(d), mcpSessions: map[string]spaceMCPSession{}}
}

func TestACPHostIsSpaceServerRegardlessOfToolComputer(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	node := "node"
	now := d.Clock()
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','online','{}','{}','/srv/zakura','{}',false,?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	s, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	a, _ := h.store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: s.ID})
	sess, _ := h.store.CreateSession(context.Background(), "tenant", "", a.ID, Session{Kind: "acp"})
	if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,capabilities_json,created_at,updated_at) VALUES('tool','tenant',?,'Tool','temporary','["commands","files"]',?,?)`, s.ID, now, now).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.computerStore().SetSessionDefault(context.Background(), "tenant", s.ID, sess.ID, "tool"); err != nil {
		t.Fatal(err)
	}
	exec, err := resolveACPHost(context.Background(), h, "tenant", a.ID, sess.ID)
	if err != nil || exec == nil || exec.computer.ID != computers.ServerComputerID(s.ID) || exec.nodeID != node {
		t.Fatalf("ACP host: %+v %v", exec, err)
	}
	if err = d.Gorm.Exec(`UPDATE cloud_agent_sessions SET origin_json='{"acpComputerId":"other"}' WHERE id=?`, sess.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = resolveACPHost(context.Background(), h, "tenant", a.ID, sess.ID); err == nil || !strings.Contains(err.Error(), "host computer changed") {
		t.Fatalf("host switch accepted: %v", err)
	}
}

func TestACPRegistryLaunchUsesContainerAndPersistentSpaceHome(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	runnerToken := "rnr_acp_registry"
	hash := sha256.Sum256([]byte(runnerToken))
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now)
	if err != nil {
		t.Fatal(err)
	}
	node := "node"
	store := NewStore(d)
	s, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	a, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: s.ID})
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	creates := make(chan map[string]any, 1)
	cleanups := make(chan string, 1)
	configWrites := make(chan string, 1)
	startMigrationRunner(t, server.URL, runnerToken, func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true, "privateAtomicFS": true, "filesystemNoFollowStat": true}}, nil
		case "host.fs.list":
			return map[string]any{"entries": []any{}}, nil
		case "host.fs.mkdir":
			return map[string]any{"abs": "/srv/zakura/spaces/" + s.ID + "/workspace"}, nil
		case "host.fs.write":
			if strings.HasSuffix(fmt.Sprint(params["path"]), "/opencode/zakura.json") {
				configWrites <- fmt.Sprint(params["content"])
			}
			return map[string]any{"ok": true, "mode": 384, "atomic": true}, nil
		case "docker.pull", "docker.exec.close":
			return map[string]any{"ok": true}, nil
		case "docker.stop":
			if params["remove"] == true {
				cleanups <- fmt.Sprint(params["id"])
			}
			return map[string]any{"ok": true}, nil
		case "docker.create":
			creates <- params
			return map[string]any{"dockerId": "adapter-ctr"}, nil
		case "docker.attach":
			return nil, fmt.Errorf("stop after launch verification")
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
	body := map[string]any{"agents": map[string]any{"opencode": map[string]any{"enabled": true, "modelProvider": "zakura", "setupMode": "api_key", "managed": map[string]any{"zakura_api_key": "sk-test-space", "zakura_base_url": "http://gateway.test/v1", "model": "test-model"}}}}
	code, out := doJSON(t, server.Client(), http.MethodPut, server.URL+"/api/spaces/"+s.ID+"/acp/config", token, body)
	if code != 200 {
		t.Fatalf("save: %d %#v", code, out)
	}
	code, out = doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/agents/"+a.ID+"/acp/draft", token, map[string]any{"profileId": "opencode"})
	if code != http.StatusCreated {
		t.Fatalf("draft: %d %#v", code, out)
	}
	select {
	case spec := <-creates:
		if spec["image"] != acpAdapterImage("opencode", "") || spec["stdinOpen"] != true || spec["command"] != nil || spec["privileged"] != nil || spec["ports"] != nil {
			t.Fatalf("unsafe or wrong launch: %#v", spec)
		}
		env := spec["env"].(map[string]any)
		if env["HOME"] != "/workspace/.zakura/acp/opencode/home" || env["OPENCODE_CONFIG"] != "/workspace/.zakura/acp/opencode/home/.config/opencode/zakura.json" || env["OPENCODE_CONFIG_CONTENT"] != nil {
			t.Fatalf("missing launch config: %#v", env)
		}
		labels := spec["labels"].(map[string]any)
		if labels["zakura.computer"] != computers.ServerComputerID(s.ID) {
			t.Fatalf("wrong host: %#v", labels)
		}
		select {
		case content := <-configWrites:
			var opencode map[string]any
			if json.Unmarshal([]byte(content), &opencode) != nil || opencode["model"] != "zakura/test-model" {
				t.Fatal("invalid opencode config file")
			}
		default:
			t.Fatal("adapter started before its model configuration was written")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no adapter container created")
	}
	select {
	case id := <-cleanups:
		if id != "adapter-ctr" {
			t.Fatalf("wrong container cleaned up: %s", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("failed attach leaked adapter container")
	}
}
