// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"fmt"
	"path/filepath"
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

func TestEmailPackagesRejectComponentCollisionAtomically(t *testing.T) {
	for _, collision := range []struct{ name, id, kind, ref string }{
		{"id", "email-mailgun:connector", "connector", "unrelated-custom"},
		{"kind", "mailgun-skill", "skill", "email-mailgun"},
	} {
		t.Run(collision.name, func(t *testing.T) {
			d, _, _ := setup(t)
			h := &handler{deps: d}
			now := h.now().Format(time.RFC3339Nano)
			if err := d.Gorm.Create(&models.IntegrationPackage{ID: strPtr("email-mailgun"), Slug: "email-mailgun", Name: "Mailgun", ManifestJSON: "{}", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := d.Gorm.Create(&models.IntegrationComponent{ID: strPtr(collision.id), PackageID: "email-mailgun", Kind: collision.kind, Ref: collision.ref, ManifestJSON: `{"retained":true}`}).Error; err != nil {
				t.Fatal(err)
			}
			if err := h.seedEmailPackages(context.Background()); err == nil {
				t.Fatal("component collision silently reused a different component")
			}
			var packages, components int64
			if err := d.Gorm.Model(&models.IntegrationPackage{}).Count(&packages).Error; err != nil {
				t.Fatal(err)
			}
			if err := d.Gorm.Model(&models.IntegrationComponent{}).Count(&components).Error; err != nil {
				t.Fatal(err)
			}
			if packages != 1 || components != 1 {
				t.Fatalf("failed seed committed partial catalogue: packages=%d components=%d", packages, components)
			}
			var retained models.IntegrationComponent
			if err := d.Gorm.Where("id = ?", collision.id).Take(&retained).Error; err != nil || retained.Kind != collision.kind || retained.Ref != collision.ref || retained.ManifestJSON != `{"retained":true}` {
				t.Fatalf("conflicting component changed: %+v %v", retained, err)
			}
		})
	}
}

func assertEmailPackagesSeedLegacySchema(t *testing.T, databaseURL string) {
	t.Helper()
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.DB.Close() })
	// The Drizzle catalogue keyed components by package, kind and ref and kept
	// display fields outside config_json. In particular, name had no default.
	for _, q := range []string{
		`CREATE TABLE integration_packages (id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',manifest_json TEXT NOT NULL DEFAULT '{}',created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE integration_components (id TEXT PRIMARY KEY,package_id TEXT NOT NULL REFERENCES integration_packages(id) ON DELETE CASCADE,kind TEXT NOT NULL,ref TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',config_json TEXT NOT NULL DEFAULT '{}',sort_order INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(package_id,kind,ref))`,
		`INSERT INTO integration_packages(id,slug,name,manifest_json) VALUES('legacy-smtp','email-smtp','Retained SMTP','{"retained":true}')`,
		`INSERT INTO integration_components(id,package_id,kind,ref,name,config_json) VALUES('legacy-smtp-connector','legacy-smtp','connector','email-smtp','Retained connector','{"retained":true}')`,
		`INSERT INTO integration_components(id,package_id,kind,ref,name,config_json) VALUES('legacy-smtp-skill','legacy-smtp','skill','email-smtp','Retained skill','{"skill":true}')`,
	} {
		if _, err := conn.DB.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
			t.Fatal(err)
		}
	}
	gdb, err := conn.Gorm()
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: &appdeps.Dependencies{DB: conn.DB, Gorm: gdb, Dialect: conn.Dialect, Rebind: conn.Rebind, Clock: time.Now}}
	for i := 0; i < 2; i++ {
		if err := h.seedEmailPackages(ctx); err != nil {
			t.Fatalf("seed legacy schema %d: %v", i, err)
		}
	}
	var pkg models.IntegrationPackage
	if err := gdb.Where("slug = ?", "email-smtp").Take(&pkg).Error; err != nil {
		t.Fatal(err)
	}
	if pkg.ID == nil || *pkg.ID != "legacy-smtp" || pkg.Name != "Retained SMTP" || pkg.ManifestJSON != `{"retained":true}` {
		t.Fatalf("legacy package changed: %+v", pkg)
	}
	for _, p := range providers {
		if !strings.HasPrefix(p.Ref, "email-") {
			continue
		}
		var rows []struct {
			models.IntegrationComponent
			Name        string `gorm:"column:name"`
			Description string `gorm:"column:description"`
			ConfigJSON  string `gorm:"column:config_json"`
		}
		if err := gdb.Table("integration_components").Where("kind = ? AND ref = ?", "connector", p.Ref).Find(&rows).Error; err != nil || len(rows) != 1 {
			t.Fatalf("connector %s missing/duplicated: %+v %v", p.Ref, rows, err)
		}
		row := rows[0]
		if p.Ref == "email-smtp" {
			if row.ID == nil || *row.ID != "legacy-smtp-connector" || row.Name != "Retained connector" || row.ConfigJSON != `{"retained":true}` || row.ManifestJSON != row.ConfigJSON {
				t.Fatalf("legacy connector changed: %+v", row)
			}
		} else if row.Name != p.Name || row.Description != p.Description || row.ConfigJSON != row.ManifestJSON || row.ManifestJSON == "{}" {
			t.Fatalf("new connector missing legacy fields: %+v", row)
		}
	}
	var skill models.IntegrationComponent
	if err := gdb.Where("id = ?", "legacy-smtp-skill").Take(&skill).Error; err != nil || skill.Kind != "skill" || skill.ManifestJSON != `{"skill":true}` {
		t.Fatalf("same-ref skill changed: %+v %v", skill, err)
	}
}

func TestEmailPackagesSeedLegacySchema(t *testing.T) {
	assertEmailPackagesSeedLegacySchema(t, "file:"+filepath.Join(t.TempDir(), "catalogue.db"))
}

func TestPostgresEmailPackagesSeedLegacySchema(t *testing.T) {
	assertEmailPackagesSeedLegacySchema(t, pgtest.FreshURL(t, "", "legacy_email_packages"))
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
