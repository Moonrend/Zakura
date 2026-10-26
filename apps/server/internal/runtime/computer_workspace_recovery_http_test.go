package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestWorkspaceRecoveryAcknowledgementRequiresUncertainOperation(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S"})
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	lease, err := h.acquireSpaceWorkspace(context.Background(), "tenant", space.ID, "starting", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.release()
	if err := h.acknowledgeAbsentSpaceWorkspace(context.Background(), "tenant", space.ID, lease.Token); err == nil {
		t.Fatal("active operation was unlocked by recovery acknowledgement")
	}
	for _, tc := range []struct {
		name      string
		principal httpx.Principal
		body      string
		want      int
	}{
		{"member denied", httpx.Principal{TenantID: "tenant", Role: "member"}, `{}`, http.StatusForbidden},
		{"explicit acknowledgement required", httpx.Principal{TenantID: "tenant", Role: "owner"}, `{"token":"` + lease.Token + `"}`, http.StatusBadRequest},
		{"agent key denied", httpx.Principal{TenantID: "tenant", Role: "owner", APIKey: true, AgentID: "agent", APIKeyScopes: `["*"]`}, `{}`, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router := chi.NewRouter()
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					next.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), tc.principal)))
				})
			})
			router.Post("/spaces/{id}/computer/recovery/acknowledge", h.acknowledgeWorkspaceRecovery)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/spaces/"+space.ID+"/computer/recovery/acknowledge", strings.NewReader(tc.body)))
			if w.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.want, w.Body.String())
			}
		})
	}
}
