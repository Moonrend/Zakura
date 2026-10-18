// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"

	"gorm.io/gorm"
)

type approvalRecord struct {
	ID                string  `gorm:"column:id"`
	RunID             *string `gorm:"column:run_id"`
	ToolCallID        *string `gorm:"column:tool_call_id"`
	Status            string  `gorm:"column:status"`
	ExpiresAt         *string `gorm:"column:expires_at"`
	Source            string  `gorm:"column:source"`
	ProtocolRequestID string  `gorm:"column:protocol_request_id"`
}

func (s *Store) getApproval(ctx context.Context, tenant, agent, session, id string) (approvalRecord, error) {
	var row approvalRecord
	err := s.deps.Gorm.WithContext(ctx).Table("agent_tool_approvals").Where("id=? AND tenant_id=? AND agent_id=? AND session_id=?", id, tenant, agent, session).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		err = ErrNotFound
	}
	return row, err
}

func (s *Store) settleApproval(ctx context.Context, tenant, agent, session, id, decision, by string, remember bool) error {
	if remember || (decision != "approved" && decision != "denied" && decision != "cancelled" && decision != "timeout") {
		return errors.New("invalid approval decision")
	}
	return s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return s.settleApprovalTx(ctx, tx, tenant, agent, session, id, decision, by)
	})
}

func (s *Store) settleApprovalTx(ctx context.Context, tx *gorm.DB, tenant, agent, session, id, decision, by string) error {
	var row approvalRecord
	if err := tx.Table("agent_tool_approvals").Where("id=? AND tenant_id=? AND agent_id=? AND session_id=?", id, tenant, agent, session).Take(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrNotFound
		}
		return err
	}
	query := tx.Table("agent_tool_approvals").Where("id=? AND tenant_id=? AND agent_id=? AND session_id=? AND status='pending'", id, tenant, agent, session)
	if by == "user" || by == "ai" {
		query = query.Where("expires_at IS NULL OR expires_at>?", runtimeTimeString(s.now()))
		if row.RunID != nil {
			query = query.Where("EXISTS (SELECT 1 FROM cloud_agent_runs r WHERE r.id=agent_tool_approvals.run_id AND r.session_id=agent_tool_approvals.session_id AND r.status='running' AND r.cancel_requested=FALSE)")
		}
	}
	res := query.Updates(map[string]any{"status": decision, "decided_by": by, "always_allow": false, "resolved_at": runtimeTimeString(s.now())})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected != 1 {
		return ErrConflict
	}
	_, err := s.appendEventTx(ctx, tx, session, "tool_approval_resolved", row.RunID, map[string]any{"requestId": id, "toolCallId": row.ToolCallID, "decision": decision, "decidedBy": by, "alwaysAllow": false})
	return err
}

func (s *Store) cancelApprovalsTx(ctx context.Context, tx *gorm.DB, tenant, agent, session, run string) error {
	query := tx.Table("agent_tool_approvals").Where("tenant_id=? AND agent_id=? AND session_id=? AND status='pending'", tenant, agent, session)
	if run != "" {
		query = query.Where("run_id=?", run)
	}
	var rows []approvalRecord
	if err := query.Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		if err := s.settleApprovalTx(ctx, tx, tenant, agent, session, row.ID, "cancelled", "cancel"); err != nil && !errors.Is(err, ErrConflict) {
			return err
		}
	}
	return nil
}

func (s *Store) cancelApprovals(ctx context.Context, tenant, agent, session, run string) error {
	return s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return s.cancelApprovalsTx(ctx, tx, tenant, agent, session, run)
	})
}

// Access revocation includes idle/runless callbacks, not only active Runs.
func (s *Store) cancelOwnerApprovalsTx(ctx context.Context, tx *gorm.DB, tenant, user string) error {
	query := tx.Table("agent_tool_approvals").Select("DISTINCT agent_id,session_id").Where("tenant_id=? AND status='pending'", tenant)
	if user != "" {
		query = query.Where("session_id IN (SELECT id FROM cloud_agent_sessions WHERE tenant_id=? AND created_by_user_id=?)", tenant, user)
	}
	var sessions []struct {
		AgentID   string `gorm:"column:agent_id"`
		SessionID string `gorm:"column:session_id"`
	}
	if err := query.Find(&sessions).Error; err != nil {
		return err
	}
	for _, session := range sessions {
		if err := s.cancelApprovalsTx(ctx, tx, tenant, session.AgentID, session.SessionID, ""); err != nil {
			return err
		}
	}
	return nil
}
