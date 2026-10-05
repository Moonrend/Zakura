// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
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
	id := s.id()
	e := appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO agent_user_questions(id,tenant_id,agent_id,session_id,run_id,tool_call_id,question,options_json,allow_multiple,secret,mode,timeout_seconds,timeout_action,default_option_ids_json,placeholder,status,answer_json,expires_at,resolved_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','{}',?,NULL,?)`), id, tenant, agent, session, nullString(runID), nullString(toolCallID), in.Question, validJSON(in.Options, "[]"), in.AllowMultiple, in.Secret, in.Mode, in.TimeoutSeconds, in.TimeoutAction, validJSON(in.DefaultOptionIDs, "[]"), in.Placeholder, expires, s.now()); err != nil {
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
	id := s.id()
	e := appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO agent_tool_approvals(id,tenant_id,agent_id,session_id,run_id,tool_call_id,tool_name,qualified_name,args_json,reason,ai_json,status,decided_by,always_allow,expires_at,resolved_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,false,?,NULL,?)`), id, tenant, agent, session, nullString(runID), nullString(toolCallID), in.ToolName, in.QualifiedName, validJSON(in.Args, "{}"), in.Reason, validJSON(in.AI, "{}"), expires, s.now()); err != nil {
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
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE agent_user_questions SET status=?,answer_json=?,resolved_at=? WHERE id=? AND tenant_id=? AND agent_id=? AND session_id=? AND status='pending' AND (expires_at IS NULL OR expires_at>?)`), status, string(answer), h.store.now(), b.RequestID, p.TenantID, agent, session, h.store.now())
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
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
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE agent_tool_approvals SET status=?,decided_by='user',always_allow=?,resolved_at=? WHERE id=? AND tenant_id=? AND agent_id=? AND session_id=? AND status='pending' AND (expires_at IS NULL OR expires_at>?)`), b.Decision, b.AlwaysAllow, h.store.now(), b.RequestID, p.TenantID, agent, session, h.store.now())
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
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
	a, e := s.deps.DB.ExecContext(ctx, s.q(`UPDATE agent_user_questions SET status=CASE WHEN timeout_action='default' THEN 'answered' ELSE 'timeout' END,answer_json=CASE WHEN timeout_action='default' THEN default_option_ids_json ELSE '{}' END,resolved_at=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=?`), now, now)
	if e != nil {
		return 0, e
	}
	b, e := s.deps.DB.ExecContext(ctx, s.q(`UPDATE agent_tool_approvals SET status='timeout',decided_by='timeout',resolved_at=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=?`), now, now)
	if e != nil {
		return 0, e
	}
	an, _ := a.RowsAffected()
	bn, _ := b.RowsAffected()
	return an + bn, nil
}

var _ = sql.ErrNoRows
