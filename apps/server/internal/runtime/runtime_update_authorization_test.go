// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
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
