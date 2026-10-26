package runtime

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestSpaceServerComputerLifecycleWithoutAgent(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Empty Space"})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var instance computerContainer
	creates, starts, stops, pulls := 0, 0, 0, 0
	h := builtinToolHarness(t, d, "rnr_space_server_lifecycle", func(method string, params map[string]any) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "server", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true, "dockerCreateReceipts": true}}, nil
		case "host.fs.mkdir":
			if params["spaceId"] != space.ID || params["path"] != "/" || params["root"] != nil {
				return nil, errors.New("workspace path is not Space-scoped")
			}
			return map[string]any{"abs": "/srv/zakura/spaces/" + space.ID + "/workspace"}, nil
		case "docker.list":
			if params["label"] != "zakura.space="+space.ID {
				return nil, errors.New("workspace lookup is not Space-scoped")
			}
			if instance.DockerID == "" {
				return []computerContainer{}, nil
			}
			return []computerContainer{instance}, nil
		case "docker.images":
			return []computerImageStatus{}, nil
		case "docker.pull":
			pulls++
			return map[string]any{}, nil
		case "docker.create":
			creates++
			if pulls != 1 {
				return nil, errors.New("workspace image was not pulled before create")
			}
			volume := params["volumes"].([]any)[0].(map[string]any)
			if volume["hostPath"] != "/srv/zakura/spaces/"+space.ID+"/workspace" || volume["containerPath"] != "/workspace" {
				return nil, errors.New("workspace does not share the Space filesystem")
			}
			env := params["env"].(map[string]any)
			if env["ZAKURA_ENABLE_COMPUTER"] != "1" || env["ZAKURA_ENABLE_BROWSER"] != "1" {
				return nil, errors.New("default desktop/browser were not enabled")
			}
			instance = workspaceReceiptFixture(params, "space-workspace")
			return instance, nil
		case "docker.create.status":
			return workspaceReceiptStatusFixture(instance), nil
		case "docker.stop":
			stops++
			if params["id"] != instance.DockerID || params["remove"] != false {
				return nil, errors.New("stop must preserve workspace container")
			}
			instance.Status = "exited"
			return map[string]any{"ok": true}, nil
		case "docker.start":
			starts++
			if params["id"] != instance.DockerID {
				return nil, errors.New("restart changed container identity")
			}
			instance.Status = "running"
			return instance, nil
		default:
			return nil, fmt.Errorf("unexpected RPC %s", method)
		}
	})
	router := chi.NewRouter()
	h.registerComputers(router)
	base := "/spaces/" + space.ID + "/computer"
	owner := httpx.Principal{TenantID: "tenant", Role: "owner"}
	call := func(method, path, body string, p httpx.Principal) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	if w := call(http.MethodPost, base+"/start", `{}`, owner); w.Code != http.StatusConflict {
		t.Fatalf("unbound start: %d %s", w.Code, w.Body)
	}
	config := `{"runtimeNodeId":"node","workspaceKind":"container","enableComputer":false,"workspaceImage":"custom:space"}`
	if w := call(http.MethodPut, base+"/config", config, owner); w.Code != http.StatusOK {
		t.Fatalf("configure without Agent: %d %s", w.Code, w.Body)
	}
	for _, action := range []string{"start", "start", "stop", "start"} {
		w := call(http.MethodPost, base+"/"+action, `{}`, owner)
		if w.Code != http.StatusOK {
			t.Fatalf("%s without Agent: %d %s", action, w.Code, w.Body)
		}
		want := "running"
		if action == "stop" {
			want = "stopped"
		}
		if !strings.Contains(w.Body.String(), `"workspaceStatus":"`+want+`"`) {
			t.Fatalf("%s state: %s", action, w.Body)
		}
	}
	if w := call(http.MethodPut, base+"/config", config, owner); w.Code != http.StatusOK {
		t.Fatalf("repeated initialization was not idempotent: %d %s", w.Code, w.Body)
	}
	mu.Lock()
	if creates != 1 || starts != 1 || stops != 1 || pulls != 1 {
		t.Errorf("unexpected lifecycle creates=%d starts=%d stops=%d pulls=%d", creates, starts, stops, pulls)
	}
	mu.Unlock()
	var agentID sql.NullString
	if err := d.DB.QueryRow(`SELECT agent_id FROM managed_containers WHERE space_id=? AND purpose='workspace'`, space.ID).Scan(&agentID); err != nil || agentID.Valid {
		t.Fatalf("workspace borrowed Agent: %v %v", agentID, err)
	}
	var count int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM agents WHERE space_id=?`, space.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("lifecycle created host Agent: %d %v", count, err)
	}
	for _, p := range []httpx.Principal{
		{TenantID: "tenant"}, {TenantID: "tenant", Role: "owner", AgentID: "some-agent"},
		{TenantID: "tenant", Role: "owner", SpaceID: "other"}, {TenantID: "tenant", Role: "owner", APIKey: true, APIKeyScopes: `["gateway"]`},
	} {
		if w := call(http.MethodPost, base+"/start", `{}`, p); w.Code != http.StatusForbidden {
			t.Fatalf("unprivileged start: %d %s", w.Code, w.Body)
		}
	}
}

func TestSpaceServerComputerReconfigurationPreservesFiles(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Reconfigure", RuntimeNodeID: &node, WorkspaceKind: "container", WorkspaceStatus: "stopped"})
	if err != nil {
		t.Fatal(err)
	}
	removed := false
	h := builtinToolHarness(t, d, "rnr_space_server_config", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "server", "storageRoot": "/srv/zakura"}, nil
		case "docker.list":
			if removed {
				return []computerContainer{}, nil
			}
			return []computerContainer{{DockerID: "old-container", Name: "old", Image: "old:image", Status: "exited", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.stop":
			if params["id"] != "old-container" || params["remove"] != true {
				return nil, errors.New("configuration did not replace stopped container")
			}
			removed = true
			return map[string]any{"ok": true}, nil
		default:
			return nil, fmt.Errorf("filesystem must not be removed: %s", method)
		}
	})
	if err := d.Gorm.Exec(`INSERT INTO managed_containers(id,tenant_id,space_id,runtime_node_id,docker_id,name,image,purpose,status,created_at,updated_at) VALUES('old','tenant',?,'node','old-container','old','old:image','workspace','stopped','before','before')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	h.registerComputers(router)
	req := httptest.NewRequest(http.MethodPut, "/spaces/"+space.ID+"/computer/config", strings.NewReader(`{"runtimeNodeId":"node","workspaceKind":"container","enableComputer":true,"workspaceImage":"new:image"}`))
	req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant", Role: "owner"}))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK || removed {
		t.Fatalf("repeat configuration replaced existing workspace: %d %s removed=%v", w.Code, w.Body, removed)
	}
	var id sql.NullString
	if err := d.DB.QueryRow(`SELECT docker_id FROM managed_containers WHERE id='old'`).Scan(&id); err != nil || !id.Valid || id.String != "old-container" {
		t.Fatalf("existing container identity changed: %v %v", id, err)
	}
	current, err := store.GetSpace(context.Background(), "tenant", space.ID)
	if err != nil || current.EnableComputer || current.WorkspaceImage != nil {
		t.Fatalf("repeat initialization changed legacy configuration: %+v %v", current, err)
	}
	req = httptest.NewRequest(http.MethodPut, "/spaces/"+space.ID+"/computer/config", strings.NewReader(`{"runtimeNodeId":"other-node"}`))
	req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant", Role: "owner"}))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("node change bypassed migration: %d %s", w.Code, w.Body)
	}
}

func TestSpaceWorkspaceClaimsSerializeLifecycle(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	ctx := context.Background()
	space, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "Claims"})
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"starting", "stopping", "configuring"} {
		_, release, err := h.claimSpaceWorkspace(ctx, "tenant", space.ID, state, false)
		if err != nil {
			t.Fatal(err)
		}
		for _, other := range []string{"starting", "stopping", "configuring"} {
			if _, _, err := h.claimSpaceWorkspace(ctx, "tenant", space.ID, other, false); !errors.Is(err, errWorkspaceStarting) {
				t.Fatalf("%s did not exclude %s: %v", state, other, err)
			}
		}
		release()
		_, nextRelease, err := h.claimSpaceWorkspace(ctx, "tenant", space.ID, state, false)
		if err != nil {
			t.Fatal(err)
		}
		release() // An old deferred release must not release a later claim.
		if _, _, err := h.claimSpaceWorkspace(ctx, "tenant", space.ID, state, false); !errors.Is(err, errWorkspaceStarting) {
			t.Fatalf("old release unlocked next claim: %v", err)
		}
		nextRelease()
		got, err := h.store.GetSpace(ctx, "tenant", space.ID)
		if err != nil || got.WorkspaceStatus != space.WorkspaceStatus {
			t.Fatalf("claim release: %+v %v", got, err)
		}
	}
	if err := d.Gorm.Exec(`UPDATE spaces SET workspace_status='running' WHERE id=?`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.claimSpaceWorkspace(ctx, "tenant", space.ID, "configuring", true); !errors.Is(err, errWorkspaceStarting) {
		t.Fatalf("running computer reconfiguration claimed: %v", err)
	}
}

func TestSpaceServerComputerConfigurationRejectsForeignNode(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	seedTenant(t, d, "other")
	h := &handler{deps: d, store: NewStore(d)}
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "S"})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range [][3]string{{"foreign", "other", "server"}, {"unsupported", "tenant", "runner"}, {"shared", "other", "server"}} {
		if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES(?,?,?,?,?,'offline','hash','{}','{}','/tmp','{}',?,'now','now')`, row[0], row[1], row[0], row[0], row[2], row[0] == "shared"); err != nil {
			t.Fatal(err)
		}
	}
	router := chi.NewRouter()
	h.registerComputers(router)
	for _, node := range []string{"missing", "foreign", "unsupported", "shared"} {
		req := httptest.NewRequest(http.MethodPut, "/spaces/"+space.ID+"/computer/config", strings.NewReader(`{"runtimeNodeId":"`+node+`","workspaceKind":"host"}`))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant", Role: "owner"}))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		want := http.StatusBadRequest
		if node == "shared" {
			want = http.StatusOK
		}
		if w.Code != want {
			t.Fatalf("%s node: %d %s", node, w.Code, w.Body)
		}
	}
}
