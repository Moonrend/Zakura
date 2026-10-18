// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/pgtest"
)

func assertEmailPackagesPreserveLegacyIdentity(t *testing.T, d *appdeps.Dependencies) {
	t.Helper()
	ctx := context.Background()
	h := &handler{deps: d}
	now := h.now().Format(time.RFC3339Nano)
	for _, p := range providers {
		if !strings.HasPrefix(p.Ref, "email-") {
			continue
		}
		id := "legacy-" + p.Ref
		row := models.IntegrationPackage{ID: &id, Slug: p.Package.Slug, Name: "retained " + p.Name, ManifestJSON: `{"retained":true}`, CreatedAt: now, UpdatedAt: now}
		if err := d.Gorm.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := h.seedEmailPackages(ctx); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	for _, p := range providers {
		if !strings.HasPrefix(p.Ref, "email-") {
			continue
		}
		var row models.IntegrationPackage
		if err := d.Gorm.Where("slug = ?", p.Package.Slug).Take(&row).Error; err != nil {
			t.Fatal(err)
		}
		if row.ID == nil || *row.ID != "legacy-"+p.Ref || row.Name != "retained "+p.Name || row.ManifestJSON != `{"retained":true}` {
			t.Fatalf("legacy catalogue was overwritten: %+v", row)
		}
		var components []models.IntegrationComponent
		if err := d.Gorm.Where("package_id = ? AND ref = ?", *row.ID, p.Ref).Find(&components).Error; err != nil || len(components) != 1 {
			t.Fatalf("missing/duplicate legacy component: %+v %v", components, err)
		}
	}
}

func TestEmailPackagesPreserveLegacySlugIdentity(t *testing.T) {
	d, _, _ := setup(t)
	assertEmailPackagesPreserveLegacyIdentity(t, d)
}

func TestEmailPackagesRejectUnrelatedIDCollisionAtomically(t *testing.T) {
	d, _, _ := setup(t)
	ctx := context.Background()
	h := &handler{deps: d}
	now := h.now().Format(time.RFC3339Nano)
	if err := d.Gorm.Create(&models.IntegrationPackage{ID: strPtr("email-mailgun"), Slug: "unrelated-custom", Name: "Custom", ManifestJSON: "{}", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.seedEmailPackages(ctx); err == nil {
		t.Fatal("unrelated ID collision silently reused a different package")
	}
	var packages, components int64
	if err := d.Gorm.Model(&models.IntegrationPackage{}).Count(&packages).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.Gorm.Model(&models.IntegrationComponent{}).Count(&components).Error; err != nil {
		t.Fatal(err)
	}
	if packages != 1 || components != 0 {
		t.Fatalf("failed seed committed partial catalogue: packages=%d components=%d", packages, components)
	}
}

func TestPostgresEmailPackagesPreserveLegacySlugIdentity(t *testing.T) {
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, pgtest.FreshURL(t, "", "email_packages"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.DB.Close() })
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatal(err)
	}
	gdb, err := conn.Gorm()
	if err != nil {
		t.Fatal(err)
	}
	d := &appdeps.Dependencies{DB: conn.DB, Gorm: gdb, Dialect: conn.Dialect, Rebind: conn.Rebind, Clock: time.Now}
	t.Run(fmt.Sprintf("%s-legacy-id", conn.Dialect), func(t *testing.T) {
		assertEmailPackagesPreserveLegacyIdentity(t, d)
	})
}
