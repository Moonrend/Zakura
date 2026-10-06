// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

type QuestionRequest struct {
	Question         string          `json:"question"`
	Options          json.RawMessage `json:"options"`
	AllowMultiple    bool            `json:"allowMultiple"`
	Secret           bool            `json:"secret"`
	Mode             string          `json:"mode"`
	TimeoutSeconds   *int            `json:"timeoutSeconds"`
	TimeoutAction    string          `json:"timeoutAction"`
	DefaultOptionIDs json.RawMessage `json:"defaultOptionIds"`
	Placeholder      string          `json:"placeholder"`
}
type ApprovalRequest struct {
	ToolName       string          `json:"toolName"`
	QualifiedName  *string         `json:"qualifiedName"`
	Args           json.RawMessage `json:"args"`
	Reason         string          `json:"reason"`
	AI             json.RawMessage `json:"ai"`
	TimeoutSeconds *int            `json:"timeoutSeconds"`
}

func (h *handler) registerInteractions(r chi.Router) {
	r.Post("/agents/{id}/sessions/{sid}/ask-user", h.resolveQuestion)
	r.Post("/agents/{id}/sessions/{sid}/approvals", h.resolveApproval)
}

func (s *Store) CreateQuestion(ctx context.Context, tenant, agent, session, runID, toolCallID string, in QuestionRequest) (string, error) {
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return "", e
	}
	if in.Question == "" {
		return "", errors.New("question required")
	}
	if in.Mode == "" {
		in.Mode = "sync"
	}
	if in.TimeoutAction == "" {
		in.TimeoutAction = "skip"
	}
	if len(in.Options) == 0 {
		in.Options = json.RawMessage(`[]`)
	}
	if len(in.DefaultOptionIDs) == 0 {
		in.DefaultOptionIDs = json.RawMessage(`[]`)
	}
	var expires *time.Time
	if in.TimeoutSeconds != nil {
		t := s.now().Add(time.Duration(*in.TimeoutSeconds) * time.Second)
		expires = &t
	}
	var expiresStr *string
	if expires != nil {
		v := runtimeTimeString(*expires)
		expiresStr = &v
	}
	id := s.id()
	e := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Table("agent_user_questions").Create(map[string]any{"id": id, "tenant_id": tenant, "agent_id": agent, "session_id": session, "run_id": nullString(runID), "tool_call_id": nullString(toolCallID), "question": in.Question, "options_json": validJSON(in.Options, "[]"), "allow_multiple": in.AllowMultiple, "secret": in.Secret, "mode": in.Mode, "timeout_seconds": in.TimeoutSeconds, "timeout_action": in.TimeoutAction, "default_option_ids_json": validJSON(in.DefaultOptionIDs, "[]"), "placeholder": in.Placeholder, "status": "pending", "answer_json": "{}", "expires_at": expiresStr, "resolved_at": nil, "created_at": runtimeTimeString(s.now())}).Error; err != nil {
			return err
		}
		var options any
		_ = json.Unmarshal(in.Options, &options)
		_, err := s.appendEventTx(ctx, tx, session, "ask_user_request", optionalString(runID), map[string]any{"requestId": id, "question": in.Question, "title": in.Question, "options": options, "allowMultiple": in.AllowMultiple, "secret": in.Secret, "mode": in.Mode, "placeholder": in.Placeholder, "expiresAt": expires})
		return err
	})
	return id, e
}
func (s *Store) CreateApproval(ctx context.Context, tenant, agent, session, runID, toolCallID string, in ApprovalRequest) (string, error) {
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return "", e
	}
	if in.ToolName == "" {
		return "", errors.New("toolName required")
	}
	if in.Reason == "" {
		in.Reason = "policy_ask"
	}
	if len(in.Args) == 0 {
		in.Args = json.RawMessage(`{}`)
	}
	if len(in.AI) == 0 {
		in.AI = json.RawMessage(`{}`)
	}
	var expires *time.Time
	if in.TimeoutSeconds != nil {
		t := s.now().Add(time.Duration(*in.TimeoutSeconds) * time.Second)
		expires = &t
	}
	var expiresStr *string
	if expires != nil {
		v := runtimeTimeString(*expires)
		expiresStr = &v
	}
	id := s.id()
	e := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Table("agent_tool_approvals").Create(map[string]any{"id": id, "tenant_id": tenant, "agent_id": agent, "session_id": session, "run_id": nullString(runID), "tool_call_id": nullString(toolCallID), "tool_name": in.ToolName, "qualified_name": in.QualifiedName, "args_json": validJSON(in.Args, "{}"), "reason": in.Reason, "ai_json": validJSON(in.AI, "{}"), "status": "pending", "decided_by": nil, "always_allow": false, "expires_at": expiresStr, "resolved_at": nil, "created_at": runtimeTimeString(s.now())}).Error; err != nil {
			return err
		}
		_, err := s.appendEventTx(ctx, tx, session, "permission_request", optionalString(runID), map[string]any{"requestId": id, "title": in.ToolName, "toolCallId": toolCallID, "options": []map[string]any{{"optionId": "approved", "name": "Allow", "kind": "allow_once"}, {"optionId": "denied", "name": "Deny", "kind": "reject_once"}}})
		return err
	})
	return id, e
}
func nullString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func (h *handler) resolveQuestion(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, session := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	if _, e := h.store.GetSession(r.Context(), p.TenantID, agent, session); e != nil {
		statusErr(w, e)
		return
	}
	var b struct {
		RequestID string  `json:"requestId"`
		Cancelled bool    `json:"cancelled"`
		Selected  any     `json:"selected"`
		Text      *string `json:"text"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.RequestID == "" {
		httpx.Error(w, 400, "requestId required")
		return
	}
	answer, _ := json.Marshal(map[string]any{"cancelled": b.Cancelled, "selected": b.Selected, "text": b.Text})
	status := "answered"
	if b.Cancelled {
		status = "cancelled"
	}
	res := h.deps.Gorm.WithContext(r.Context()).Table("agent_user_questions").Where("id=? AND tenant_id=? AND agent_id=? AND session_id=? AND status='pending' AND (expires_at IS NULL OR expires_at>?)", b.RequestID, p.TenantID, agent, session, runtimeTimeString(h.store.now())).Updates(map[string]any{"status": status, "answer_json": string(answer), "resolved_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	n := res.RowsAffected
	if n == 0 {
		httpx.Error(w, 409, "question is missing, expired, or already resolved")
		return
	}
	_, _ = h.store.AppendEvent(r.Context(), p.TenantID, agent, session, "ask_user_resolved", nil, map[string]any{"requestId": b.RequestID, "status": status, "cancelled": b.Cancelled, "answer": json.RawMessage(answer)})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) resolveApproval(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, session := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	if _, e := h.store.GetSession(r.Context(), p.TenantID, agent, session); e != nil {
		statusErr(w, e)
		return
	}
	var b struct {
		RequestID   string `json:"requestId"`
		Decision    string `json:"decision"`
		AlwaysAllow bool   `json:"alwaysAllow"`
		Cancelled   bool   `json:"cancelled"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.RequestID == "" {
		httpx.Error(w, 400, "requestId required")
		return
	}
	if b.Cancelled {
		b.Decision = "denied"
	}
	if b.Decision != "approved" && b.Decision != "denied" {
		httpx.Error(w, 400, "decision must be approved or denied")
		return
	}
	res := h.deps.Gorm.WithContext(r.Context()).Table("agent_tool_approvals").Where("id=? AND tenant_id=? AND agent_id=? AND session_id=? AND status='pending' AND (expires_at IS NULL OR expires_at>?)", b.RequestID, p.TenantID, agent, session, runtimeTimeString(h.store.now())).Updates(map[string]any{"status": b.Decision, "decided_by": "user", "always_allow": b.AlwaysAllow, "resolved_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	n := res.RowsAffected
	if n == 0 {
		httpx.Error(w, 409, "approval is missing, expired, or already resolved")
		return
	}
	outcome := "selected"
	if b.Decision == "denied" {
		outcome = "cancelled"
	}
	_, _ = h.store.AppendEvent(r.Context(), p.TenantID, agent, session, "permission_resolved", nil, map[string]any{"requestId": b.RequestID, "decision": b.Decision, "outcome": outcome, "alwaysAllow": b.AlwaysAllow})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (s *Store) ExpireInteractions(ctx context.Context) (int64, error) {
	now := s.now()
	a := s.deps.Gorm.WithContext(ctx).Exec(`UPDATE agent_user_questions SET status=CASE WHEN timeout_action='default' THEN 'answered' ELSE 'timeout' END,answer_json=CASE WHEN timeout_action='default' THEN default_option_ids_json ELSE '{}' END,resolved_at=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=?`, runtimeTimeString(now), runtimeTimeString(now))
	if a.Error != nil {
		return 0, a.Error
	}
	b := s.deps.Gorm.WithContext(ctx).Exec(`UPDATE agent_tool_approvals SET status='timeout',decided_by='timeout',resolved_at=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=?`, runtimeTimeString(now), runtimeTimeString(now))
	if b.Error != nil {
		return 0, b.Error
	}
	an, bn := a.RowsAffected, b.RowsAffected
	return an + bn, nil
}

var _ = sql.ErrNoRows
