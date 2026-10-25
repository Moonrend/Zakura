package runtime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func TestWorkspaceStartupUsesCachedImage(t *testing.T) {
	for _, scenario := range []string{"present", "missing", "probe-error", "pull-error", "cancel-pull"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			node, image := "node", "custom/workspace:cached"
			space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: scenario, RuntimeNodeID: &node, WorkspaceImage: &image, WorkspaceKind: "container", WorkspaceStatus: "stopped"})
			if err != nil {
				t.Fatal(err)
			}
			var mu sync.Mutex
			var instance computerContainer
			probes, pulls, creates := 0, 0, 0
			h := builtinToolHarness(t, d, "rnr_cached_"+scenario, func(method string, p map[string]any) (any, error) {
				mu.Lock()
				defer mu.Unlock()
				switch method {
				case "sys.info":
					return map[string]any{"kind": "server", "storageRoot": "/fixture", "capabilities": map[string]any{"docker": true, "dockerCreateReceipts": true}}, nil
				case "host.fs.mkdir":
					return map[string]any{"abs": "/fixture/workspace"}, nil
				case "docker.list":
					if instance.DockerID == "" {
						return []computerContainer{}, nil
					}
					return []computerContainer{instance}, nil
				case "docker.images":
					probes++
					if fmt.Sprint(p["images"]) != "["+image+"]" {
						return nil, errors.New("probed the wrong workspace image")
					}
					if scenario == "probe-error" {
						return nil, errors.New("fixture Docker permission denied")
					}
					if scenario == "present" {
						return []computerImageStatus{{Image: image, ID: "sha256:cached"}}, nil
					}
					return []computerImageStatus{{Image: image, Error: "No such image"}}, nil
				case "docker.pull":
					pulls++
					if scenario == "present" || scenario == "pull-error" {
						return nil, errors.New("fixture registry unavailable")
					}
					if scenario == "cancel-pull" {
						cancel()
					}
					return map[string]any{}, nil
				case "docker.create":
					creates++
					instance = workspaceReceiptFixture(p, "workspace")
					return instance, nil
				case "docker.create.status":
					return workspaceReceiptStatusFixture(instance), nil
				default:
					return nil, fmt.Errorf("unexpected RPC %s", method)
				}
			})
			err = h.startSpaceWorkspace(ctx, space)
			mu.Lock()
			defer mu.Unlock()
			wantSuccess := scenario == "present" || scenario == "missing"
			if (err == nil) != wantSuccess {
				t.Fatalf("start: %v", err)
			}
			wantPulls := 1
			if scenario == "present" || scenario == "probe-error" {
				wantPulls = 0
			}
			wantCreates := 0
			if wantSuccess {
				wantCreates = 1
			}
			if probes != 1 || pulls != wantPulls || creates != wantCreates {
				t.Fatalf("probes/pulls/creates = %d/%d/%d", probes, pulls, creates)
			}
			var leases, operations int64
			if err := d.Gorm.Table("computer_workspace_leases").Where("space_id=?", space.ID).Count(&leases).Error; err != nil || leases != 0 {
				t.Fatalf("lease retained: %d %v", leases, err)
			}
			if err := d.Gorm.Table("workspace_create_operations").Where("space_id=?", space.ID).Count(&operations).Error; err != nil || operations != int64(wantCreates) {
				t.Fatalf("creation intent: %d %v", operations, err)
			}
			current, readErr := h.store.GetSpace(context.Background(), "tenant", space.ID)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if wantSuccess {
				if current.WorkspaceStatus != "running" || current.LastError != nil {
					t.Fatalf("successful startup: %+v", current)
				}
			} else if current.WorkspaceStatus != "stopped" || current.LastError == nil || !strings.Contains(*current.LastError, err.Error()) {
				t.Fatalf("failed startup lost diagnostic: %+v, %v", current, err)
			}
		})
	}
}

func TestLocalNodeProjectionChecksActualDockerCapabilities(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	t.Setenv("ZAKURA_DOCKER", t.TempDir()+"/missing-docker")
	if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,agent_version,capabilities_json,created_at,updated_at) VALUES('local','tenant','Local','local','local','online',?,'embedded','{"docker":true}','before','before')`, t.TempDir()).Error; err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: NewStore(d), hub: newRunnerHub(d)}
	session, err := h.hub.get("local")
	if err != nil {
		t.Fatal(err)
	}
	defer session.close(context.Canceled)
	node := map[string]any{"id": "local", "status": "online", "capabilities": map[string]any{"docker": true}}
	h.projectRuntimeNode(node)
	capabilities, ok := node["capabilities"].(map[string]any)
	if !ok || capabilities["docker"] != false || capabilities["host"] != true || capabilities["dockerCreateReceipts"] != true {
		t.Fatalf("stale capabilities: %#v", node)
	}
	if node["status"] != "online" || node["executable"] != true || node["dockerError"] == nil {
		t.Fatalf("host availability or Docker diagnostic lost: %#v", node)
	}
}
