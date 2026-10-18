// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
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
	ToolName          string          `json:"toolName"`
	QualifiedName     *string         `json:"qualifiedName"`
	Args              json.RawMessage `json:"args"`
	Reason            string          `json:"reason"`
	AI                json.RawMessage `json:"ai"`
	TimeoutSeconds    *int            `json:"timeoutSeconds"`
	SpaceID           string          `json:"-"`
	TargetDigest      string          `json:"-"`
	Source            string          `json:"-"`
	ProtocolRequestID string          `json:"-"`
	terminalDecision  string
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
	if _, err := s.GetSession(ctx, tenant, agent, session); err != nil {
		return "", err
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
	var expires *string
	if in.TimeoutSeconds != nil && *in.TimeoutSeconds > 0 {
		v := runtimeTimeString(s.now().Add(time.Duration(*in.TimeoutSeconds) * time.Second))
		expires = &v
	}
	id := s.id()
	err := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if runID != "" {
			var n int64
			if err := tx.Table("cloud_agent_runs AS r").Joins("JOIN cloud_agent_sessions AS s ON s.id=r.session_id").Where("r.id=? AND r.session_id=? AND s.tenant_id=? AND s.agent_id=? AND r.status='running'", runID, session, tenant, agent).Count(&n).Error; err != nil {
				return err
			}
			if n != 1 {
				return ErrConflict
			}
		}
		if err := tx.Table("agent_tool_approvals").Create(map[string]any{"id": id, "tenant_id": tenant, "agent_id": agent, "session_id": session, "run_id": nullString(runID), "tool_call_id": nullString(toolCallID), "tool_name": in.ToolName, "qualified_name": in.QualifiedName, "args_json": validJSON(in.Args, "{}"), "reason": in.Reason, "ai_json": validJSON(in.AI, "{}"), "status": "pending", "always_allow": false, "expires_at": expires, "created_at": runtimeTimeString(s.now()), "space_id": nullString(in.SpaceID), "target_digest": in.TargetDigest, "source": in.Source, "protocol_request_id": in.ProtocolRequestID}).Error; err != nil {
			return err
		}
		_, err := s.appendEventTx(ctx, tx, session, "tool_approval_request", optionalString(runID), map[string]any{"requestId": id, "toolCallId": toolCallID, "toolName": in.ToolName, "qualifiedName": in.QualifiedName, "title": in.ToolName, "argumentsJson": string(in.Args), "reason": in.Reason, "ai": json.RawMessage(in.AI), "expiresAt": expires, "options": []map[string]any{{"optionId": "allow", "name": "允许", "kind": "allow_once"}, {"optionId": "deny", "name": "拒绝", "kind": "reject_once"}}})
		if err != nil {
			return err
		}
		if in.terminalDecision != "" {
			if in.terminalDecision != "approved" && in.terminalDecision != "denied" {
				return errors.New("invalid automatic approval")
			}
			return s.settleApprovalTx(ctx, tx, tenant, agent, session, id, in.terminalDecision, "ai")
		}
		return nil
	})
	return id, err
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
	if err := httpx.AuthorizeResource(r.Context(), h.deps, p, "", agent); err != nil {
		statusErr(w, err)
		return
	}
	if _, err := h.store.GetSession(r.Context(), p.TenantID, agent, session); err != nil {
		statusErr(w, err)
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
	if b.AlwaysAllow {
		httpx.Error(w, 400, "approval applies to this call only")
		return
	}
	by := "user"
	if b.Cancelled {
		b.Decision = "cancelled"
	}
	if b.Decision != "approved" && b.Decision != "denied" && b.Decision != "cancelled" {
		httpx.Error(w, 400, "invalid approval decision")
		return
	}
	if err := h.store.settleApproval(r.Context(), p.TenantID, agent, session, b.RequestID, b.Decision, by, false); err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (s *Store) ExpireInteractions(ctx context.Context) (int64, error) {
	now := s.now()
	a := s.deps.Gorm.WithContext(ctx).Exec(`UPDATE agent_user_questions SET status=CASE WHEN timeout_action='default' THEN 'answered' ELSE 'timeout' END,answer_json=CASE WHEN timeout_action='default' THEN default_option_ids_json ELSE '{}' END,resolved_at=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=?`, runtimeTimeString(now), runtimeTimeString(now))
	if a.Error != nil {
		return 0, a.Error
	}
	var approvals []struct{ ID, TenantID, AgentID, SessionID string }
	if err := s.deps.Gorm.WithContext(ctx).Table("agent_tool_approvals").Select("id,tenant_id,agent_id,session_id").Where("status='pending' AND expires_at IS NOT NULL AND expires_at<=?", runtimeTimeString(now)).Find(&approvals).Error; err != nil {
		return 0, err
	}
	var expired int64
	for _, row := range approvals {
		if err := s.settleApproval(ctx, row.TenantID, row.AgentID, row.SessionID, row.ID, "timeout", "timeout", false); err == nil {
			expired++
		} else if !errors.Is(err, ErrConflict) {
			return expired, err
		}
	}
	return a.RowsAffected + expired, nil
}

var _ = sql.ErrNoRows
