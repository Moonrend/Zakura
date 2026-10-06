// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
)

type Service struct {
	store           *Store
	gateway         *Gateway
	mu              sync.Mutex
	cancels         map[string]context.CancelFunc
	toolRunner      func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error)
	acpRunner       func(context.Context, string, string, string, string, string) error
	catalogProvider func(context.Context, string, string) (agentCatalog, error)
	loadedTools     func(context.Context, string, string, string) map[string]bool
}

func NewService(store *Store) *Service {
	return &Service{store: store, gateway: NewGateway(store), cancels: map[string]context.CancelFunc{}}
}

func (s *Service) StartTurn(ctx context.Context, tenant, agent, session, content string, attachments, options json.RawMessage, queueOnConflict bool) (Run, *QueueMessage, error) {
	run, err := s.store.StartRun(ctx, tenant, agent, session, content, attachments, options)
	if errors.Is(err, ErrConflict) && queueOnConflict {
		q, qe := s.store.Enqueue(ctx, tenant, agent, session, QueueMessage{Content: content, Attachments: attachments, Options: options})
		return Run{}, &q, qe
	}
	if err != nil {
		return Run{}, nil, err
	}
	bg, cancel := context.WithCancel(s.store.deps.RunContext())
	s.mu.Lock()
	s.cancels[run.ID] = cancel
	s.mu.Unlock()
	go s.execute(bg, tenant, agent, session, run.ID, content)
	return run, nil, nil
}

func (s *Service) execute(ctx context.Context, tenant, agent, session, runID, content string) {
	defer func() {
		s.mu.Lock()
		delete(s.cancels, runID)
		s.mu.Unlock()
		if s.store.deps.RunContext().Err() == nil {
			s.startNext(s.store.deps.RunContext(), tenant, agent, session)
		}
	}()
	sess, err := s.store.GetSession(ctx, tenant, agent, session)
	if err != nil {
		s.fail(ctx, tenant, agent, session, runID, err)
		return
	}
	if sess.Kind == "acp" {
		if s.acpRunner == nil {
			s.fail(context.WithoutCancel(ctx), tenant, agent, session, runID, errors.New("ACP runtime is unavailable"))
			return
		}
		if err := s.acpRunner(ctx, tenant, agent, session, runID, content); err != nil {
			s.fail(context.WithoutCancel(ctx), tenant, agent, session, runID, err)
		}
		return
	}
	model := ""
	if sess.Model != nil {
		model = *sess.Model
	}
	var catalog agentCatalog
	var loaded map[string]bool
	if s.catalogProvider != nil {
		if c, err := s.catalogProvider(ctx, tenant, agent); err == nil {
			catalog = c
		}
		if s.loadedTools != nil {
			loaded = s.loadedTools(ctx, tenant, agent, session)
		}
	}
	messages := []map[string]any{}
	if section := renderServerHints(catalog); section != "" {
		messages = append(messages, map[string]any{"role": "system", "content": section})
	}
	if startSeq, ok := s.runStartSeq(ctx, session, runID); ok {
		if history := s.sessionHistory(ctx, tenant, agent, session, startSeq, sessionHistoryBudget); len(history) > 0 {
			messages = append(messages, history...)
		}
	}
	messages = append(messages, map[string]any{"role": "user", "content": content})
	var raw []byte
	for turn := 0; turn < 8; turn++ {
		payloadMap := map[string]any{"model": model, "stream": false, "messages": messages}
		if tools := declaredTools(catalog, loaded); len(tools) > 0 {
			payloadMap["tools"] = tools
		}
		payload, _ := json.Marshal(payloadMap)
		resp, e := s.gateway.Do(ctx, tenant, "chat", "chat", model, payload)
		if e != nil {
			s.fail(context.WithoutCancel(ctx), tenant, agent, session, runID, e)
			return
		}
		raw, e = io.ReadAll(io.LimitReader(resp.Body, maxProviderResponse+1))
		resp.Body.Close()
		if e != nil || len(raw) > maxProviderResponse {
			if e == nil {
				e = errors.New("provider response too large")
			}
			s.fail(context.WithoutCancel(ctx), tenant, agent, session, runID, e)
			return
		}
		if resp.Status < 200 || resp.Status >= 300 {
			s.fail(context.WithoutCancel(ctx), tenant, agent, session, runID, fmt.Errorf("provider status %d: %s", resp.Status, string(raw)))
			return
		}
		assistant, calls := canonicalAssistant(raw)
		if len(calls) == 0 {
			break
		}
		if s.toolRunner == nil {
			s.fail(context.WithoutCancel(ctx), tenant, agent, session, runID, errors.New("model requested tools but tool runner is unavailable"))
			return
		}
		messages = append(messages, assistant)
		for _, call := range calls {
			argsRaw, _ := json.Marshal(call.Args)
			startedAt := s.store.now()
			_, _ = s.store.AppendEvent(context.WithoutCancel(ctx), tenant, agent, session, "tool_call_start", &runID, map[string]any{"toolCallId": call.ID, "name": call.Name})
			arguments, _ := json.Marshal(call.Args)
			_, _ = s.store.AppendEvent(context.WithoutCancel(ctx), tenant, agent, session, "tool_call_args", &runID, map[string]any{"toolCallId": call.ID, "arguments": string(arguments)})
			result, e := s.toolRunner(ctx, tenant, agent, session, call.ID, call.Name, argsRaw)
			if e != nil {
				duration := s.store.now().Sub(startedAt).Milliseconds()
				_, _ = s.store.AppendEvent(context.WithoutCancel(ctx), tenant, agent, session, "tool_call_result", &runID, map[string]any{"toolCallId": call.ID, "name": call.Name, "resultText": e.Error(), "isError": true, "durationMs": duration})
				s.recordToolUsage(context.WithoutCancel(ctx), sess, tenant, agent, session, call.ID, call.Name, "error", duration)
				messages = append(messages, map[string]any{"role": "tool", "tool_call_id": call.ID, "content": e.Error()})
				continue
			}
			duration := s.store.now().Sub(startedAt).Milliseconds()
			_, _ = s.store.AppendEvent(context.WithoutCancel(ctx), tenant, agent, session, "tool_call_result", &runID, map[string]any{"toolCallId": call.ID, "name": call.Name, "resultText": string(result), "isError": false, "durationMs": duration})
			s.recordToolUsage(context.WithoutCancel(ctx), sess, tenant, agent, session, call.ID, call.Name, "ok", duration)
			messages = append(messages, map[string]any{"role": "tool", "tool_call_id": call.ID, "content": string(result)})
		}
		if s.loadedTools != nil {
			loaded = s.loadedTools(context.WithoutCancel(ctx), tenant, agent, session)
		}
		if turn == 7 {
			s.fail(context.WithoutCancel(ctx), tenant, agent, session, runID, errors.New("tool continuation limit exceeded"))
			return
		}
	}
	text := extractAssistantText(raw)
	_, err = s.store.AppendEvent(context.WithoutCancel(ctx), tenant, agent, session, "assistant_message", &runID, map[string]any{"content": text, "provider": json.RawMessage(raw)})
	if err != nil {
		s.fail(context.WithoutCancel(ctx), tenant, agent, session, runID, err)
		return
	}
	_ = s.store.FinishRun(context.WithoutCancel(ctx), tenant, agent, session, runID, "completed", nil, map[string]any{"runId": runID})
}

const (
	sessionHistoryBudget   = 60000
	sessionHistoryEventCap = 400
)

func (s *Service) runStartSeq(ctx context.Context, session, runID string) (int64, bool) {
	if s.store == nil || s.store.deps == nil || s.store.deps.Gorm == nil {
		return 0, false
	}
	var row struct {
		Seq *int64 `gorm:"column:seq"`
	}
	err := s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").
		Select("MIN(seq) AS seq").
		Where("session_id = ? AND run_id = ?", session, runID).
		Scan(&row).Error
	if err != nil || row.Seq == nil || *row.Seq <= 0 {
		return 0, false
	}
	return *row.Seq, true
}

func (s *Service) sessionHistory(ctx context.Context, tenant, agent, session string, startSeq int64, budget int) []map[string]any {
	if s.store == nil || s.store.deps == nil || s.store.deps.Gorm == nil {
		return nil
	}
	if budget <= 0 {
		budget = sessionHistoryBudget
	}
	var rows []struct {
		Seq         int64  `gorm:"column:seq"`
		Type        string `gorm:"column:type"`
		PayloadJSON string `gorm:"column:payload_json"`
	}
	query := s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").
		Select("seq,type,payload_json").
		Where("session_id = ?", session)
	if startSeq > 0 {
		query = query.Where("seq < ?", startSeq)
	}
	if err := query.Order("seq DESC").Limit(sessionHistoryEventCap).Find(&rows).Error; err != nil {
		return nil
	}
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	type historyEntry struct {
		seq int64
		msg map[string]any
	}
	entries := make([]historyEntry, 0, len(rows))
	questions := map[string]string{}
	for _, row := range rows {
		var payload map[string]any
		if json.Unmarshal([]byte(row.PayloadJSON), &payload) != nil {
			continue
		}
		switch row.Type {
		case "user_message":
			if content, _ := payload["content"].(string); content != "" {
				entries = append(entries, historyEntry{seq: row.Seq, msg: map[string]any{"role": "user", "content": content}})
			}
		case "assistant_message":
			if content, _ := payload["content"].(string); strings.TrimSpace(content) != "" {
				entries = append(entries, historyEntry{seq: row.Seq, msg: map[string]any{"role": "assistant", "content": content}})
			}
		case "ask_user_request":
			if requestID, _ := payload["requestId"].(string); requestID != "" {
				questions[requestID] = fmt.Sprint(payload["question"])
			}
		case "ask_user_resolved":
			requestID, _ := payload["requestId"].(string)
			status, _ := payload["status"].(string)
			if requestID == "" || status != "answered" {
				continue
			}
			question, ok := questions[requestID]
			if !ok {
				continue
			}
			id := "au_" + requestID
			if len(id) > 15 {
				id = id[:15]
			}
			arguments, _ := json.Marshal(map[string]any{"question": question})
			entries = append(entries,
				historyEntry{seq: row.Seq, msg: map[string]any{
					"role":    "assistant",
					"content": "",
					"tool_calls": []any{map[string]any{
						"id":   id,
						"type": "function",
						"function": map[string]any{
							"name":      "ask_user",
							"arguments": string(arguments),
						},
					}},
				}},
				historyEntry{seq: row.Seq, msg: map[string]any{"role": "tool", "tool_call_id": id, "content": askAnswerText(payload["answer"])}},
			)
		case "session.compacted":
			through := int64(0)
			if value, ok := payload["throughSeq"].(float64); ok {
				through = int64(value)
			}
			kept := entries[:0]
			for _, entry := range entries {
				if entry.seq > through {
					kept = append(kept, entry)
				}
			}
			entries = kept
			content := "[Earlier conversation summary]"
			if summary := compactSummaryText(payload["summary"]); summary != "" {
				content += "\n" + summary
			}
			entries = append(entries, historyEntry{seq: row.Seq, msg: map[string]any{"role": "user", "content": content}})
		}
	}
	total := 0
	start := len(entries)
	for i := len(entries) - 1; i >= 0; i-- {
		size := historyMessageSize(entries[i].msg)
		if total+size > budget && start != len(entries) {
			break
		}
		total += size
		start = i
	}
	window := entries[start:]
	haveCall := map[string]bool{}
	out := make([]map[string]any, 0, len(window))
	for _, entry := range window {
		switch entry.msg["role"] {
		case "assistant":
			if calls, ok := entry.msg["tool_calls"].([]any); ok {
				for _, call := range calls {
					if cm, ok := call.(map[string]any); ok {
						haveCall[fmt.Sprint(cm["id"])] = true
					}
				}
			}
			out = append(out, entry.msg)
		case "tool":
			if haveCall[fmt.Sprint(entry.msg["tool_call_id"])] {
				out = append(out, entry.msg)
			}
		default:
			out = append(out, entry.msg)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func historyMessageSize(msg map[string]any) int {
	size := 0
	if content, ok := msg["content"].(string); ok {
		size += len(content)
	}
	if calls, ok := msg["tool_calls"].([]any); ok {
		for _, call := range calls {
			cm, _ := call.(map[string]any)
			size += 16
			if fn, ok := cm["function"].(map[string]any); ok {
				if name, ok := fn["name"].(string); ok {
					size += len(name)
				}
				if arguments, ok := fn["arguments"].(string); ok {
					size += len(arguments)
				}
			}
		}
	}
	return size
}

func askAnswerText(answer any) string {
	m, _ := answer.(map[string]any)
	if m == nil {
		return "User answered."
	}
	if cancelled, _ := m["cancelled"].(bool); cancelled {
		return "User dismissed the question."
	}
	text, _ := m["text"].(string)
	selected := m["selected"]
	switch {
	case strings.TrimSpace(text) != "" && selected != nil:
		return "User answered: " + text + "; selected: " + joinAnswerValues(selected)
	case strings.TrimSpace(text) != "":
		return "User answered: " + text
	case selected != nil:
		return "User selected: " + joinAnswerValues(selected)
	}
	return "User answered."
}

func compactSummaryText(summary any) string {
	switch value := summary.(type) {
	case string:
		return value
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			m, _ := item.(map[string]any)
			if content, _ := m["content"].(string); strings.TrimSpace(content) != "" {
				parts = append(parts, content)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func (s *Service) recordToolUsage(ctx context.Context, sess Session, tenant, agent, session, callID, name, status string, duration int64) {
	if s.store.deps.RecordUsage == nil || sess.CreatedByUserID == nil || *sess.CreatedByUserID == "" {
		return
	}
	_ = s.store.deps.RecordUsage(ctx, appdeps.UsageRecord{TenantID: tenant, UserID: *sess.CreatedByUserID, ActorKind: "user", Category: "tool", Action: "tool_called", Status: status, DurationMS: duration, AgentID: agent, SessionID: session, ResourceKind: "tool_call", ResourceID: callID, Summary: name})
}

type toolCall struct {
	ID, Name string
	Args     any
}

func canonicalAssistant(raw []byte) (map[string]any, []toolCall) {
	var open struct {
		Choices []struct {
			Message map[string]any `json:"message"`
		}
	}
	if json.Unmarshal(raw, &open) == nil && len(open.Choices) > 0 {
		m := open.Choices[0].Message
		calls := []toolCall{}
		if list, ok := m["tool_calls"].([]any); ok {
			for _, item := range list {
				x, _ := item.(map[string]any)
				f, _ := x["function"].(map[string]any)
				args := any(map[string]any{})
				if s, ok := f["arguments"].(string); ok {
					_ = json.Unmarshal([]byte(s), &args)
				}
				calls = append(calls, toolCall{ID: fmt.Sprint(x["id"]), Name: fmt.Sprint(f["name"]), Args: args})
			}
		}
		return m, calls
	}
	var ant struct {
		Content []map[string]any `json:"content"`
	}
	if json.Unmarshal(raw, &ant) == nil {
		calls := []toolCall{}
		toolMaps := []any{}
		text := ""
		for _, x := range ant.Content {
			if x["type"] == "text" {
				text += fmt.Sprint(x["text"])
			} else if x["type"] == "tool_use" {
				id, name := fmt.Sprint(x["id"]), fmt.Sprint(x["name"])
				calls = append(calls, toolCall{ID: id, Name: name, Args: x["input"]})
				arg, _ := json.Marshal(x["input"])
				toolMaps = append(toolMaps, map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": string(arg)}})
			}
		}
		m := map[string]any{"role": "assistant", "content": text}
		if len(toolMaps) > 0 {
			m["tool_calls"] = toolMaps
		}
		return m, calls
	}
	return map[string]any{"role": "assistant", "content": string(raw)}, nil
}
func (s *Service) fail(ctx context.Context, tenant, agent, session, runID string, err error) {
	m := err.Error()
	_ = s.store.FinishRun(ctx, tenant, agent, session, runID, "failed", &m, map[string]any{"runId": runID, "error": m})
}
func (s *Service) startNext(ctx context.Context, tenant, agent, session string) {
	m, e := s.store.TakeQueued(ctx, tenant, agent, session)
	if e != nil {
		return
	}
	_, _, e = s.StartTurn(ctx, tenant, agent, session, m.Content, m.Attachments, m.Options, false)
	if e != nil {
		_, _ = s.store.Enqueue(ctx, tenant, agent, session, m)
	}
}
func (s *Service) Cancel(ctx context.Context, tenant, agent, session string) (Run, error) {
	sess, e := s.store.GetSession(ctx, tenant, agent, session)
	if e != nil {
		return Run{}, e
	}
	if sess.ActiveRunID != nil {
		s.mu.Lock()
		cancel := s.cancels[*sess.ActiveRunID]
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	}
	return s.store.CancelRun(ctx, tenant, agent, session)
}

func (s *Service) cancelRunIDs(ids []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		if cancel := s.cancels[id]; cancel != nil {
			cancel()
		}
	}
}

func extractAssistantText(raw []byte) string {
	var v struct {
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
			Delta struct {
				Content string `json:"content"`
			} `json:"delta"`
		} `json:"choices"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		OutputText string `json:"output_text"`
		Output     []struct {
			Content []struct {
				Text       string `json:"text"`
				OutputText string `json:"output_text"`
			} `json:"content"`
		} `json:"output"`
	}
	if json.Unmarshal(raw, &v) != nil {
		return string(raw)
	}
	if v.OutputText != "" {
		return v.OutputText
	}
	for _, o := range v.Output {
		for _, c := range o.Content {
			if c.Text != "" {
				return c.Text
			}
			if c.OutputText != "" {
				return c.OutputText
			}
		}
	}
	if len(v.Choices) > 0 {
		switch c := v.Choices[0].Message.Content.(type) {
		case string:
			return c
		case []any:
			b, _ := json.Marshal(c)
			return string(b)
		}
		if v.Choices[0].Delta.Content != "" {
			return v.Choices[0].Delta.Content
		}
	}
	if len(v.Content) > 0 {
		return v.Content[0].Text
	}
	return string(raw)
}

func declaredTools(catalog agentCatalog, loaded map[string]bool) []map[string]any {
	out := []map[string]any{}
	for _, tool := range catalog.Tools {
		switch tool.Exposure {
		case "direct":
		case "deferred":
			if loaded == nil || !loaded[tool.Name] {
				continue
			}
		default:
			continue
		}
		schema := tool.InputSchema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        tool.Name,
				"description": tool.Description,
				"parameters":  schema,
			},
		})
	}
	return out
}

func renderServerHints(catalog agentCatalog) string {
	type hintServer struct {
		ref         string
		name        string
		description string
	}
	seen := map[string]bool{}
	servers := []hintServer{}
	for _, tool := range catalog.Tools {
		if tool.Kind != "mcp" || tool.Exposure != "deferred" {
			continue
		}
		key := tool.ServerRef + "\x00" + tool.InstanceID
		if seen[key] {
			continue
		}
		seen[key] = true
		description := tool.ServerDescription
		if description == "" {
			description = tool.ServerName
		}
		servers = append(servers, hintServer{ref: tool.ServerRef, name: tool.ServerName, description: description})
	}
	if len(servers) == 0 {
		return ""
	}
	sort.SliceStable(servers, func(i, j int) bool { return servers[i].name < servers[j].name })
	lines := []string{"Tools of the following MCP servers are not listed upfront. Use the tool_search tool with a short query to find and load the tools you need; loaded tools become available on your next turn."}
	for _, server := range servers {
		slug := slugify(server.ref)
		if slug == "" {
			slug = slugify(server.name)
		}
		lines = append(lines, "- mcp__"+slug+": "+server.description)
	}
	const maxHintChars = 2000
	for len(lines) > 1 && len(strings.Join(lines, "\n")) > maxHintChars {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}
