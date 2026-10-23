// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"gorm.io/gorm"
)

// Capture is bounded independently from forwarding. Slow storage can lose a
// transcript (with an explicit error), but can never stall the caller's stream.
const gatewayCaptureSlots = 32
const gatewayCaptureQueue = 4096
const gatewayCaptureBytes = 4 << 20
const gatewayCaptureChunk = 32 << 10

type gatewayCapture struct {
	http.ResponseWriter
	chunks      chan []byte
	done        chan struct{}
	failed      atomic.Bool
	queuedBytes atomic.Int64
	status      int
	finishErr   error
	operation   string
}

func (c *gatewayCapture) Unwrap() http.ResponseWriter { return c.ResponseWriter }
func (c *gatewayCapture) WriteHeader(status int) {
	c.status = status
	c.ResponseWriter.WriteHeader(status)
}
func (c *gatewayCapture) Write(p []byte) (int, error) {
	n, err := c.ResponseWriter.Write(p)
	if c.status == 0 {
		c.status = http.StatusOK
	}
	for rest := p[:n]; len(rest) > 0 && !c.failed.Load(); {
		size := min(len(rest), gatewayCaptureChunk)
		if c.queuedBytes.Add(int64(size)) > gatewayCaptureBytes {
			c.queuedBytes.Add(-int64(size))
			c.failed.Store(true)
			break
		}
		chunk := append([]byte(nil), rest[:size]...)
		rest = rest[size:]
		select {
		case c.chunks <- chunk:
		default:
			c.queuedBytes.Add(-int64(size))
			c.failed.Store(true)
		}
	}
	return n, err
}
func (c *gatewayCapture) finish(err error) { c.finishErr = err; close(c.chunks) }

type gatewayCaptureKey struct {
	scope, client, firstUser string
}

func (key gatewayCaptureKey) follows(previous gatewayCaptureKey) bool {
	if key.scope != previous.scope {
		return false
	}
	if key.client != "" && previous.client != "" {
		return key.client == previous.client
	}
	return key.firstUser != "" && key.firstUser == previous.firstUser
}

func (h *handler) captureGateway(w http.ResponseWriter, p httpx.Principal, headers http.Header, operation string, body map[string]any) *gatewayCapture {
	if !gwChatOperation(operation) {
		return nil
	}
	select {
	case h.service.gateway.captureSlots <- struct{}{}:
	default:
		slog.Warn("gateway transcript capacity exceeded", "tenant", p.TenantID, "space", p.SpaceID)
		return nil
	}
	c := &gatewayCapture{ResponseWriter: w, chunks: make(chan []byte, gatewayCaptureQueue), done: make(chan struct{}), operation: operation}
	identity := gatewayClientIdentity(headers, body, operation)
	// Chain captures at admission, so a fast next HTTP request cannot overtake
	// the preceding response's database commit. This never waits on the proxy.
	g := h.service.gateway
	key := gatewayCaptureKey{
		scope:  gatewayHash(string(rawJSON([]string{p.TenantID, p.SpaceID, p.APIKeyID, identity.Harness}))),
		client: identity.ClientKey,
	}
	// Keep both forms of evidence so an optional session header does not change
	// the recording queue halfway through a conversation. This only orders
	// persistence; the database still decides whether the chats actually match.
	items := gwSlice(body["messages"])
	if operation == "responses" {
		items = gwSlice(body["input"])
		if text, ok := body["input"].(string); ok {
			visible, _ := gatewayUserText(text)
			if strings.TrimSpace(visible) != "" {
				key.firstUser = gatewayHash(visible)
			}
		}
	}
	for _, item := range items {
		m := gwMap(item)
		if gwStr(m["role"]) == "user" {
			text, _ := gatewayUserText(gwContentText(m["content"]))
			if strings.TrimSpace(text) == "" {
				continue
			}
			key.firstUser = gatewayHash(text)
			break
		}
	}
	g.captureMu.Lock()
	if g.captureTails == nil {
		g.captureTails = map[*gatewayCapture]gatewayCaptureKey{}
	}
	previous := []<-chan struct{}{}
	for capture, candidate := range g.captureTails {
		if key.follows(candidate) {
			previous = append(previous, capture.done)
		}
	}
	g.captureTails[c] = key
	g.captureMu.Unlock()
	go func() {
		defer func() {
			<-g.captureSlots
			g.captureMu.Lock()
			delete(g.captureTails, c)
			close(c.done)
			g.captureMu.Unlock()
		}()
		for _, done := range previous {
			select {
			case <-done:
			case <-h.deps.RunContext().Done():
				return
			}
		}
		h.recordGatewayCapture(c, p, identity, body)
	}()
	return c
}

func (h *handler) recordGatewayCapture(capture *gatewayCapture, p httpx.Principal, identity gatewayIdentity, body map[string]any) {
	ctx, cancel := context.WithTimeout(h.deps.RunContext(), 15*time.Second)
	conversation, err := h.store.beginGatewayConversation(ctx, p, identity, gatewayInputMessages(capture.operation, body), gwStr(body["model"]))
	cancel()
	if err != nil {
		slog.Error("gateway transcript admission failed", "error", err, "space", p.SpaceID)
		capture.failed.Store(true)
		return
	}
	h.notifyGatewaySession(conversation)
	decoder := &gwStreamDecoder{}
	streaming, _ := body["stream"].(bool)
	var buffer bytes.Buffer
	var data []string
	eventName := ""
	var pendingText, pendingReasoning strings.Builder
	var parseErr error
	var responseID string
	toolSeen := map[string]bool{}
	var outputExtras []gatewayMessage
	compactionBlocks := map[int]*strings.Builder{}
	compactionOrder := []int{}
	addOutputExtras := func(response map[string]any) {
		input := map[string]any{"input": response["output"]}
		operation := "responses"
		if capture.operation == "messages" {
			operation = "messages"
			input = map[string]any{"messages": []any{map[string]any{"role": "assistant", "content": response["content"]}}}
		}
		for _, m := range gatewayInputMessages(operation, input) {
			if m.Kind == "compaction" {
				outputExtras = append(outputExtras, m)
			}
		}
	}
	persist := func(final bool) error {
		ctx, cancel := context.WithTimeout(h.deps.RunContext(), 10*time.Second)
		defer cancel()
		return h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := tx.Exec("UPDATE gateway_sessions SET id=id WHERE id=?", conversation.session).Error; err != nil {
				return err
			}
			emit := func(typ string, payload any) error {
				return h.store.appendGatewayEvent(tx, conversation.session, conversation.run, typ, payload)
			}
			if pendingReasoning.Len() > 0 {
				if err := emit("reasoning_delta", map[string]any{"messageId": conversation.reasoning, "delta": pendingReasoning.String()}); err != nil {
					return err
				}
			}
			if pendingText.Len() > 0 {
				if err := emit("assistant_delta", map[string]any{"messageId": conversation.message, "delta": pendingText.String()}); err != nil {
					return err
				}
			}
			result := decoder.final()
			for _, tool := range result.ToolCalls {
				if tool.ID == "" || toolSeen[tool.ID] {
					continue
				}
				if err := emit("tool_call_start", map[string]any{"toolCallId": tool.ID, "name": tool.Name, "arguments": tool.Arguments}); err != nil {
					return err
				}
			}
			if !final {
				return nil
			}
			if err := emit("assistant_message", map[string]any{"messageId": conversation.message, "content": result.Text}); err != nil {
				return err
			}
			for _, tool := range result.ToolCalls {
				if err := emit("tool_call_args", map[string]any{"toolCallId": tool.ID, "arguments": tool.Arguments}); err != nil {
					return err
				}
			}
			for _, m := range append(gatewayResultMessages(result), outputExtras...) {
				if err := h.store.storeGatewayMessage(tx, conversation, m); err != nil {
					return err
				}
			}
			for _, m := range outputExtras {
				if err := emit("context_compacted", map[string]any{"summary": m.Text, "source": "auto"}); err != nil {
					return err
				}
			}
			if err := h.store.gatewayResponseLink(tx, conversation.session, responseID); err != nil {
				return err
			}
			status := "completed"
			failure := parseErr
			if capture.failed.Load() {
				failure = errors.New("Gateway 记录队列已满；本次记录不完整，客户端响应未受影响")
			}
			if capture.finishErr != nil {
				failure = capture.finishErr
			}
			if capture.status >= 400 && failure == nil {
				failure = errors.New(http.StatusText(capture.status))
			}
			if failure != nil {
				status = "failed"
				if err := emit("run_error", map[string]any{"message": failure.Error()}); err != nil {
					return err
				}
			}
			if err := emit("run_log", map[string]any{"level": "info", "message": "Gateway response", "data": map[string]any{"promptTokens": result.Usage.Input, "completionTokens": result.Usage.Output, "model": result.Model}}); err != nil {
				return err
			}
			return emit("run_end", map[string]any{"status": status, "gateway": true})
		})
	}
	flush := func(final bool) {
		if err := persist(final); err != nil {
			slog.Error("gateway transcript write failed", "error", err, "session", conversation.session)
		} else {
			pendingText.Reset()
			pendingReasoning.Reset()
			for _, tool := range decoder.final().ToolCalls {
				if tool.ID != "" {
					toolSeen[tool.ID] = true
				}
			}
		}
	}
	consume := func(ev gwSSEEvent) {
		if parseErr != nil {
			return
		}
		protocol := "openai"
		if capture.operation == "messages" {
			protocol = "anthropic"
		}
		var deltas []gwStreamDelta
		if capture.operation == "responses" {
			deltas, err = decoder.consumeResponses(ev)
		} else {
			deltas, err = decoder.consume(protocol, ev)
		}
		if err != nil {
			parseErr = err
			return
		}
		responseID = decoder.result.ID
		for _, delta := range deltas {
			pendingText.WriteString(delta.text)
			pendingReasoning.WriteString(delta.reasoning)
		}
		var m map[string]any
		_ = json.Unmarshal([]byte(ev.Data), &m)
		if capture.operation == "messages" {
			index := gwInt(m["index"])
			switch gwOr(gwStr(m["type"]), ev.Event) {
			case "content_block_start":
				block := gwMap(m["content_block"])
				if gwStr(block["type"]) == "compaction" {
					compactionBlocks[index] = &strings.Builder{}
					compactionBlocks[index].WriteString(gwStr(block["content"]))
					compactionOrder = append(compactionOrder, index)
				}
			case "content_block_delta":
				delta := gwMap(m["delta"])
				if block := compactionBlocks[index]; block != nil && gwStr(delta["type"]) == "compaction_delta" {
					block.WriteString(gwStr(delta["content"]))
				}
			}
		} else if capture.operation == "responses" && (gwStr(m["type"]) == "response.completed" || gwStr(m["type"]) == "response.incomplete") {
			addOutputExtras(gwMap(m["response"]))
		}
	}
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	total := 0
	for {
		select {
		case chunk, ok := <-capture.chunks:
			if !ok {
				if !streaming {
					protocol := "openai"
					if capture.operation == "messages" {
						protocol = "anthropic"
					}
					var valid bool
					if capture.operation == "responses" {
						decoder.result, valid = gwParseResponsesResult(buffer.Bytes())
					} else {
						decoder.result, valid = gwParseResult(protocol, buffer.Bytes())
					}
					if !valid {
						parseErr = errors.New(gwOr(gwErrorMessage(buffer.Bytes()), "invalid completion"))
					}
					responseID = decoder.result.ID
					pendingText.WriteString(decoder.result.Text)
					pendingReasoning.WriteString(decoder.result.Reasoning)
					if capture.operation == "messages" || capture.operation == "responses" {
						var response map[string]any
						_ = json.Unmarshal(buffer.Bytes(), &response)
						addOutputExtras(response)
					}
				} else {
					if buffer.Len() > 0 {
						data = append(data, strings.TrimPrefix(strings.TrimSpace(buffer.String()), "data: "))
					}
					if len(data) > 0 {
						consume(gwSSEEvent{Event: eventName, Data: strings.Join(data, "\n")})
					}
					if !decoder.complete && decoder.result.Finish == "" && parseErr == nil {
						parseErr = errors.New("upstream stream ended before completion")
					}
				}
				for _, index := range compactionOrder {
					outputExtras = append(outputExtras, gatewayMessage{Kind: "compaction", Text: compactionBlocks[index].String()})
				}
				flush(true)
				h.notifyGatewaySession(conversation)
				return
			}
			capture.queuedBytes.Add(-int64(len(chunk)))
			total += len(chunk)
			if total > maxProviderResponse {
				capture.failed.Store(true)
				continue
			}
			buffer.Write(chunk)
			if !streaming {
				continue
			}
			for {
				line, readErr := buffer.ReadString('\n')
				if readErr == io.EOF {
					buffer.WriteString(line)
					break
				}
				line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
				if line == "" {
					if len(data) > 0 {
						consume(gwSSEEvent{Event: eventName, Data: strings.Join(data, "\n")})
					}
					data = nil
					eventName = ""
					continue
				}
				field, value, _ := strings.Cut(line, ":")
				value = strings.TrimPrefix(value, " ")
				if field == "event" {
					eventName = value
				}
				if field == "data" {
					data = append(data, value)
				}
			}
		case <-ticker.C:
			if pendingText.Len() > 0 || pendingReasoning.Len() > 0 || len(decoder.tools) > len(toolSeen) {
				flush(false)
			}
		case <-h.deps.RunContext().Done():
			return
		}
	}
}

func gwParseResponsesResult(raw []byte) (gwResult, bool) {
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil || gwStr(body["object"]) != "response" {
		return gwResult{}, false
	}
	res := gwResult{ID: gwStr(body["id"]), Model: gwStr(body["model"]), Finish: "stop"}
	if gwStr(body["status"]) == "incomplete" {
		res.Finish = "length"
	}
	for _, m := range gatewayInputMessages("responses", map[string]any{"input": body["output"]}) {
		switch m.Kind {
		case "assistant":
			res.Text += m.Text
		case "reasoning":
			res.Reasoning += m.Text
		case "tool":
			res.ToolCalls = append(res.ToolCalls, gwToolCall{ID: m.ID, Name: m.Name, Arguments: m.Arguments})
		}
	}
	if u := gwMap(body["usage"]); u != nil {
		res.Usage = gwUsage{Input: gwInt(u["input_tokens"]), Output: gwInt(u["output_tokens"]), CacheRead: gwInt(gwMap(u["input_tokens_details"])["cached_tokens"]), Seen: true}
	}
	return res, true
}

func (d *gwStreamDecoder) consumeResponses(ev gwSSEEvent) ([]gwStreamDelta, error) {
	var m map[string]any
	if json.Unmarshal([]byte(ev.Data), &m) != nil {
		return nil, errors.New("invalid Responses event")
	}
	if d.tools == nil {
		d.tools = map[int]*gwStreamTool{}
	}
	switch gwOr(gwStr(m["type"]), ev.Event) {
	case "response.created":
		d.result.ID = gwStr(gwMap(m["response"])["id"])
		d.result.Model = gwStr(gwMap(m["response"])["model"])
	case "response.output_text.delta":
		text := gwStr(m["delta"])
		d.result.Text += text
		return []gwStreamDelta{{text: text}}, nil
	case "response.reasoning_summary_text.delta":
		text := gwStr(m["delta"])
		d.result.Reasoning += text
		return []gwStreamDelta{{reasoning: text}}, nil
	case "response.output_item.added":
		item := gwMap(m["item"])
		if gwStr(item["type"]) == "function_call" {
			index := gwInt(m["output_index"])
			d.tools[index] = &gwStreamTool{index: index, gwToolCall: gwToolCall{ID: gwStr(item["call_id"]), Name: gwStr(item["name"]), Arguments: gwStr(item["arguments"])}}
		}
	case "response.function_call_arguments.delta":
		if tool := d.tools[gwInt(m["output_index"])]; tool != nil {
			tool.Arguments += gwStr(m["delta"])
		}
	case "response.completed", "response.incomplete":
		result, ok := gwParseResponsesResult(rawJSON(m["response"]))
		if ok {
			d.result = result
			// The terminal response is authoritative, including tools with no
			// argument delta (an empty input) or only a terminal output item.
			d.tools = map[int]*gwStreamTool{}
		}
		d.complete = true
	case "response.failed", "error":
		return nil, errors.New(gwOr(gwErrorMessage([]byte(ev.Data)), "upstream failed"))
	}
	return nil, nil
}
