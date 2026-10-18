// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"
)

// The gateway accepts three client dialects (operation "chat" = OpenAI Chat
// Completions, "responses" = OpenAI Responses, "messages" = Anthropic Messages)
// and speaks two upstream dialects (Anthropic Messages, OpenAI-compatible chat).
// Requests are bridged onto the upstream dialect here; responses are bridged
// back in copyProviderResponse.

const defaultAnthropicMaxTokens = 4096

func gwChatOperation(operation string) bool {
	return operation == "chat" || operation == "responses" || operation == "messages"
}

// gwPassthrough reports whether the client and upstream already speak the same
// dialect, in which case bodies (and streams) are forwarded byte for byte.
func gwPassthrough(protocol, operation string) bool {
	if !gwChatOperation(operation) {
		return true
	}
	anthropic := isAnthropicProtocol(protocol)
	return (operation == "chat" && !anthropic) || (operation == "messages" && anthropic)
}

type gwRouteDefaults struct {
	MaxTokens   *float64 `json:"maxTokens"`
	Temperature *float64 `json:"temperature"`
}

func gwRouteOptions(raw json.RawMessage) gwRouteDefaults {
	var out gwRouteDefaults
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

func prepareUpstreamRequest(protocol, operation string, route ModelRoute, body map[string]any) map[string]any {
	if !gwChatOperation(operation) {
		body["model"] = route.Model
		return body
	}
	opts := gwRouteOptions(route.Options)
	anthropic := isAnthropicProtocol(protocol)
	if operation == "messages" && anthropic {
		body["model"] = route.Model
		gwStripUnsignedThinking(body)
		if _, ok := body["max_tokens"]; !ok {
			body["max_tokens"] = gwDefaultMaxTokens(opts)
		}
		return body
	}
	chat := body
	switch operation {
	case "responses":
		chat = responsesRequestToChat(body)
	case "messages":
		chat = anthropicRequestToChat(body)
	}
	chat["model"] = route.Model
	if anthropic {
		return chatRequestToAnthropic(chat, opts)
	}
	if _, ok := chat["max_tokens"]; !ok && opts.MaxTokens != nil {
		if _, ok := chat["max_completion_tokens"]; !ok {
			chat["max_tokens"] = int(*opts.MaxTokens)
		}
	}
	if _, ok := chat["temperature"]; !ok && opts.Temperature != nil {
		chat["temperature"] = *opts.Temperature
	}
	if stream, _ := chat["stream"].(bool); stream && operation != "chat" {
		// Bridged streams need the trailing usage chunk to report token counts.
		chat["stream_options"] = map[string]any{"include_usage": true}
	}
	return chat
}

func gwDefaultMaxTokens(opts gwRouteDefaults) any {
	if opts.MaxTokens != nil && *opts.MaxTokens > 0 {
		return int(*opts.MaxTokens)
	}
	return defaultAnthropicMaxTokens
}

// gwStripUnsignedThinking drops thinking blocks that were synthesised from an
// OpenAI-compatible upstream: Anthropic rejects thinking without a signature.
func gwStripUnsignedThinking(body map[string]any) {
	for _, raw := range gwSlice(body["messages"]) {
		m := gwMap(raw)
		if m == nil || gwStr(m["role"]) != "assistant" {
			continue
		}
		blocks, ok := m["content"].([]any)
		if !ok {
			continue
		}
		kept := blocks[:0:0]
		for _, b := range blocks {
			block := gwMap(b)
			if block != nil && gwStr(block["type"]) == "thinking" && gwStr(block["signature"]) == "" {
				continue
			}
			kept = append(kept, b)
		}
		if len(kept) != len(blocks) {
			m["content"] = kept
		}
	}
}

// ---- OpenAI Chat -> Anthropic Messages -------------------------------------

func chatRequestToAnthropic(chat map[string]any, opts gwRouteDefaults) map[string]any {
	out := map[string]any{"model": chat["model"]}
	if v, ok := chat["max_tokens"]; ok && v != nil {
		out["max_tokens"] = v
	} else if v, ok := chat["max_completion_tokens"]; ok && v != nil {
		out["max_tokens"] = v
	} else {
		out["max_tokens"] = gwDefaultMaxTokens(opts)
	}
	system, messages := chatMessagesToAnthropic(gwSlice(chat["messages"]))
	if system != "" {
		out["system"] = system
	}
	out["messages"] = messages
	if t, ok := gwNum(chat["temperature"]); ok {
		out["temperature"] = min(max(t, 0), 1)
	} else if opts.Temperature != nil {
		out["temperature"] = min(max(*opts.Temperature, 0), 1)
	}
	if _, hasTemp := out["temperature"]; !hasTemp {
		if v, ok := chat["top_p"]; ok && v != nil {
			out["top_p"] = v
		}
	}
	if v, ok := chat["top_k"]; ok && v != nil {
		out["top_k"] = v
	}
	switch stop := chat["stop"].(type) {
	case string:
		if stop != "" {
			out["stop_sequences"] = []any{stop}
		}
	case []any:
		seqs := []any{}
		for _, s := range stop {
			if str := gwStr(s); str != "" {
				seqs = append(seqs, str)
			}
		}
		if len(seqs) > 0 {
			out["stop_sequences"] = seqs
		}
	}
	if stream, _ := chat["stream"].(bool); stream {
		out["stream"] = true
	}
	if user := gwStr(chat["user"]); user != "" {
		out["metadata"] = map[string]any{"user_id": user}
	}
	if tools := chatToolsToAnthropic(gwSlice(chat["tools"])); len(tools) > 0 {
		out["tools"] = tools
		if tc := chatToolChoiceToAnthropic(chat["tool_choice"], chat["parallel_tool_calls"]); tc != nil {
			out["tool_choice"] = tc
		}
	}
	return out
}

func chatMessagesToAnthropic(messages []any) (string, []any) {
	systems := []string{}
	out := []map[string]any{}
	push := func(role string, blocks []any) {
		if len(blocks) == 0 {
			return
		}
		if n := len(out); n > 0 && out[n-1]["role"] == role {
			out[n-1]["content"] = append(out[n-1]["content"].([]any), blocks...)
			return
		}
		out = append(out, map[string]any{"role": role, "content": blocks})
	}
	for _, item := range messages {
		m := gwMap(item)
		if m == nil {
			continue
		}
		switch role := gwStr(m["role"]); role {
		case "system", "developer":
			if text := gwContentText(m["content"]); strings.TrimSpace(text) != "" {
				systems = append(systems, text)
			}
		case "tool", "function":
			id := gwStr(m["tool_call_id"])
			if id == "" {
				id = gwStr(m["name"])
			}
			push("user", []any{map[string]any{"type": "tool_result", "tool_use_id": id, "content": gwToolResultContent(m["content"])}})
		case "assistant":
			blocks := gwTextBlocks(m["content"], false)
			for _, raw := range gwSlice(m["tool_calls"]) {
				tc := gwMap(raw)
				f := gwMap(tc["function"])
				name := gwStr(f["name"])
				if name == "" {
					continue
				}
				id := gwStr(tc["id"])
				if id == "" {
					id = gwID("toolu_")
				}
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": id, "name": name, "input": gwToolInput(f["arguments"])})
			}
			if fc := gwMap(m["function_call"]); gwStr(fc["name"]) != "" {
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": gwID("toolu_"), "name": gwStr(fc["name"]), "input": gwToolInput(fc["arguments"])})
			}
			push("assistant", blocks)
		default:
			push("user", gwTextBlocks(m["content"], true))
		}
	}
	result := make([]any, 0, len(out))
	for _, m := range out {
		result = append(result, m)
	}
	return strings.Join(systems, "\n\n"), result
}

func gwTextBlocks(content any, allowImages bool) []any {
	blocks := []any{}
	switch c := content.(type) {
	case string:
		if strings.TrimSpace(c) != "" {
			blocks = append(blocks, map[string]any{"type": "text", "text": c})
		}
	case []any:
		for _, raw := range c {
			part := gwMap(raw)
			if part == nil {
				if s := gwStr(raw); strings.TrimSpace(s) != "" {
					blocks = append(blocks, map[string]any{"type": "text", "text": s})
				}
				continue
			}
			switch gwStr(part["type"]) {
			case "text", "input_text", "output_text":
				text := gwStr(part["text"])
				if strings.TrimSpace(text) == "" {
					continue
				}
				block := map[string]any{"type": "text", "text": text}
				if cc, ok := part["cache_control"]; ok {
					block["cache_control"] = cc
				}
				blocks = append(blocks, block)
			case "refusal":
				if text := gwStr(part["refusal"]); strings.TrimSpace(text) != "" {
					blocks = append(blocks, map[string]any{"type": "text", "text": text})
				}
			case "image_url", "input_image":
				if !allowImages {
					continue
				}
				if block := gwImageBlock(gwImageURL(part["image_url"])); block != nil {
					blocks = append(blocks, block)
				}
			}
		}
	}
	return blocks
}

func gwImageURL(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return gwStr(gwMap(v)["url"])
}

func gwImageBlock(url string) map[string]any {
	if url == "" {
		return nil
	}
	if rest, ok := strings.CutPrefix(url, "data:"); ok {
		meta, data, found := strings.Cut(rest, ",")
		if !found || !strings.HasSuffix(meta, ";base64") {
			return nil
		}
		media := strings.TrimSuffix(meta, ";base64")
		if media == "" {
			media = "image/png"
		}
		return map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": media, "data": data}}
	}
	return map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": url}}
}

func gwToolResultContent(content any) any {
	switch c := content.(type) {
	case nil:
		return ""
	case string:
		return c
	case []any:
		blocks := gwTextBlocks(c, true)
		allText := true
		texts := []string{}
		for _, b := range blocks {
			block := gwMap(b)
			if gwStr(block["type"]) != "text" {
				allText = false
				break
			}
			texts = append(texts, gwStr(block["text"]))
		}
		if allText {
			return strings.Join(texts, "\n")
		}
		return blocks
	default:
		return string(rawJSON(c))
	}
}

func gwToolInput(args any) any {
	switch a := args.(type) {
	case map[string]any:
		return a
	case string:
		if strings.TrimSpace(a) == "" {
			return map[string]any{}
		}
		var parsed any
		if err := json.Unmarshal([]byte(a), &parsed); err != nil {
			return map[string]any{"_raw": a}
		}
		if m, ok := parsed.(map[string]any); ok {
			return m
		}
		return map[string]any{"value": parsed}
	default:
		return map[string]any{}
	}
}

func chatToolsToAnthropic(tools []any) []any {
	out := []any{}
	for _, raw := range tools {
		t := gwMap(raw)
		if t == nil {
			continue
		}
		if f := gwMap(t["function"]); f != nil {
			name := gwStr(f["name"])
			if name == "" {
				continue
			}
			schema := gwMap(f["parameters"])
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			tool := map[string]any{"name": name, "input_schema": schema}
			if d := gwStr(f["description"]); d != "" {
				tool["description"] = d
			}
			out = append(out, tool)
			continue
		}
		if gwStr(t["name"]) != "" && t["input_schema"] != nil {
			out = append(out, t)
		}
	}
	return out
}

func chatToolChoiceToAnthropic(choice, parallel any) map[string]any {
	var tc map[string]any
	switch c := choice.(type) {
	case string:
		switch c {
		case "auto":
			tc = map[string]any{"type": "auto"}
		case "none":
			tc = map[string]any{"type": "none"}
		case "required":
			tc = map[string]any{"type": "any"}
		}
	case map[string]any:
		name := gwStr(gwMap(c["function"])["name"])
		if name == "" {
			name = gwStr(c["name"])
		}
		if name != "" {
			tc = map[string]any{"type": "tool", "name": name}
		}
	}
	if p, ok := parallel.(bool); ok && !p {
		if tc == nil {
			tc = map[string]any{"type": "auto"}
		}
		if tc["type"] != "none" {
			tc["disable_parallel_tool_use"] = true
		}
	}
	return tc
}

// ---- Anthropic Messages -> OpenAI Chat -------------------------------------

func anthropicRequestToChat(body map[string]any) map[string]any {
	out := map[string]any{"model": body["model"]}
	messages := []any{}
	if system := gwAnthropicSystemText(body["system"]); system != "" {
		messages = append(messages, map[string]any{"role": "system", "content": system})
	}
	for _, raw := range gwSlice(body["messages"]) {
		m := gwMap(raw)
		if m == nil {
			continue
		}
		if gwStr(m["role"]) == "assistant" {
			text, calls := gwAnthropicAssistantToChat(m["content"])
			if text == "" && len(calls) == 0 {
				continue
			}
			msg := map[string]any{"role": "assistant", "content": text}
			if len(calls) > 0 {
				msg["tool_calls"] = calls
				if text == "" {
					msg["content"] = nil
				}
			}
			messages = append(messages, msg)
			continue
		}
		parts, toolMessages := gwAnthropicUserToChat(m["content"])
		messages = append(messages, toolMessages...)
		if len(parts) > 0 {
			messages = append(messages, map[string]any{"role": "user", "content": gwPartsContent(parts)})
		}
	}
	out["messages"] = messages
	for _, k := range []string{"max_tokens", "temperature", "top_p"} {
		if v, ok := body[k]; ok && v != nil {
			out[k] = v
		}
	}
	if seqs := gwSlice(body["stop_sequences"]); len(seqs) > 0 {
		out["stop"] = seqs
	}
	if stream, _ := body["stream"].(bool); stream {
		out["stream"] = true
	}
	if user := gwStr(gwMap(body["metadata"])["user_id"]); user != "" {
		out["user"] = user
	}
	tools := []any{}
	for _, raw := range gwSlice(body["tools"]) {
		t := gwMap(raw)
		name := gwStr(t["name"])
		if t == nil || name == "" {
			continue
		}
		// Server tools (web_search, bash, ...) carry a type and no schema; they
		// cannot be expressed as functions.
		if typ := gwStr(t["type"]); typ != "" && typ != "custom" && t["input_schema"] == nil {
			continue
		}
		schema := gwMap(t["input_schema"])
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		fn := map[string]any{"name": name, "parameters": schema}
		if d := gwStr(t["description"]); d != "" {
			fn["description"] = d
		}
		tools = append(tools, map[string]any{"type": "function", "function": fn})
	}
	if len(tools) > 0 {
		out["tools"] = tools
		if tc := gwMap(body["tool_choice"]); tc != nil {
			switch gwStr(tc["type"]) {
			case "auto":
				out["tool_choice"] = "auto"
			case "any":
				out["tool_choice"] = "required"
			case "none":
				out["tool_choice"] = "none"
			case "tool":
				if name := gwStr(tc["name"]); name != "" {
					out["tool_choice"] = map[string]any{"type": "function", "function": map[string]any{"name": name}}
				}
			}
			if disable, _ := tc["disable_parallel_tool_use"].(bool); disable {
				out["parallel_tool_calls"] = false
			}
		}
	}
	return out
}

func gwAnthropicSystemText(system any) string {
	switch s := system.(type) {
	case string:
		return s
	case []any:
		parts := []string{}
		for _, raw := range s {
			if text := gwStr(gwMap(raw)["text"]); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n\n")
	}
	return ""
}

func gwAnthropicAssistantToChat(content any) (string, []any) {
	if s, ok := content.(string); ok {
		return s, nil
	}
	var text strings.Builder
	calls := []any{}
	for _, raw := range gwSlice(content) {
		block := gwMap(raw)
		switch gwStr(block["type"]) {
		case "text":
			text.WriteString(gwStr(block["text"]))
		case "tool_use":
			name := gwStr(block["name"])
			if name == "" {
				continue
			}
			input := block["input"]
			if input == nil {
				input = map[string]any{}
			}
			id := gwStr(block["id"])
			if id == "" {
				id = gwID("call_")
			}
			calls = append(calls, map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": string(rawJSON(input))}})
		}
	}
	return text.String(), calls
}

func gwAnthropicUserToChat(content any) ([]any, []any) {
	parts := []any{}
	toolMessages := []any{}
	if s, ok := content.(string); ok {
		if s != "" {
			parts = append(parts, map[string]any{"type": "text", "text": s})
		}
		return parts, toolMessages
	}
	for _, raw := range gwSlice(content) {
		block := gwMap(raw)
		switch gwStr(block["type"]) {
		case "text":
			if text := gwStr(block["text"]); text != "" {
				parts = append(parts, map[string]any{"type": "text", "text": text})
			}
		case "image":
			source := gwMap(block["source"])
			switch gwStr(source["type"]) {
			case "base64":
				media := gwOr(gwStr(source["media_type"]), "image/png")
				parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:" + media + ";base64," + gwStr(source["data"])}})
			case "url":
				parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": gwStr(source["url"])}})
			}
		case "tool_result":
			id := gwStr(block["tool_use_id"])
			if id == "" {
				continue
			}
			toolMessages = append(toolMessages, map[string]any{"role": "tool", "tool_call_id": id, "content": gwAnthropicToolResultText(block["content"])})
		}
	}
	return parts, toolMessages
}

func gwAnthropicToolResultText(content any) string {
	switch c := content.(type) {
	case nil:
		return ""
	case string:
		return c
	case []any:
		texts := []string{}
		for _, raw := range c {
			block := gwMap(raw)
			if gwStr(block["type"]) == "text" {
				texts = append(texts, gwStr(block["text"]))
			}
		}
		if len(texts) > 0 {
			return strings.Join(texts, "\n")
		}
	}
	return string(rawJSON(content))
}

func gwPartsContent(parts []any) any {
	texts := []string{}
	for _, raw := range parts {
		part := gwMap(raw)
		if gwStr(part["type"]) != "text" {
			return parts
		}
		texts = append(texts, gwStr(part["text"]))
	}
	return strings.Join(texts, "")
}

// ---- OpenAI Responses -> OpenAI Chat ---------------------------------------

func responsesRequestToChat(body map[string]any) map[string]any {
	out := map[string]any{"model": body["model"]}
	messages := []map[string]any{}
	if instructions := gwStr(body["instructions"]); strings.TrimSpace(instructions) != "" {
		messages = append(messages, map[string]any{"role": "system", "content": instructions})
	}
	switch input := body["input"].(type) {
	case string:
		if strings.TrimSpace(input) != "" {
			messages = append(messages, map[string]any{"role": "user", "content": input})
		}
	case []any:
		for _, raw := range input {
			item := gwMap(raw)
			if item == nil {
				continue
			}
			typ := gwStr(item["type"])
			if typ == "" && item["role"] != nil {
				typ = "message"
			}
			switch typ {
			case "message":
				role := gwStr(item["role"])
				switch role {
				case "system", "developer":
					role = "system"
				case "assistant":
				default:
					role = "user"
				}
				content := gwResponsesContent(item["content"])
				if role == "assistant" {
					content = gwContentText(content)
				}
				messages = append(messages, map[string]any{"role": role, "content": content})
			case "function_call":
				callID := gwOr(gwStr(item["call_id"]), gwStr(item["id"]))
				if callID == "" {
					callID = gwID("call_")
				}
				args := gwStr(item["arguments"])
				if strings.TrimSpace(args) == "" {
					args = "{}"
				}
				call := map[string]any{"id": callID, "type": "function", "function": map[string]any{"name": gwStr(item["name"]), "arguments": args}}
				if n := len(messages); n > 0 && messages[n-1]["role"] == "assistant" {
					last := messages[n-1]
					last["tool_calls"] = append(gwSlice(last["tool_calls"]), call)
					continue
				}
				messages = append(messages, map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{call}})
			case "function_call_output":
				messages = append(messages, map[string]any{"role": "tool", "tool_call_id": gwStr(item["call_id"]), "content": gwResponsesOutputText(item["output"])})
			}
		}
	}
	chatMessages := make([]any, 0, len(messages))
	for _, m := range messages {
		if m["role"] == "assistant" {
			hasCalls := len(gwSlice(m["tool_calls"])) > 0
			if text, _ := m["content"].(string); text == "" {
				if !hasCalls {
					continue
				}
				m["content"] = nil
			}
		}
		chatMessages = append(chatMessages, m)
	}
	out["messages"] = chatMessages
	if v, ok := body["max_output_tokens"]; ok && v != nil {
		out["max_tokens"] = v
	}
	for _, k := range []string{"temperature", "top_p", "parallel_tool_calls", "user"} {
		if v, ok := body[k]; ok && v != nil {
			out[k] = v
		}
	}
	if stream, _ := body["stream"].(bool); stream {
		out["stream"] = true
	}
	tools := []any{}
	for _, raw := range gwSlice(body["tools"]) {
		t := gwMap(raw)
		name := strings.TrimSpace(gwStr(t["name"]))
		if gwStr(t["type"]) != "function" || name == "" {
			continue
		}
		params := gwMap(t["parameters"])
		if params == nil {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		fn := map[string]any{"name": name, "parameters": params}
		if d := gwStr(t["description"]); d != "" {
			fn["description"] = d
		}
		if strict, _ := t["strict"].(bool); strict {
			fn["strict"] = true
		}
		tools = append(tools, map[string]any{"type": "function", "function": fn})
	}
	if len(tools) > 0 {
		out["tools"] = tools
		switch tc := body["tool_choice"].(type) {
		case string:
			if tc == "auto" || tc == "none" || tc == "required" {
				out["tool_choice"] = tc
			}
		case map[string]any:
			if gwStr(tc["type"]) == "function" && gwStr(tc["name"]) != "" {
				out["tool_choice"] = map[string]any{"type": "function", "function": map[string]any{"name": gwStr(tc["name"])}}
			}
		}
	}
	if format := gwMap(gwMap(body["text"])["format"]); format != nil {
		switch gwStr(format["type"]) {
		case "json_schema":
			schema := map[string]any{"name": gwOr(gwStr(format["name"]), "response"), "schema": format["schema"]}
			if strict, ok := format["strict"].(bool); ok {
				schema["strict"] = strict
			}
			out["response_format"] = map[string]any{"type": "json_schema", "json_schema": schema}
		case "json_object":
			out["response_format"] = map[string]any{"type": "json_object"}
		}
	}
	return out
}

func gwResponsesContent(content any) any {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		parts := []any{}
		allText := true
		var text strings.Builder
		for _, raw := range c {
			part := gwMap(raw)
			switch gwStr(part["type"]) {
			case "input_text", "output_text", "summary_text", "text":
				t := gwStr(part["text"])
				text.WriteString(t)
				parts = append(parts, map[string]any{"type": "text", "text": t})
			case "input_image":
				if url := gwImageURL(part["image_url"]); url != "" {
					allText = false
					parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}})
				}
			}
		}
		if allText {
			return text.String()
		}
		return parts
	}
	return ""
}

func gwResponsesOutputText(output any) string {
	switch o := output.(type) {
	case string:
		return o
	case []any:
		texts := []string{}
		for _, raw := range o {
			if text := gwStr(gwMap(raw)["text"]); text != "" {
				texts = append(texts, text)
			}
		}
		if len(texts) > 0 {
			return strings.Join(texts, "\n")
		}
	case nil:
		return ""
	}
	return string(rawJSON(output))
}

// ---- Response normalization (non-streaming) --------------------------------

type gwToolCall struct {
	ID, Name, Arguments string
}

// gwUsage counts Input as every prompt token, cached ones included, matching
// OpenAI's prompt_tokens; Anthropic's split fields are derived from it.
type gwUsage struct {
	Input, Output, CacheRead, CacheWrite, Reasoning int
	Seen                                            bool
}

type gwResult struct {
	ID, Model, Text, Reasoning, Finish string
	ToolCalls                          []gwToolCall
	Usage                              gwUsage
}

type gwOpenAIUsage struct {
	PromptTokens        int `json:"prompt_tokens"`
	CompletionTokens    int `json:"completion_tokens"`
	PromptTokensDetails struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionTokensDetails struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

func (u gwOpenAIUsage) usage() gwUsage {
	return gwUsage{Input: u.PromptTokens, Output: u.CompletionTokens, CacheRead: u.PromptTokensDetails.CachedTokens, Reasoning: u.CompletionTokensDetails.ReasoningTokens, Seen: true}
}

type gwAnthropicUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
}

func (u gwAnthropicUsage) usage() gwUsage {
	return gwUsage{Input: u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens, Output: u.OutputTokens, CacheRead: u.CacheReadInputTokens, CacheWrite: u.CacheCreationInputTokens, Seen: true}
}

func parseOpenAIResult(raw []byte) (gwResult, bool) {
	var o struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content          any    `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				Reasoning        any    `json:"reasoning"`
				ToolCalls        []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments any    `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage *gwOpenAIUsage `json:"usage"`
	}
	if json.Unmarshal(raw, &o) != nil || len(o.Choices) == 0 {
		return gwResult{}, false
	}
	choice := o.Choices[0]
	res := gwResult{ID: o.ID, Model: o.Model, Text: gwContentText(choice.Message.Content), Reasoning: gwOr(choice.Message.ReasoningContent, gwStr(choice.Message.Reasoning)), Finish: choice.FinishReason}
	for _, tc := range choice.Message.ToolCalls {
		args, ok := tc.Function.Arguments.(string)
		if !ok && tc.Function.Arguments != nil {
			args = string(rawJSON(tc.Function.Arguments))
		}
		res.ToolCalls = append(res.ToolCalls, gwToolCall{ID: tc.ID, Name: tc.Function.Name, Arguments: args})
	}
	if o.Usage != nil {
		res.Usage = o.Usage.usage()
	}
	return res, true
}

func parseAnthropicResult(raw []byte) (gwResult, bool) {
	var a struct {
		ID         string `json:"id"`
		Type       string `json:"type"`
		Model      string `json:"model"`
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type     string          `json:"type"`
			Text     string          `json:"text"`
			Thinking string          `json:"thinking"`
			ID       string          `json:"id"`
			Name     string          `json:"name"`
			Input    json.RawMessage `json:"input"`
		} `json:"content"`
		Usage *gwAnthropicUsage `json:"usage"`
	}
	if json.Unmarshal(raw, &a) != nil || (a.Type != "message" && len(a.Content) == 0) {
		return gwResult{}, false
	}
	res := gwResult{ID: a.ID, Model: a.Model, Finish: gwFinishFromAnthropic(a.StopReason)}
	var text, reasoning strings.Builder
	for _, c := range a.Content {
		switch c.Type {
		case "text":
			text.WriteString(c.Text)
		case "thinking":
			reasoning.WriteString(c.Thinking)
		case "tool_use":
			args := "{}"
			if len(c.Input) > 0 && string(c.Input) != "null" {
				args = string(c.Input)
			}
			res.ToolCalls = append(res.ToolCalls, gwToolCall{ID: c.ID, Name: c.Name, Arguments: args})
		}
	}
	res.Text, res.Reasoning = text.String(), reasoning.String()
	if a.Usage != nil {
		res.Usage = a.Usage.usage()
	}
	return res, true
}

func gwFinishFromAnthropic(stop string) string {
	switch stop {
	case "":
		return ""
	case "max_tokens", "model_context_window_exceeded":
		return "length"
	case "tool_use":
		return "tool_calls"
	case "refusal":
		return "content_filter"
	default:
		return "stop"
	}
}

func gwAnthropicStop(finish string, hasTools bool) string {
	switch {
	case finish == "length":
		return "max_tokens"
	case hasTools || finish == "tool_calls" || finish == "function_call":
		return "tool_use"
	case finish == "content_filter":
		return "refusal"
	default:
		return "end_turn"
	}
}

func gwChatFinish(finish string, hasTools bool) string {
	if finish != "" {
		return finish
	}
	if hasTools {
		return "tool_calls"
	}
	return "stop"
}

func gwOpenAIUsageMap(u gwUsage) map[string]any {
	out := map[string]any{"prompt_tokens": u.Input, "completion_tokens": u.Output, "total_tokens": u.Input + u.Output}
	if u.CacheRead > 0 {
		out["prompt_tokens_details"] = map[string]any{"cached_tokens": u.CacheRead}
	}
	if u.Reasoning > 0 {
		out["completion_tokens_details"] = map[string]any{"reasoning_tokens": u.Reasoning}
	}
	return out
}

func gwAnthropicUsageMap(u gwUsage) map[string]any {
	out := map[string]any{"input_tokens": max(u.Input-u.CacheRead-u.CacheWrite, 0), "output_tokens": u.Output}
	if u.CacheRead > 0 {
		out["cache_read_input_tokens"] = u.CacheRead
	}
	if u.CacheWrite > 0 {
		out["cache_creation_input_tokens"] = u.CacheWrite
	}
	return out
}

func gwResponsesUsageMap(u gwUsage) map[string]any {
	return map[string]any{
		"input_tokens":          u.Input,
		"input_tokens_details":  map[string]any{"cached_tokens": u.CacheRead},
		"output_tokens":         u.Output,
		"output_tokens_details": map[string]any{"reasoning_tokens": u.Reasoning},
		"total_tokens":          u.Input + u.Output,
	}
}

func encodeChatCompletion(res gwResult) map[string]any {
	msg := map[string]any{"role": "assistant", "content": res.Text}
	if res.Reasoning != "" {
		msg["reasoning_content"] = res.Reasoning
	}
	if len(res.ToolCalls) > 0 {
		calls := make([]any, 0, len(res.ToolCalls))
		for _, tc := range res.ToolCalls {
			calls = append(calls, map[string]any{"id": tc.ID, "type": "function", "function": map[string]any{"name": tc.Name, "arguments": gwOr(tc.Arguments, "{}")}})
		}
		msg["tool_calls"] = calls
		if res.Text == "" {
			msg["content"] = nil
		}
	}
	out := map[string]any{
		"id":      gwPrefixed("chatcmpl-", res.ID),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   res.Model,
		"choices": []any{map[string]any{"index": 0, "message": msg, "finish_reason": gwChatFinish(res.Finish, len(res.ToolCalls) > 0)}},
	}
	if res.Usage.Seen {
		out["usage"] = gwOpenAIUsageMap(res.Usage)
	}
	return out
}

func encodeAnthropicMessage(res gwResult) map[string]any {
	content := []any{}
	if res.Reasoning != "" {
		content = append(content, map[string]any{"type": "thinking", "thinking": res.Reasoning, "signature": ""})
	}
	if res.Text != "" {
		content = append(content, map[string]any{"type": "text", "text": res.Text})
	}
	for _, tc := range res.ToolCalls {
		content = append(content, map[string]any{"type": "tool_use", "id": gwOr(tc.ID, gwID("toolu_")), "name": tc.Name, "input": gwToolInput(tc.Arguments)})
	}
	if len(content) == 0 {
		content = append(content, map[string]any{"type": "text", "text": ""})
	}
	return map[string]any{
		"id":            gwPrefixed("msg_", res.ID),
		"type":          "message",
		"role":          "assistant",
		"model":         res.Model,
		"content":       content,
		"stop_reason":   gwAnthropicStop(res.Finish, len(res.ToolCalls) > 0),
		"stop_sequence": nil,
		"usage":         gwAnthropicUsageMap(res.Usage),
	}
}

func encodeResponsesObject(res gwResult) map[string]any {
	output := []any{}
	if res.Reasoning != "" {
		output = append(output, map[string]any{"id": gwID("rs_"), "type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": res.Reasoning}}})
	}
	if res.Text != "" {
		output = append(output, map[string]any{"id": gwID("msg_"), "type": "message", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": res.Text, "annotations": []any{}}}})
	}
	for _, tc := range res.ToolCalls {
		output = append(output, map[string]any{"id": gwID("fc_"), "type": "function_call", "status": "completed", "call_id": gwOr(tc.ID, gwID("call_")), "name": tc.Name, "arguments": gwOr(tc.Arguments, "{}")})
	}
	out := map[string]any{
		"id":         gwID("resp_"),
		"object":     "response",
		"created_at": time.Now().Unix(),
		"status":     "completed",
		"model":      res.Model,
		"output":     output,
		"usage":      gwResponsesUsageMap(res.Usage),
	}
	if res.Finish == "length" {
		out["status"] = "incomplete"
		out["incomplete_details"] = map[string]any{"reason": "max_output_tokens"}
	}
	return out
}

func gwParseResult(protocol string, raw []byte) (gwResult, bool) {
	if isAnthropicProtocol(protocol) {
		return parseAnthropicResult(raw)
	}
	return parseOpenAIResult(raw)
}

func gwEncodeResult(operation string, res gwResult) []byte {
	switch operation {
	case "messages":
		return rawJSON(encodeAnthropicMessage(res))
	case "responses":
		return rawJSON(encodeResponsesObject(res))
	default:
		return rawJSON(encodeChatCompletion(res))
	}
}

// normalizeProviderResponse converts a complete (non-streaming) upstream body
// into the client's dialect; same-dialect and non-chat bodies pass through.
func normalizeProviderResponse(protocol, operation string, raw []byte) []byte {
	if gwPassthrough(protocol, operation) {
		return raw
	}
	res, ok := gwParseResult(protocol, raw)
	if !ok {
		return raw
	}
	return gwEncodeResult(operation, res)
}

// ---- Errors -----------------------------------------------------------------

func gwErrorMessage(raw []byte) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ""
	}
	var probe map[string]any
	if json.Unmarshal([]byte(trimmed), &probe) == nil {
		switch e := probe["error"].(type) {
		case string:
			return e
		case map[string]any:
			if msg := gwStr(e["message"]); msg != "" {
				return msg
			}
		}
		for _, k := range []string{"message", "detail", "msg"} {
			if msg := gwStr(probe[k]); msg != "" {
				return msg
			}
		}
	}
	return gwTruncate(trimmed, 500)
}

func gwOpenAIErrorType(status int) string {
	switch {
	case status == 401:
		return "authentication_error"
	case status == 403:
		return "permission_error"
	case status == 404:
		return "not_found_error"
	case status == 429:
		return "rate_limit_error"
	case status >= 500:
		return "server_error"
	default:
		return "invalid_request_error"
	}
}

func gwAnthropicErrorType(status int) string {
	switch {
	case status == 401:
		return "authentication_error"
	case status == 403:
		return "permission_error"
	case status == 404:
		return "not_found_error"
	case status == 413:
		return "request_too_large"
	case status == 429:
		return "rate_limit_error"
	case status == 529:
		return "overloaded_error"
	case status >= 500:
		return "api_error"
	default:
		return "invalid_request_error"
	}
}

// gwErrorBody renders an error envelope in the client's dialect.
func gwErrorBody(operation string, status int, message, code string) []byte {
	if operation == "messages" {
		return rawJSON(map[string]any{"type": "error", "error": map[string]any{"type": gwAnthropicErrorType(status), "message": message}})
	}
	var c any
	if code != "" {
		c = code
	}
	return rawJSON(map[string]any{"error": map[string]any{"message": message, "type": gwOpenAIErrorType(status), "param": nil, "code": c}})
}

// ---- Small helpers ------------------------------------------------------------

func gwMap(v any) map[string]any { m, _ := v.(map[string]any); return m }
func gwSlice(v any) []any        { s, _ := v.([]any); return s }
func gwStr(v any) string         { s, _ := v.(string); return s }

func gwOr(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func gwNum(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

func gwContentText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var b strings.Builder
		for _, raw := range c {
			part := gwMap(raw)
			switch gwStr(part["type"]) {
			case "text", "input_text", "output_text":
				b.WriteString(gwStr(part["text"]))
			}
		}
		return b.String()
	}
	return ""
}

func gwTruncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

func gwID(prefix string) string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

func gwPrefixed(prefix, id string) string {
	if id == "" {
		return gwID(prefix)
	}
	if strings.HasPrefix(id, prefix) {
		return id
	}
	return prefix + id
}
