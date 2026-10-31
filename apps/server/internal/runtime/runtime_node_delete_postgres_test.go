package runtime

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func TestPostgresNodeRemovalSerializesDiskOperations(t *testing.T) {
	d := runtimePostgresDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, operation := range []string{"allocate", "delete"} {
		for n := range 4 {
			t.Run(fmt.Sprintf("%s-%d", operation, n), func(t *testing.T) {
				node := fmt.Sprintf("node-%s-%d", operation, n)
				if _, err := d.DB.Exec(d.Rebind(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,incarnation,created_at,updated_at) VALUES(?,'tenant',?,?,'server','offline','/workspace-data','incarnation','before','before')`), node, node, node); err != nil {
					t.Fatal(err)
				}
				diskID := "disk-" + node
				if operation == "delete" {
					disk, err := h.workspaceStore().RegisterDisk(ctx, "tenant", diskID, "Data", node, "incarnation", h.store.now())
					if err != nil {
						t.Fatal(err)
					}
					if err := h.workspaceStore().VerifyDisk(ctx, disk, 0, h.store.now()); err != nil {
						t.Fatal(err)
					}
				}
				start := make(chan struct{})
				result := make(chan error, 1)
				go func() {
					<-start
					var err error
					if operation == "allocate" {
						_, err = h.workspaceStore().RegisterDisk(ctx, "tenant", diskID, "Data", node, "incarnation", h.store.now())
					} else {
						_, err = h.workspaceStore().DeleteDisk(ctx, "tenant", diskID, "request-"+node, "cleanup-"+node, h.store.now())
					}
					result <- err
				}()
				close(start)
				removeErr := h.removeRuntimeNode(ctx, "tenant", node)
				operationErr := <-result
				if removeErr != nil {
					t.Fatal(removeErr)
				}
				if operationErr != nil && !errors.Is(operationErr, workspaces.ErrConflict) {
					t.Fatal(operationErr)
				}
				var activeDisks, pendingJobs int
				if err := d.DB.QueryRow(d.Rebind(`SELECT COUNT(*) FROM workspace_disks WHERE node_id=? AND node_removed_at IS NULL`), node).Scan(&activeDisks); err != nil || activeDisks != 0 {
					t.Fatalf("disk escaped node removal: count=%d err=%v", activeDisks, err)
				}
				if err := d.DB.QueryRow(d.Rebind(`SELECT COUNT(*) FROM workspace_cleanup_tombstones WHERE node_id=? AND pending=TRUE`), node).Scan(&pendingJobs); err != nil || pendingJobs != 0 {
					t.Fatalf("cleanup still awaits removed node: count=%d err=%v", pendingJobs, err)
				}
				if operation == "allocate" && operationErr == nil {
					disk, err := h.workspaceStore().Disk(ctx, "tenant", diskID)
					if err != nil || disk.NodeRemovedAt == nil || disk.State != "pending" {
						t.Fatalf("accepted allocation lost its removal marker: %+v %v", disk, err)
					}
					if err := h.workspaceStore().VerifyDisk(ctx, disk, 0, h.store.now()); !errors.Is(err, workspaces.ErrConflict) {
						t.Fatalf("late allocation became available: %v", err)
					}
				}
			})
		}
	}
}
