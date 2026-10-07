// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"gorm.io/gorm/clause"
)

func (h *handler) seedEmailPackages(ctx context.Context) {
	now := h.now().Format(time.RFC3339Nano)
	for _, p := range providers {
		if !strings.HasPrefix(p.Ref, "email-") {
			continue
		}
		id := p.Package.Slug
		meta, _ := json.Marshal(map[string]any{
			"kind": "plugin", "icon": p.Package.Icon, "homepage": p.Package.Homepage,
			"publisher": "reCloud", "category": p.Category, "verified": false, "featured": p.Package.Featured,
			"summary": p.Package.Summary, "description": p.Description,
		})
		pkg := models.IntegrationPackage{ID: strPtr(id), Slug: p.Package.Slug, Name: p.Package.Name, Description: strPtr(p.Description), ManifestJSON: string(meta), CreatedAt: now, UpdatedAt: now}
		if e := h.deps.Gorm.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "id"}}, DoNothing: true}).Create(&pkg).Error; e != nil {
			continue
		}
		compMeta, _ := json.Marshal(map[string]any{"name": p.Name, "description": p.Description, "auth": p.Auth, "needsRunner": false})
		comp := models.IntegrationComponent{ID: strPtr(id + ":connector"), PackageID: id, Ref: p.Ref, Kind: "connector", ManifestJSON: string(compMeta)}
		_ = h.deps.Gorm.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "package_id"}, {Name: "ref"}}, DoNothing: true}).Create(&comp).Error
	}
}
