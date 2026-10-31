package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
	"github.com/go-chi/chi/v5"
)

func TestWorkspaceRetirementHTTPWhileOffline(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "Offline"})
	if err != nil {
		t.Fatal(err)
	}
	h := builtinToolHarness(t, d, "rnr_offline_retirement", func(method string, params map[string]any) (any, error) {
		if method == "sys.info" {
			return map[string]any{"kind": "server", "storageRoot": "/workspace-data"}, nil
		}
		return nil, fmt.Errorf("unexpected remote operation %s", method)
	})
	old := attachTestWorkspace(t, h, space.ID, "old-disk", "old-instance")
	lease, err := h.acquireSpaceWorkspace(ctx, "tenant", space.ID, "starting", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.hub = newRunnerHub(d)
	router := chi.NewRouter()
	h.registerComputers(router)
	base := "/spaces/" + space.ID + "/computer"
	owner := httpx.Principal{TenantID: "tenant", Role: "owner"}
	call := func(method, body string, p httpx.Principal) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, base, strings.NewReader(body))
		r = r.WithContext(httpx.WithPrincipal(r.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	body := `{"expectedInstanceId":"old-instance","requestId":"retire"}`
	for _, p := range []httpx.Principal{{TenantID: "tenant"}, {TenantID: "tenant", Role: "owner", AgentID: "agent"}, {TenantID: "tenant", Role: "owner", APIKey: true, APIKeyScopes: `["api"]`}} {
		if w := call(http.MethodDelete, body, p); w.Code != 403 {
			t.Fatalf("permission: %d %s", w.Code, w.Body)
		}
	}
	w := call(http.MethodDelete, body, owner)
	if w.Code != 202 {
		t.Fatalf("offline retire: %d %s", w.Code, w.Body)
	}
	var response struct {
		Operation workspaces.Cleanup `json:"operation"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.Operation.Pending || response.Operation.DeleteDisk {
		t.Fatalf("default retention: %+v", response)
	}
	if w := call(http.MethodGet, "", owner); w.Code != 200 || !strings.Contains(w.Body.String(), `"workspaceInstance":null`) || !strings.Contains(w.Body.String(), response.Operation.ID) {
		t.Fatalf("retired status: %d %s", w.Code, w.Body)
	}
	if err := lease.finish(ctx, "running", nil); !errors.Is(err, errWorkspaceLeaseLost) {
		t.Fatalf("late completion: %v", err)
	}
	if w := call(http.MethodDelete, body, owner); w.Code != 202 || !strings.Contains(w.Body.String(), response.Operation.ID) {
		t.Fatalf("retry changed operation: %d %s", w.Code, w.Body)
	}
	if w := call(http.MethodDelete, `{"expectedInstanceId":"old-instance","requestId":"retire","deleteDisk":true}`, owner); w.Code != 409 {
		t.Fatalf("retry changed disk authorization: %d", w.Code)
	}
	newInstance := attachTestWorkspace(t, h, space.ID, "new-disk", "new-instance")
	if w := call(http.MethodDelete, `{"expectedInstanceId":"old-instance","requestId":"stale-delete"}`, owner); w.Code != 409 {
		t.Fatalf("stale deletion: %d %s", w.Code, w.Body)
	}
	lease.release()
	current, err := h.workspaceStore().Current(ctx, "tenant", space.ID)
	if err != nil || current.Target != newInstance.Target {
		t.Fatalf("replacement changed: %+v %v", current, err)
	}
	disk, err := h.workspaceStore().Disk(ctx, "tenant", old.DiskID)
	if err != nil || disk.State != "release_pending" || disk.AttachedInstanceID == nil || *disk.AttachedInstanceID != old.InstanceID {
		t.Fatalf("offline disk released: %+v %v", disk, err)
	}
	if w := call(http.MethodDelete, `{"expectedInstanceId":"new-instance","requestId":"delete-both","deleteDisk":true}`, owner); w.Code != 202 {
		t.Fatalf("explicit deletion: %d %s", w.Code, w.Body)
	}
	disk, err = h.workspaceStore().Disk(ctx, "tenant", newInstance.DiskID)
	if err != nil || disk.State != "delete_pending" || disk.AttachedInstanceID == nil {
		t.Fatalf("disk deletion lost obligation: %+v %v", disk, err)
	}
}
