// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestContainerAllocationRequiresPlatformAdmin(t *testing.T) {
	h := &handler{}
	router := chi.NewRouter()
	h.registerInstances(router)
	h.registerWorkspace(router)

	request := func(path, body string, actor httpx.Principal) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), actor))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}

	for _, path := range []string{
		"/containers/allocate",
		"/runtime-nodes/node/containers/allocate",
	} {
		t.Run(path, func(t *testing.T) {
			member := request(path, `{"image":"attacker/image","command":["sleep","infinity"]}`, httpx.Principal{TenantID: "tenant", Role: "member"})
			if member.Code != http.StatusForbidden {
				t.Fatalf("member allocation status = %d, want %d", member.Code, http.StatusForbidden)
			}

			admin := request(path, `{}`, httpx.Principal{TenantID: "tenant", Role: "owner", IsPlatformAdmin: true})
			if admin.Code != http.StatusBadRequest {
				t.Fatalf("platform admin validation status = %d, want %d", admin.Code, http.StatusBadRequest)
			}
		})
	}
}
