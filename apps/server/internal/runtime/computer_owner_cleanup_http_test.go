package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

// Exercise the real deletion handlers, not preparation helpers directly.
func ownerCleanupHTTPDelete(t *testing.T, h *handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	router.Delete("/spaces/{id}", h.deleteSpace)
	h.registerComputers(router)
	req := httptest.NewRequest(http.MethodDelete, path, nil)
	req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant", Role: "owner"}))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func TestOwnerCleanupTenantUnboundRegisteredNodeDoesNotInventWorkload(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	h.service = NewService(h.store)
	ctx := context.Background()
	for _, kind := range []string{"local", "host", "container"} {
		if _, err := h.store.CreateSpace(ctx, "tenant", Space{Name: kind, WorkspaceKind: kind}); err != nil {
			t.Fatal(err)
		}
	}
	if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('admin-created-node','tenant','Unbound','unbound','computer','online','{}','{}','/srv/zakura','{}',TRUE,'now','now')`).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.beforeTenantDelete(ctx, "tenant"); err != nil {
		t.Fatalf("unbound registration blocked empty tenant deletion: %v", err)
	}
	if err := h.beforeTenantDelete(ctx, "tenant"); err != nil {
		t.Fatalf("multiple empty Space preparation not retryable: %v", err)
	}
	var intents int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM managed_container_cleanup_intents`).Scan(&intents); err != nil || intents != 0 {
		t.Fatalf("bare registration invented cleanup workload: %d %v", intents, err)
	}
}

func TestOwnerCleanupHTTPFreshLocalSpaceDeletion(t *testing.T) {
	for _, kind := range []string{"", "local", "host"} {
		t.Run("kind="+kind, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			h := &handler{deps: d, store: NewStore(d)}
			space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "Fresh local", WorkspaceKind: kind})
			if err != nil {
				t.Fatal(err)
			}
			w := ownerCleanupHTTPDelete(t, h, "/spaces/"+space.ID)
			if w.Code != http.StatusOK {
				t.Fatalf("fresh Space deletion: %d %s", w.Code, w.Body)
			}
			var count int
			for _, table := range []string{"spaces", "computers", "computer_workspace_leases", "computer_cleanup_intents", "managed_container_cleanup_intents"} {
				if err = d.DB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
					t.Fatalf("fresh deletion left %s rows=%d: %v", table, count, err)
				}
			}
		})
	}
}

func TestOwnerCleanupHTTPSpaceDeletionQueuesSurvivingManagedIntent(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	node := "node"
	space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "Delete stopped workspace", RuntimeNodeID: &node, WorkspaceStatus: "stopped"})
	if err != nil {
		t.Fatal(err)
	}
	container := computerContainer{DockerID: "original-workspace", Name: "original", Image: serverComputerImage, Status: "exited", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}
	var mu sync.Mutex
	removed, stops := false, 0
	h := builtinToolHarness(t, d, "rnr_owner_http_space", func(method string, params map[string]any) (any, error) {
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
			if params["id"] != container.DockerID || params["remove"] != true {
				return nil, errors.New("cleanup targeted a different container")
			}
			stops++
			removed = true
			return map[string]any{"ok": true}, nil
		default:
			return nil, fmt.Errorf("Space files must not be removed: %s", method)
		}
	})
	labels, _ := json.Marshal(container.Labels)
	if err = d.Gorm.Exec(`INSERT INTO managed_containers(id,tenant_id,space_id,runtime_node_id,docker_id,name,image,purpose,status,labels_json,created_at,updated_at) VALUES('managed-http','tenant',?,'node',?,'original',?,'workspace','stopped',?,'now','now')`, space.ID, container.DockerID, container.Image, string(labels)).Error; err != nil {
		t.Fatal(err)
	}
	w := ownerCleanupHTTPDelete(t, h, "/spaces/"+space.ID)
	if w.Code != http.StatusOK {
		t.Fatalf("Space deletion: %d %s", w.Code, w.Body)
	}
	if _, err = h.store.GetSpace(ctx, "tenant", space.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Space owner survived successful DELETE: %v", err)
	}
	var pending bool
	var snapshot string
	if err = d.DB.QueryRow(`SELECT pending,snapshot_json FROM managed_container_cleanup_intents WHERE docker_id=?`, container.DockerID).Scan(&pending, &snapshot); err != nil || !pending || snapshot == "" {
		t.Fatalf("owner cascade erased durable intent: pending=%v snapshot=%q err=%v", pending, snapshot, err)
	}
	mu.Lock()
	before := stops
	mu.Unlock()
	if before != 0 {
		t.Fatalf("HTTP preparation performed destruction: %d", before)
	}
	if err = h.sweepManagedContainerCleanup(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if err = d.DB.QueryRow(`SELECT pending FROM managed_container_cleanup_intents WHERE docker_id=?`, container.DockerID).Scan(&pending); err != nil || pending {
		t.Fatalf("post-owner cleanup failed: %v %v", pending, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if stops != 1 {
		t.Fatalf("original stopped container cleanup count=%d", stops)
	}
}

func TestOwnerCleanupHTTPSpaceUnknownCreationRejected(t *testing.T) {
	for _, state := range []string{"creating", "unknown"} {
		t.Run(state, func(t *testing.T) {
			h, runtime := e2bTestSetup(t)
			if err := h.deps.Gorm.Exec(`UPDATE computer_runtimes SET state=? WHERE id=?`, state, runtime.ID).Error; err != nil {
				t.Fatal(err)
			}
			w := ownerCleanupHTTPDelete(t, h, "/spaces/"+runtime.SpaceID)
			if w.Code != http.StatusConflict {
				t.Fatalf("uncertain creation deletion: %d %s", w.Code, w.Body)
			}
			var pending bool
			if err := h.deps.DB.QueryRow(`SELECT deletion_pending FROM spaces WHERE id=?`, runtime.SpaceID).Scan(&pending); err != nil || pending {
				t.Fatalf("preflight rejection lost/stuck owner: pending=%v %v", pending, err)
			}
			var got string
			if err := h.deps.DB.QueryRow(`SELECT state FROM computer_runtimes WHERE id=?`, runtime.ID).Scan(&got); err != nil || got != state {
				t.Fatalf("unknown runtime rewritten: %s %v", got, err)
			}
			var count int
			for _, table := range []string{"computer_cleanup_intents", "managed_container_cleanup_intents", "computer_workspace_leases"} {
				if err := h.deps.DB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
					t.Fatalf("uncertain creation guessed %s rows=%d %v", table, count, err)
				}
			}
		})
	}
}

func TestOwnerCleanupHTTPAttachedDeletionReleasesAndFailureRetainsFence(t *testing.T) {
	for _, failDelete := range []bool{false, true} {
		t.Run(fmt.Sprintf("failDelete=%v", failDelete), func(t *testing.T) {
			h, runtime := e2bTestSetup(t)
			if err := h.deps.Gorm.Exec(`UPDATE computer_runtimes SET state='pending_approval' WHERE id=?`, runtime.ID).Error; err != nil {
				t.Fatal(err)
			}
			space, err := h.store.GetSpace(context.Background(), runtime.TenantID, runtime.SpaceID)
			if err != nil {
				t.Fatal(err)
			}
			if failDelete {
				// Fail after preparation/revocation, at the actual owner DELETE.
				if err = h.deps.Gorm.Exec(`CREATE TRIGGER owner_http_delete_failure BEFORE DELETE ON computers WHEN OLD.id='computer' BEGIN SELECT RAISE(ABORT,'injected owner delete failure'); END`).Error; err != nil {
					t.Fatal(err)
				}
			}
			path := "/spaces/" + runtime.SpaceID + "/computers/" + runtime.ComputerID
			w := ownerCleanupHTTPDelete(t, h, path)
			if failDelete {
				if w.Code < 400 {
					t.Fatalf("injected delete failure reported success: %d %s", w.Code, w.Body)
				}
				var pending bool
				if err = h.deps.DB.QueryRow(`SELECT deletion_pending FROM computers WHERE id=?`, runtime.ComputerID).Scan(&pending); err != nil || !pending {
					t.Fatalf("delete failure reopened creation: pending=%v %v", pending, err)
				}
				var leases int
				var state string
				if err = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM computer_workspace_leases WHERE space_id=?`, runtime.SpaceID).Scan(&leases); err != nil || leases != 0 {
					t.Fatalf("attached DELETE claimed workspace: %d %v", leases, err)
				}
				if err = h.deps.DB.QueryRow(`SELECT state FROM computer_runtimes WHERE id=?`, runtime.ID).Scan(&state); err != nil || state != "failed" {
					t.Fatalf("failed DELETE left runnable reservation: %s %v", state, err)
				}
				if err = h.deps.Gorm.Exec(`DROP TRIGGER owner_http_delete_failure`).Error; err != nil {
					t.Fatal(err)
				}
				w = ownerCleanupHTTPDelete(t, h, path)
			}
			if w.Code != http.StatusOK {
				t.Fatalf("attached deletion/retry: %d %s", w.Code, w.Body)
			}
			var leases, owners int
			if err = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM computer_workspace_leases WHERE space_id=?`, runtime.SpaceID).Scan(&leases); err != nil || leases != 0 {
				t.Fatalf("successful attached DELETE retained lease: %d %v", leases, err)
			}
			if err = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM computers WHERE id=?`, runtime.ComputerID).Scan(&owners); err != nil || owners != 0 {
				t.Fatalf("successful attached DELETE retained owner: %d %v", owners, err)
			}
			current, err := h.store.GetSpace(context.Background(), runtime.TenantID, runtime.SpaceID)
			if err != nil || current.WorkspaceStatus != space.WorkspaceStatus {
				t.Fatalf("attached finalizer changed Space status: %s want=%s err=%v", current.WorkspaceStatus, space.WorkspaceStatus, err)
			}
		})
	}
}
