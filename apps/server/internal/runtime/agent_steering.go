// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"

	"gorm.io/gorm"
)

func steerOptionsCompatible(current, incoming json.RawMessage) bool {
	var have, want map[string]any
	if len(incoming) == 0 {
		return true
	}
	if json.Unmarshal(incoming, &want) != nil {
		return false
	}
	_ = json.Unmarshal(current, &have)
	for key, value := range want {
		if !reflect.DeepEqual(have[key], value) {
			return false
		}
	}
	return true
}

func (s *Service) injectSteers(ctx context.Context, req TurnRequest, run string, messages *[]chatMessage) (int, error) {
	pending, err := s.store.PendingQueue(ctx, req.Tenant, req.Agent, req.Session)
	if err != nil {
		return 0, err
	}
	selected := []QueueMessage{}
	for _, item := range pending {
		if item.Interrupt {
			break
		}
		if item.Mode != queueModeSteer {
			continue
		}
		if !steerOptionsCompatible(req.Options, item.Options) {
			break
		}
		selected = append(selected, item)
	}
	if len(selected) == 0 {
		return 0, nil
	}
	contexts := make([]string, len(selected))
	for i, item := range selected {
		contexts[i], err = s.invokeProjectHooks(ctx, req, run, projectHookInput{Event: "UserPromptSubmit", Prompt: item.Content}, false)
		if err != nil {
			return 0, err
		}
	}
	if err = s.store.consumeSteers(ctx, req.Tenant, req.Agent, req.Session, run, selected); err != nil {
		// An edit or deletion won the race. Re-read at the next boundary, without
		// attaching hook output for the obsolete message snapshot.
		if errors.Is(err, ErrConflict) {
			return 0, nil
		}
		return 0, err
	}
	for i, item := range selected {
		if contexts[i] != "" {
			*messages = append(*messages, chatMessage{Role: "system", Content: contexts[i]})
		}
		var attachments any
		_ = json.Unmarshal(item.Attachments, &attachments)
		message := userChatMessage(item.Context.render(item.Content), parseChatAttachments(attachments))
		message.UserMessageID = item.ID
		*messages = append(*messages, message)
	}
	return len(selected), nil
}

// consumeSteers commits user history and queue removal together. Hooks run
// outside this transaction and are bound to the exact snapshots passed here.
func (s *Store) consumeSteers(ctx context.Context, tenant, agent, session, run string, selected []QueueMessage) error {
	if len(selected) == 0 {
		return nil
	}
	return s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Exec(`UPDATE cloud_agent_sessions SET updated_at=updated_at WHERE id=? AND tenant_id=? AND agent_id=? AND active_run_id=?`, session, tenant, agent, run)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrConflict
		}
		var active int64
		if err := tx.Table("cloud_agent_runs").Where("id=? AND session_id=? AND status='running' AND cancel_requested=false", run, session).Count(&active).Error; err != nil {
			return err
		}
		if active != 1 {
			return ErrConflict
		}
		items, err := queueState(tx, session)
		if err != nil {
			return err
		}
		kept := make([]QueueMessage, 0, len(items))
		index := 0
		for _, item := range items {
			if index < len(selected) && (item.Interrupt || item.Mode == queueModeSteer) {
				if !reflect.DeepEqual(item, selected[index]) {
					return ErrConflict
				}
				index++
				continue
			}
			kept = append(kept, item)
		}
		if index != len(selected) {
			return ErrConflict
		}
		for _, item := range selected {
			payload := map[string]any{"messageId": item.ID, "content": item.Content, "attachments": json.RawMessage(validJSON(item.Attachments, "[]")), "options": json.RawMessage(validJSON(item.Options, "{}")), "steer": true}
			if item.Context != nil {
				payload["context"] = item.Context
			}
			if item.UserID != "" {
				payload["userId"], payload["userName"] = item.UserID, item.UserName
			}
			if _, err := s.appendEventTx(ctx, tx, session, "user_message", &run, payload); err != nil {
				return err
			}
		}
		_, err = s.appendEventTx(ctx, tx, session, "queue_update", nil, map[string]any{"items": kept})
		return err
	})
}
