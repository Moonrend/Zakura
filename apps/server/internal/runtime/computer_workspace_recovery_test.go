package runtime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"gorm.io/gorm"
)

func TestWorkspaceRecoveryFinishesPersistedConfigAfterCrash(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Config crash", RuntimeNodeID: &node, WorkspaceKind: "container", WorkspaceStatus: "stopped"})
	if err != nil {
		t.Fatal(err)
	}
	h := builtinToolHarness(t, d, "rnr_workspace_config_crash", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
		case "docker.list":
			return []computerContainer{}, nil
		default:
			return nil, fmt.Errorf("must not remove files or create: %s", method)
		}
	})
	ctx := context.Background()
	image := "after:crash"
	desired := workspaceConfig{RuntimeNodeID: &node, WorkspaceKind: "container", WorkspaceImage: &image, EnableComputer: true}
	old, err := h.acquireSpaceWorkspace(ctx, "tenant", space.ID, "configuring", true, &desired)
	if err != nil {
		t.Fatal(err)
	}
	// Process dies after the external removal but before configuration commit.
	if err = d.Gorm.Exec(`UPDATE computer_workspace_leases SET expires_at=0 WHERE space_id=?`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.recoverSpaceWorkspaces(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if err = old.applyConfig(ctx, workspaceConfig{WorkspaceKind: "host"}); !errors.Is(err, errWorkspaceLeaseLost) {
		t.Fatalf("late configuration=%v", err)
	}
	old.release()
	got, err := store.GetSpace(ctx, "tenant", space.ID)
	if err != nil || got.WorkspaceImage == nil || *got.WorkspaceImage != image || !got.EnableComputer || got.WorkspaceStatus != "stopped" {
		t.Fatalf("configuration not recovered: %+v %v", got, err)
	}
	var runtimes int
	if err = d.DB.QueryRow(`SELECT COUNT(*) FROM computer_runtimes WHERE space_id=?`, space.ID).Scan(&runtimes); err != nil || runtimes != 0 {
		t.Fatalf("recovery manufactured runtimes=%d %v", runtimes, err)
	}
}

func TestWorkspaceExpiredLeaseFencesLateCompletionAndRelease(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Fencing", RuntimeNodeID: &node, WorkspaceKind: "container"})
	if err != nil {
		t.Fatal(err)
	}
	h := builtinToolHarness(t, d, "rnr_workspace_fence", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
		case "docker.list":
			return []computerContainer{{DockerID: "orphan", Name: "workspace", Image: serverComputerImage, Status: "running", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		default:
			return nil, fmt.Errorf("unexpected effect %s", method)
		}
	})
	ctx := context.Background()
	old, err := h.acquireSpaceWorkspace(ctx, "tenant", space.ID, "starting", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`UPDATE computer_workspace_leases SET expires_at=0 WHERE space_id=?`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.recoverSpaceWorkspaces(ctx, 10); err != nil {
		t.Fatal(err)
	}
	got, _ := store.GetSpace(ctx, "tenant", space.ID)
	if got.WorkspaceStatus != "running" {
		t.Fatalf("recovery status=%s", got.WorkspaceStatus)
	}
	next, err := h.acquireSpaceWorkspace(ctx, "tenant", space.ID, "stopping", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = old.finish(ctx, "error", map[string]any{"last_error": "late"}); !errors.Is(err, errWorkspaceLeaseLost) {
		t.Fatalf("late finish=%v", err)
	}
	old.release()
	got, _ = store.GetSpace(ctx, "tenant", space.ID)
	if got.WorkspaceStatus != "stopping" {
		t.Fatalf("late release unlocked successor: %s", got.WorkspaceStatus)
	}
	if err = old.fenced(ctx, func(tx *gorm.DB) error {
		return tx.Table("managed_containers").Where("space_id=?", space.ID).Update("docker_id", "replacement-overwritten").Error
	}); !errors.Is(err, errWorkspaceLeaseLost) {
		t.Fatalf("late metadata=%v", err)
	}
	next.release()
	var dockerID string
	if err = d.DB.QueryRow(`SELECT docker_id FROM managed_containers WHERE space_id=? AND purpose='workspace'`, space.ID).Scan(&dockerID); err != nil || dockerID != "orphan" {
		t.Fatalf("orphan repair=%s %v", dockerID, err)
	}
}
func TestWorkspaceUnknownAbsenceBlocksBlindCreateUntilAcknowledged(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Unknown", RuntimeNodeID: &node, WorkspaceKind: "container"})
	if err != nil {
		t.Fatal(err)
	}
	h := builtinToolHarness(t, d, "rnr_workspace_absent", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
		case "docker.list":
			return []computerContainer{}, nil
		default:
			return nil, fmt.Errorf("must not create after uncertainty: %s", method)
		}
	})
	ctx := context.Background()
	l, err := h.acquireSpaceWorkspace(ctx, "tenant", space.ID, "starting", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = l.uncertain(errors.New("lost create reply"))
	l.release()
	if err = d.Gorm.Exec(`UPDATE computer_workspace_leases SET expires_at=0 WHERE space_id=?`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.recoverSpaceWorkspaces(ctx, 10); err == nil || !strings.Contains(err.Error(), "no replacement will be created") {
		t.Fatalf("unknown recovery=%v", err)
	}
	if err = h.startSpaceWorkspace(ctx, space); !errors.Is(err, errWorkspaceStarting) {
		t.Fatalf("blind restart allowed: %v", err)
	}
	var token string
	if err = d.DB.QueryRow(`SELECT token FROM computer_workspace_leases WHERE space_id=?`, space.ID).Scan(&token); err != nil {
		t.Fatal(err)
	}
	if err = h.acknowledgeAbsentSpaceWorkspace(ctx, "tenant", space.ID, l.Token); !errors.Is(err, errWorkspaceLeaseLost) {
		t.Fatalf("old acknowledgement=%v", err)
	}
	if err = h.acknowledgeAbsentSpaceWorkspace(ctx, "tenant", space.ID, token); err != nil {
		t.Fatal(err)
	}
	got, _ := store.GetSpace(ctx, "tenant", space.ID)
	if got.WorkspaceStatus != "stopped" {
		t.Fatalf("acknowledgement=%s", got.WorkspaceStatus)
	}
}
func TestWorkspaceStopObservesOrphanAndFailurePreservesMetadata(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Stop orphan", RuntimeNodeID: &node, WorkspaceKind: "container"})
	if err != nil {
		t.Fatal(err)
	}
	stops := 0
	h := builtinToolHarness(t, d, "rnr_workspace_stop_failure", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
		case "docker.list":
			return []computerContainer{{DockerID: "orphan", Status: "running", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.stop":
			stops++
			if params["id"] != "orphan" || params["remove"] != false {
				t.Error("stop attempted removal")
			}
			return nil, errors.New("stop failed")
		default:
			return nil, fmt.Errorf("unexpected destructive call %s", method)
		}
	})
	if err = h.stopSpaceWorkspace(context.Background(), space); err == nil || !strings.Contains(err.Error(), "stop failed") {
		t.Fatalf("stop=%v", err)
	}
	var id, status string
	if err = d.DB.QueryRow(`SELECT docker_id,status FROM managed_containers WHERE space_id=? AND purpose='workspace'`, space.ID).Scan(&id, &status); err != nil || id != "orphan" || status != "running" {
		t.Fatalf("false stop metadata=%s %s %v", id, status, err)
	}
	if stops != 1 {
		t.Fatalf("stops=%d", stops)
	}
}
func TestWorkspaceObserverRejectsDuplicatesForeignAndIncompleteList(t *testing.T) {
	for _, scenario := range []string{"duplicate", "foreign", "incomplete"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			store := NewStore(d)
			node := "node"
			space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: scenario, RuntimeNodeID: &node, WorkspaceKind: "container"})
			if err != nil {
				t.Fatal(err)
			}
			h := builtinToolHarness(t, d, "rnr_workspace_"+scenario, func(method string, params map[string]any) (any, error) {
				if method == "sys.info" {
					return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
				}
				if method != "docker.list" {
					return nil, fmt.Errorf("must not mutate: %s", method)
				}
				if scenario == "incomplete" {
					return nil, errors.New("docker list incomplete: inspect failed")
				}
				c := computerContainer{DockerID: "one", Status: "running", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}
				if scenario == "foreign" {
					c.Labels["zakura.tenant"] = "other"
					return []computerContainer{c}, nil
				}
				other := c
				other.DockerID = "two"
				return []computerContainer{c, other}, nil
			})
			if err = h.startSpaceWorkspace(context.Background(), space); err == nil {
				t.Fatal("unsafe observation accepted")
			}
			var count int
			if err = d.DB.QueryRow(`SELECT COUNT(*) FROM managed_containers WHERE space_id=?`, space.ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("unsafe metadata=%d %v", count, err)
			}
		})
	}
}
