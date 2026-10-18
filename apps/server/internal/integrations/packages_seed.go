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
			comp := models.IntegrationComponent{ID: strPtr(*stored.ID + ":connector"), PackageID: *stored.ID, Ref: p.Ref, Kind: "connector", ManifestJSON: string(compMeta)}
			if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "package_id"}, {Name: "ref"}}, DoNothing: true}).Create(&comp).Error; err != nil {
				return err
			}
		}
		return nil
	})
}
