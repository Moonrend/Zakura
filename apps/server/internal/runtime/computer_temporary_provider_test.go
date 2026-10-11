package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

func TestTemporaryComputerProvisioning(t *testing.T) {
	for _, mode := range []string{"success", "response-lost", "duplicate"} {
		t.Run(mode, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			ctx := context.Background()
			store := NewStore(d)
			space, err := store.CreateSpace(ctx, "tenant", Space{Name: "temporary"})
			if err != nil {
				t.Fatal(err)
			}
			agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
			if err != nil {
				t.Fatal(err)
			}
			chat, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
			if err != nil {
				t.Fatal(err)
			}
			var mu sync.Mutex
			creates, finds := 0, 0
			mkdirAbs := ""
			var instance computerContainer
			h := builtinToolHarness(t, d, "rnr_temp_"+mode, func(method string, params map[string]any) (any, error) {
				switch method {
				case "sys.info":
					return map[string]any{"version": "test", "kind": "server", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"docker": true}}, nil
				case "host.fs.mkdir":
					mu.Lock()
					defer mu.Unlock()
					root := fmt.Sprint(params["root"])
					rel := fmt.Sprint(params["path"])
					if root != "/srv/zakura" || !strings.HasPrefix(rel, "computers/") || !strings.HasSuffix(rel, "/workspace") {
						return nil, errors.New("unscoped computer root")
					}
					mkdirAbs = fmt.Sprintf("/srv/zakura/%s", rel)
					return map[string]any{"abs": mkdirAbs}, nil
				case "docker.create":
					mu.Lock()
					defer mu.Unlock()
					creates++
					if params["restart"] != "no" {
						return nil, errors.New("temporary container must not restart")
					}
					if params["privileged"] != nil || params["ports"] != nil {
						return nil, errors.New("unsafe creation spec")
					}
					volume, ok := params["volumes"].([]any)
					if !ok || len(volume) != 1 {
						return nil, errors.New("missing bind mount")
					}
					mount := volume[0].(map[string]any)
					if mount["hostPath"] != mkdirAbs || mount["containerPath"] != "/workspace" {
						return nil, errors.New("unsafe bind mount")
					}
					raw, _ := json.Marshal(params["labels"])
					var labels map[string]string
					_ = json.Unmarshal(raw, &labels)
					name := fmt.Sprint(params["name"])
					instance = computerContainer{DockerID: "container", Name: "/" + name, Image: serverComputerImage, Status: "running", Labels: labels}
					if mode == "response-lost" || mode == "duplicate" {
						return nil, errors.New("response lost")
					}
					return instance, nil
				case "docker.list":
					mu.Lock()
					defer mu.Unlock()
					finds++
					if params["label"] != "zakura.operation="+instance.Labels["zakura.operation"] {
						return nil, errors.New("unscoped lookup")
					}
					if mode == "duplicate" {
						return []computerContainer{instance, instance}, nil
					}
					return []computerContainer{instance}, nil
				default:
					return nil, fmt.Errorf("unexpected RPC %s", method)
				}
			})
			if err = d.Gorm.Exec(`UPDATE runtime_nodes SET kind='server' WHERE id='node'`).Error; err != nil {
				t.Fatal(err)
			}
			cs := h.computerStore()
			c := computers.Computer{ID: "temp", TenantID: "tenant", SpaceID: space.ID, Name: "Temporary", Provider: computers.Temporary, RuntimeNodeID: "node", IdleSeconds: 900, MaxLifetimeSeconds: 3600}
			sealed, err := computers.SealCredentials(d.Secret, c.TenantID, c.SpaceID, c.ID, []byte(`{}`))
			if err != nil {
				t.Fatal(err)
			}
			if err = cs.Create(ctx, c, sealed); err != nil {
				t.Fatal(err)
			}
			r, err := cs.ReserveRuntime(ctx, "tenant", space.ID, c.ID, chat.ID, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if r.SessionScope != chat.ID {
				t.Fatalf("temporary runtime lost its session scope: %q", r.SessionScope)
			}
			target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
			adapter := temporaryComputerProvider{h: h}
			if _, err = adapter.Create(ctx, r); err == nil {
				t.Fatal("creation without approval")
			}
			if _, err = adapter.Find(ctx, r); err == nil {
				t.Fatal("reconciliation without approval")
			}
			p := computers.Provisioner{Store: cs, Providers: map[computers.Provider]computers.CreationProvider{computers.Temporary: adapter}}
			result, err := p.ApproveAndCreate(ctx, target, r.CreateOperationID, "admin")
			if mode == "success" {
				if err != nil || result.State != computers.Ready || result.ExternalID != "container" {
					t.Fatalf("create: %+v %v", result, err)
				}
			} else {
				if !errors.Is(err, computers.ErrCreationUncertain) {
					t.Fatalf("expected uncertain: %v", err)
				}
				if _, err = p.ApproveAndCreate(ctx, target, r.CreateOperationID, "admin"); err == nil {
					t.Fatal("retried creation")
				}
				result, err = p.ReconcileCreation(ctx, target)
				if mode == "response-lost" {
					if err != nil || result.ExternalID != "container" || result.State != computers.Ready {
						t.Fatalf("reconcile: %+v %v", result, err)
					}
				} else if err == nil {
					t.Fatal("accepted an ambiguous instance")
				}
			}
			foreign := r
			foreign.TenantID = "other"
			if _, err = adapter.Find(ctx, foreign); err == nil {
				t.Fatal("cross tenant lookup")
			}
			otherScope := r
			otherScope.SessionScope = "another-chat"
			if _, err = adapter.Find(ctx, otherScope); err == nil {
				t.Fatal("cross session lookup")
			}
			mu.Lock()
			defer mu.Unlock()
			if creates != 1 {
				t.Fatalf("creates=%d", creates)
			}
			if mode == "success" {
				if finds != 0 {
					t.Fatalf("unexpected lookup: %d", finds)
				}
			} else if finds != 1 {
				t.Fatalf("finds=%d", finds)
			}
		})
	}
}

func TestTemporaryComputerDestroy(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "temporary"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	chat, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	mkdirAbs := ""
	stops, removes := 0, 0
	stopID, removeRoot, removePath := "", "", ""
	removeRecursive := false
	var instance computerContainer
	h := builtinToolHarness(t, d, "rnr_temp_destroy", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "server", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"docker": true}}, nil
		case "host.fs.mkdir":
			mu.Lock()
			defer mu.Unlock()
			mkdirAbs = fmt.Sprintf("/srv/zakura/%s", fmt.Sprint(params["path"]))
			return map[string]any{"abs": mkdirAbs}, nil
		case "docker.create":
			mu.Lock()
			defer mu.Unlock()
			if params["restart"] != "no" {
				return nil, errors.New("temporary container must not restart")
			}
			raw, _ := json.Marshal(params["labels"])
			var labels map[string]string
			_ = json.Unmarshal(raw, &labels)
			instance = computerContainer{DockerID: "container", Name: "/" + fmt.Sprint(params["name"]), Image: serverComputerImage, Status: "running", Labels: labels}
			return instance, nil
		case "docker.stop":
			mu.Lock()
			defer mu.Unlock()
			stops++
			stopID = fmt.Sprint(params["id"])
			if params["remove"] != true {
				return nil, errors.New("stop must remove the container")
			}
			return map[string]any{"ok": true}, nil
		case "host.fs.remove":
			mu.Lock()
			defer mu.Unlock()
			removes++
			removeRoot = fmt.Sprint(params["root"])
			removePath = fmt.Sprint(params["path"])
			removeRecursive, _ = params["recursive"].(bool)
			return map[string]any{"ok": true}, nil
		default:
			return nil, fmt.Errorf("unexpected RPC %s", method)
		}
	})
	if err = d.Gorm.Exec(`UPDATE runtime_nodes SET kind='server' WHERE id='node'`).Error; err != nil {
		t.Fatal(err)
	}
	cs := h.computerStore()
	c := computers.Computer{ID: "temp", TenantID: "tenant", SpaceID: space.ID, Name: "Temporary", Provider: computers.Temporary, RuntimeNodeID: "node", IdleSeconds: 900, MaxLifetimeSeconds: 3600}
	sealed, err := computers.SealCredentials(d.Secret, c.TenantID, c.SpaceID, c.ID, []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if err = cs.Create(ctx, c, sealed); err != nil {
		t.Fatal(err)
	}
	r, err := cs.ReserveRuntime(ctx, "tenant", space.ID, c.ID, chat.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	adapter := temporaryComputerProvider{h: h}
	p := computers.Provisioner{Store: cs, Providers: map[computers.Provider]computers.CreationProvider{computers.Temporary: adapter}}
	result, err := p.ApproveAndCreate(ctx, target, r.CreateOperationID, "admin")
	if err != nil || result.State != computers.Ready || result.ExternalID != "container" {
		t.Fatalf("create: %+v %v", result, err)
	}
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	// The cleanup coordinator parks an overdue runtime in stopping before destroying.
	if err = cs.Transition(ctx, target, computers.Ready, computers.Stopping, stamp); err != nil {
		t.Fatal(err)
	}
	if err = adapter.Destroy(ctx, result); err != nil {
		t.Fatalf("destroy: %v", err)
	}
	mu.Lock()
	if stops != 1 || stopID != "container" {
		mu.Unlock()
		t.Fatalf("stops=%d id=%s", stops, stopID)
	}
	if removes != 1 || removeRoot != "/srv/zakura" || removePath != "computers/"+result.ID+"/workspace" || !removeRecursive {
		mu.Unlock()
		t.Fatalf("remove root=%q path=%q recursive=%v", removeRoot, removePath, removeRecursive)
	}
	mu.Unlock()
	if err = cs.Transition(ctx, target, computers.Stopping, computers.Destroyed, stamp); err != nil {
		t.Fatal(err)
	}
	if err = adapter.Destroy(ctx, result); err == nil {
		t.Fatal("destroy accepted a terminal runtime")
	}
}
