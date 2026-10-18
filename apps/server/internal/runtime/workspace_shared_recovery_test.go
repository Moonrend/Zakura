package runtime

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"gorm.io/gorm"
)

func TestWorkspaceSharedWriteRecoveryRequiresExplicitAcknowledgement(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Shared write", RuntimeNodeID: &node, WorkspaceKind: "container", WorkspaceStatus: "running"})
	if err != nil {
		t.Fatal(err)
	}
	h := builtinToolHarness(t, d, "rnr_shared_write_recovery", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"kind": "computer", "storageRoot": "/srv/zakura"}, nil
		case "docker.list":
			return []computerContainer{{DockerID: "existing", Status: "running", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		default:
			return nil, fmt.Errorf("recovery must not mutate files or processes: %s", method)
		}
	})
	ctx := context.Background()
	old, err := h.acquireSpaceInfrastructure(ctx, "tenant", space.ID)
	if err != nil {
		t.Fatal(err)
	}
	_ = old.uncertain(errors.New("write reply lost"))
	old.release()
	if err = d.Gorm.Exec(`UPDATE computer_workspace_leases SET expires_at=0 WHERE space_id=?`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.recoverSpaceWorkspaces(ctx, 10); err == nil {
		t.Fatal("sweep cleared an uncertain shared write merely because its workspace was running")
	}
	if claim, err := h.acquireSpaceInfrastructure(ctx, "tenant", space.ID); err == nil {
		claim.release()
		t.Fatal("unreconciled write allowed another writer")
	}
	var token string
	if err = d.DB.QueryRow(`SELECT token FROM computer_workspace_leases WHERE space_id=?`, space.ID).Scan(&token); err != nil {
		t.Fatal(err)
	}
	if err = h.acknowledgeAbsentSpaceWorkspace(ctx, "tenant", space.ID, token); err != nil {
		t.Fatal(err)
	}
	if err = old.fenced(ctx, func(*gorm.DB) error { return nil }); !errors.Is(err, errWorkspaceLeaseLost) {
		t.Fatalf("old writer was not fenced: %v", err)
	}
	current, err := store.GetSpace(ctx, "tenant", space.ID)
	if err != nil || current.WorkspaceStatus != "running" {
		t.Fatalf("recovery changed the observed workspace: %+v %v", current, err)
	}
	var leases int
	if err = d.DB.QueryRow(`SELECT COUNT(*) FROM computer_workspace_leases WHERE space_id=?`, space.ID).Scan(&leases); err != nil || leases != 0 {
		t.Fatalf("recovery left lease: %d %v", leases, err)
	}
}
