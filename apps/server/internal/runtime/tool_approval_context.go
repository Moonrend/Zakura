// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"unicode/utf8"
)

// Send only the current run's request, not conversation history, memory,
// attachments, provider settings, or credentials. All text remains untrusted.
func (s *Service) toolApprovalReviewContext(ctx context.Context, tenant, agent, session, run, source string, target toolApprovalTargetSnapshot) (map[string]any, error) {
	sess, err := s.store.GetSession(ctx, tenant, agent, session)
	if err != nil {
		return nil, err
	}
	review := map[string]any{"source": source, "target": target.Review}
	if sess.Project != nil {
		review["project"] = *sess.Project
	}
	if run == "" {
		return review, nil
	}
	var rows []struct {
		Payload string `gorm:"column:payload_json"`
	}
	if err := s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events e").Select("e.payload_json").Joins("JOIN cloud_agent_sessions s ON s.id=e.session_id").Where("s.tenant_id=? AND s.agent_id=? AND s.id=? AND e.run_id=? AND e.type='user_message'", tenant, agent, session, run).Order("e.seq DESC").Limit(1).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return review, nil
	}
	var payload struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(rows[0].Payload), &payload); err != nil {
		return nil, err
	}
	const limit = 16 << 10
	if len(payload.Content) > limit {
		payload.Content = payload.Content[:limit]
		for !utf8.ValidString(payload.Content) {
			payload.Content = payload.Content[:len(payload.Content)-1]
		}
		review["requestTruncated"] = true
	}
	review["request"] = payload.Content
	return review, nil
}
