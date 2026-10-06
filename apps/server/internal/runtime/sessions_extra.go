// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func (h *handler) compactSession(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, sid := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	events, e := h.store.ListEvents(r.Context(), p.TenantID, agent, sid, 0, 1000)
	if e != nil {
		statusErr(w, e)
		return
	}
	keep := 50
	if raw := r.URL.Query().Get("keep"); raw != "" {
		if n, _ := strconv.Atoi(raw); n >= 10 && n <= 200 {
			keep = n
		}
	}
	if len(events) <= keep {
		httpx.JSON(w, 200, map[string]any{"compacted": false, "eventCount": len(events)})
		return
	}
	older := events[:len(events)-keep]
	summary := make([]map[string]any, 0)
	for _, ev := range older {
		if ev.Type != "user_message" && ev.Type != "assistant_message" && ev.Type != "message.created" {
			continue
		}
		var x map[string]any
		if json.Unmarshal(ev.Payload, &x) == nil {
			summary = append(summary, map[string]any{"role": x["role"], "content": x["content"]})
		}
	}
	ev, e := h.store.AppendEvent(r.Context(), p.TenantID, agent, sid, "session.compacted", nil, map[string]any{"throughSeq": older[len(older)-1].Seq, "summary": summary})
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"compacted": true, "event": ev, "summarized": len(older)})
}
func (h *handler) forkSession(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, sid := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	source, e := h.store.GetSession(r.Context(), p.TenantID, agent, sid)
	if e != nil {
		statusErr(w, e)
		return
	}
	var b struct {
		Title string `json:"title"`
		AtSeq int64  `json:"atSeq"`
	}
	_ = httpx.DecodeJSON(r, &b)
	if b.Title == "" {
		b.Title = source.Title + " (fork)"
	}
	origin, _ := json.Marshal(map[string]any{"channel": "fork", "parentSessionId": sid, "atSeq": b.AtSeq})
	userID := p.UserID
	if p.APIKey {
		userID = ""
	}
	fork, e := h.store.CreateSession(r.Context(), p.TenantID, userID, agent, Session{Title: b.Title, Kind: source.Kind, Project: source.Project, Origin: origin, Model: source.Model, ModelRouteID: source.ModelRouteID, Reasoning: source.Reasoning})
	if e != nil {
		statusErr(w, e)
		return
	}
	events, e := h.store.ListEvents(r.Context(), p.TenantID, agent, sid, 0, 1000)
	if e != nil {
		statusErr(w, e)
		return
	}
	copied := 0
	for _, ev := range events {
		if b.AtSeq > 0 && ev.Seq > b.AtSeq {
			break
		}
		if ev.Type != "user_message" && ev.Type != "assistant_message" && ev.Type != "message.created" && ev.Type != "session.compacted" {
			continue
		}
		var payload any
		if json.Unmarshal(ev.Payload, &payload) != nil {
			continue
		}
		if _, e = h.store.AppendEvent(r.Context(), p.TenantID, agent, fork.ID, ev.Type, nil, payload); e != nil {
			statusErr(w, e)
			return
		}
		copied++
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"sessionId": fork.ID, "title": fork.Title, "sourceSessionId": sid, "copiedEvents": copied, "mode": "copy", "session": fork})
}
func (h *handler) sessionTools(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, sid := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	if _, e := h.store.GetSession(r.Context(), p.TenantID, agent, sid); e != nil {
		statusErr(w, e)
		return
	}
	rawIDs := strings.Split(r.URL.Query().Get("ids"), ",")
	ids := make([]string, 0, len(rawIDs))
	seen := map[string]bool{}
	for _, raw := range rawIDs {
		id := strings.TrimSpace(raw)
		if id != "" && !seen[id] && len(ids) < 40 {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]any{"tools": []any{}})
		return
	}
	var events []struct {
		Type        string `gorm:"column:type"`
		PayloadJSON string `gorm:"column:payload_json"`
		CreatedAt   string `gorm:"column:created_at"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("cloud_agent_events").Select("type,payload_json,created_at").Where("session_id=? AND type IN ('tool.started','tool.completed','tool.failed','tool_call_start','tool_call_args','tool_call_result')", sid).Order("seq").Find(&events).Error; e != nil {
		statusErr(w, e)
		return
	}
	type detail struct {
		ToolCallID    string `json:"toolCallId"`
		Name          string `json:"name,omitempty"`
		Arguments     string `json:"arguments,omitempty"`
		ResultText    string `json:"resultText,omitempty"`
		IsError       bool   `json:"isError,omitempty"`
		DurationMS    int64  `json:"durationMs,omitempty"`
		ChildSession  string `json:"childSessionId,omitempty"`
		ChildAgent    string `json:"childAgentId,omitempty"`
		startedMillis int64
	}
	details := map[string]*detail{}
	for _, row := range events {
		eventType, payloadRaw, created := row.Type, row.PayloadJSON, parseTime(row.CreatedAt)
		var payload map[string]any
		if json.Unmarshal([]byte(payloadRaw), &payload) != nil {
			continue
		}
		id, _ := payload["toolCallId"].(string)
		if !seen[id] {
			continue
		}
		item := details[id]
		if item == nil {
			item = &detail{ToolCallID: id}
			details[id] = item
		}
		switch eventType {
		case "tool.started", "tool_call_start":
			item.Name, _ = payload["name"].(string)
			if arguments, ok := payload["arguments"].(string); ok {
				item.Arguments = arguments
			} else if arguments, ok := payload["arguments"]; ok {
				encoded, _ := json.Marshal(arguments)
				item.Arguments = string(encoded)
			}
			item.startedMillis = created.UnixMilli()
		case "tool_call_args":
			item.Arguments, _ = payload["arguments"].(string)
		case "tool.completed", "tool_call_result":
			if isError, _ := payload["isError"].(bool); isError {
				item.IsError = true
			}
			if resultText, ok := payload["resultText"].(string); ok {
				item.ResultText = resultText
			}
			if result, ok := payload["result"].(string); ok {
				item.ResultText = result
			} else if result, ok := payload["result"]; ok {
				encoded, _ := json.Marshal(result)
				item.ResultText = string(encoded)
			}
			if item.startedMillis > 0 {
				item.DurationMS = created.UnixMilli() - item.startedMillis
			}
		case "tool.failed":
			item.IsError = true
			item.ResultText = fmt.Sprint(payload["error"])
			if item.startedMillis > 0 {
				item.DurationMS = created.UnixMilli() - item.startedMillis
			}
		}
		if child, ok := payload["childSessionId"].(string); ok {
			item.ChildSession = child
		}
		if child, ok := payload["childAgentId"].(string); ok {
			item.ChildAgent = child
		}
	}
	tools := make([]detail, 0, len(ids))
	for _, id := range ids {
		if item := details[id]; item != nil {
			tools = append(tools, *item)
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"tools": tools})
}
