// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"gorm.io/gorm"
)

func readHistoryRows(query *gorm.DB) ([]histEvent, error) {
	var rows []struct {
		ID          string  `gorm:"column:id"`
		Seq         int64   `gorm:"column:seq"`
		Type        string  `gorm:"column:type"`
		RunID       *string `gorm:"column:run_id"`
		PayloadJSON string  `gorm:"column:payload_json"`
	}
	if err := query.Select("id,seq,type,run_id,payload_json").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]histEvent, 0, len(rows))
	for _, row := range rows {
		var payload map[string]any
		if err := json.Unmarshal([]byte(row.PayloadJSON), &payload); err != nil {
			return nil, fmt.Errorf("decode history event %s: %w", row.ID, err)
		}
		ev := histEvent{ID: row.ID, Seq: row.Seq, Type: row.Type, Payload: payload}
		if row.RunID != nil {
			ev.RunID = *row.RunID
		}
		out = append(out, ev)
	}
	return out, nil
}

// Read topology first, without stream chunks, tool outputs, images or request
// templates. Legacy unlinked messages still need chronological topology.
func (s *Service) historyTopology(ctx context.Context, session string, through int64) ([]histEvent, error) {
	return readHistoryRows(s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").Where("seq<=?", through).
		Where("session_id=? AND (type IN ? OR (type='assistant_message' AND run_id IS NULL))", session,
			[]string{"user_message", "message.created", "run_start", "run_end", "run_error", "ask_user_request", "ask_user_resolved", "session.compacted"}).Order("seq ASC"))
}

// Only load the selected branch's working context. A checkpoint replaces all
// covered payloads; projections replace the preceding stream/tool event payloads.
func (s *Service) loadContextHistory(ctx context.Context, session, target, parentRun string, through int64) ([]histEvent, error) {
	events, err := s.historyTopology(ctx, session, through)
	if err != nil {
		return nil, err
	}
	if parentRun != "" {
		events = append(events, histEvent{Seq: through + 1, Type: "user_message", Payload: map[string]any{"messageId": target, "parentRunId": parentRun, "content": ""}})
	}
	chain, _, _ := historyChain(events, target)
	if len(chain) == 0 {
		return nil, ErrNotFound
	}
	var checkpoint *contextCheckpoint
	before := through + 1
	for {
		rows, err := readHistoryRows(s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").Where("session_id=? AND type='context.checkpoint' AND seq<?", session, before).Order("seq DESC").Limit(1))
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			break
		}
		before = rows[0].Seq
		if checkpoint = chainCheckpoint(chain, rows); checkpoint != nil {
			events = append(events, rows[0])
			break
		}
	}
	covered := int64(0)
	if checkpoint != nil {
		covered = checkpoint.ThroughSeq
	}
	runs := []string{}
	descendants := []string{}
	pastAnchor := false
	for _, node := range chain {
		if node.isRun && !node.failed {
			id := strings.TrimPrefix(node.key, "r:")
			if pastAnchor {
				descendants = append(descendants, id)
			} else {
				runs = append(runs, id)
			}
		}
		if checkpoint != nil && node.key == "r:"+checkpoint.AnchorRunID {
			pastAnchor = true
		}
	}
	known := map[int64]bool{}
	for _, ev := range events {
		known[ev.Seq] = true
	}
	// Descendant runs were never read by this checkpoint, even when their events
	// predate a later manual compaction of an ancestor.
	groups := []struct {
		runs    []string
		covered int64
	}{{runs, covered}, {descendants, 0}}
	for _, group := range groups {
		runs, covered := group.runs, group.covered
		// Bound SQL parameter counts for very long, as-yet uncompacted sessions.
		for start := 0; start < len(runs); start += 200 {
			ids := runs[start:min(start+200, len(runs))]
			query := s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").
				Where("session_id=? AND run_id IN ? AND seq>? AND seq<=? AND type IN ?", session, ids, covered, through, historyEventTypes).
				Where("type <> 'context.template' AND type <> 'context.checkpoint'").
				Where("(type='context.messages' OR seq > COALESCE((SELECT MAX(p.seq) FROM cloud_agent_events p WHERE p.session_id=? AND p.run_id=cloud_agent_events.run_id AND p.type='context.messages' AND p.seq<=?), 0))", session, through)
			rows, err := readHistoryRows(query.Order("seq ASC"))
			if err != nil {
				return nil, err
			}
			for _, ev := range rows {
				if !known[ev.Seq] {
					events = append(events, ev)
					known[ev.Seq] = true
				}
			}
		}
	}
	sort.Slice(events, func(i, j int) bool { return events[i].Seq < events[j].Seq })
	return events, nil
}
