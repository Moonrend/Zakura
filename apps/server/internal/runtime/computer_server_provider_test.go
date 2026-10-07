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

func TestServerComputerProvisioning(t *testing.T) {
	for _, mode := range []string{"success", "response-lost", "wrong-owner", "duplicate", "stopped", "unsupported"} {
		t.Run(mode, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			ctx := context.Background()
			space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "computers"})
			if err != nil {
				t.Fatal(err)
			}
			var mu sync.Mutex
			creates, finds := 0, 0
			var instance computerContainer
			h := builtinToolHarness(t, d, "rnr_computer_"+mode, func(method string, params map[string]any) (any, error) {
				switch method {
				case "sys.info":
					return map[string]any{"version": "test", "kind": "server", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"docker": true}}, nil
				case "docker.create":
					mu.Lock()
					defer mu.Unlock()
					creates++
					if mode == "unsupported" {
						return nil, errors.New("unknown method")
					}
					raw, _ := json.Marshal(params["labels"])
					var labels map[string]string
					_ = json.Unmarshal(raw, &labels)
					name := fmt.Sprint(params["name"])
					volume := params["volumes"].([]any)[0].(map[string]any)
					if volume["volumeName"] != name+"-data" || volume["containerPath"] != "/workspace" || volume["hostPath"] != nil || params["privileged"] != nil || params["ports"] != nil {
						return nil, errors.New("unsafe creation spec")
					}
					instance = computerContainer{DockerID: "container", Name: "/" + name, Image: serverComputerImage, Status: "running", Labels: labels}
					if mode == "wrong-owner" {
						instance.Labels["zakura.tenant"] = "foreign"
					}
					if mode == "stopped" {
						instance.Status = "exited"
					}
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
			store := h.computerStore()
			c := computers.Computer{ID: "computer", TenantID: "tenant", SpaceID: space.ID, Name: "Server", Provider: computers.Server, RuntimeNodeID: "node", IdleSeconds: 900, MaxLifetimeSeconds: 3600}
			sealed, err := computers.SealCredentials(d.Secret, c.TenantID, c.SpaceID, c.ID, []byte(`{}`))
			if err != nil {
				t.Fatal(err)
			}
			if err = store.Create(ctx, c, sealed); err != nil {
				t.Fatal(err)
			}
			r, err := store.ReserveRuntime(ctx, "tenant", space.ID, c.ID, "", time.Now())
			if err != nil {
				t.Fatal(err)
			}
			target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
			adapter := serverComputerProvider{h: h}
			if _, err = adapter.Create(ctx, r); err == nil {
				t.Fatal("creation without approval")
			}
			if _, err = adapter.Find(ctx, r); err == nil {
				t.Fatal("reconciliation without approval")
			}
			p := computers.Provisioner{Store: store, Providers: map[computers.Provider]computers.CreationProvider{computers.Server: adapter}}
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
				if mode != "unsupported" {
					result, err = p.ReconcileCreation(ctx, target)
					if mode == "response-lost" {
						if err != nil || result.ExternalID != "container" || result.State != computers.Ready {
							t.Fatalf("reconcile: %+v %v", result, err)
						}
					} else if err == nil {
						t.Fatal("accepted unverified instance")
					}
				}
			}
			foreign := r
			foreign.TenantID = "other"
			if _, err = adapter.Find(ctx, foreign); err == nil {
				t.Fatal("cross tenant lookup")
			}
			mu.Lock()
			defer mu.Unlock()
			if creates != 1 {
				t.Fatalf("creates=%d", creates)
			}
			if mode == "success" || mode == "unsupported" {
				if finds != 0 {
					t.Fatalf("unexpected lookup: %d", finds)
				}
			} else if finds != 1 {
				t.Fatalf("finds=%d", finds)
			}
		})
	}
}

func TestComputerContainerIdentitySeparatesIncarnations(t *testing.T) {
	base := computers.Runtime{TenantID: "t", SpaceID: "s", ComputerID: "c", ID: "r", Incarnation: "i", CreateOperationID: "op"}
	name, _ := computerContainerIdentity(base)
	for _, change := range []func(*computers.Runtime){
		func(r *computers.Runtime) { r.TenantID += "2" }, func(r *computers.Runtime) { r.SpaceID += "2" },
		func(r *computers.Runtime) { r.ComputerID += "2" }, func(r *computers.Runtime) { r.ID += "2" },
		func(r *computers.Runtime) { r.Incarnation += "2" }, func(r *computers.Runtime) { r.CreateOperationID += "2" },
	} {
		other := base
		change(&other)
		if n, _ := computerContainerIdentity(other); n == name {
			t.Fatal("identity collision")
		}
	}
}
