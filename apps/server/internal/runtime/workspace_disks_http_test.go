package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
	"github.com/go-chi/chi/v5"
)

func TestWorkspaceDiskHTTPAndOfflineCleanup(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	// Disks are tenant storage: creating one needs no Space.
	var deletes atomic.Int64
	var loseAllocate, wrongAck atomic.Bool
	loseAllocate.Store(true)
	h := builtinToolHarness(t, d, "rnr_disks", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"kind": "server", "storageRoot": "/workspace-data", "capabilities": map[string]any{"workspaceProtocolV2": true}}, nil
		case "workspace.identity":
			return map[string]any{"version": 1, "incarnation": "incarnation"}, nil
		case "workspace.disk.allocate":
			if loseAllocate.Swap(false) {
				return nil, fmt.Errorf("allocation reply lost")
			}
			return map[string]any{"disk": params, "usedBytes": 17}, nil
		case "workspace.disk.usage":
			return map[string]any{"disk": params, "usedBytes": 23}, nil
		case "workspace.disk.delete":
			deletes.Add(1)
			disk := params["disk"].(map[string]any)
			if wrongAck.Load() {
				disk["locatorVersion"] = 999
			}
			return map[string]any{"disk": disk, "deleted": true}, nil
		default:
			return nil, fmt.Errorf("unexpected RPC %s", method)
		}
	})
	if _, err := d.DB.Exec(`UPDATE runtime_nodes SET incarnation='incarnation' WHERE id='node'`); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	h.registerWorkspaceDisks(router)
	owner := httpx.Principal{TenantID: "tenant", Role: "owner"}
	call := func(method, path, body string, p httpx.Principal) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r = r.WithContext(httpx.WithPrincipal(r.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	base := "/disks"
	for _, p := range []httpx.Principal{{TenantID: "tenant"}, {TenantID: "tenant", Role: "owner", AgentID: "agent"}, {TenantID: "tenant", Role: "owner", SpaceID: "other"}, {TenantID: "tenant", Role: "owner", APIKey: true, APIKeyScopes: `["api"]`}} {
		if w := call(http.MethodPost, base, `{"name":"Disk","nodeId":"node"}`, p); w.Code != 403 {
			t.Fatalf("unauthorized create: %d", w.Code)
		}
	}
	w := call(http.MethodPost, base, `{"name":"Disk","nodeId":"node"}`, owner)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	var created struct {
		Disk workspaces.Disk `json:"disk"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Disk.State != "pending" || created.Disk.LastError == nil {
		t.Fatalf("lost allocation: %+v", created.Disk)
	}
	id := created.Disk.ID
	if w := call(http.MethodPost, base+"/"+id+"/refresh", `{}`, owner); w.Code != 200 {
		t.Fatalf("retry: %d %s", w.Code, w.Body)
	}
	if w := call(http.MethodPatch, base+"/"+id, `{"name":"Retained"}`, owner); w.Code != 200 {
		t.Fatalf("rename: %d %s", w.Code, w.Body)
	}
	if w := call(http.MethodGet, base, ``, httpx.Principal{TenantID: "foreign", Role: "owner"}); w.Code != 200 || strings.Contains(w.Body.String(), id) {
		t.Fatalf("cross tenant: %d %s", w.Code, w.Body)
	}
	if w := call(http.MethodPatch, base+"/"+id, `{"name":"Foreign"}`, httpx.Principal{TenantID: "foreign", Role: "owner"}); w.Code == 200 {
		t.Fatalf("cross tenant rename: %d", w.Code)
	}
	w = call(http.MethodGet, base, "", owner)
	if w.Code != 200 || strings.Contains(w.Body.String(), "disks/"+id+"/workspace") || !strings.Contains(w.Body.String(), "Retained") {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	connected := h.hub
	h.hub = newRunnerHub(d)
	w = call(http.MethodDelete, base+"/"+id, `{"requestId":"delete-disk"}`, owner)
	if w.Code != 202 {
		t.Fatalf("offline delete: %d %s", w.Code, w.Body)
	}
	var deletion struct {
		Operation workspaces.Cleanup `json:"operation"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &deletion); err != nil {
		t.Fatal(err)
	}
	if err := h.sweepWorkspaceCleanup(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	job, err := h.workspaceStore().Cleanup(context.Background(), "tenant", deletion.Operation.SpaceID, deletion.Operation.ID)
	if err != nil || job.Attempts != 0 || !job.Pending || deletes.Load() != 0 {
		t.Fatalf("offline cleanup consumed claim: %+v %v", job, err)
	}
	if w := call(http.MethodDelete, base+"/"+id, `{"requestId":"delete-disk"}`, owner); w.Code != 202 {
		t.Fatalf("idempotent delete: %d", w.Code)
	}
	// A restarted handler uses only persisted cleanup records and the connected hub.
	restarted := &handler{deps: d, store: NewStore(d), hub: connected}
	wrongAck.Store(true)
	if err := restarted.sweepWorkspaceCleanup(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	job, err = restarted.workspaceStore().Cleanup(context.Background(), "tenant", job.SpaceID, job.ID)
	if err != nil || !job.Pending || job.LastError == nil {
		t.Fatalf("wrong ack completed cleanup: %+v %v", job, err)
	}
	wrongAck.Store(false)
	if _, err := d.DB.Exec(`UPDATE workspace_cleanup_tombstones SET next_attempt=0 WHERE id=?`, job.ID); err != nil {
		t.Fatal(err)
	}
	if err := restarted.sweepWorkspaceCleanup(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	job, err = restarted.workspaceStore().Cleanup(context.Background(), "tenant", job.SpaceID, job.ID)
	if err != nil || job.Pending || job.Phase != "completed" || deletes.Load() != 2 {
		t.Fatalf("cleanup: %+v %v deletes=%d", job, err, deletes.Load())
	}
	if w := call(http.MethodGet, base, "", owner); w.Code != 200 || strings.Contains(w.Body.String(), "Retained") {
		t.Fatalf("deleted disk visible: %d %s", w.Code, w.Body)
	}
}

func TestWorkspaceDiskRequiresCompleteNodeProtocol(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := builtinToolHarness(t, d, "rnr_disks_old", func(method string, params map[string]any) (any, error) {
		if method == "sys.info" {
			return map[string]any{"kind": "server", "storageRoot": "/workspace-data", "capabilities": map[string]bool{"docker": true, "dockerCreateReceipts": true}}, nil
		}
		return nil, fmt.Errorf("unexpected RPC %s", method)
	})
	if _, err := d.DB.Exec(`UPDATE runtime_nodes SET incarnation='incarnation'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.workspaceDiskNode(context.Background(), "tenant", "node"); err == nil || !strings.Contains(err.Error(), "update") {
		t.Fatalf("partial protocol accepted: %v", err)
	}
}
