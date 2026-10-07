// SPDX-License-Identifier: AGPL-3.0-or-later
package agentconfig

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"gorm.io/gorm"
)

var ErrConflict = errors.New("agent configuration changed concurrently")

const maxUpdateAttempts = 16

// Update applies a field-scoped mutation to the latest configuration. The
// comparison in the write protects against other processes and full-config
// replacements, on both SQLite and PostgreSQL. mutate may run more than once
// and must not perform external side effects or reuse stale configuration.
// columns contains any accompanying, already validated non-config updates.
func Update(ctx context.Context, db *gorm.DB, tenant, id, updatedAt string, columns map[string]any, mutate func(map[string]any) error) (bool, error) {
	for attempt := 0; attempt < maxUpdateAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		var row struct {
			Config string `gorm:"column:config_json"`
		}
		if err := db.WithContext(ctx).Table("agents").Select("config_json").Where("tenant_id=? AND id=?", tenant, id).Take(&row).Error; err != nil {
			return false, err
		}
		var config map[string]any
		decoder := json.NewDecoder(strings.NewReader(row.Config))
		decoder.UseNumber()
		if !json.Valid([]byte(row.Config)) || decoder.Decode(&config) != nil || config == nil {
			return false, errors.New("invalid agent configuration")
		}
		if err := mutate(config); err != nil {
			return false, err
		}
		next, err := json.Marshal(config)
		if err != nil {
			return false, err
		}
		if string(next) == row.Config && len(columns) == 0 {
			return false, nil
		}
		updates := make(map[string]any, len(columns)+2)
		for key, value := range columns {
			updates[key] = value
		}
		updates["config_json"] = string(next)
		updates["updated_at"] = updatedAt
		result := db.WithContext(ctx).Table("agents").Where("tenant_id=? AND id=? AND config_json=?", tenant, id, row.Config).Updates(updates)
		if result.Error != nil {
			return false, result.Error
		}
		if result.RowsAffected != 0 {
			return true, nil
		}
	}
	return false, ErrConflict
}
