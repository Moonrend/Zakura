package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
	"github.com/go-chi/chi/v5"
)

func TestWorkspaceInstanceHTTPConfigureStartRetireRebuild(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "Instances"})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	containers := map[string]computerContainer{}
	creates := 0
	loseAttach := true
	h := builtinToolHarness(t, d, "rnr_instance_lifecycle", func(method string, p map[string]any) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		binding := func() (protocol.Binding, error) {
			var b protocol.Binding
			raw, _ := json.Marshal(p["workspace"])
			if err := json.Unmarshal(raw, &b); err != nil {
				return b, err
			}
			return b, b.Validate()
		}
		switch method {
		case "sys.info":
			return map[string]any{"kind": "server", "storageRoot": "/workspace-data", "capabilities": map[string]any{"workspaceProtocolV2": true, "dockerCreateReceipts": true}}, nil
		case "workspace.identity":
			return map[string]any{"version": 1, "incarnation": "incarnation"}, nil
		case "workspace.disk.allocate":
			return map[string]any{"disk": p, "usedBytes": 0}, nil
		case "workspace.attach":
			if loseAttach {
				loseAttach = false
				return nil, errors.New("lost attach reply")
			}
			return map[string]any{"target": p["target"], "ok": true}, nil
		case "workspace.mount":
			disk := p["disk"].(map[string]any)
			return map[string]any{"target": p["target"], "mount": map[string]any{"volumeName": "test-workspace-data", "volumeSubpath": "disks/" + fmt.Sprint(disk["diskId"]) + "/workspace", "containerPath": "/workspace", "noCopy": true}}, nil
		case "docker.list":
			id := strings.TrimPrefix(fmt.Sprint(p["label"]), "zakura.workspace-instance=")
			if id == fmt.Sprint(p["label"]) {
				return nil, errors.New("unscoped container observation")
			}
			if c, ok := containers[id]; ok {
				return []computerContainer{c}, nil
			}
			return []computerContainer{}, nil
		case "docker.images":
			return []computerImageStatus{}, nil
		case "docker.pull":
			return map[string]any{}, nil
		case "docker.create":
			b, err := binding()
			if err != nil {
				return nil, err
			}
			v := p["volumes"].([]any)[0].(map[string]any)
			if v["volumeName"] != "test-workspace-data" || v["volumeSubpath"] != b.Disk.Locator.RelativePath || v["noCopy"] != true || v["hostPath"] != nil {
				return nil, errors.New("incorrect volume descriptor")
			}
			op := p["operation"].(map[string]any)
			if op["instanceId"] != b.Target.InstanceID || op["diskId"] != b.Target.DiskID || op["generation"] != float64(b.Target.Generation) {
				return nil, errors.New("unbound create operation")
			}
			creates++
			c := workspaceReceiptFixture(p, fmt.Sprintf("docker-%d", creates))
			containers[b.Target.InstanceID] = c
			return c, nil
		case "docker.create.status":
			c, ok := containers[fmt.Sprint(p["instanceId"])]
			if !ok || p["operationId"] != c.Labels["zakura.create-operation"] {
				return nil, errors.New("receipt identity changed")
			}
			return workspaceReceiptStatusFixture(c), nil
		case "docker.stop", "docker.start":
			b, err := binding()
			if err != nil {
				return nil, err
			}
			c := containers[b.Target.InstanceID]
			if p["id"] != c.DockerID || p["remove"] == true {
				return nil, errors.New("wrong lifecycle target")
			}
			c.Status = "running"
			if method == "docker.stop" {
				c.Status = "exited"
			}
			containers[b.Target.InstanceID] = c
			return c, nil
		default:
			return nil, fmt.Errorf("unexpected RPC %s", method)
		}
	})
	if _, err := d.DB.Exec(`UPDATE runtime_nodes SET incarnation='incarnation' WHERE id='node'`); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	h.registerComputers(router)
	h.registerWorkspaceDisks(router)
	base := "/spaces/" + space.ID
	call := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		target := base + path
		if strings.HasPrefix(path, "/disks") {
			target = path
		}
		r := httptest.NewRequest(method, target, strings.NewReader(body))
		r = r.WithContext(httpx.WithPrincipal(r.Context(), httpx.Principal{TenantID: "tenant", Role: "owner"}))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	allocate := func() string {
		t.Helper()
		w := call(http.MethodPost, "/disks", `{"name":"Data","nodeId":"node"}`)
		if w.Code != 201 {
			t.Fatalf("allocate: %d %s", w.Code, w.Body)
		}
		var response struct {
			Disk workspaces.Disk `json:"disk"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response.Disk.ID
	}
	firstDisk := allocate()
	configuration := fmt.Sprintf(`{"diskId":%q,"workspaceImage":"test:image","enableComputer":false}`, firstDisk)
	if w := call(http.MethodPut, "/computer/config", configuration); w.Code != 502 {
		t.Fatalf("lost attach: %d %s", w.Code, w.Body)
	}
	first, err := h.workspaceStore().Current(ctx, "tenant", space.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`UPDATE computer_workspace_leases SET expires_at=0 WHERE space_id=?`, space.ID); err != nil {
		t.Fatal(err)
	}
	if err := h.recoverSpaceWorkspaces(ctx, 10); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"start", "stop", "start"} {
		if w := call(http.MethodPost, "/computer/"+action, `{}`); w.Code != 200 {
			t.Fatalf("%s: %d %s", action, w.Code, w.Body)
		}
	}
	if w := call(http.MethodDelete, "/computer", fmt.Sprintf(`{"expectedInstanceId":%q,"requestId":"delete-first"}`, first.InstanceID)); w.Code != 202 {
		t.Fatalf("retire: %d %s", w.Code, w.Body)
	}
	if w := call(http.MethodPut, "/computer/config", configuration); w.Code != 409 {
		t.Fatalf("reused unreleased disk: %d %s", w.Code, w.Body)
	}
	secondDisk := allocate()
	if w := call(http.MethodPut, "/computer/config", fmt.Sprintf(`{"diskId":%q}`, secondDisk)); w.Code != 200 {
		t.Fatalf("rebuild config: %d %s", w.Code, w.Body)
	}
	if w := call(http.MethodPost, "/computer/start", `{}`); w.Code != 200 {
		t.Fatalf("rebuild start: %d %s", w.Code, w.Body)
	}
	second, err := h.workspaceStore().Current(ctx, "tenant", space.ID)
	if err != nil || second.InstanceID == first.InstanceID || second.Generation <= first.Generation || second.DiskID != secondDisk {
		t.Fatalf("replacement: %+v %v", second, err)
	}
	var count int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM workspace_create_operations WHERE space_id=? AND identity_version=2`, space.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("creation intents lost: %d %v", count, err)
	}
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM managed_containers WHERE space_id=? AND workspace_instance_id=? AND docker_id='docker-1'`, space.ID, first.InstanceID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("old metadata overwritten: %d %v", count, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if creates != 2 || len(containers) != 2 {
		t.Fatalf("old container interfered: %d %d", creates, len(containers))
	}
}
