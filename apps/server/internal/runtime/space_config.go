// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
)

// mutateSpaceConfig reapplies a mutation to the latest snapshot on every CAS
// retry. Mutations must not perform external effects.
func (s *Store) mutateSpaceConfig(ctx context.Context, tenant, space string, mutate func(map[string]any) error) (map[string]any, error) {
	for attempt := 0; attempt < 8; attempt++ {
		current, err := s.GetSpace(ctx, tenant, space)
		if err != nil {
			return nil, err
		}
		config := map[string]any{}
		if len(current.Config) > 0 && string(current.Config) != "null" {
			if err = json.Unmarshal(current.Config, &config); err != nil {
				return nil, errors.New("space configuration is invalid JSON")
			}
		}
		if config == nil {
			config = map[string]any{}
		}
		if err = mutate(config); err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(config)
		if err != nil {
			return nil, err
		}
		result := s.deps.Gorm.WithContext(ctx).Table("spaces").Where("tenant_id=? AND id=? AND config_json=?", tenant, space, string(current.Config)).Updates(map[string]any{"config_json": string(encoded), "updated_at": runtimeTimeString(s.now())})
		if result.Error != nil {
			return nil, result.Error
		}
		if result.RowsAffected == 1 {
			return config, nil
		}
	}
	return nil, ErrConflict
}

// mergeConfigPatch follows JSON merge-patch semantics: null resets a field,
// objects merge recursively, and other values replace the current value.
func mergeConfigPatch(current, patch map[string]any) {
	for key, value := range patch {
		if value == nil {
			delete(current, key)
			continue
		}
		if fields, ok := value.(map[string]any); ok {
			next, _ := current[key].(map[string]any)
			if next == nil {
				next = map[string]any{}
			}
			mergeConfigPatch(next, fields)
			current[key] = next
			continue
		}
		current[key] = value
	}
}
