package runtime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
	"github.com/go-chi/chi/v5"
)

func TestRuntimeNodeDeletionStopsWorkspaceSynchronization(t *testing.T) {
	for _, deleteDisk := range []bool{false, true} {
		name := "retain-disk"
		if deleteDisk {
			name = "delete-disk"
		}
		t.Run(name, func(t *testing.T) {
			rig := newWorkspaceProxyRig(t)
			h, ctx := rig.h, context.Background()
			old := attachProxyWorkspace(t, rig, "removed-node-disk", "removed-node-instance")
			runner, err := h.hub.get(old.NodeID)
			if err != nil {
				t.Fatal(err)
			}
			if err := h.removeRuntimeNode(ctx, "tenant", old.NodeID); !errors.Is(err, errRuntimeNodeBound) {
				t.Fatalf("removed node with current workspace: %v", err)
			}
			cleanup, err := h.workspaceStore().Retire(ctx, old.Target, "retire-node", "cleanup-node", deleteDisk, h.store.now())
			if err != nil {
				t.Fatal(err)
			}
			claimed, err := h.workspaceStore().ClaimCleanup(ctx, "tenant", rig.space.ID, cleanup.ID, "old-worker", h.store.now())
			if err != nil {
				t.Fatal(err)
			}
			pending, err := h.workspaceStore().RegisterDisk(ctx, "tenant", "pending-disk", "Pending", old.NodeID, old.NodeIncarnation, h.store.now())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := h.deps.DB.Exec(`INSERT INTO node_installations(id,tenant_id,node_id,node_incarnation,bootstrap_hash,credential_nonce,created_at) VALUES('installation','tenant','node','incarnation','fixture-hash','fixture-nonce','before')`); err != nil {
				t.Fatal(err)
			}
			runnerTokenCache.Store(old.NodeID, "fixture-cache")
			if err := h.removeRuntimeNode(ctx, "tenant", old.NodeID); err != nil {
				t.Fatal(err)
			}
			select {
			case <-runner.done:
			default:
				t.Fatal("removed node connection remains live")
			}
			if _, err := h.hub.get(old.NodeID); err == nil {
				t.Fatal("removed node still accepts dispatch")
			}
			if _, ok := runnerTokenCache.Load(old.NodeID); ok {
				t.Fatal("removed node credential remains cached")
			}
			var revoked bool
			if err := h.deps.DB.QueryRow(`SELECT revoked FROM node_installations WHERE id='installation'`).Scan(&revoked); err != nil || !revoked {
				t.Fatalf("installation remains renewable: %v", err)
			}
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("Authorization", "Bearer rnr_workspace_proxy")
			request.Header.Set("Upgrade", "websocket")
			response := httptest.NewRecorder()
			h.runnerHubHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("deleted node reconnected: %d", response.Code)
			}
			job, err := h.workspaceStore().Cleanup(ctx, "tenant", rig.space.ID, cleanup.ID)
			if err != nil || job.Pending || job.Phase != "node_removed" || job.Token != "" {
				t.Fatalf("node deletion retained synchronization: %+v %v", job, err)
			}
			if err := h.workspaceStore().CompleteRelease(ctx, claimed, old.Target, h.store.now()); !errors.Is(err, workspaces.ErrConflict) {
				t.Fatalf("stale worker committed after node removal: %v", err)
			}
			if bindings, err := h.workspaceStore().NodeRevocations(ctx, old.NodeID); err != nil || len(bindings) != 0 {
				t.Fatalf("deleted node still has synchronization work: %v", err)
			}
			disk, err := h.workspaceStore().Disk(ctx, "tenant", old.DiskID)
			if err != nil || disk.NodeRemovedAt == nil || disk.AttachedInstanceID == nil || disk.VerifiedAt == nil {
				t.Fatalf("node deletion lost disk evidence: %+v %v", disk, err)
			}
			instance, err := h.workspaceStore().Instance(ctx, "tenant", rig.space.ID, old.InstanceID)
			if err != nil || instance.ReleasedAt != nil || instance.State != "revoked" {
				t.Fatalf("node deletion claimed remote writer release: %v", err)
			}
			if deleteDisk && disk.State != "deleted" || !deleteDisk && disk.State != "release_pending" {
				t.Fatalf("node deletion changed requested retention: %s", disk.State)
			}
			if !deleteDisk {
				removed, err := h.workspaceStore().DeleteDisk(ctx, "tenant", disk.ID, "forget-disk", "forget-cleanup", h.store.now())
				if err != nil || removed.Pending || removed.Phase != "node_removed" {
					t.Fatalf("forgotten disk enqueued remote work: %v", err)
				}
			}
			for _, err := range []error{
				h.workspaceStore().VerifyDisk(ctx, pending, 1, h.store.now()),
				h.workspaceStore().SampleUsage(ctx, pending, 1, h.store.now()),
				h.workspaceStore().DiskError(ctx, pending, errors.New("late allocation failure"), h.store.now()),
			} {
				if !errors.Is(err, workspaces.ErrConflict) {
					t.Fatalf("deleted node accepted allocation callback: %v", err)
				}
			}
			if _, err := h.workspaceStore().RegisterDisk(ctx, "tenant", "late-disk", "Late", old.NodeID, old.NodeIncarnation, h.store.now()); !errors.Is(err, workspaces.ErrConflict) {
				t.Fatalf("deleted node accepted a new disk: %v", err)
			}
			forgotten, err := h.workspaceStore().DeleteDisk(ctx, "tenant", pending.ID, "forget-pending", "forget-pending-cleanup", h.store.now())
			if err != nil || forgotten.Pending || forgotten.Phase != "node_removed" {
				t.Fatalf("pending disk cannot be forgotten after node removal: %v", err)
			}
			if disks, err := h.workspaceStore().Disks(ctx, "tenant"); err != nil || len(disks) != 0 {
				t.Fatalf("removed disk remains in management: %v", err)
			}
		})
	}
}

func TestRuntimeNodeDeletionPermission(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,created_at,updated_at) VALUES('node','tenant','Node','node','server','offline','/fixture','before','before')`); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Delete("/runtime-nodes/{id}", h.deleteRuntimeNode)
	for _, p := range []httpx.Principal{
		{TenantID: "tenant", Role: "member"},
		{TenantID: "tenant", Role: "owner", SpaceID: "space"},
		{TenantID: "tenant", Role: "owner", AgentID: "agent"},
		{TenantID: "tenant", APIKey: true, APIKeyScopes: `["api"]`},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodDelete, "/runtime-nodes/node", nil)
		router.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(context.Background(), p)))
		if w.Code != http.StatusForbidden {
			t.Fatalf("unauthorized node deletion: %d", w.Code)
		}
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodDelete, "/runtime-nodes/node", nil)
	router.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(context.Background(), httpx.Principal{TenantID: "tenant", Role: "owner"})))
	if w.Code != http.StatusOK {
		t.Fatalf("offline node deletion failed: %d %s", w.Code, w.Body)
	}
}
