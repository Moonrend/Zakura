// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (h *handler) seedEmailPackages(ctx context.Context) error {
	now := h.now().Format(time.RFC3339Nano)
	return h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		rows, err := tx.Raw(`SELECT * FROM integration_components LIMIT 0`).Rows()
		if err != nil {
			return fmt.Errorf("inspect integration components: %w", err)
		}
		columns, err := rows.Columns()
		rows.Close()
		if err != nil {
			return fmt.Errorf("read integration component columns: %w", err)
		}
		componentColumns := make(map[string]bool, len(columns))
		for _, column := range columns {
			componentColumns[column] = true
		}
		for _, p := range providers {
			if !strings.HasPrefix(p.Ref, "email-") {
				continue
			}
			meta, _ := json.Marshal(map[string]any{
				"kind": "plugin", "icon": p.Package.Icon, "homepage": p.Package.Homepage,
				"publisher": "reCloud", "category": p.Category, "verified": false, "featured": p.Package.Featured,
				"summary": p.Package.Summary, "description": p.Description,
			})
			pkg := models.IntegrationPackage{ID: strPtr(p.Package.Slug), Slug: p.Package.Slug, Name: p.Package.Name, Description: strPtr(p.Description), ManifestJSON: string(meta), CreatedAt: now, UpdatedAt: now}
			// Older catalogues used generated IDs. The unique slug, not the
			// proposed deterministic ID, identifies an existing package.
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&pkg).Error; err != nil {
				return err
			}
			var stored models.IntegrationPackage
			if err := tx.Where("slug = ?", p.Package.Slug).Take(&stored).Error; err != nil {
				return fmt.Errorf("resolve email package %s: %w", p.Package.Slug, err)
			}
			if stored.ID == nil || *stored.ID == "" {
				return fmt.Errorf("email package %s has no identity", p.Package.Slug)
			}
			compMeta, _ := json.Marshal(map[string]any{"name": p.Name, "description": p.Description, "auth": p.Auth, "needsRunner": false})
			comp := map[string]any{"id": *stored.ID + ":connector", "package_id": *stored.ID, "ref": p.Ref, "kind": "connector", "manifest_json": string(compMeta)}
			// Drizzle catalogues also require display fields outside the manifest.
			for key, value := range map[string]any{"name": p.Name, "description": p.Description, "config_json": string(compMeta), "created_at": now, "updated_at": now} {
				if componentColumns[key] {
					comp[key] = value
				}
			}
			// Legacy catalogues use (package_id, kind, ref); native ones use
			// (package_id, ref). Let either constraint preserve existing rows.
			if err := tx.Table(models.TableNameIntegrationComponent).Clauses(clause.OnConflict{DoNothing: true}).Create(comp).Error; err != nil {
				return err
			}
			var component models.IntegrationComponent
			if err := tx.Where("package_id = ? AND kind = ? AND ref = ?", *stored.ID, "connector", p.Ref).Take(&component).Error; err != nil {
				return fmt.Errorf("resolve email component %s: %w", p.Ref, err)
			}
		}
		return nil
	})
}
