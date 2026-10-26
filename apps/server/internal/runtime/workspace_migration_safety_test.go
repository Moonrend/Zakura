// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"gorm.io/gorm"
)

func TestWorkspaceMigrationRejectsUnsafeModes(t *testing.T) {
	for _, tc := range []struct {
		mode    string
		dir, ok bool
	}{
		{"0640", false, true}, {"0600", false, true}, {"-rw-r-----", false, true}, {"drwxr-x---", true, true}, {"0750", true, true},
		{"0755", false, false}, {"-rwxr-xr-x", false, false}, {"-rwSr-----", false, false}, {"Lrwxrwxrwx", false, false}, {"Dcrw-------", false, false}, {"", false, false}, {"garbage", false, false},
	} {
		if err := migrationFileMode(runnerFSEntry{Mode: tc.mode, IsDir: tc.dir}); (err == nil) != tc.ok {
			t.Errorf("mode %q dir=%v: %v", tc.mode, tc.dir, err)
		}
	}
}

func TestWorkspaceMigrationQuiescenceRejectsDurableActivity(t *testing.T) {
	for _, kind := range []string{"run", "unknown", "persisting", "expired-pending", "project-intent", "stopped-mcp"} {
		t.Run(kind, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			store := NewStore(d)
			node := "node"
			space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
			if err != nil {
				t.Fatal(err)
			}
			h := &handler{deps: d, store: store, hub: newRunnerHub(d)}
			switch kind {
			case "run":
				agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
				if err != nil {
					t.Fatal(err)
				}
				session, err := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
				if err != nil {
					t.Fatal(err)
				}
				if _, err = store.StartRun(context.Background(), "tenant", agent.ID, session.ID, "hello", nil, nil); err != nil {
					t.Fatal(err)
				}
			case "unknown", "persisting", "expired-pending":
				status := kind
				if kind == "expired-pending" {
					status = "pending"
				}
				if err = d.Gorm.Table("acp_device_auth_attempts").Create(map[string]any{"id": "attempt", "tenant_id": "tenant", "space_id": space.ID, "profile_id": "codex", "principal_id": "user", "node_id": "node", "computer_id": "computer", "config_hash": "hash", "status": status, "expires_at": "2000-01-01T00:00:00Z", "next_poll_at": "2000-01-01T00:00:00Z", "created_at": "before", "updated_at": "before"}).Error; err != nil {
					t.Fatal(err)
				}
			case "project-intent":
				if err = d.Gorm.Table("spaces").Where("id=?", space.ID).Update("config_json", `{"projectOperations":{"old":{"kind":"rename"}}}`).Error; err != nil {
					t.Fatal(err)
				}
			case "stopped-mcp":
				if err = d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,created_at,updated_at) VALUES('node','tenant','Node','node','computer','offline','/srv/zakura','before','before')`).Error; err != nil {
					t.Fatal(err)
				}
				if err = d.Gorm.Exec(`INSERT INTO managed_containers(id,tenant_id,space_id,runtime_node_id,docker_id,name,image,purpose,status,created_at,updated_at) VALUES('old','tenant',?,'node','old','old','image','component','stopped','before','before')`, space.ID).Error; err != nil {
					t.Fatal(err)
				}
			}
			err = h.migrationQuiescent(context.Background(), space, "target")
			expected := "authentication"
			switch kind {
			case "run":
				expected = "active Space runs"
			case "project-intent":
				expected = "project operations"
			case "stopped-mcp":
				expected = "ACP/MCP"
			}
			if err == nil || !strings.Contains(err.Error(), expected) {
				t.Fatalf("activity %s not rejected: %v", kind, err)
			}
		})
	}
}

func TestWorkspaceMigrationTargetMustBeEmpty(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := builtinToolHarness(t, d, "rnr_migration_empty", func(method string, params map[string]any) (any, error) {
		if method == "sys.info" {
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "privateAtomicFS": true, "filesystemNoFollowStat": true}, "hostInfo": map[string]any{}}, nil
		}
		if method == "host.fs.list" {
			return map[string]any{"path": "/", "entries": []map[string]any{{"path": "/.zakura-migration-old.tar.gz"}}}, nil
		}
		return nil, fmt.Errorf("unexpected %s", method)
	})
	runner, err := h.hub.get("node")
	if err != nil {
		t.Fatal(err)
	}
	if err = migrationTargetEmpty(context.Background(), &remoteWorkspace{runner: runner, spaceID: "space"}); err == nil || !strings.Contains(err.Error(), "not empty") {
		t.Fatal(err)
	}
}

func TestWorkspaceMigrationArchivesRejectUnsafeSource(t *testing.T) {
	for _, unsafe := range []string{"executable", "mode-missing", "changed", "symlink", "old-runner"} {
		t.Run(unsafe, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			var stats atomic.Int64
			h := builtinToolHarness(t, d, "rnr_migration_archive", func(method string, params map[string]any) (any, error) {
				switch method {
				case "sys.info":
					return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "privateAtomicFS": true, "filesystemNoFollowStat": unsafe != "old-runner"}, "hostInfo": map[string]any{}}, nil
				case "host.fs.list":
					return map[string]any{"path": "/", "entries": []map[string]any{{"path": "/a"}}}, nil
				case "host.fs.stat":
					if params["noFollow"] != true || unsafe == "old-runner" {
						t.Error("unsafe metadata request reached runner")
						return nil, fmt.Errorf("unsafe metadata request")
					}
					p := fmt.Sprint(params["path"])
					mode := "-rw-------"
					if p == "/" {
						mode = "drwx------"
					} else {
						n := stats.Add(1)
						if unsafe == "executable" {
							mode = "-rwx------"
						}
						if unsafe == "symlink" {
							mode = "Lrwxrwxrwx"
						}
						if unsafe == "mode-missing" {
							mode = ""
						}
						if unsafe == "changed" && n > 1 {
							return map[string]any{"path": p, "size": 6, "mode": mode, "modTime": "changed"}, nil
						}
					}
					return map[string]any{"path": p, "isDir": p == "/", "size": 5, "mode": mode, "modTime": "before"}, nil
				case "host.fs.read":
					return map[string]any{"base64": base64.StdEncoding.EncodeToString([]byte("hello"))}, nil
				}
				return nil, fmt.Errorf("unexpected %s", method)
			})
			runner, _ := h.hub.get("node")
			if _, err := migrationArchive(context.Background(), &remoteWorkspace{runner: runner, spaceID: "space"}); err == nil {
				t.Fatal("unsafe export accepted")
			}
		})
	}
}

func TestWorkspaceMigrationRemovesStoppedSourceBeforeRebinding(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container"})
	if err != nil {
		t.Fatal(err)
	}
	var removed atomic.Bool
	h := builtinToolHarness(t, d, "rnr_migration_cleanup", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "privateAtomicFS": true, "filesystemNoFollowStat": true}, "hostInfo": map[string]any{}}, nil
		case "docker.list":
			if removed.Load() {
				return []any{}, nil
			}
			return []map[string]any{{"dockerId": "old", "status": "exited", "labels": map[string]string{"zakura.space": space.ID, "zakura.tenant": "tenant", "zakura.purpose": "workspace"}}}, nil
		case "docker.stop":
			if params["id"] != "old" || params["remove"] != true {
				return nil, fmt.Errorf("wrong cleanup identity")
			}
			removed.Store(true)
			return map[string]any{"ok": true}, nil
		}
		return nil, fmt.Errorf("unexpected %s", method)
	})
	if err = d.Gorm.Exec(`INSERT INTO managed_containers(id,tenant_id,space_id,runtime_node_id,docker_id,name,image,purpose,status,created_at,updated_at) VALUES('old','tenant',?,'node','old','old','image','workspace','stopped','before','before')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	lease, err := h.acquireSpaceWorkspace(context.Background(), "tenant", space.ID, "migrating", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.release()
	if err = h.migrationCleanupSourceWorkspace(context.Background(), lease); err != nil {
		t.Fatal(err)
	}
	var old models.ManagedContainer
	if err = d.Gorm.Where("id='old'").Take(&old).Error; err != nil {
		t.Fatal(err)
	}
	if !removed.Load() || old.DockerID != nil || old.Status != "removed" {
		t.Fatalf("old container still routable: %#v", old)
	}
	// Completion metadata update is fenced by the same lease, not a raw node patch.
	if err = lease.fenced(context.Background(), func(tx *gorm.DB) error { return nil }); err != nil {
		t.Fatal(err)
	}
}
