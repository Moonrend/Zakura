// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestRuntimeNodeUpdateAuthorizationRequiresPlatformAdminOwnership(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant-a")
	seedTenant(t, d, "tenant-b")
	now := runtimeTimeString(d.Clock())
	node := func(id, tenant string, shared bool) models.RuntimeNode {
		return models.RuntimeNode{ID: &id, TenantID: tenant, Name: id, Slug: id, Kind: "computer", Status: "online", CapabilitiesJSON: "{}", HostInfoJSON: "{}", StorageRoot: "/var/lib/zakura", LabelsJSON: "{}", IsShared: shared, CreatedAt: now, UpdatedAt: now}
	}
	for _, candidate := range []models.RuntimeNode{
		node("owned", "tenant-a", false),
		node("foreign-shared", "tenant-b", true),
	} {
		if err := d.Gorm.Create(&candidate).Error; err != nil {
			t.Fatal(err)
		}
	}
	h := &handler{deps: d}
	for _, tc := range []struct {
		name  string
		actor httpx.Principal
		node  string
		want  error
	}{
		{name: "member cannot update owned node", actor: httpx.Principal{TenantID: "tenant-a", Role: "member"}, node: "owned", want: errRuntimeNodeUpdateForbidden},
		{name: "admin cannot update foreign shared node", actor: httpx.Principal{TenantID: "tenant-a", Role: "owner", IsPlatformAdmin: true}, node: "foreign-shared", want: ErrNotFound},
		{name: "admin can update owned node", actor: httpx.Principal{TenantID: "tenant-a", Role: "owner", IsPlatformAdmin: true}, node: "owned"},
		{name: "owning admin can update shared node", actor: httpx.Principal{TenantID: "tenant-b", Role: "owner", IsPlatformAdmin: true}, node: "foreign-shared"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := h.authorizeRuntimeNodeUpdate(context.Background(), tc.actor, tc.node)
			if !errors.Is(err, tc.want) {
				t.Fatalf("authorizeRuntimeNodeUpdate() error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestRefreshWorkspaceImageAuthorizesBeforeNodeSideEffects(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant-a")
	seedTenant(t, d, "tenant-b")
	now := runtimeTimeString(d.Clock())
	node := func(id, tenant string, shared bool) models.RuntimeNode {
		return models.RuntimeNode{ID: &id, TenantID: tenant, Name: id, Slug: id, Kind: "computer", Status: "online", CapabilitiesJSON: "{}", HostInfoJSON: "{}", StorageRoot: "/var/lib/zakura", LabelsJSON: "{}", IsShared: shared, CreatedAt: now, UpdatedAt: now}
	}
	for _, candidate := range []models.RuntimeNode{
		node("owned", "tenant-a", false),
		node("foreign-shared", "tenant-b", true),
	} {
		if err := d.Gorm.Create(&candidate).Error; err != nil {
			t.Fatal(err)
		}
	}

	h := &handler{deps: d}
	for _, tc := range []struct {
		name   string
		actor  httpx.Principal
		nodeID string
		status int
	}{
		{name: "member cannot refresh owned node", actor: httpx.Principal{TenantID: "tenant-a", Role: "member"}, nodeID: "owned", status: http.StatusForbidden},
		{name: "admin cannot refresh foreign shared node", actor: httpx.Principal{TenantID: "tenant-a", Role: "owner", IsPlatformAdmin: true}, nodeID: "foreign-shared", status: http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/runtime-nodes/"+tc.nodeID+"/refresh-workspace-image", strings.NewReader(`{"image":"example.invalid/workspace:latest"}`))
			route := chi.NewRouteContext()
			route.URLParams.Add("id", tc.nodeID)
			ctx := context.WithValue(httpx.WithPrincipal(request.Context(), tc.actor), chi.RouteCtxKey, route)
			request = request.WithContext(ctx)

			// The nil hub is intentional: denied requests must return before any Docker RPC.
			response := httptest.NewRecorder()
			h.refreshWorkspaceImage(response, request)
			if response.Code != tc.status {
				t.Fatalf("refreshWorkspaceImage() status = %d, want %d", response.Code, tc.status)
			}
		})
	}
}
