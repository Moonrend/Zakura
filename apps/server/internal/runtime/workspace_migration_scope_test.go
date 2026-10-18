package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestWorkspaceMigrationDirectIDRetainsSpaceScope(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	ctx := context.Background()
	own, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "Own migration"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "Other migration"})
	if err != nil {
		t.Fatal(err)
	}
	for _, node := range []string{"source", "target"} {
		if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,created_at,updated_at) VALUES(?,'tenant',?,?,'computer','offline','/srv/zakura','now','now')`, node, node, node).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := d.Gorm.Exec(`INSERT INTO workspace_migrations(id,tenant_id,space_id,source_node_id,target_node_id,status,phase,progress_pct,created_at,updated_at) VALUES('job','tenant',?,'source','target','completed','completed',100,'now','now')`, own.ID).Error; err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, space string
		p           httpx.Principal
		want        int
	}{
		{"own", own.ID, httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: own.ID}, 200},
		{"wrong-route", other.ID, httpx.Principal{TenantID: "tenant", Role: "owner"}, 404},
		{"wrong-key", own.ID, httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: other.ID}, 404},
		{"agent-key", own.ID, httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: "bound"}, 404},
	} {
		for _, events := range []bool{false, true} {
			t.Run(tc.name+map[bool]string{false: "/get", true: "/events"}[events], func(t *testing.T) {
				router := chi.NewRouter()
				router.Use(func(next http.Handler) http.Handler {
					return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						ctx := httpx.WithPrincipal(r.Context(), tc.p)
						ctx = context.WithValue(ctx, spaceWorkspaceRequestKey{}, tc.space)
						next.ServeHTTP(w, r.WithContext(ctx))
					})
				})
				call := h.getWorkspaceMigration
				if events {
					call = h.workspaceMigrationEvents
				}
				router.Get("/migrations/{jobId}", call)
				w := httptest.NewRecorder()
				router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/migrations/job", nil))
				if w.Code != tc.want {
					t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
				}
			})
		}
	}
}
