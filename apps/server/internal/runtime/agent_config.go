// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/agentconfig"
	"gorm.io/gorm"
)

// updateAgentConfig is for internal field-scoped settings saves. UpdateAgent
// retains the public API's deliberate whole-config replacement semantics.
func (s *Store) updateAgentConfig(ctx context.Context, tenant, id string, columns map[string]any, mutate func(map[string]any) error) (Agent, error) {
	_, err := agentconfig.Update(ctx, s.deps.Gorm, tenant, id, runtimeTimeString(s.now()), columns, mutate)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		err = ErrNotFound
	} else if errors.Is(err, agentconfig.ErrConflict) {
		err = ErrConflict
	}
	if err != nil {
		return Agent{}, err
	}
	return s.GetAgent(ctx, tenant, id)
}

// saveAgentConfigChanges carries only the top-level fields changed relative to
// the caller's original snapshot. In particular, an unchanged executionMode
// must never overwrite a newer policy while saving ACP state.
func (s *Store) saveAgentConfigChanges(ctx context.Context, tenant string, original Agent, next map[string]any) error {
	var previous map[string]any
	if json.Unmarshal(original.Config, &previous) != nil || previous == nil || next == nil {
		return errors.New("invalid agent configuration")
	}
	_, err := s.updateAgentConfig(ctx, tenant, original.ID, nil, func(current map[string]any) error {
		for key := range previous {
			if _, ok := next[key]; !ok {
				delete(current, key)
			}
		}
		for key, value := range next {
			old, exists := previous[key]
			if !exists || !reflect.DeepEqual(old, value) {
				current[key] = value
			}
		}
		return nil
	})
	return err
}
