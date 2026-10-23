// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type gwSSEEvent struct{ Event, Data string }
type gwSSEReader struct {
	reader    *bufio.Reader
	remaining int64
}

func gwNewSSEReader(r io.Reader) *gwSSEReader {
	return &gwSSEReader{reader: bufio.NewReaderSize(r, 32<<10), remaining: maxProviderResponse}
}

func (r *gwSSEReader) Next() (gwSSEEvent, error) {
	var ev gwSSEEvent
	var data []string
	for {
		line, err := r.reader.ReadString('\n')
		r.remaining -= int64(len(line))
		if r.remaining < 0 {
			return ev, errors.New("provider stream exceeds size limit")
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" && len(data) > 0 {
			ev.Data = strings.Join(data, "\n")
			return ev, nil
		}
		if line != "" && !strings.HasPrefix(line, ":") {
			field, value, _ := strings.Cut(line, ":")
			value = strings.TrimPrefix(value, " ")
			switch field {
			case "event":
				ev.Event = value
			case "data":
				data = append(data, value)
			}
		}
		if err != nil {
			if err == io.EOF && len(data) > 0 {
				ev.Data = strings.Join(data, "\n")
				return ev, nil
			}
			return ev, err
		}
		if line == "" {
			ev.Event = ""
		}
	}
}

type gwStreamTool struct {
	gwToolCall
	index int
}
type gwStreamDelta struct {
	text, reasoning string
	tool            *gwStreamTool
	arguments       string
}
type gwStreamDecoder struct {
	result   gwResult
	tools    map[int]*gwStreamTool
	blocks   map[int]string
	complete bool
}

func (d *gwStreamDecoder) consume(protocol string, ev gwSSEEvent) ([]gwStreamDelta, error) {
	if strings.TrimSpace(ev.Data) == "[DONE]" {
		d.complete = true
		return nil, nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(ev.Data), &m); err != nil {
		return nil, fmt.Errorf("invalid upstream event: %w", err)
	}
	if m["error"] != nil || ev.Event == "error" || gwStr(m["type"]) == "error" {
		return nil, errors.New(gwOr(gwErrorMessage([]byte(ev.Data)), "upstream stream error"))
	}
	if d.tools == nil {
		d.tools = map[int]*gwStreamTool{}
		d.blocks = map[int]string{}
	}
	var deltas []gwStreamDelta
	text := func(value string, reasoning bool) {
		if value == "" {
			return
		}
		if reasoning {
			d.result.Reasoning += value
			deltas = append(deltas, gwStreamDelta{reasoning: value})
		} else {
			d.result.Text += value
			deltas = append(deltas, gwStreamDelta{text: value})
		}
	}
	if !isAnthropicProtocol(protocol) {
		d.result.ID = gwOr(gwStr(m["id"]), d.result.ID)
		d.result.Model = gwOr(gwStr(m["model"]), d.result.Model)
		if u := gwMap(m["usage"]); u != nil {
			var usage gwOpenAIUsage
			_ = json.Unmarshal(rawJSON(u), &usage)
			d.result.Usage = usage.usage()
		}
		for _, raw := range gwSlice(m["choices"]) {
			choice := gwMap(raw)
			if gwInt(choice["index"]) != 0 {
				continue
			}
			delta := gwMap(choice["delta"])
			text(gwContentText(delta["content"]), false)
			text(gwOr(gwStr(delta["reasoning_content"]), gwStr(delta["reasoning"])), true)
			for _, raw := range gwSlice(delta["tool_calls"]) {
				tc := gwMap(raw)
				index := gwInt(tc["index"])
				f := gwMap(tc["function"])
				tool := d.tools[index]
				if tool == nil {
					tool = &gwStreamTool{index: index}
					d.tools[index] = tool
				}
				tool.ID = gwOr(gwStr(tc["id"]), tool.ID)
				tool.Name += gwStr(f["name"])
				args := gwStr(f["arguments"])
				tool.Arguments += args
				if args != "" {
					deltas = append(deltas, gwStreamDelta{tool: tool, arguments: args})
				}
			}
			if finish := gwStr(choice["finish_reason"]); finish != "" {
				d.result.Finish = finish
				indices := make([]int, 0, len(d.tools))
				for index := range d.tools {
					indices = append(indices, index)
				}
				sort.Ints(indices)
				for _, index := range indices {
					deltas = append(deltas, gwStreamDelta{tool: d.tools[index]})
				}
			}
		}
		return deltas, nil
	}
	typ := gwOr(gwStr(m["type"]), ev.Event)
	switch typ {
	case "message_start":
		message := gwMap(m["message"])
		d.result.ID, d.result.Model = gwStr(message["id"]), gwStr(message["model"])
		if message["usage"] != nil {
			var u gwAnthropicUsage
			_ = json.Unmarshal(rawJSON(message["usage"]), &u)
			d.result.Usage = u.usage()
		}
	case "content_block_start":
		index := gwInt(m["index"])
		block := gwMap(m["content_block"])
		d.blocks[index] = gwStr(block["type"])
		switch d.blocks[index] {
		case "text":
			text(gwStr(block["text"]), false)
		case "thinking":
			text(gwStr(block["thinking"]), true)
		case "tool_use":
			tool := &gwStreamTool{gwToolCall: gwToolCall{ID: gwStr(block["id"]), Name: gwStr(block["name"])}, index: index}
			d.tools[index] = tool
			deltas = append(deltas, gwStreamDelta{tool: tool})
		}
	case "content_block_delta":
		index := gwInt(m["index"])
		delta := gwMap(m["delta"])
		switch gwStr(delta["type"]) {
		case "text_delta":
			text(gwStr(delta["text"]), false)
		case "thinking_delta":
			text(gwStr(delta["thinking"]), true)
		case "input_json_delta":
			if tool := d.tools[index]; tool != nil {
				args := gwStr(delta["partial_json"])
				tool.Arguments += args
				deltas = append(deltas, gwStreamDelta{tool: tool, arguments: args})
			}
		}
	case "message_delta":
		d.result.Finish = gwFinishFromAnthropic(gwStr(gwMap(m["delta"])["stop_reason"]))
		if usage := gwMap(m["usage"]); usage != nil {
			d.result.Usage.Output = gwInt(usage["output_tokens"])
			d.result.Usage.Seen = true
		}
	case "message_stop":
		d.complete = true
	}
	return deltas, nil
}

func gwInt(v any) int { n, _ := gwNum(v); return int(n) }

type gwStreamItem struct {
	index           int
	kind, id, text  string
	tool            *gwStreamTool
	started, closed bool
}

type gwStreamEncoder struct {
	w                       http.ResponseWriter
	operation               string
	result                  gwResult
	started                 bool
	sequence                int
	id                      string
	items                   []*gwStreamItem
	textItem, reasoningItem *gwStreamItem
	toolItems               map[*gwStreamTool]*gwStreamItem
}

func (e *gwStreamEncoder) event(name string, value any) error {
	if name != "" {
		if m, ok := value.(map[string]any); ok && e.operation == "responses" {
			m["sequence_number"] = e.sequence
			e.sequence++
		}
		if _, err := fmt.Fprintf(e.w, "event: %s\n", name); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(e.w, "data: %s\n\n", rawJSON(value)); err != nil {
		return err
	}
	return http.NewResponseController(e.w).Flush()
}

func (e *gwStreamEncoder) start(res gwResult) error {
	if e.started {
		return nil
	}
	e.started = true
	e.result = res
	e.toolItems = map[*gwStreamTool]*gwStreamItem{}
	switch e.operation {
	case "messages":
		e.id = gwPrefixed("msg_", res.ID)
		return e.event("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": e.id, "type": "message", "role": "assistant", "model": res.Model, "content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": gwAnthropicUsageMap(res.Usage)}})
	case "responses":
		e.id = gwID("resp_")
		response := e.response("in_progress", nil)
		if err := e.event("response.created", map[string]any{"type": "response.created", "response": response}); err != nil {
			return err
		}
		return e.event("response.in_progress", map[string]any{"type": "response.in_progress", "response": response})
	default:
		e.id = gwPrefixed("chatcmpl-", res.ID)
		return e.chat(map[string]any{"role": "assistant", "content": ""}, nil, nil)
	}
}

func (e *gwStreamEncoder) chat(delta any, finish any, usage any) error {
	choices := []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}
	if usage != nil {
		choices = []any{}
	}
	out := map[string]any{"id": e.id, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": e.result.Model, "choices": choices}
	if usage != nil {
		out["usage"] = usage
	}
	return e.event("", out)
}

func (e *gwStreamEncoder) item(kind string, tool *gwStreamTool) (*gwStreamItem, error) {
	item := &gwStreamItem{index: len(e.items), kind: kind, id: gwID("msg_"), tool: tool}
	if kind == "function_call" {
		item.id = gwID("fc_")
	}
	if kind == "reasoning" {
		item.id = gwID("rs_")
	}
	e.items = append(e.items, item)
	if e.operation == "messages" {
		for _, previous := range e.items[:len(e.items)-1] {
			if previous.closed {
				continue
			}
			// OpenAI may interleave argument deltas for parallel calls. Anthropic
			// requires sequential blocks: later calls wait until finish(), while
			// the first call continues streaming without buffering the response.
			if previous.tool != nil || !previous.started {
				return item, nil
			}
			if err := e.closeAnthropicItem(previous); err != nil {
				return nil, err
			}
		}
		return item, e.startAnthropicItem(item)
	}
	if e.operation != "responses" {
		return item, nil
	}
	if err := e.event("response.output_item.added", map[string]any{"type": "response.output_item.added", "output_index": item.index, "item": e.outputItem(item, false)}); err != nil {
		return nil, err
	}
	if kind == "message" {
		return item, e.event("response.content_part.added", map[string]any{"type": "response.content_part.added", "output_index": item.index, "item_id": item.id, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}})
	}
	if kind == "reasoning" {
		return item, e.event("response.reasoning_summary_part.added", map[string]any{"type": "response.reasoning_summary_part.added", "output_index": item.index, "item_id": item.id, "summary_index": 0, "part": map[string]any{"type": "summary_text", "text": ""}})
	}
	return item, nil
}

func (e *gwStreamEncoder) startAnthropicItem(item *gwStreamItem) error {
	block := map[string]any{"type": "text", "text": ""}
	if item.kind == "reasoning" {
		block = map[string]any{"type": "thinking", "thinking": "", "signature": ""}
	}
	if item.tool != nil {
		block = map[string]any{"type": "tool_use", "id": item.tool.ID, "name": item.tool.Name, "input": map[string]any{}}
	}
	if err := e.event("content_block_start", map[string]any{"type": "content_block_start", "index": item.index, "content_block": block}); err != nil {
		return err
	}
	item.started = true
	return nil
}

func (e *gwStreamEncoder) closeAnthropicItem(item *gwStreamItem) error {
	if err := e.event("content_block_stop", map[string]any{"type": "content_block_stop", "index": item.index}); err != nil {
		return err
	}
	item.closed = true
	return nil
}

func (e *gwStreamEncoder) anthropicItemDelta(item *gwStreamItem, value string) error {
	if !item.started || value == "" {
		return nil
	}
	delta := map[string]any{"type": "text_delta", "text": value}
	if item.kind == "reasoning" {
		delta = map[string]any{"type": "thinking_delta", "thinking": value}
	}
	if item.tool != nil {
		delta = map[string]any{"type": "input_json_delta", "partial_json": value}
	}
	return e.event("content_block_delta", map[string]any{"type": "content_block_delta", "index": item.index, "delta": delta})
}

func (e *gwStreamEncoder) delta(delta gwStreamDelta) error {
	if delta.tool != nil {
		tool := delta.tool
		item := e.toolItems[tool]
		fresh := item == nil
		if fresh {
			if tool.Name == "" {
				return nil
			}
			if tool.ID == "" {
				tool.ID = gwID("call_")
			}
			var err error
			item, err = e.item("function_call", tool)
			if err != nil {
				return err
			}
			e.toolItems[tool] = item
		}
		args := delta.arguments
		if fresh {
			args = tool.Arguments
		}
		item.text += args
		switch e.operation {
		case "messages":
			return e.anthropicItemDelta(item, args)
		case "responses":
			if args == "" {
				return nil
			}
			return e.event("response.function_call_arguments.delta", map[string]any{"type": "response.function_call_arguments.delta", "output_index": item.index, "item_id": item.id, "delta": args})
		default:
			call := map[string]any{"index": item.index, "function": map[string]any{"arguments": args}}
			if fresh {
				call["id"] = tool.ID
				call["type"] = "function"
				call["function"] = map[string]any{"name": tool.Name, "arguments": args}
			}
			return e.chat(map[string]any{"tool_calls": []any{call}}, nil, nil)
		}
	}
	value, kind := delta.text, "message"
	item := e.textItem
	if delta.reasoning != "" {
		value, kind, item = delta.reasoning, "reasoning", e.reasoningItem
	}
	if value == "" {
		return nil
	}
	if e.operation == "chat" {
		key := "content"
		if kind == "reasoning" {
			key = "reasoning_content"
		}
		return e.chat(map[string]any{key: value}, nil, nil)
	}
	if item == nil || e.operation == "messages" && item.closed {
		var err error
		item, err = e.item(kind, nil)
		if err != nil {
			return err
		}
		if kind == "message" {
			e.textItem = item
		} else {
			e.reasoningItem = item
		}
	}
	item.text += value
	if e.operation == "messages" {
		return e.anthropicItemDelta(item, value)
	}
	name := "response.output_text.delta"
	field := "content_index"
	if kind == "reasoning" {
		name, field = "response.reasoning_summary_text.delta", "summary_index"
	}
	return e.event(name, map[string]any{"type": name, "output_index": item.index, "item_id": item.id, field: 0, "delta": value})
}

func (e *gwStreamEncoder) outputItem(item *gwStreamItem, done bool) map[string]any {
	status, text := "in_progress", ""
	if done {
		status, text = "completed", item.text
	}
	if item.tool != nil {
		return map[string]any{"id": item.id, "type": "function_call", "status": status, "call_id": item.tool.ID, "name": item.tool.Name, "arguments": text}
	}
	if item.kind == "reasoning" {
		return map[string]any{"id": item.id, "type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": text}}}
	}
	return map[string]any{"id": item.id, "type": "message", "role": "assistant", "status": status, "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}}
}

func (e *gwStreamEncoder) response(status string, usage any) map[string]any {
	output := []any{}
	for _, item := range e.items {
		output = append(output, e.outputItem(item, status != "in_progress"))
	}
	return map[string]any{"id": e.id, "object": "response", "created_at": time.Now().Unix(), "status": status, "model": e.result.Model, "output": output, "usage": usage}
}

func (e *gwStreamEncoder) finish(res gwResult) error {
	e.result = res
	switch e.operation {
	case "messages":
		for _, item := range e.items {
			if item.closed {
				continue
			}
			if !item.started {
				if err := e.startAnthropicItem(item); err != nil {
					return err
				}
				if err := e.anthropicItemDelta(item, item.text); err != nil {
					return err
				}
			}
			if err := e.closeAnthropicItem(item); err != nil {
				return err
			}
		}
		if err := e.event("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": gwAnthropicStop(res.Finish, len(res.ToolCalls) > 0), "stop_sequence": nil}, "usage": gwAnthropicUsageMap(res.Usage)}); err != nil {
			return err
		}
		return e.event("message_stop", map[string]any{"type": "message_stop"})
	case "responses":
		for _, item := range e.items {
			name, field := "response.output_text.done", "text"
			if item.kind == "reasoning" {
				name = "response.reasoning_summary_text.done"
			}
			if item.tool != nil {
				name, field = "response.function_call_arguments.done", "arguments"
			}
			payload := map[string]any{"type": name, "item_id": item.id, "output_index": item.index, field: item.text}
			if item.tool == nil {
				if item.kind == "reasoning" {
					payload["summary_index"] = 0
				} else {
					payload["content_index"] = 0
				}
			}
			if err := e.event(name, payload); err != nil {
				return err
			}
			if item.tool == nil {
				partName, indexName := "response.content_part.done", "content_index"
				part := map[string]any{"type": "output_text", "text": item.text, "annotations": []any{}}
				if item.kind == "reasoning" {
					partName, indexName = "response.reasoning_summary_part.done", "summary_index"
					part = map[string]any{"type": "summary_text", "text": item.text}
				}
				if err := e.event(partName, map[string]any{"type": partName, "item_id": item.id, "output_index": item.index, indexName: 0, "part": part}); err != nil {
					return err
				}
			}
			if err := e.event("response.output_item.done", map[string]any{"type": "response.output_item.done", "output_index": item.index, "item": e.outputItem(item, true)}); err != nil {
				return err
			}
		}
		name, status := "response.completed", "completed"
		if res.Finish == "length" {
			name, status = "response.incomplete", "incomplete"
		}
		response := e.response(status, gwResponsesUsageMap(res.Usage))
		if status == "incomplete" {
			response["incomplete_details"] = map[string]any{"reason": "max_output_tokens"}
		}
		return e.event(name, map[string]any{"type": name, "response": response})
	default:
		if err := e.chat(map[string]any{}, gwChatFinish(res.Finish, len(res.ToolCalls) > 0), nil); err != nil {
			return err
		}
		if res.Usage.Seen {
			if err := e.chat(nil, nil, gwOpenAIUsageMap(res.Usage)); err != nil {
				return err
			}
		}
		if _, err := io.WriteString(e.w, "data: [DONE]\n\n"); err != nil {
			return err
		}
		return http.NewResponseController(e.w).Flush()
	}
}

func translateGatewayStream(w http.ResponseWriter, resp *ProviderResponse) error {
	reader := gwNewSSEReader(resp.Body)
	decoder := &gwStreamDecoder{result: gwResult{Model: resp.Model}}
	if isAnthropicProtocol(resp.Protocol) {
		decoder.result.ID = gwID("msg_")
	}
	encoder := &gwStreamEncoder{w: w, operation: resp.Operation}
	for {
		ev, err := reader.Next()
		if err == io.EOF {
			if !decoder.complete && decoder.result.Finish == "" {
				err = errors.New("upstream stream ended before completion")
			} else {
				return encoder.finish(decoder.final())
			}
		}
		if err == nil {
			var deltas []gwStreamDelta
			deltas, err = decoder.consume(resp.Protocol, ev)
			if err == nil {
				if err = encoder.start(decoder.result); err != nil {
					return err
				}
				for _, delta := range deltas {
					if err = encoder.delta(delta); err != nil {
						return err
					}
				}
				if decoder.complete {
					return encoder.finish(decoder.final())
				}
			}
		}
		if err != nil {
			body := map[string]any{}
			_ = json.Unmarshal(gwErrorBody(resp.Operation, http.StatusBadGateway, err.Error(), "upstream_error"), &body)
			if resp.Operation == "responses" {
				body["type"] = "error"
			}
			_ = encoder.event("error", body)
			return err
		}
	}
}

func (d *gwStreamDecoder) final() gwResult {
	out := d.result
	indices := make([]int, 0, len(d.tools))
	for index := range d.tools {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	for _, index := range indices {
		out.ToolCalls = append(out.ToolCalls, d.tools[index].gwToolCall)
	}
	return out
}
