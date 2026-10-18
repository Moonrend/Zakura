// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestToolApprovalTerminalLifecycleRejectsLateDecisions(t *testing.T) {
	for _, action := range []string{"finish", "cancel", "restart", "delete"} {
		t.Run(action, func(t *testing.T) {
			s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
			ctx := context.Background()
			ids := []string{}
			for _, runID := range []string{run.ID, ""} {
				id, err := s.store.CreateApproval(ctx, "tenant", a.ID, session.ID, runID, "call", ApprovalRequest{ToolName: "fs_read"})
				if err != nil {
					t.Fatal(err)
				}
				ids = append(ids, id)
			}
			var err error
			switch action {
			case "finish":
				err = s.store.FinishRun(ctx, "tenant", a.ID, session.ID, run.ID, "completed", nil, nil)
			case "cancel":
				_, err = s.store.CancelRun(ctx, "tenant", a.ID, session.ID)
			case "restart":
				_, err = s.store.RecoverRuns(ctx)
			case "delete":
				err = s.store.DeleteSession(ctx, "tenant", a.ID, session.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if action == "delete" {
				var pending int64
				if err = s.store.deps.Gorm.Table("agent_tool_approvals").Where("session_id=? AND status='pending'", session.ID).Count(&pending).Error; err != nil || pending != 0 {
					t.Fatalf("orphan pending=%d err=%v", pending, err)
				}
				return
			}
			for index, id := range ids {
				row, err := s.store.getApproval(ctx, "tenant", a.ID, session.ID, id)
				if err != nil {
					t.Fatal(err)
				}
				if index == 1 && (action == "finish" || action == "cancel") {
					if row.Status != "pending" {
						t.Fatal("run cancellation touched unrelated runless callback")
					}
					continue
				}
				if row.Status != "cancelled" {
					t.Fatalf("%s approval %s", action, row.Status)
				}
				if err = s.store.settleApproval(ctx, "tenant", a.ID, session.ID, id, "approved", "user", false); !errors.Is(err, ErrConflict) {
					t.Fatalf("late approval accepted: %v", err)
				}
			}
			events, err := s.store.ListEvents(ctx, "tenant", a.ID, session.ID, 0, 100)
			if err != nil {
				t.Fatal(err)
			}
			resolved := 0
			for _, event := range events {
				if event.Type == "tool_approval_resolved" {
					resolved++
				}
			}
			want := 1
			if action == "restart" {
				want = 2
			}
			if resolved != want {
				t.Fatalf("resolved events=%d want %d", resolved, want)
			}
		})
	}
}

func TestToolApprovalAIAuditHasNoPendingWindow(t *testing.T) {
	s, a, session, run := approvalFixture(t, map[string]any{"policy": "ai"})
	ctx := context.Background()
	if err := s.recordAIApproval(ctx, "tenant", a.ID, session.ID, run.ID, "call", "fs_read", json.RawMessage(`{}`), a.SpaceID, "target", "standard", "", json.RawMessage(`{"decision":"allow","confidence":1}`), "approved"); err != nil {
		t.Fatal(err)
	}
	var rows []approvalRecord
	if err := s.store.deps.Gorm.Table("agent_tool_approvals").Where("session_id=?", session.ID).Find(&rows).Error; err != nil || len(rows) != 1 || rows[0].Status != "approved" {
		t.Fatalf("audit=%+v err=%v", rows, err)
	}
	events, err := s.store.ListEvents(ctx, "tenant", a.ID, session.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	requests, resolved := 0, 0
	for _, event := range events {
		if event.Type == "tool_approval_request" {
			requests++
		}
		if event.Type == "tool_approval_resolved" {
			resolved++
		}
	}
	if requests != 1 || resolved != 1 {
		t.Fatalf("request/resolved=%d/%d", requests, resolved)
	}
	if _, err = s.store.CancelRun(ctx, "tenant", a.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.recordAIApproval(ctx, "tenant", a.ID, session.ID, run.ID, "late", "fs_read", json.RawMessage(`{}`), a.SpaceID, "target", "standard", "", nil, "approved"); err == nil {
		t.Fatal("AI audit accepted cancelled Run")
	}
	var count int64
	if err = s.store.deps.Gorm.Table("agent_tool_approvals").Where("session_id=?", session.ID).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("cancelled AI audit leaked pending row: %d %v", count, err)
	}
}

func TestToolApprovalCancellationFlagAndExpiryWin(t *testing.T) {
	for _, scenario := range []string{"cancel-flag", "expiry"} {
		t.Run(scenario, func(t *testing.T) {
			s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
			id, err := s.store.CreateApproval(context.Background(), "tenant", a.ID, session.ID, run.ID, "call", ApprovalRequest{ToolName: "fs_read"})
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "cancel-flag" {
				err = s.store.deps.Gorm.Table("cloud_agent_runs").Where("id=?", run.ID).Update("cancel_requested", true).Error
			} else {
				err = s.store.deps.Gorm.Table("agent_tool_approvals").Where("id=?", id).Update("expires_at", runtimeTimeString(time.Now().Add(-time.Second))).Error
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = s.store.settleApproval(context.Background(), "tenant", a.ID, session.ID, id, "approved", "user", false); !errors.Is(err, ErrConflict) {
				t.Fatalf("late decision=%v", err)
			}
		})
	}
}
