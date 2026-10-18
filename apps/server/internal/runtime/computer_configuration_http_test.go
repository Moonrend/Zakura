package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestComputerConfigurationHTTP(t *testing.T) {
	h, runtime := e2bTestSetup(t)
	ctx := context.Background()
	router := chi.NewRouter()
	h.registerComputers(router)
	base := "/spaces/" + runtime.SpaceID + "/computers/" + runtime.ComputerID
	call := func(method, path, body string, p httpx.Principal) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	owner := httpx.Principal{TenantID: runtime.TenantID, Role: "owner"}
	for _, p := range []httpx.Principal{{TenantID: "tenant"}, {TenantID: "tenant", Role: "owner", SpaceID: "foreign"}, {TenantID: "tenant", Role: "owner", AgentID: "agent"}, {TenantID: "tenant", Role: "owner", APIKey: true, APIKeyScopes: `["api"]`}} {
		for _, method := range []string{http.MethodGet, http.MethodPatch} {
			path := base
			if method == http.MethodGet {
				path += "/config"
			}
			if w := call(method, path, `{"name":"hijack"}`, p); w.Code != http.StatusForbidden {
				t.Fatalf("configuration management bypass: %d %s", w.Code, w.Body)
			}
		}
	}
	w := call(http.MethodGet, base+"/config", "", owner)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"template":"base"`) || strings.Contains(w.Body.String(), "test-key") || strings.Contains(w.Body.String(), "apiKey") {
		t.Fatalf("public configuration: %d %s", w.Code, w.Body)
	}
	// Renaming and template/policy changes remain available during an active
	// runtime. They never create another sandbox or rewrite its identity.
	w = call(http.MethodPatch, base, `{"name":"Renamed","idleSeconds":300,"maxLifetimeSeconds":1800,"config":{"apiKey":"","template":"updated"}}`, owner)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "test-key") {
		t.Fatalf("update: %d %s", w.Code, w.Body)
	}
	c, err := h.computerStore().Get(ctx, runtime.TenantID, runtime.SpaceID, runtime.ComputerID)
	if err != nil || c.Name != "Renamed" || c.IdleSeconds != 300 || c.MaxLifetimeSeconds != 1800 {
		t.Fatalf("updated computer: %+v %v", c, err)
	}
	var sealed string
	if err = h.deps.DB.QueryRow(`SELECT secret_ref FROM computers WHERE id=?`, c.ID).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	plain, err := computers.OpenCredentials(h.deps.Secret, c.TenantID, c.SpaceID, c.ID, sealed)
	var config map[string]string
	if err != nil || json.Unmarshal(plain, &config) != nil || config["apiKey"] != "test-key" || config["template"] != "updated" {
		t.Fatalf("partial update lost stored credential: %v", err)
	}
	for _, body := range []string{`{"idleSeconds":0}`, `{"idleSeconds":2000}`, `{"provider":"ssh"}`, `{"config":{"template":""}}`, `{"config":{"unsupported":"value"}}`} {
		if w = call(http.MethodPatch, base, body, owner); w.Code != http.StatusBadRequest {
			t.Fatalf("invalid update %s: %d %s", body, w.Code, w.Body)
		}
	}
	if w = call(http.MethodPatch, base, `{"config":{"apiKey":"replacement"}}`, owner); w.Code != http.StatusConflict {
		t.Fatalf("active instance account was replaced: %d %s", w.Code, w.Body)
	}
	if w = call(http.MethodPatch, base, `{"name":"Name only"}`, owner); w.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", w.Code, w.Body)
	}
	if err = h.deps.Gorm.Exec(`UPDATE computer_runtimes SET state='destroyed' WHERE id=?`, runtime.ID).Error; err != nil {
		t.Fatal(err)
	}
	if w = call(http.MethodPatch, base, `{"config":{"apiKey":"replacement"}}`, owner); w.Code != http.StatusOK {
		t.Fatalf("credential update after cleanup: %d %s", w.Code, w.Body)
	}
	var count int
	if err = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM computer_runtimes`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("configuration created a runtime: %d %v", count, err)
	}
	if err = h.deps.Gorm.Exec(`UPDATE computers SET deletion_pending=TRUE WHERE id=?`, c.ID).Error; err != nil {
		t.Fatal(err)
	}
	if w = call(http.MethodPatch, base, `{"config":{"template":"after-deletion"}}`, owner); w.Code != http.StatusConflict {
		t.Fatalf("configuration bypassed deletion fence: %d %s", w.Code, w.Body)
	}
}

func TestAttachedComputerDeletionIgnoresOfflineWorkspaceAndLease(t *testing.T) {
	for _, provider := range []string{"ssh", "remote_agent", "railway", "e2b", "temporary"} {
		for _, state := range []string{"creating", "unknown", "ready"} {
			t.Run(provider+"/"+state, func(t *testing.T) {
				h, runtime := e2bTestSetup(t)
				if err := h.deps.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,created_at,updated_at) VALUES('offline','tenant','Offline','offline','server','offline','/srv/zakura','now','now')`).Error; err != nil {
					t.Fatal(err)
				}
				if err := h.deps.Gorm.Exec(`UPDATE spaces SET runtime_node_id='offline' WHERE id=?`, runtime.SpaceID).Error; err != nil {
					t.Fatal(err)
				}
				if err := h.deps.Gorm.Exec(`UPDATE computers SET provider=?,runtime_node_id=CASE WHEN ? IN ('remote_agent','temporary') THEN 'offline' ELSE NULL END WHERE id=?`, provider, provider, runtime.ComputerID).Error; err != nil {
					t.Fatal(err)
				}
				if err := h.deps.Gorm.Exec(`UPDATE computer_runtimes SET state=?,external_id=CASE WHEN ?='ready' THEN 'original-instance' ELSE NULL END WHERE id=?`, state, state, runtime.ID).Error; err != nil {
					t.Fatal(err)
				}
				if err := h.deps.Gorm.Exec(`INSERT INTO managed_containers(id,tenant_id,space_id,runtime_node_id,docker_id,name,image,purpose,status,labels_json,created_at,updated_at) VALUES('unrelated-workspace','tenant',?,'offline','workspace-id','workspace','image','workspace','stopped','{}','now','now')`, runtime.SpaceID).Error; err != nil {
					t.Fatal(err)
				}
				lease, err := h.acquireSpaceWorkspace(context.Background(), runtime.TenantID, runtime.SpaceID, "starting", false, nil)
				if err != nil {
					t.Fatal(err)
				}
				defer lease.release()
				w := ownerCleanupHTTPDelete(t, h, "/spaces/"+runtime.SpaceID+"/computers/"+runtime.ComputerID)
				if w.Code != http.StatusOK {
					t.Fatalf("offline workspace blocked attached deletion: %d %s", w.Code, w.Body)
				}
				if err := lease.check(context.Background()); err != nil {
					t.Fatalf("attached deletion changed workspace lease: %v", err)
				}
				var intents int
				want := 0
				if provider == "e2b" || provider == "temporary" {
					want = 1
				}
				if err := h.deps.DB.QueryRow(`SELECT COUNT(*) FROM computer_cleanup_intents WHERE pending=TRUE`).Scan(&intents); err != nil || intents != want {
					t.Fatalf("cleanup intents=%d want=%d %v", intents, want, err)
				}
			})
		}
	}
}
