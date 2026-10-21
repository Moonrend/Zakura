// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

const (
	sessionHistoryBudget   = 80000
	sessionHistoryEventCap = 6000
	historyToolResultChars = 6000
)

// chatMessage is the provider-neutral message the loop keeps; it is rendered
// to the wire format just before each model call.
type chatMessage struct {
	Role          string
	Content       string
	ToolCalls     []modelToolCall
	ToolCallID    string
	UserMessageID string `json:",omitempty"`
	Images        []string
}

func (m chatMessage) size() int {
	n := len(m.Content)
	for _, c := range m.ToolCalls {
		n += 16 + len(c.Name) + len(c.Arguments)
	}
	return n
}

type histEvent struct {
	ID      string
	Seq     int64
	Type    string
	RunID   string
	Payload map[string]any
}

var historyEventTypes = []string{
	"user_message", "message.created", "run_start", "run_end", "run_error",
	"assistant_delta", "assistant_message", "assistant_rollback",
	"tool_call_start", "tool_call_args", "tool_call_result",
	"ask_user_request", "ask_user_resolved", "session.compacted",
}

func (s *Service) loadHistoryEvents(ctx context.Context, session string) []histEvent {
	if s.store == nil || s.store.deps == nil || s.store.deps.Gorm == nil {
		return nil
	}
	var rows []struct {
		ID          string  `gorm:"column:id"`
		Seq         int64   `gorm:"column:seq"`
		Type        string  `gorm:"column:type"`
		RunID       *string `gorm:"column:run_id"`
		PayloadJSON string  `gorm:"column:payload_json"`
	}
	err := s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").
		Select("id,seq,type,run_id,payload_json").
		Where("session_id = ? AND type IN ?", session, historyEventTypes).
		Order("seq DESC").Limit(sessionHistoryEventCap).Find(&rows).Error
	if err != nil {
		return nil
	}
	out := make([]histEvent, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		row := rows[i]
		var payload map[string]any
		if json.Unmarshal([]byte(row.PayloadJSON), &payload) != nil || payload == nil {
			continue
		}
		ev := histEvent{ID: row.ID, Seq: row.Seq, Type: row.Type, Payload: payload}
		if row.RunID != nil {
			ev.RunID = *row.RunID
		}
		out = append(out, ev)
	}
	return out
}

type histNode struct {
	key         string
	parent      string
	seq         int64
	isRun       bool
	content     string
	attachments []chatAttachment
	events      []histEvent
	failed      bool
}

type askQuestion struct {
	question   string
	toolCallID string
	mode       string
	runID      string
}

// buildChainMessages rebuilds the model context for targetMessageID by walking
// the conversation tree from that user message back to the root: user
// messages point at the run they follow (parentRunId), runs point at the
// message they answer (replyToMessageId). Older events without those links are
// chained linearly, so regenerated variants and abandoned edit branches stay
// out of the context while legacy sessions read as before. Failed runs and
// rolled-back stream output are dropped; orphan tool calls are patched.
func buildChainMessages(events []histEvent, targetMessageID string, budget int) []chatMessage {
	if budget <= 0 {
		budget = sessionHistoryBudget
	}
	nodes := map[string]*histNode{}
	lastNode, lastUser := "", ""
	ensureRun := func(rid string, seq int64) *histNode {
		key := "r:" + rid
		n := nodes[key]
		if n == nil {
			n = &histNode{key: key, parent: lastUser, seq: seq, isRun: true}
			nodes[key] = n
		}
		return n
	}
	resultIDs := map[string]bool{}
	for _, ev := range events {
		if ev.Type == "tool_call_result" {
			if id, _ := ev.Payload["toolCallId"].(string); id != "" {
				resultIDs[id] = true
			}
		}
	}
	questions := map[string]askQuestion{}
	var compactSeq, compactThrough int64
	compactSummary := ""
	compactions := []histEvent{}
	for _, ev := range events {
		p := ev.Payload
		typ := ev.Type
		if typ == "message.created" {
			switch p["role"] {
			case "user":
				typ = "user_message"
			case "assistant":
				typ = "assistant_message"
			default:
				continue
			}
		}
		switch typ {
		case "user_message":
			if steer, _ := p["steer"].(bool); steer && ev.RunID != "" {
				n := ensureRun(ev.RunID, ev.Seq)
				n.events = append(n.events, histEvent{ID: ev.ID, Seq: ev.Seq, Type: "user_message", RunID: ev.RunID, Payload: p})
				continue
			}
			mid, _ := p["messageId"].(string)
			if mid == "" {
				mid = "ev:" + ev.ID
			}
			parent := lastNode
			if raw, ok := p["parentRunId"]; ok {
				parent = ""
				if rid, _ := raw.(string); rid != "" {
					parent = "r:" + rid
				}
			}
			content := userPayloadContent(p)
			key := "u:" + mid
			nodes[key] = &histNode{key: key, parent: parent, seq: ev.Seq, content: content, attachments: parseChatAttachments(p["attachments"])}
			lastNode, lastUser = key, key
		case "run_start":
			rid := ev.RunID
			if rid == "" {
				rid, _ = p["runId"].(string)
			}
			if rid == "" {
				continue
			}
			n := ensureRun(rid, ev.Seq)
			n.seq = ev.Seq
			if reply, _ := p["replyToMessageId"].(string); reply != "" {
				n.parent = "u:" + reply
			} else {
				n.parent = lastUser
			}
			lastNode = n.key
		case "run_end", "run_error":
			if ev.RunID == "" {
				continue
			}
			if status, _ := p["status"].(string); status == "failed" || typ == "run_error" {
				if n := nodes["r:"+ev.RunID]; n != nil {
					n.failed = true
				}
			}
		case "assistant_message":
			if ev.RunID == "" {
				key := "r:orphan:" + ev.ID
				nodes[key] = &histNode{key: key, parent: lastNode, seq: ev.Seq, isRun: true, events: []histEvent{{ID: ev.ID, Seq: ev.Seq, Type: "assistant_message", Payload: p}}}
				lastNode = key
				continue
			}
			n := ensureRun(ev.RunID, ev.Seq)
			n.events = append(n.events, histEvent{ID: ev.ID, Seq: ev.Seq, Type: typ, RunID: ev.RunID, Payload: p})
		case "ask_user_request":
			rid, _ := p["requestId"].(string)
			if rid == "" {
				continue
			}
			q := askQuestion{runID: ev.RunID}
			q.question, _ = p["question"].(string)
			q.toolCallID, _ = p["toolCallId"].(string)
			q.mode, _ = p["mode"].(string)
			questions[rid] = q
		case "ask_user_resolved":
			rid, _ := p["requestId"].(string)
			status, _ := p["status"].(string)
			q, ok := questions[rid]
			if rid == "" || status != "answered" || !ok {
				continue
			}
			// A synchronous ask_user already returned the answer as its tool
			// result; only asynchronous answers need a synthetic pair.
			if q.mode != "async" && q.toolCallID != "" && resultIDs[q.toolCallID] {
				continue
			}
			pair := histEvent{ID: ev.ID, Seq: ev.Seq, Type: "_ask_pair", Payload: map[string]any{"requestId": rid, "question": q.question, "answer": p["answer"]}}
			if q.runID != "" && nodes["r:"+q.runID] != nil {
				n := nodes["r:"+q.runID]
				n.events = append(n.events, pair)
				continue
			}
			key := "r:ask:" + ev.ID
			nodes[key] = &histNode{key: key, parent: lastNode, seq: ev.Seq, isRun: true, events: []histEvent{pair}}
			lastNode = key
		case "session.compacted":
			compactions = append(compactions, ev)
		default:
			if ev.RunID == "" {
				continue
			}
			n := ensureRun(ev.RunID, ev.Seq)
			n.events = append(n.events, ev)
		}
	}

	target := nodes["u:"+targetMessageID]
	if target == nil {
		return nil
	}
	chain := []*histNode{}
	seen := map[string]bool{}
	for n := target; n != nil && !seen[n.key]; n = nodes[n.parent] {
		seen[n.key] = true
		chain = append(chain, n)
		if n.parent == "" {
			break
		}
	}
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}

	for _, ev := range compactions {
		anchor, _ := ev.Payload["anchorMessageId"].(string)
		if anchor != "" && !seen["u:"+anchor] {
			continue
		}
		compactSeq = ev.Seq
		if v, ok := ev.Payload["throughSeq"].(float64); ok {
			compactThrough = int64(v)
		}
		compactSummary = compactSummaryText(ev.Payload["summary"])
	}
	out := []chatMessage{}
	dropped := compactSeq > 0 && compactThrough > 0 && len(chain) > 0 && chain[0].seq > compactThrough
	for _, n := range chain {
		if compactSeq > 0 && n != target && n.seq <= compactThrough {
			dropped = true
			continue
		}
		if !n.isRun {
			message := userChatMessage(n.content, n.attachments)
			message.UserMessageID = strings.TrimPrefix(n.key, "u:")
			out = append(out, message)
			continue
		}
		if n.failed {
			continue
		}
		out = append(out, runEventsToMessages(n.events)...)
	}
	if dropped {
		content := "[Earlier conversation summary]"
		if strings.TrimSpace(compactSummary) != "" {
			content += "\n" + compactSummary
		}
		out = append([]chatMessage{{Role: "user", Content: content}}, out...)
	}
	return trimHistory(out, budget)
}

func runEventsToMessages(events []histEvent) []chatMessage {
	// Nested calls remain in the event log for UI, approvals and audit, but
	// only the outer script's selected output belongs in model history.
	visible := make([]histEvent, 0, len(events))
	for _, ev := range events {
		if strings.HasPrefix(ev.Type, "tool_call_") {
			parent, _ := ev.Payload["parentToolCallId"].(string)
			id, _ := ev.Payload["toolCallId"].(string)
			if parent != "" || strings.Contains(id, "/codemode-") || strings.HasSuffix(id, "/execute") {
				continue
			}
		}
		visible = append(visible, ev)
	}
	events = visible
	rolled := map[string]bool{}
	for _, ev := range events {
		if ev.Type == "assistant_rollback" {
			if mid, _ := ev.Payload["messageId"].(string); mid != "" {
				rolled[mid] = true
			}
		}
	}
	out := []chatMessage{}
	var pending *chatMessage
	names := map[string]string{}
	called := map[string]bool{}
	answered := map[string]bool{}
	ensure := func() *chatMessage {
		if pending == nil {
			pending = &chatMessage{Role: "assistant"}
		}
		return pending
	}
	flush := func() {
		if pending == nil {
			return
		}
		if strings.TrimSpace(pending.Content) != "" || len(pending.ToolCalls) > 0 {
			for _, c := range pending.ToolCalls {
				called[c.ID] = true
			}
			out = append(out, *pending)
		}
		pending = nil
	}
	for _, ev := range events {
		p := ev.Payload
		switch ev.Type {
		case "user_message":
			flush()
			content := userPayloadContent(p)
			message := userChatMessage(content, parseChatAttachments(p["attachments"]))
			message.UserMessageID, _ = p["messageId"].(string)
			out = append(out, message)
		case "assistant_delta":
			if mid, _ := p["messageId"].(string); rolled[mid] {
				continue
			}
			if d, ok := p["delta"].(string); ok {
				ensure().Content += d
			}
		case "assistant_message":
			if mid, _ := p["messageId"].(string); mid != "" && rolled[mid] {
				continue
			}
			msg := ensure()
			if content, ok := p["content"].(string); ok {
				msg.Content = content
			}
			if list, ok := p["toolCalls"].([]any); ok {
				for _, raw := range list {
					tc, _ := raw.(map[string]any)
					fn, _ := tc["function"].(map[string]any)
					id, _ := tc["id"].(string)
					name, _ := fn["name"].(string)
					args, _ := fn["arguments"].(string)
					if id != "" && name != "" {
						msg.ToolCalls = append(msg.ToolCalls, modelToolCall{ID: id, Name: name, Arguments: defaultArgs(args)})
					}
				}
			}
			flush()
		case "tool_call_start":
			id, _ := p["toolCallId"].(string)
			name, _ := p["name"].(string)
			if id != "" {
				names[id] = name
			}
		case "tool_call_args":
			id, _ := p["toolCallId"].(string)
			if id == "" {
				continue
			}
			msg := ensure()
			dup := false
			for _, c := range msg.ToolCalls {
				if c.ID == id {
					dup = true
					break
				}
			}
			if dup {
				continue
			}
			args, _ := p["arguments"].(string)
			name := names[id]
			if name == "" {
				name = "tool"
			}
			msg.ToolCalls = append(msg.ToolCalls, modelToolCall{ID: id, Name: name, Arguments: defaultArgs(args)})
		case "tool_call_result":
			flush()
			id, _ := p["toolCallId"].(string)
			if id == "" || !called[id] || answered[id] {
				continue
			}
			answered[id] = true
			text, _ := p["resultText"].(string)
			out = append(out, chatMessage{Role: "tool", ToolCallID: id, Content: shrinkText(text, historyToolResultChars)})
		case "_ask_pair":
			flush()
			rid, _ := p["requestId"].(string)
			id := "au_" + rid
			if len(id) > 15 {
				id = id[:15]
			}
			question, _ := p["question"].(string)
			args, _ := json.Marshal(map[string]any{"question": question})
			out = append(out,
				chatMessage{Role: "assistant", ToolCalls: []modelToolCall{{ID: id, Name: "ask_user", Arguments: string(args)}}},
				chatMessage{Role: "tool", ToolCallID: id, Content: askAnswerText(p["answer"])},
			)
		}
	}
	flush()
	return patchOrphanToolCalls(out)
}

// patchOrphanToolCalls gives every assistant tool call a tool result; OpenAI
// compatible upstreams reject a request with unanswered calls (cancelled or
// interrupted runs leave them behind).
func patchOrphanToolCalls(messages []chatMessage) []chatMessage {
	out := make([]chatMessage, 0, len(messages))
	for i := 0; i < len(messages); i++ {
		m := messages[i]
		out = append(out, m)
		if m.Role != "assistant" || len(m.ToolCalls) == 0 {
			continue
		}
		have := map[string]chatMessage{}
		j := i + 1
		for ; j < len(messages) && messages[j].Role == "tool"; j++ {
			have[messages[j].ToolCallID] = messages[j]
		}
		for _, c := range m.ToolCalls {
			if result, ok := have[c.ID]; ok {
				out = append(out, result)
			} else {
				out = append(out, chatMessage{Role: "tool", ToolCallID: c.ID, Content: "（该工具调用未完成：运行已中断）"})
			}
		}
		i = j - 1
	}
	return out
}

// trimHistory keeps the newest messages within budget characters; the final
// (target) message is always kept and the window never starts with a tool
// result whose call was trimmed away.
func trimHistory(messages []chatMessage, budget int) []chatMessage {
	total := 0
	start := len(messages)
	for i := len(messages) - 1; i >= 0; i-- {
		size := messages[i].size()
		if total+size > budget && start != len(messages) {
			break
		}
		total += size
		start = i
	}
	window := messages[start:]
	for len(window) > 1 && window[0].Role == "tool" {
		window = window[1:]
	}
	return window
}

func shrinkText(text string, keep int) string {
	if len(text) <= keep {
		return text
	}
	head := keep * 7 / 10
	tail := keep - head - 40
	if tail < 0 {
		tail = 0
	}
	return safeUTF8Prefix(text, head) + "\n…(已截断，原 " + strconv.Itoa(len(text)) + " 字节)\n" + safeUTF8Suffix(text, tail)
}

func safeUTF8Prefix(s string, n int) string {
	if n >= len(s) {
		return s
	}
	for n > 0 && n < len(s) && !historyRuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func safeUTF8Suffix(s string, n int) string {
	if n >= len(s) {
		return s
	}
	i := len(s) - n
	for i < len(s) && !historyRuneStart(s[i]) {
		i++
	}
	return s[i:]
}

func historyRuneStart(b byte) bool { return b&0xC0 != 0x80 }

func defaultArgs(args string) string {
	if strings.TrimSpace(args) == "" {
		return "{}"
	}
	return args
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
