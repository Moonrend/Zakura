package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

func TestTemporaryCleanupSnapshotSurvivesOwnerDeletion(t *testing.T) {
	for _, mode := range []string{"running", "stopped", "absent", "foreign", "duplicate", "incomplete", "stop-failure", "removal-unconfirmed"} {
		t.Run(mode, func(t *testing.T) {
			initial, r := e2bTestSetup(t)
			d := initial.deps
			ctx := context.Background()
			r.State = computers.Stopping
			r.ExternalID = "original-container"
			r.RootPath = "/srv/zakura/computers/" + r.ID + "/workspace"
			name, labels := computerContainerIdentity(r)
			instance := computerContainer{DockerID: r.ExternalID, Name: name, Image: serverComputerImage, Status: "running", Labels: labels}
			if mode == "stopped" {
				instance.Status = "exited"
			}
			if mode == "foreign" {
				instance.Labels["zakura.tenant"] = "foreign"
			}
			var mu sync.Mutex
			removed := mode == "absent"
			stops, files := 0, 0
			h := builtinToolHarness(t, d, "rnr_temp_cleanup_"+mode, func(method string, params map[string]any) (any, error) {
				mu.Lock()
				defer mu.Unlock()
				switch method {
				case "sys.info":
					return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
				case "docker.list":
					if params["label"] != nil {
						return nil, errors.New("cleanup did not request full list")
					}
					if mode == "incomplete" {
						return nil, errors.New("inspect failed")
					}
					if removed {
						return []computerContainer{}, nil
					}
					if mode == "duplicate" {
						return []computerContainer{instance, instance}, nil
					}
					return []computerContainer{instance}, nil
				case "docker.stop":
					stops++
					if params["id"] != r.ExternalID || params["remove"] != true {
						return nil, errors.New("cleanup redirected container")
					}
					if mode == "stop-failure" {
						return nil, errors.New("stop failed")
					}
					if mode != "removal-unconfirmed" {
						removed = true
					}
					return map[string]any{"ok": true}, nil
				case "host.fs.remove":
					files++
					if params["root"] != "/srv/zakura" || params["path"] != "computers/"+r.ID+"/workspace" || params["recursive"] != true {
						return nil, errors.New("cleanup removed foreign workspace")
					}
					return map[string]any{"ok": true}, nil
				default:
					return nil, fmt.Errorf("unexpected cleanup effect %s", method)
				}
			})
			if err := d.Gorm.Exec(`UPDATE computers SET provider='temporary',runtime_node_id='node' WHERE id=?`, r.ComputerID).Error; err != nil {
				t.Fatal(err)
			}
			if err := d.Gorm.Exec(`UPDATE computer_runtimes SET state='stopping',external_id=?,root_path=? WHERE id=?`, r.ExternalID, r.RootPath, r.ID).Error; err != nil {
				t.Fatal(err)
			}
			adapter := temporaryComputerProvider{h: h}
			snapshot, err := adapter.CaptureCleanup(ctx, r)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(snapshot), "/srv/zakura") {
				t.Fatal("trusted routing snapshot was not sealed")
			}
			if err = d.Gorm.Exec(`DELETE FROM computers WHERE id=?`, r.ComputerID).Error; err != nil {
				t.Fatal(err)
			}
			// No owner or runtime row remains. Cleanup must not consult a replacement.
			err = adapter.DestroyCleanup(ctx, r, snapshot)
			success := mode == "running" || mode == "stopped" || mode == "absent"
			mu.Lock()
			defer mu.Unlock()
			if success {
				if err != nil || files != 1 {
					t.Fatalf("cleanup=%v files=%d", err, files)
				}
				want := 1
				if mode == "absent" {
					want = 0
				}
				if stops != want {
					t.Fatalf("stops=%d", stops)
				}
			} else {
				if err == nil || files != 0 {
					t.Fatalf("unsafe cleanup=%v files=%d", err, files)
				}
				if mode != "stop-failure" && mode != "removal-unconfirmed" && stops != 0 {
					t.Fatalf("mutated foreign/uncertain container: %d", stops)
				}
			}
		})
	}
}

func TestTemporaryCleanupRejectsRetargetedOrForgedSnapshot(t *testing.T) {
	h, r := e2bTestSetup(t)
	ctx := context.Background()
	if err := h.deps.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,storage_root,created_at,updated_at) VALUES('snapshot-node','tenant','Node','node','server','offline','hash','/srv/zakura','now','now')`).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.deps.Gorm.Exec(`UPDATE computers SET provider='temporary',runtime_node_id='snapshot-node' WHERE id=?`, r.ComputerID).Error; err != nil {
		t.Fatal(err)
	}
	r.ExternalID = "original"
	r.RootPath = "/srv/zakura/computers/" + r.ID + "/workspace"
	if err := h.deps.Gorm.Exec(`UPDATE computer_runtimes SET external_id=?,root_path=? WHERE id=?`, r.ExternalID, r.RootPath, r.ID).Error; err != nil {
		t.Fatal(err)
	}
	p := temporaryComputerProvider{h: h}
	data, err := p.CaptureCleanup(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	replacement := r
	replacement.ExternalID = "replacement"
	if err = p.DestroyCleanup(ctx, replacement, data); !errors.Is(err, computers.ErrTransitionConflict) {
		t.Fatalf("retargeted=%v", err)
	}
	if err = p.DestroyCleanup(ctx, r, json.RawMessage(`{"nodeId":"forged","storageRoot":"/"}`)); err == nil {
		t.Fatal("unsealed snapshot accepted")
	}
	r.RootPath = "/srv/zakura/spaces/space/workspace"
	if _, err = p.CaptureCleanup(ctx, r); err == nil {
		t.Fatal("foreign root accepted")
	}
}
