// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"gorm.io/gorm"
)

const (
	queueModeSteer = "steer"
	queueModeQueue = "queue"
)

type queueMessageJSON struct {
	ID          string          `json:"id,omitempty"`
	MessageID   string          `json:"messageId,omitempty"`
	Content     string          `json:"content"`
	Context     *MessageContext `json:"context,omitempty"`
	Attachments json.RawMessage `json:"attachments,omitempty"`
	Options     json.RawMessage `json:"options,omitempty"`
	Mode        string          `json:"mode,omitempty"`
	Interrupt   bool            `json:"interrupt,omitempty"`
	CreatedAt   string          `json:"createdAt,omitempty"`
	UserID      string          `json:"userId,omitempty"`
	UserName    string          `json:"userName,omitempty"`
}

func (m QueueMessage) MarshalJSON() ([]byte, error) {
	mode := m.Mode
	if mode == "" {
		mode = queueModeQueue
	}
	return json.Marshal(queueMessageJSON{ID: m.ID, MessageID: m.ID, Content: m.Content, Context: m.Context, Attachments: m.Attachments, Options: m.Options, Mode: mode, Interrupt: m.Interrupt, CreatedAt: m.CreatedAt, UserID: m.UserID, UserName: m.UserName})
}

func (m *QueueMessage) UnmarshalJSON(raw []byte) error {
	var v queueMessageJSON
	if err := json.Unmarshal(raw, &v); err != nil {
		return err
	}
	id := v.MessageID
	if id == "" {
		id = v.ID
	}
	*m = QueueMessage{ID: id, Content: v.Content, Context: v.Context, Attachments: v.Attachments, Options: v.Options, Mode: v.Mode, Interrupt: v.Interrupt, CreatedAt: v.CreatedAt, UserID: v.UserID, UserName: v.UserName}
	return nil
}

// queueState replays the session's queue events. queue_update snapshots are
// authoritative; the legacy per-item queue.* events are still honoured so
// sessions written before snapshots existed keep their pending items.
func queueState(tx *gorm.DB, session string) ([]QueueMessage, error) {
	var rows []struct {
		Type        string `gorm:"column:type"`
		PayloadJSON string `gorm:"column:payload_json"`
	}
	if err := tx.Table("cloud_agent_events").Select("type,payload_json").
		Where("session_id = ? AND type IN ?", session, []string{"queue_update", "queue.added", "queue.updated", "queue.deleted", "queue.started"}).
		Order("seq").Find(&rows).Error; err != nil {
		return nil, err
	}
	order := []string{}
	state := map[string]QueueMessage{}
	for _, row := range rows {
		switch row.Type {
		case "queue_update":
			var snap struct {
				Items []QueueMessage `json:"items"`
			}
			if json.Unmarshal([]byte(row.PayloadJSON), &snap) != nil {
				continue
			}
			order = order[:0]
			state = map[string]QueueMessage{}
			for _, item := range snap.Items {
				if item.ID == "" {
					continue
				}
				if _, ok := state[item.ID]; !ok {
					order = append(order, item.ID)
				}
				state[item.ID] = item
			}
		case "queue.added", "queue.updated":
			var m QueueMessage
			if json.Unmarshal([]byte(row.PayloadJSON), &m) != nil || m.ID == "" {
				continue
			}
			if _, ok := state[m.ID]; !ok {
				order = append(order, m.ID)
			}
			state[m.ID] = m
		case "queue.deleted", "queue.started":
			var x QueueMessage
			if json.Unmarshal([]byte(row.PayloadJSON), &x) == nil {
				delete(state, x.ID)
			}
		}
	}
	out := make([]QueueMessage, 0, len(state))
	for _, id := range order {
		if m, ok := state[id]; ok {
			out = append(out, m)
		}
	}
	return out, nil
}

// mutateQueue applies fn to the pending queue under the session row lock and
// broadcasts the result as a queue_update snapshot when anything changed.
func (s *Store) mutateQueue(ctx context.Context, tenant, agent, session string, fn func([]QueueMessage) ([]QueueMessage, bool, error)) ([]QueueMessage, error) {
	return s.mutateQueueGuarded(ctx, tenant, agent, session, false, fn)
}

func (s *Store) mutateQueueGuarded(ctx context.Context, tenant, agent, session string, admission bool, fn func([]QueueMessage) ([]QueueMessage, bool, error)) ([]QueueMessage, error) {
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return nil, e
	}
	var out []QueueMessage
	e := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if admission {
			if err := s.guardAgentWorkspaceTx(tx, tenant, agent); err != nil {
				return err
			}
		}
		res := tx.Exec(`UPDATE cloud_agent_sessions SET updated_at=updated_at WHERE id=?`, session)
		if res.Error != nil {
			return res.Error
		}
		items, err := queueState(tx, session)
		if err != nil {
			return err
		}
		known := make(map[string]bool, len(items))
		for _, item := range items {
			known[item.ID] = true
		}
		next, changed, err := fn(items)
		if err != nil {
			return err
		}
		out = next
		if !changed {
			return nil
		}
		if next == nil {
			next = []QueueMessage{}
		}
		for _, item := range next {
			if known[item.ID] {
				continue
			}
			if err := s.persistBotUserTx(ctx, tx, tenant, agent, session, item.ID, item.Content, item.Attachments); err != nil {
				return err
			}
		}
		_, err = s.appendEventTx(ctx, tx, session, "queue_update", nil, map[string]any{"items": next})
		return err
	})
	return out, e
}

func normalizeQueueMessage(msg QueueMessage, id, now string) (QueueMessage, error) {
	msg.Content = strings.TrimSpace(msg.Content)
	if msg.Content == "" && !hasAttachments(msg.Attachments) {
		return QueueMessage{}, errors.New("content or attachments required")
	}
	if msg.ID == "" {
		msg.ID = id
	}
	if msg.Mode != queueModeSteer {
		msg.Mode = queueModeQueue
	}
	if msg.CreatedAt == "" {
		msg.CreatedAt = now
	}
	if len(msg.Attachments) == 0 || !json.Valid(msg.Attachments) {
		msg.Attachments = json.RawMessage(`[]`)
	}
	if len(msg.Options) == 0 || !json.Valid(msg.Options) {
		msg.Options = json.RawMessage(`{}`)
	}
	return msg, nil
}

func hasAttachments(raw json.RawMessage) bool {
	var list []any
	return json.Unmarshal(raw, &list) == nil && len(list) > 0
}

func (s *Store) Enqueue(ctx context.Context, tenant, agent, session string, msg QueueMessage) (QueueMessage, error) {
	msg, err := normalizeQueueMessage(msg, s.id(), runtimeTimeString(s.now()))
	if err != nil {
		return QueueMessage{}, err
	}
	_, err = s.mutateQueue(ctx, tenant, agent, session, func(items []QueueMessage) ([]QueueMessage, bool, error) {
		return append(items, msg), true, nil
	})
	return msg, err
}

// requeueFront puts a message taken from the queue back at its head, used when
// starting it lost a race against another turn.
func (s *Store) requeueFront(ctx context.Context, tenant, agent, session string, msg QueueMessage) error {
	_, err := s.mutateQueue(ctx, tenant, agent, session, func(items []QueueMessage) ([]QueueMessage, bool, error) {
		for _, item := range items {
			if item.ID == msg.ID {
				return items, false, nil
			}
		}
		return append([]QueueMessage{msg}, items...), true, nil
	})
	return err
}

func (s *Store) UpdateQueued(ctx context.Context, tenant, agent, session, id string, patch QueueMessage) (QueueMessage, error) {
	var updated QueueMessage
	_, err := s.mutateQueue(ctx, tenant, agent, session, func(items []QueueMessage) ([]QueueMessage, bool, error) {
		for i := range items {
			if items[i].ID != id {
				continue
			}
			if strings.TrimSpace(patch.Content) != "" {
				items[i].Content = strings.TrimSpace(patch.Content)
			}
			if patch.Context != nil {
				items[i].Context = patch.Context
			}
			if len(patch.Attachments) > 0 {
				items[i].Attachments = patch.Attachments
			}
			if len(patch.Options) > 0 {
				items[i].Options = patch.Options
			}
			updated = items[i]
			return items, true, nil
		}
		return nil, false, ErrNotFound
	})
	return updated, err
}

func (s *Store) DeleteQueued(ctx context.Context, tenant, agent, session, id string) error {
	_, err := s.mutateQueue(ctx, tenant, agent, session, func(items []QueueMessage) ([]QueueMessage, bool, error) {
		for i := range items {
			if items[i].ID == id {
				return append(items[:i:i], items[i+1:]...), true, nil
			}
		}
		return nil, false, ErrNotFound
	})
	return err
}

// markQueuedInterrupt promotes a queued message so the next dequeue takes it
// before the FIFO head.
func (s *Store) markQueuedInterrupt(ctx context.Context, tenant, agent, session, id string) (QueueMessage, error) {
	var hit QueueMessage
	_, err := s.mutateQueue(ctx, tenant, agent, session, func(items []QueueMessage) ([]QueueMessage, bool, error) {
		for i := range items {
			if items[i].ID == id {
				hit = items[i]
				hit.Interrupt = true
				rest := append(items[:i:i], items[i+1:]...)
				return append([]QueueMessage{hit}, rest...), true, nil
			}
		}
		return nil, false, ErrNotFound
	})
	return hit, err
}

func (s *Store) PendingQueue(ctx context.Context, tenant, agent, session string) ([]QueueMessage, error) {
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return nil, e
	}
	return queueState(s.deps.Gorm.WithContext(ctx), session)
}

// TakeQueued removes and returns the next message to run: interrupt items
// first, then FIFO.
func (s *Store) TakeQueued(ctx context.Context, tenant, agent, session string) (QueueMessage, error) {
	var taken QueueMessage
	_, err := s.mutateQueueGuarded(ctx, tenant, agent, session, true, func(items []QueueMessage) ([]QueueMessage, bool, error) {
		if len(items) == 0 {
			return nil, false, ErrNotFound
		}
		pick := 0
		for i := range items {
			if items[i].Interrupt {
				pick = i
				break
			}
		}
		taken = items[pick]
		return append(items[:pick:pick], items[pick+1:]...), true, nil
	})
	return taken, err
}
