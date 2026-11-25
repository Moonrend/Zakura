package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestSharedRuntimeNodeInstallMaterialRequiresOwningPlatformAdmin(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "owner-tenant")
	seedTenant(t, d, "other-tenant")
	now := runtimeTimeString(d.Clock())
	id := "shared-node"
	node := models.RuntimeNode{ID: &id, TenantID: "owner-tenant", Name: "Shared", Slug: "shared", Kind: "computer", Status: "offline", CapabilitiesJSON: "{}", HostInfoJSON: "{}", StorageRoot: "/var/lib/zakura", LabelsJSON: "{}", IsShared: true, CreatedAt: now, UpdatedAt: now}
	if err := d.Gorm.Create(&node).Error; err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: NewStore(d), hub: newRunnerHub(d)}
	const token = "rnr_shared-install-secret"
	runnerTokenCache.Store(id, token)
	t.Cleanup(func() { runnerTokenCache.Delete(id) })
	router := chi.NewRouter()
	router.Get("/runtime-nodes/{id}/install", h.runtimeInstallInfo)
	router.Get("/runtime-nodes/{id}/detail", h.runtimeNodeDetail)
	request := func(path string, actor httpx.Principal) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		router.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(context.Background(), actor)))
		return w
	}

	foreign := httpx.Principal{TenantID: "other-tenant", Role: "owner", IsPlatformAdmin: true}
	if w := request("/runtime-nodes/shared-node/install", foreign); w.Code != http.StatusNotFound || strings.Contains(w.Body.String(), token) {
		t.Fatalf("foreign shared install response: %d %s", w.Code, w.Body.String())
	}
	w := request("/runtime-nodes/shared-node/detail", foreign)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), token) {
		t.Fatalf("foreign shared detail response: %d %s", w.Code, w.Body.String())
	}
	var detail struct {
		Node struct {
			Access string `json:"access"`
		} `json:"node"`
		Install          any `json:"install"`
		InstallTailscale any `json:"installTailscale"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil || detail.Node.Access != "shared" || detail.Install != nil || detail.InstallTailscale != nil {
		t.Fatalf("shared detail contains installation material: %#v, %v", detail, err)
	}

	owner := httpx.Principal{TenantID: "owner-tenant", Role: "owner", IsPlatformAdmin: true}
	w = request("/runtime-nodes/shared-node/install", owner)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), token) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("owning platform admin install response: %d %s", w.Code, w.Body.String())
	}
	owner.IsPlatformAdmin = false
	if w := request("/runtime-nodes/shared-node/install", owner); w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), token) {
		t.Fatalf("non-platform shared install response: %d %s", w.Code, w.Body.String())
	}
}

func TestRuntimeNodeInstallAuthorizationRejectsUntrustedPrincipals(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	now := runtimeTimeString(d.Clock())
	id := "owned-node"
	node := models.RuntimeNode{ID: &id, TenantID: "tenant", Name: "Owned", Slug: "owned", Kind: "computer", Status: "offline", CapabilitiesJSON: "{}", HostInfoJSON: "{}", StorageRoot: "/var/lib/zakura", LabelsJSON: "{}", CreatedAt: now, UpdatedAt: now}
	if err := d.Gorm.Create(&node).Error; err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d}
	for _, actor := range []httpx.Principal{
		{TenantID: "tenant", Role: "member"},
		{TenantID: "tenant", Role: "owner", APIKey: true},
		{TenantID: "tenant", Role: "owner", SpaceID: "space"},
		{TenantID: "tenant", Role: "owner", AgentID: "agent"},
	} {
		if err := h.authorizeRuntimeNodeInstall(context.Background(), actor, id); !errors.Is(err, errRuntimeNodeInstallForbidden) {
			t.Fatalf("untrusted principal authorization error = %v", err)
		}
	}
	if err := h.authorizeRuntimeNodeInstall(context.Background(), httpx.Principal{TenantID: "tenant", Role: "admin"}, id); err != nil {
		t.Fatalf("tenant admin authorization error = %v", err)
	}
}

func TestManualNodeAuthenticationDoesNotRestoreInstallMaterial(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	now := runtimeTimeString(d.Clock())
	id := "manual-node"
	node := models.RuntimeNode{ID: &id, TenantID: "tenant", Name: "Manual", Slug: "manual", Kind: "computer", Status: "offline", CapabilitiesJSON: "{}", HostInfoJSON: "{}", StorageRoot: "/var/lib/zakura", LabelsJSON: "{}", CreatedAt: now, UpdatedAt: now}
	if err := d.Gorm.Create(&node).Error; err != nil {
		t.Fatal(err)
	}
	runnerTokenCache.Delete(id)
	h := &handler{deps: d}
	incarnation, err := h.cacheRuntimeNodeToken(context.Background(), id, "rnr_runtime-credential")
	if err != nil || incarnation != "" {
		t.Fatalf("manual node authentication failed: %q %v", incarnation, err)
	}
	if _, ok := runnerTokenCache.Load(id); ok {
		t.Fatal("manual node authentication restored installation material")
	}
}
