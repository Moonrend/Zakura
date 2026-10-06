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
	toolRunner      func(context.Context, string, string, string, string, json.RawMessage) (json.RawMessage, error)
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
			result, e := s.toolRunner(ctx, tenant, agent, session, call.Name, argsRaw)
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
