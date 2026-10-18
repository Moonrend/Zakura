package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

func TestOwnerDeletionUnknownCreationQueuesDurableCleanup(t *testing.T) {
	for _, state := range []string{"creating", "unknown"} {
		t.Run(state, func(t *testing.T) {
			h, r := e2bTestSetup(t)
			if err := h.deps.Gorm.Exec(`UPDATE computer_runtimes SET state=? WHERE id=?`, state, r.ID).Error; err != nil {
				t.Fatal(err)
			}
			if err := h.prepareComputerDeletion(context.Background(), r.TenantID, r.SpaceID, r.ComputerID); err != nil {
				t.Fatalf("uncertain deletion=%v", err)
			}
			var pending bool
			if err := h.deps.DB.QueryRow(`SELECT deletion_pending FROM computers WHERE id=?`, r.ComputerID).Scan(&pending); err != nil || !pending {
				t.Fatalf("missing deletion fence=%v %v", pending, err)
			}
			var intents int
			if err := h.deps.DB.QueryRow(`SELECT COUNT(*) FROM computer_cleanup_intents WHERE runtime_id=? AND pending=TRUE`, r.ID).Scan(&intents); err != nil || intents != 1 {
				t.Fatalf("missing durable cleanup=%d %v", intents, err)
			}
			if err := h.computerStore().Delete(context.Background(), r.TenantID, r.SpaceID, r.ComputerID); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestOwnerDeletionQueuesStoppedManagedContainerAndPreservesSpaceFiles(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	ctx := context.Background()
	node := "node"
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "delete", RuntimeNodeID: &node, WorkspaceKind: "container", WorkspaceStatus: "stopped"})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	removed := false
	stops := 0
	c := computerContainer{DockerID: "stopped-container", Name: "workspace", Image: serverComputerImage, Status: "exited", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}
	h := builtinToolHarness(t, d, "rnr_delete_stopped", func(method string, params map[string]any) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		switch method {
		case "sys.info":
			return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
		case "docker.list":
			if removed {
				return []computerContainer{}, nil
			}
			return []computerContainer{c}, nil
		case "docker.stop":
			stops++
			if params["id"] != c.DockerID || params["remove"] != true {
				return nil, errors.New("wrong cleanup identity")
			}
			removed = true
			return map[string]any{"ok": true}, nil
		default:
			return nil, fmt.Errorf("Space files must be preserved: %s", method)
		}
	})
	labels, _ := json.Marshal(c.Labels)
	if err = d.Gorm.Exec(`INSERT INTO managed_containers(id,tenant_id,space_id,runtime_node_id,docker_id,name,image,purpose,status,labels_json,created_at,updated_at) VALUES('managed','tenant',?,'node',?,'workspace',?,'workspace','stopped',?,'now','now')`, space.ID, c.DockerID, c.Image, string(labels)).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.prepareSpaceDeletion(ctx, "tenant", space.ID); err != nil {
		t.Fatal(err)
	}
	if err = h.prepareSpaceDeletion(ctx, "tenant", space.ID); err != nil {
		t.Fatalf("idempotent prepare=%v", err)
	}
	if err = h.requireSpaceNotDeleting(ctx, "tenant", space.ID); !errors.Is(err, computers.ErrOwnerDeleting) {
		t.Fatalf("deletion fence=%v", err)
	}
	mu.Lock()
	if stops != 0 {
		t.Error("preparation destroyed a container")
	}
	mu.Unlock()
	if err = d.Gorm.Exec(`DELETE FROM spaces WHERE id=?`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.sweepManagedContainerCleanup(ctx, 10); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if stops != 1 {
		t.Fatalf("stopped container leaked: stops=%d", stops)
	}
	var pending bool
	if err = d.DB.QueryRow(`SELECT pending FROM managed_container_cleanup_intents WHERE docker_id=?`, c.DockerID).Scan(&pending); err != nil || pending {
		t.Fatalf("cleanup pending=%v %v", pending, err)
	}
}

func TestOwnerDeletionTemporarySnapshotRevokesThenSurvivesOwnerLoss(t *testing.T) {
	initial, r := e2bTestSetup(t)
	d := initial.deps
	ctx := context.Background()
	r.ExternalID = "original"
	r.RootPath = "/srv/zakura/computers/" + r.ID + "/workspace"
	r.State = computers.Ready
	name, labels := computerContainerIdentity(r)
	container := computerContainer{DockerID: r.ExternalID, Name: name, Image: serverComputerImage, Status: "running", Labels: labels}
	var mu sync.Mutex
	removed := false
	stops, files := 0, 0
	h := builtinToolHarness(t, d, "rnr_owner_temp", func(method string, params map[string]any) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		switch method {
		case "sys.info":
			return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
		case "docker.list":
			if removed {
				return []computerContainer{}, nil
			}
			return []computerContainer{container}, nil
		case "docker.stop":
			stops++
			removed = true
			return map[string]any{"ok": true}, nil
		case "host.fs.remove":
			files++
			if params["path"] != "computers/"+r.ID+"/workspace" {
				return nil, errors.New("foreign files")
			}
			return map[string]any{"ok": true}, nil
		default:
			return nil, fmt.Errorf("unexpected %s", method)
		}
	})
	if err := d.Gorm.Exec(`UPDATE computers SET provider='temporary',runtime_node_id='node' WHERE id=?`, r.ComputerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.Gorm.Exec(`UPDATE computer_runtimes SET state='ready',external_id=?,root_path=? WHERE id=?`, r.ExternalID, r.RootPath, r.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.prepareComputerDeletion(ctx, r.TenantID, r.SpaceID, r.ComputerID); err != nil {
		t.Fatal(err)
	}
	got, err := h.computerStore().GetRuntime(ctx, computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation})
	if err != nil || got.State != computers.Expired {
		t.Fatalf("execution not revoked: %+v %v", got, err)
	}
	if err = h.computerStore().Delete(ctx, r.TenantID, r.SpaceID, r.ComputerID); err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`UPDATE computer_workspace_leases SET expires_at=0 WHERE space_id=?`, r.SpaceID).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.finishComputerDeletion(ctx, r.TenantID, r.SpaceID); err != nil {
		t.Fatal(err)
	}
	if err = h.finishComputerDeletion(ctx, r.TenantID, r.SpaceID); err != nil {
		t.Fatalf("idempotent finalizer=%v", err)
	}
	cleanup := computers.CleanupDeps{Store: h.computerStore(), Destroyers: h.computerDestroyers(), Now: time.Now}
	if _, _, err = cleanup.ExpireOverdue(ctx, 10); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if stops != 1 || files != 1 {
		t.Fatalf("cleanup stops=%d files=%d", stops, files)
	}
}

func TestOwnerDeletionManagedAttemptFailureCannotEraseIntentOrMetadata(t *testing.T) {
	for _, mode := range []string{"stop-failure", "late-token"} {
		t.Run(mode, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			ctx := context.Background()
			node := "node"
			space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "managed", RuntimeNodeID: &node, WorkspaceStatus: "stopped"})
			if err != nil {
				t.Fatal(err)
			}
			c := computerContainer{DockerID: "original", Name: "login", Image: "adapter", Status: "exited", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "acp-login"}}
			var mu sync.Mutex
			removed := false
			h := builtinToolHarness(t, d, "rnr_owner_"+mode, func(method string, params map[string]any) (any, error) {
				mu.Lock()
				defer mu.Unlock()
				switch method {
				case "sys.info":
					return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
				case "docker.list":
					if removed {
						return []computerContainer{}, nil
					}
					return []computerContainer{c}, nil
				case "docker.stop":
					if mode == "stop-failure" {
						return nil, errors.New("daemon stop failed")
					}
					// A successor claims the durable attempt before the old RPC replies.
					if err := d.Gorm.Exec(`UPDATE managed_container_cleanup_intents SET token='successor',next_attempt=? WHERE docker_id=?`, time.Now().Add(time.Hour).UnixMilli(), c.DockerID).Error; err != nil {
						return nil, err
					}
					removed = true
					return map[string]any{"ok": true}, nil
				default:
					return nil, fmt.Errorf("unexpected filesystem/effect %s", method)
				}
			})
			labels, _ := json.Marshal(c.Labels)
			if err = d.Gorm.Exec(`INSERT INTO managed_containers(id,tenant_id,space_id,runtime_node_id,docker_id,name,image,purpose,status,labels_json,created_at,updated_at) VALUES('managed','tenant',?,'node',?,'login','adapter','acp-login','stopped',?,'now','now')`, space.ID, c.DockerID, string(labels)).Error; err != nil {
				t.Fatal(err)
			}
			if err = h.prepareSpaceDeletion(ctx, "tenant", space.ID); err != nil {
				t.Fatal(err)
			}
			if err = h.sweepManagedContainerCleanup(ctx, 10); err == nil {
				t.Fatal("failed/stale attempt was reported successful")
			}
			var pending bool
			var token, dockerID, status string
			if err = d.DB.QueryRow(`SELECT pending,token FROM managed_container_cleanup_intents WHERE docker_id=?`, c.DockerID).Scan(&pending, &token); err != nil || !pending {
				t.Fatalf("intent lost: pending=%v %v", pending, err)
			}
			if mode == "late-token" && token != "successor" {
				t.Fatalf("late attempt overwrote successor: %s", token)
			}
			if err = d.DB.QueryRow(`SELECT docker_id,status FROM managed_containers WHERE id='managed'`).Scan(&dockerID, &status); err != nil || dockerID != c.DockerID || status != "stopped" {
				t.Fatalf("failed attempt rewrote metadata: %s %s %v", dockerID, status, err)
			}
		})
	}
}

func TestOwnerDeletionTenantRetainsNodeUntilStoppedOrphanCleanupSucceeds(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	var mu sync.Mutex
	fail, removed := true, false
	c := computerContainer{DockerID: "tenant-orphan", Name: "tenant-adapter", Image: "adapter", Status: "exited", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.purpose": "acp-login"}}
	h := builtinToolHarness(t, d, "rnr_owner_tenant", func(method string, params map[string]any) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		switch method {
		case "sys.info":
			return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
		case "docker.list":
			if removed {
				return []computerContainer{}, nil
			}
			return []computerContainer{c}, nil
		case "docker.stop":
			if fail {
				return nil, errors.New("stop failure")
			}
			removed = true
			return map[string]any{"ok": true}, nil
		default:
			return nil, fmt.Errorf("unexpected %s", method)
		}
	})
	if err := h.beforeTenantDelete(ctx, "tenant"); err == nil {
		t.Fatal("tenant deletion ignored pending orphan cleanup")
	}
	if _, err := h.hub.get("node"); err != nil {
		t.Fatalf("cleanup failure disconnected original node: %v", err)
	}
	var pending bool
	if err := d.DB.QueryRow(`SELECT pending FROM managed_container_cleanup_intents WHERE docker_id=?`, c.DockerID).Scan(&pending); err != nil || !pending {
		t.Fatalf("orphan cleanup lost: %v %v", pending, err)
	}
	mu.Lock()
	fail = false
	mu.Unlock()
	if err := d.Gorm.Exec(`UPDATE managed_container_cleanup_intents SET next_attempt=0`).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.beforeTenantDelete(ctx, "tenant"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.hub.get("node"); err == nil {
		t.Fatal("completed tenant deletion retained node session")
	}
}

func TestOwnerDeletionMigrationLeaseDoesNotBlockAttachedPreparation(t *testing.T) {
	h, r := e2bTestSetup(t)
	ctx := context.Background()
	lease, err := h.acquireSpaceWorkspace(ctx, r.TenantID, r.SpaceID, "migrating", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.release()
	if err = h.prepareComputerDeletion(ctx, r.TenantID, r.SpaceID, r.ComputerID); err != nil {
		t.Fatalf("unrelated migration blocked deletion: %v", err)
	}
	if err = lease.check(ctx); err != nil {
		t.Fatalf("attached deletion changed migration lease: %v", err)
	}
	current, err := h.store.GetSpace(ctx, r.TenantID, r.SpaceID)
	if err != nil || current.WorkspaceStatus != "migrating" {
		t.Fatalf("attached deletion changed workspace: %s %v", current.WorkspaceStatus, err)
	}
}

func TestOwnerDeletionOfflineManagedPreflightRetainsOwner(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	ctx := context.Background()
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "offline"})
	if err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,storage_root,created_at,updated_at) VALUES('missing','tenant','offline','offline','server','offline','hash','/srv/zakura','now','now')`).Error; err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`INSERT INTO managed_containers(id,tenant_id,space_id,runtime_node_id,docker_id,name,image,purpose,status,created_at,updated_at) VALUES('offline','tenant',?,'missing','stopped','old','image','workspace','stopped','now','now')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	if err = h.prepareSpaceDeletion(ctx, "tenant", space.ID); err == nil {
		t.Fatal("offline deletion accepted")
	}
	var pending bool
	if err = d.DB.QueryRow(`SELECT deletion_pending FROM spaces WHERE id=?`, space.ID).Scan(&pending); err != nil || pending {
		t.Fatalf("preflight changed owner=%v %v", pending, err)
	}
}
