package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func workspaceReceiptFixture(params map[string]any, id string) computerContainer {
	labels := map[string]string{}
	for key, value := range params["labels"].(map[string]any) {
		labels[key] = fmt.Sprint(value)
	}
	op := params["operation"].(map[string]any)
	labels["zakura.create-operation"] = fmt.Sprint(op["id"])
	labels["zakura.create-digest"] = strings.Repeat("a", 64)
	return computerContainer{DockerID: id, Name: fmt.Sprint(params["name"]), Image: fmt.Sprint(params["image"]), Status: "running", Labels: labels}
}

func workspaceReceiptStatusFixture(c computerContainer) map[string]any {
	return map[string]any{"state": "committed", "name": c.Name, "configDigest": c.Labels["zakura.create-digest"], "container": c}
}

func TestWorkspaceCreateLostReplyUsesOriginalReceipt(t *testing.T) {
	for _, scenario := range []string{"committed", "missing-receipt", "missing-container", "wrong-operation"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			ctx := context.Background()
			node := "node"
			space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "Create", RuntimeNodeID: &node, WorkspaceKind: "container"})
			if err != nil {
				t.Fatal(err)
			}
			var mu sync.Mutex
			var instance computerContainer
			creates, statuses := 0, 0
			h := builtinToolHarness(t, d, "rnr_create_receipt", func(method string, p map[string]any) (any, error) {
				mu.Lock()
				defer mu.Unlock()
				switch method {
				case "sys.info":
					info := codemodeInfo()
					info["capabilities"].(map[string]any)["dockerCreateReceipts"] = true
					return info, nil
				case "host.fs.mkdir":
					return map[string]any{"abs": "/fixture/workspace"}, nil
				case "docker.list":
					if instance.DockerID == "" || scenario == "missing-container" {
						return []any{}, nil
					}
					return []computerContainer{instance}, nil
				case "docker.images":
					return []computerImageStatus{}, nil
				case "docker.pull":
					return map[string]any{}, nil
				case "docker.create":
					creates++
					var persisted int64
					if err := d.Gorm.Table("workspace_create_operations").Where("space_id=? AND operation_id=?", space.ID, p["operation"].(map[string]any)["id"]).Count(&persisted).Error; err != nil || persisted != 1 {
						return nil, errors.New("Docker effect preceded durable intent")
					}
					instance = workspaceReceiptFixture(p, "original-workspace")
					return nil, errors.New("fixture lost create response")
				case "docker.create.status":
					statuses++
					if p["operationId"] != instance.Labels["zakura.create-operation"] {
						return nil, errors.New("operation identity changed")
					}
					if scenario == "missing-receipt" {
						return map[string]any{"state": "unknown"}, nil
					}
					c := instance
					if scenario == "wrong-operation" {
						c.Labels = map[string]string{}
					}
					return workspaceReceiptStatusFixture(c), nil
				default:
					return nil, fmt.Errorf("unexpected RPC %s", method)
				}
			})
			if err = h.startSpaceWorkspace(ctx, space); err == nil {
				t.Fatal("lost reply reported success")
			}
			for i := 0; i < 2; i++ {
				if err := d.Gorm.Table("computer_workspace_leases").Where("space_id=?", space.ID).Update("expires_at", 0).Error; err != nil {
					t.Fatal(err)
				}
				err = h.recoverSpaceWorkspaces(ctx, 10)
				if (err == nil) != (scenario == "committed") {
					t.Fatalf("recovery %s: %v", scenario, err)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if creates != 1 || statuses < 1 {
				t.Fatalf("create/status=%d/%d", creates, statuses)
			}
			current, err := h.store.GetSpace(ctx, "tenant", space.ID)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "committed" && current.WorkspaceStatus != "running" {
				t.Fatalf("status=%s", current.WorkspaceStatus)
			}
			var op workspaceCreateOperation
			if err := d.Gorm.Table("workspace_create_operations").Where("space_id=?", space.ID).Take(&op).Error; err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.Marshal(op)
			if strings.Contains(string(encoded), "ZAKURA_ENABLE") {
				t.Fatal("operation retained environment")
			}
		})
	}
}
