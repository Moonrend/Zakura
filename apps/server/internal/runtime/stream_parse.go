// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

// modelToolCall is one tool call assembled from a provider response;
// Arguments is the raw JSON text the model produced.
type modelToolCall struct {
	ID        string
	Name      string
	Arguments string
}

type modelUsage struct {
	PromptTokens        int `json:"promptTokens"`
	CompletionTokens    int `json:"completionTokens"`
	CacheReadTokens     int `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens    int `json:"cacheWriteTokens,omitempty"`
	UncachedInputTokens int `json:"uncachedInputTokens"`
}

func parseModelUsage(u map[string]any, dialect string) *modelUsage {
	out := &modelUsage{}
	switch dialect {
	case "anthropic":
		out.CacheReadTokens = intValue(u["cache_read_input_tokens"])
		out.CacheWriteTokens = intValue(u["cache_creation_input_tokens"])
		out.PromptTokens = intValue(u["input_tokens"]) + out.CacheReadTokens + out.CacheWriteTokens
		out.CompletionTokens = intValue(u["output_tokens"])
	case "responses":
		out.PromptTokens = intValue(u["input_tokens"])
		out.CompletionTokens = intValue(u["output_tokens"])
		out.CacheReadTokens = intValue(gwMap(u["input_tokens_details"])["cached_tokens"])
		out.CacheWriteTokens = intValue(u["cache_write_tokens"])
	default:
		out.PromptTokens = intValue(u["prompt_tokens"])
		out.CompletionTokens = intValue(u["completion_tokens"])
		out.CacheReadTokens = intValue(gwMap(u["prompt_tokens_details"])["cached_tokens"])
		out.CacheWriteTokens = intValue(u["cache_write_tokens"])
	}
	out.UncachedInputTokens = max(0, out.PromptTokens-out.CacheReadTokens-out.CacheWriteTokens)
	return out
}

type modelRoundResult struct {
	Text             string
	Reasoning        string
	ToolCalls        []modelToolCall
	FinishReason     string
	IncompleteReason string
	Model            string
	Usage            *modelUsage
}

// streamSink receives incremental output while a response is parsed. tick is
// called for every upstream event so time-based flushing works even when an
// event carries no text (pings, tool argument deltas).
type streamSink interface {
	text(string)
	reasoning(string)
	tick()
}

type discardSink struct{}

func (discardSink) text(string)      {}
func (discardSink) reasoning(string) {}
func (discardSink) tick()            {}

// providerError is an error reported by the upstream (HTTP status or an
// in-stream error event). Retryable marks transient failures.
type providerError struct {
	Status    int
	Message   string
	Retryable bool
}

func (e *providerError) Error() string {
	if e.Status > 0 {
		return fmt.Sprintf("provider status %d: %s", e.Status, e.Message)
	}
	return "provider error: " + e.Message
}

// errStreamInterrupted marks a stream that ended before a terminal event.
var errStreamInterrupted = errors.New("model stream ended unexpectedly")

type sseEvent struct {
	Event string
	Data  string
}

// readSSE parses a text/event-stream body and calls fn per dispatched event.
func readSSE(r io.Reader, fn func(sseEvent) (bool, error)) error {
	br := bufio.NewReaderSize(io.LimitReader(r, maxProviderResponse), 64<<10)
	var event string
	var data strings.Builder
	hasData := false
	dispatch := func() (bool, error) {
		if !hasData && event == "" {
			return false, nil
		}
		ev := sseEvent{Event: event, Data: data.String()}
		event, hasData = "", false
		data.Reset()
		return fn(ev)
	}
	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 || err == nil {
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "":
				if done, e := dispatch(); e != nil || done {
					return e
				}
			case strings.HasPrefix(line, ":"):
			default:
				field, value, _ := strings.Cut(line, ":")
				value = strings.TrimPrefix(value, " ")
				switch field {
				case "event":
					event = value
				case "data":
					if hasData {
						data.WriteByte('\n')
					}
					data.WriteString(value)
					hasData = true
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if done, e := dispatch(); e != nil || done {
					return e
				}
				return io.EOF
			}
			return err
		}
	}
}

// streamAccumulator assembles a modelRoundResult from any of the three
// supported streaming dialects. The dialect is detected per event, so a
// gateway that re-encodes one protocol as another still parses.
type streamAccumulator struct {
	sink      streamSink
	text      strings.Builder
	reasoning strings.Builder
	// OpenAI chat tool calls keyed by index.
	openaiCalls map[int]*modelToolCall
	// Anthropic content blocks keyed by index.
	blocks map[int]*anthropicBlock
	// Responses API function calls keyed by item id.
	respCalls        map[string]*modelToolCall
	respOrder        []string
	respIndexes      map[int]string
	finish           string
	incompleteReason string
	protocolErr      error
	model            string
	usage            *modelUsage
	done             bool
	sawEvent         bool
}

type anthropicBlock struct {
	kind  string
	id    string
	name  string
	input strings.Builder
}

func newStreamAccumulator(sink streamSink) *streamAccumulator {
	if sink == nil {
		sink = discardSink{}
	}
	return &streamAccumulator{sink: sink, openaiCalls: map[int]*modelToolCall{}, blocks: map[int]*anthropicBlock{}, respCalls: map[string]*modelToolCall{}, respIndexes: map[int]string{}}
}

func (a *streamAccumulator) addText(s string) {
	if s == "" {
		return
	}
	a.text.WriteString(s)
	a.sink.text(s)
}

func (a *streamAccumulator) addReasoning(s string) {
	if s == "" {
		return
	}
	a.reasoning.WriteString(s)
	a.sink.reasoning(s)
}

// parseModelStream consumes an SSE body until the provider's terminal event.
func parseModelStream(body io.Reader, sink streamSink) (modelRoundResult, error) {
	acc := newStreamAccumulator(sink)
	err := readSSE(body, func(ev sseEvent) (bool, error) {
		acc.sink.tick()
		return acc.handle(ev)
	})
	if err != nil && !errors.Is(err, io.EOF) {
		return acc.result(), err
	}
	if !acc.done {
		// Some OpenAI-compatible servers close without [DONE] after a
		// finish_reason; anything else is a truncated stream.
		if acc.finish == "" {
			return acc.result(), errStreamInterrupted
		}
	}
	return acc.result(), acc.protocolErr
}

func (a *streamAccumulator) handle(ev sseEvent) (bool, error) {
	data := strings.TrimSpace(ev.Data)
	if data == "" {
		return false, nil
	}
	if data == "[DONE]" {
		a.done = true
		return true, nil
	}
	var m map[string]any
	if json.Unmarshal([]byte(data), &m) != nil {
		return false, nil
	}
	a.sawEvent = true
	typ, _ := m["type"].(string)
	if typ == "" {
		typ = ev.Event
	}
	if errObj, ok := m["error"]; ok && errObj != nil && typ != "response.failed" {
		return true, streamErrorFrom(errObj)
	}
	switch {
	case m["choices"] != nil:
		a.handleOpenAI(m)
	case strings.HasPrefix(typ, "response."):
		return a.handleResponses(typ, m)
	case typ != "":
		return a.handleAnthropic(typ, m)
	}
	return false, nil
}

func streamErrorFrom(v any) error {
	msg := ""
	kind := ""
	switch e := v.(type) {
	case map[string]any:
		msg, _ = e["message"].(string)
		kind, _ = e["type"].(string)
		if code, ok := e["code"].(string); ok && kind == "" {
			kind = code
		}
	case string:
		msg = e
	}
	if msg == "" {
		raw, _ := json.Marshal(v)
		msg = string(raw)
	}
	retryable := false
	switch kind {
	case "overloaded_error", "api_error", "rate_limit_error", "server_error", "rate_limit_exceeded", "timeout":
		retryable = true
	}
	return &providerError{Message: msg, Retryable: retryable}
}

func (a *streamAccumulator) handleOpenAI(m map[string]any) {
	if model, ok := m["model"].(string); ok && model != "" {
		a.model = model
	}
	if u, ok := m["usage"].(map[string]any); ok {
		a.usage = parseModelUsage(u, "openai")
	}
	choices, _ := m["choices"].([]any)
	for _, raw := range choices {
		choice, _ := raw.(map[string]any)
		if choice == nil {
			continue
		}
		if idx, ok := choice["index"]; ok && intValue(idx) != 0 {
			continue
		}
		delta, _ := choice["delta"].(map[string]any)
		fullMessage := delta == nil
		if delta == nil {
			// Non-delta chunks (some proxies) carry a full message.
			delta, _ = choice["message"].(map[string]any)
		}
		if delta != nil {
			for _, key := range []string{"reasoning_content", "reasoning"} {
				if s, ok := delta[key].(string); ok {
					a.addReasoning(s)
				}
			}
			a.addText(openAIContentText(delta["content"]))
			calls, _ := delta["tool_calls"].([]any)
			for pos, rc := range calls {
				tc, _ := rc.(map[string]any)
				if tc == nil {
					continue
				}
				idx := pos
				if v, ok := tc["index"]; ok {
					idx = intValue(v)
				}
				call := a.openaiCalls[idx]
				if call == nil {
					call = &modelToolCall{}
					a.openaiCalls[idx] = call
				}
				if id, ok := tc["id"].(string); ok && id != "" {
					if call.ID != "" && call.ID != id {
						a.protocolErr = errors.New("conflicting tool call IDs at the same index")
					}
					call.ID = id
				}
				fn, _ := tc["function"].(map[string]any)
				if name, ok := fn["name"].(string); ok && name != "" {
					if fullMessage {
						if call.Name != "" && call.Name != name {
							a.protocolErr = errors.New("conflicting full tool names")
						}
						call.Name = name
					} else {
						call.Name += name
					}
				}
				switch args := fn["arguments"].(type) {
				case string:
					if fullMessage {
						call.Arguments = args
					} else {
						call.Arguments += args
					}
				case map[string]any:
					raw, _ := json.Marshal(args)
					call.Arguments = string(raw)
				}
			}
		}
		if fr, ok := choice["finish_reason"].(string); ok && fr != "" {
			a.finish = fr
		}
	}
}

func (a *streamAccumulator) handleAnthropic(typ string, m map[string]any) (bool, error) {
	switch typ {
	case "message_start":
		msg, _ := m["message"].(map[string]any)
		if model, ok := msg["model"].(string); ok {
			a.model = model
		}
		if u, ok := msg["usage"].(map[string]any); ok {
			a.usage = parseModelUsage(u, "anthropic")
		}
	case "content_block_start":
		idx := intValue(m["index"])
		if a.blocks[idx] != nil {
			return true, errors.New("duplicate Anthropic content block index")
		}
		cb, _ := m["content_block"].(map[string]any)
		blockType, _ := cb["type"].(string)
		b := &anthropicBlock{kind: blockType}
		b.id, _ = cb["id"].(string)
		b.name, _ = cb["name"].(string)
		a.blocks[idx] = b
		switch blockType {
		case "text":
			if s, ok := cb["text"].(string); ok {
				a.addText(s)
			}
		case "thinking":
			if s, ok := cb["thinking"].(string); ok {
				a.addReasoning(s)
			}
		case "tool_use":
			if input, ok := cb["input"].(map[string]any); ok && len(input) > 0 {
				raw, _ := json.Marshal(input)
				b.input.Write(raw)
			}
		}
	case "content_block_delta":
		idx := intValue(m["index"])
		delta, _ := m["delta"].(map[string]any)
		switch delta["type"] {
		case "text_delta":
			s, _ := delta["text"].(string)
			a.addText(s)
		case "thinking_delta":
			s, _ := delta["thinking"].(string)
			a.addReasoning(s)
		case "input_json_delta":
			if b := a.blocks[idx]; b != nil {
				s, _ := delta["partial_json"].(string)
				b.input.WriteString(s)
			}
		}
	case "message_delta":
		delta, _ := m["delta"].(map[string]any)
		if sr, ok := delta["stop_reason"].(string); ok && sr != "" {
			a.finish = sr
		}
		if u, ok := m["usage"].(map[string]any); ok {
			if a.usage == nil {
				a.usage = &modelUsage{}
			}
			if v, ok := u["output_tokens"]; ok {
				a.usage.CompletionTokens = intValue(v)
			}
			// Delta usage is cumulative. Merge only present fields so an output-only
			// delta preserves the input/cache counters from message_start.
			if v, ok := u["input_tokens"]; ok {
				a.usage.UncachedInputTokens = intValue(v)
			}
			if v, ok := u["cache_read_input_tokens"]; ok {
				a.usage.CacheReadTokens = intValue(v)
			}
			if v, ok := u["cache_creation_input_tokens"]; ok {
				a.usage.CacheWriteTokens = intValue(v)
			}
			a.usage.PromptTokens = a.usage.UncachedInputTokens + a.usage.CacheReadTokens + a.usage.CacheWriteTokens
		}
	case "message_stop":
		a.done = true
		return true, nil
	case "error":
		return true, streamErrorFrom(m["error"])
	}
	return false, nil
}

func (a *streamAccumulator) handleResponses(typ string, m map[string]any) (bool, error) {
	switch typ {
	case "response.output_text.delta":
		s, _ := m["delta"].(string)
		a.addText(s)
	case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
		s, _ := m["delta"].(string)
		a.addReasoning(s)
	case "response.output_item.added", "response.output_item.done":
		item, _ := m["item"].(map[string]any)
		if item["type"] != "function_call" {
			return false, nil
		}
		key, _ := item["id"].(string)
		if key == "" {
			key, _ = item["call_id"].(string)
		}
		call, err := a.responseCall(key, m)
		if err != nil {
			return true, err
		}
		if id, ok := item["call_id"].(string); ok && id != "" {
			if call.ID != "" && call.ID != id {
				return true, errors.New("conflicting Responses call IDs")
			}
			call.ID = id
		}
		if name, ok := item["name"].(string); ok && name != "" {
			if call.Name != "" && call.Name != name {
				return true, errors.New("conflicting Responses tool names")
			}
			call.Name = name
		}
		if args, ok := item["arguments"].(string); ok && args != "" && typ == "response.output_item.done" {
			call.Arguments = args
		}
	case "response.function_call_arguments.delta":
		key, _ := m["item_id"].(string)
		call, err := a.responseCall(key, m)
		if err != nil {
			return true, err
		}
		s, _ := m["delta"].(string)
		call.Arguments += s
	case "response.completed", "response.incomplete":
		resp, _ := m["response"].(map[string]any)
		if model, ok := resp["model"].(string); ok {
			a.model = model
		}
		if u, ok := resp["usage"].(map[string]any); ok {
			a.usage = parseModelUsage(u, "responses")
		}
		a.finish, a.incompleteReason = responsesFinish(resp)
		if typ == "response.incomplete" {
			a.finish = "incomplete"
			details, _ := resp["incomplete_details"].(map[string]any)
			a.incompleteReason, _ = details["reason"].(string)
		}
		a.done = true
		return true, nil
	case "response.failed", "error":
		resp, _ := m["response"].(map[string]any)
		if e, ok := resp["error"]; ok && e != nil {
			return true, streamErrorFrom(e)
		}
		return true, streamErrorFrom(m["error"])
	}
	return false, nil
}

func responsesFinish(response map[string]any) (string, string) {
	status, _ := response["status"].(string)
	if status == "incomplete" || status == "failed" || status == "cancelled" || status == "in_progress" || status == "queued" {
		details, _ := response["incomplete_details"].(map[string]any)
		reason, _ := details["reason"].(string)
		if reason == "" {
			reason = status
		}
		return "incomplete", reason
	}
	return "stop", ""
}

func (a *streamAccumulator) responseCall(key string, event map[string]any) (*modelToolCall, error) {
	index, indexed := event["output_index"]
	if indexed {
		idx := intValue(index)
		if previous, ok := a.respIndexes[idx]; ok {
			if key != "" && key != previous {
				// A previously anonymous item can acquire its provider ID.
				if !strings.HasPrefix(previous, "index:") {
					return nil, errors.New("conflicting Responses item IDs")
				}
				if existing := a.respCalls[key]; existing != nil && existing != a.respCalls[previous] {
					return nil, errors.New("Responses item identity is already in use")
				}
				a.respCalls[key] = a.respCalls[previous]
				a.respIndexes[idx] = key
			}
			if key == "" {
				key = previous
			}
		} else {
			if key == "" {
				key = fmt.Sprintf("index:%d", idx)
			}
			a.respIndexes[idx] = key
		}
	}
	if key == "" {
		return nil, errors.New("Responses tool item has no identity or output index")
	}
	call := a.respCalls[key]
	if call == nil {
		call = &modelToolCall{}
		a.respCalls[key] = call
		a.respOrder = append(a.respOrder, key)
	}
	return call, nil
}

func (a *streamAccumulator) result() modelRoundResult {
	out := modelRoundResult{Text: a.text.String(), Reasoning: a.reasoning.String(), FinishReason: a.finish, IncompleteReason: a.incompleteReason, Model: a.model, Usage: a.usage}
	indexes := make([]int, 0, len(a.openaiCalls))
	for idx := range a.openaiCalls {
		indexes = append(indexes, idx)
	}
	sort.Ints(indexes)
	for _, idx := range indexes {
		out.ToolCalls = append(out.ToolCalls, *a.openaiCalls[idx])
	}
	blockIdx := make([]int, 0, len(a.blocks))
	for idx := range a.blocks {
		blockIdx = append(blockIdx, idx)
	}
	sort.Ints(blockIdx)
	for _, idx := range blockIdx {
		b := a.blocks[idx]
		if b.kind != "tool_use" {
			continue
		}
		args := strings.TrimSpace(b.input.String())
		if args == "" {
			args = "{}"
		}
		out.ToolCalls = append(out.ToolCalls, modelToolCall{ID: b.id, Name: b.name, Arguments: args})
	}
	for _, key := range a.respOrder {
		out.ToolCalls = append(out.ToolCalls, *a.respCalls[key])
	}
	for i := range out.ToolCalls {
		if strings.TrimSpace(out.ToolCalls[i].Arguments) == "" {
			out.ToolCalls[i].Arguments = "{}"
		}
	}
	return out
}

// parseCompletionJSON decodes a non-streamed response in any of the three
// dialects (OpenAI chat.completions, Anthropic messages, OpenAI Responses).
func parseCompletionJSON(raw []byte) (modelRoundResult, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return modelRoundResult{}, fmt.Errorf("invalid provider response: %w", err)
	}
	if errObj, ok := m["error"]; ok && errObj != nil {
		return modelRoundResult{}, streamErrorFrom(errObj)
	}
	out := modelRoundResult{}
	out.Model, _ = m["model"].(string)
	switch {
	case m["choices"] != nil:
		choices, _ := m["choices"].([]any)
		if len(choices) == 0 {
			return out, errors.New("provider returned no choices")
		}
		choice, _ := choices[0].(map[string]any)
		msg, _ := choice["message"].(map[string]any)
		if msg == nil {
			msg, _ = choice["delta"].(map[string]any)
		}
		out.Text = openAIContentText(msg["content"])
		for _, key := range []string{"reasoning_content", "reasoning"} {
			if s, ok := msg[key].(string); ok && s != "" {
				out.Reasoning = s
				break
			}
		}
		calls, _ := msg["tool_calls"].([]any)
		for _, rc := range calls {
			tc, _ := rc.(map[string]any)
			fn, _ := tc["function"].(map[string]any)
			call := modelToolCall{}
			call.ID, _ = tc["id"].(string)
			call.Name, _ = fn["name"].(string)
			switch args := fn["arguments"].(type) {
			case string:
				call.Arguments = args
			case nil:
			default:
				encoded, _ := json.Marshal(args)
				call.Arguments = string(encoded)
			}
			out.ToolCalls = append(out.ToolCalls, call)
		}
		out.FinishReason, _ = choice["finish_reason"].(string)
		if u, ok := m["usage"].(map[string]any); ok {
			out.Usage = parseModelUsage(u, "openai")
		}
	case m["output"] != nil || m["output_text"] != nil || m["object"] == "response":
		items, _ := m["output"].([]any)
		var text strings.Builder
		for _, ri := range items {
			item, _ := ri.(map[string]any)
			switch item["type"] {
			case "message":
				parts, _ := item["content"].([]any)
				for _, rp := range parts {
					part, _ := rp.(map[string]any)
					if s, ok := part["text"].(string); ok && (part["type"] == "output_text" || part["type"] == "text" || part["type"] == nil) {
						text.WriteString(s)
					}
				}
			case "function_call":
				call := modelToolCall{}
				call.ID, _ = item["call_id"].(string)
				call.Name, _ = item["name"].(string)
				call.Arguments, _ = item["arguments"].(string)
				out.ToolCalls = append(out.ToolCalls, call)
			case "reasoning":
				summary, _ := item["summary"].([]any)
				for _, rs := range summary {
					part, _ := rs.(map[string]any)
					if s, ok := part["text"].(string); ok {
						out.Reasoning += s
					}
				}
			}
		}
		out.Text = text.String()
		if out.Text == "" {
			out.Text, _ = m["output_text"].(string)
		}
		out.FinishReason, out.IncompleteReason = responsesFinish(m)
		if u, ok := m["usage"].(map[string]any); ok {
			out.Usage = parseModelUsage(u, "responses")
		}
	case m["content"] != nil:
		blocks, _ := m["content"].([]any)
		var text strings.Builder
		for _, rb := range blocks {
			b, _ := rb.(map[string]any)
			switch b["type"] {
			case "text":
				s, _ := b["text"].(string)
				text.WriteString(s)
			case "thinking":
				s, _ := b["thinking"].(string)
				out.Reasoning += s
			case "tool_use":
				call := modelToolCall{}
				call.ID, _ = b["id"].(string)
				call.Name, _ = b["name"].(string)
				encoded, _ := json.Marshal(b["input"])
				call.Arguments = string(encoded)
				if call.Arguments == "null" {
					call.Arguments = "{}"
				}
				out.ToolCalls = append(out.ToolCalls, call)
			}
		}
		out.Text = text.String()
		out.FinishReason, _ = m["stop_reason"].(string)
		if u, ok := m["usage"].(map[string]any); ok {
			out.Usage = parseModelUsage(u, "anthropic")
		}
	default:
		return out, errors.New("unrecognized provider response")
	}
	for i := range out.ToolCalls {
		if strings.TrimSpace(out.ToolCalls[i].Arguments) == "" {
			out.ToolCalls[i].Arguments = "{}"
		}
	}
	return out, nil
}

// openAIContentText flattens chat content that may be a string or an array of
// typed parts.
func openAIContentText(v any) string {
	switch c := v.(type) {
	case string:
		return c
	case []any:
		var b strings.Builder
		for _, rp := range c {
			part, _ := rp.(map[string]any)
			if part == nil {
				continue
			}
			if t, _ := part["type"].(string); t != "" && t != "text" && t != "output_text" {
				continue
			}
			if s, ok := part["text"].(string); ok {
				b.WriteString(s)
			}
		}
		return b.String()
	}
	return ""
}

func intValue(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	}
	return 0
}
