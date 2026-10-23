// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

// Transcript normalization is deliberately independent of upstream translation:
// developer instructions, compaction summaries and tool results are UI context,
// not user turns. Opaque reasoning/signatures remain on the forwarding path only.
type gatewayMessage struct {
	Kind      string          `json:"kind"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Arguments string          `json:"arguments,omitempty"`
	Context   *MessageContext `json:"context,omitempty"`
	Error     bool            `json:"error,omitempty"`
}

func (m gatewayMessage) fingerprint() string {
	if m.Kind == "tool" && m.ID != "" {
		return gatewayHash(m.Kind + ":" + m.ID)
	}
	if m.Kind == "user" {
		m.Context = nil
	}
	return gatewayHash(string(rawJSON(m)))
}
func gatewayHash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

type gatewayIdentity struct{ Harness, ClientKey, PreviousResponse string }

var claudeSessionPattern = regexp.MustCompile(`_session_([a-zA-Z0-9-]+)$`)

func gatewayClientIdentity(h http.Header, body map[string]any, operation string) gatewayIdentity {
	identity := gatewayIdentity{Harness: operation, PreviousResponse: gwStr(body["previous_response_id"])}
	ua := strings.ToLower(h.Get("User-Agent") + " " + h.Get("Originator"))
	if strings.Contains(ua, "codex") {
		identity.Harness = "codex"
	}
	if strings.Contains(ua, "claude") {
		identity.Harness = "claude-code"
	}
	setKey := func(value string) bool {
		value = strings.TrimSpace(value)
		if identity.ClientKey != "" || value == "" || len(value) > 256 {
			return false
		}
		identity.ClientKey = value
		return true
	}
	// Harness conversation IDs take precedence over generic transport/session
	// headers, which a proxy can regenerate for every HTTP request.
	if setKey(h.Get("x-codex-session-id")) {
		identity.Harness = "codex"
	}
	meta := gwMap(body["metadata"])
	user := gwStr(meta["user_id"])
	var embedded map[string]any
	claudeKey := ""
	if json.Unmarshal([]byte(user), &embedded) == nil {
		claudeKey = gwStr(embedded["session_id"])
	}
	if match := claudeSessionPattern.FindStringSubmatch(user); len(match) > 1 {
		claudeKey = match[1]
	}
	if setKey(claudeKey) {
		identity.Harness = "claude-code"
	}
	for _, source := range []map[string]any{meta, body} {
		for _, key := range []string{"session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId"} {
			setKey(gwStr(source[key]))
		}
	}
	for _, key := range []string{"session_id", "x-session-id", "x-session-key", "x-conversation-id", "x-thread-id"} {
		setKey(h.Get(key))
	}
	// prompt_cache_key/user identify a cache or account, never a conversation.
	return identity
}

func gatewayInputMessages(operation string, body map[string]any) []gatewayMessage {
	out := []gatewayMessage{}
	addText := func(role, text string) {
		if strings.TrimSpace(text) == "" {
			return
		}
		kind := role
		if role == "system" || role == "developer" {
			kind = "context"
		}
		lower := strings.ToLower(strings.TrimSpace(text))
		if strings.Contains(lower, "this session is being continued from a previous conversation") || strings.HasPrefix(lower, "another language model started to solve this problem") || strings.HasPrefix(lower, "<summary>") || strings.HasPrefix(lower, "## summary of conversation") {
			kind = "compaction"
		}
		if role == "user" && kind == "user" {
			visible, context := gatewayUserText(text)
			if visible == "" {
				out = append(out, gatewayMessage{Kind: "context", Text: text})
				return
			}
			out = append(out, gatewayMessage{Kind: kind, Text: visible, Context: context})
			return
		}
		out = append(out, gatewayMessage{Kind: kind, Text: text})
	}
	if text := gwAnthropicSystemText(body["system"]); text != "" {
		addText("system", text)
	}
	if text := gwStr(body["instructions"]); text != "" {
		addText("developer", text)
	}
	input := gwSlice(body["messages"])
	if operation == "responses" {
		input = gwSlice(body["input"])
		if text, ok := body["input"].(string); ok {
			addText("user", text)
		}
	}
	for _, raw := range input {
		m := gwMap(raw)
		role, typ := gwStr(m["role"]), gwStr(m["type"])
		switch typ {
		case "function_call", "custom_tool_call":
			args := gwOr(gwStr(m["arguments"]), gwStr(m["input"]))
			out = append(out, gatewayMessage{Kind: "tool", ID: gwOr(gwStr(m["call_id"]), gwStr(m["id"])), Name: gwStr(m["name"]), Arguments: args})
			continue
		case "function_call_output", "custom_tool_call_output":
			out = append(out, gatewayMessage{Kind: "result", ID: gwStr(m["call_id"]), Text: gwResponsesOutputText(m["output"])})
			continue
		case "reasoning":
			for _, summary := range gwSlice(m["summary"]) {
				out = append(out, gatewayMessage{Kind: "reasoning", Text: gwStr(gwMap(summary)["text"])})
			}
			continue
		case "compaction":
			text := gwStr(m["summary"])
			if text == "" {
				text = "客户端已压缩上下文（加密摘要）"
			}
			out = append(out, gatewayMessage{Kind: "compaction", ID: gatewayHash(gwStr(m["encrypted_content"])), Text: text})
			continue
		}
		if role == "tool" || role == "function" {
			out = append(out, gatewayMessage{Kind: "result", ID: gwOr(gwStr(m["tool_call_id"]), gwStr(m["name"])), Text: gwResponsesOutputText(m["content"])})
			continue
		}
		if reasoning := gwOr(gwStr(m["reasoning_content"]), gwStr(m["reasoning"])); reasoning != "" {
			out = append(out, gatewayMessage{Kind: "reasoning", Text: reasoning})
		}
		if text, ok := m["content"].(string); ok {
			addText(role, text)
		} else {
			var text strings.Builder
			flush := func() {
				if text.Len() > 0 {
					addText(role, text.String())
					text.Reset()
				}
			}
			for _, value := range gwSlice(m["content"]) {
				block := gwMap(value)
				switch gwStr(block["type"]) {
				case "text", "input_text", "output_text":
					text.WriteString(gwStr(block["text"]))
				case "thinking":
					flush()
					if s := gwStr(block["thinking"]); s != "" {
						out = append(out, gatewayMessage{Kind: "reasoning", Text: s})
					}
				case "compaction":
					flush()
					out = append(out, gatewayMessage{Kind: "compaction", Text: gwStr(block["content"])})
				case "tool_use", "server_tool_use":
					flush()
					out = append(out, gatewayMessage{Kind: "tool", ID: gwStr(block["id"]), Name: gwStr(block["name"]), Arguments: string(rawJSON(block["input"]))})
				case "tool_result":
					flush()
					failed, _ := block["is_error"].(bool)
					out = append(out, gatewayMessage{Kind: "result", ID: gwStr(block["tool_use_id"]), Text: gwAnthropicToolResultText(block["content"]), Error: failed})
				case "image", "input_image", "image_url", "document", "input_file":
					flush()
					out = append(out, gatewayMessage{Kind: "context", Name: gwStr(block["type"]), ID: gatewayHash(string(rawJSON(block))), Text: gwOr(gwStr(block["filename"]), gwStr(block["title"]), "客户端附件："+gwStr(block["type"]))})
				}
			}
			flush()
		}
		for _, rawCall := range gwSlice(m["tool_calls"]) {
			call := gwMap(rawCall)
			f := gwMap(call["function"])
			out = append(out, gatewayMessage{Kind: "tool", ID: gwStr(call["id"]), Name: gwStr(f["name"]), Arguments: gwStr(f["arguments"])})
		}
	}
	return out
}

func gatewayUserText(text string) (string, *MessageContext) {
	rest := strings.TrimSpace(text)
	prefix := ""
	for {
		found := false
		for _, tag := range []string{"environment_context", "environment", "system-reminder", "permissions instructions", "developer_instructions"} {
			if strings.HasPrefix(rest, "<"+tag+">") {
				if end := strings.Index(rest, "</"+tag+">"); end >= 0 {
					end += len(tag) + 3
					prefix += rest[:end] + "\n"
					rest = strings.TrimSpace(rest[end:])
					found = true
					break
				}
			}
		}
		if !found {
			break
		}
	}
	if strings.HasPrefix(rest, "# AGENTS.md instructions for ") || strings.HasPrefix(rest, "<INSTRUCTIONS>") {
		return "", nil
	}
	if prefix != "" {
		return rest, &MessageContext{Prefix: prefix}
	}
	return text, nil
}

func gatewayResultMessages(result gwResult) []gatewayMessage {
	out := []gatewayMessage{}
	if result.Reasoning != "" {
		out = append(out, gatewayMessage{Kind: "reasoning", Text: result.Reasoning})
	}
	if result.Text != "" {
		out = append(out, gatewayMessage{Kind: "assistant", Text: result.Text})
	}
	for _, call := range result.ToolCalls {
		out = append(out, gatewayMessage{Kind: "tool", ID: call.ID, Name: call.Name, Arguments: call.Arguments})
	}
	return out
}

// A replayed conversation tail followed by new input is continuation evidence
// even for short answers. Isolated greetings and static context are not.
func gatewayReplayedTail(incoming, stored []gatewayMessage) bool {
	isDialogue := func(m gatewayMessage) bool {
		return m.Kind == "user" || m.Kind == "assistant" || m.Kind == "tool" || m.Kind == "result"
	}
	old := []string{}
	for _, m := range stored {
		if isDialogue(m) {
			old = append(old, m.fingerprint())
		}
	}
	if len(old) < 2 {
		return false
	}
	history := []gatewayMessage{}
	for _, m := range incoming {
		if isDialogue(m) {
			history = append(history, m)
		}
	}
	// The trailing user/result is new input, not part of the replay to match.
	end := len(history)
	for end > 0 && (history[end-1].Kind == "user" || history[end-1].Kind == "result") {
		end--
	}
	if end < 2 || end == len(history) {
		return false
	}
	matched, hasUser, hasAssistant := 0, false, false
	for i, j := end-1, len(old)-1; i >= 0 && j >= 0; i, j = i-1, j-1 {
		if history[i].fingerprint() != old[j] {
			break
		}
		matched++
		hasUser = hasUser || history[i].Kind == "user"
		hasAssistant = hasAssistant || history[i].Kind == "assistant"
	}
	return matched >= 2 && hasUser && hasAssistant
}

// Ignore static harness context as evidence. Ties are new chats, not a guess
// based on the most recently active conversation.
func gatewayMatchScore(incoming, stored []gatewayMessage) int {
	score, matches, cursor := 0, 0, 0
	distinctive, strong := false, false
	fingerprints := make([]string, len(stored))
	for i, m := range stored {
		fingerprints[i] = m.fingerprint()
	}
	for _, m := range incoming {
		if m.Kind == "context" || m.Kind == "reasoning" {
			continue
		}
		fingerprint := m.fingerprint()
		if m.Kind == "compaction" {
			// A rewritten summary may be the only retained history. Require two
			// distinct long quotations rather than guessing from recency or topic.
			anchors := map[string]bool{}
			for _, old := range stored {
				if (old.Kind == "user" || old.Kind == "assistant") && len([]rune(old.Text)) >= 32 && strings.Contains(m.Text, old.Text) {
					anchors[old.Text] = true
				}
			}
			if len(anchors) >= 2 {
				strong = true
				score += 50
			}
		}
		for j := cursor; j < len(stored); j++ {
			old := stored[j]
			if m.Kind == "result" && m.ID != "" && old.Kind == "tool" && old.ID == m.ID {
				strong = true
				matches++
				score += 100
				cursor = j + 1
				break
			}
			if fingerprint == fingerprints[j] {
				matches++
				cursor = j + 1
				if len([]rune(strings.TrimSpace(m.Text))) >= 32 {
					distinctive = true
				}
				if (m.Kind == "tool" || m.Kind == "result") && m.ID != "" {
					strong = true
					score += 100
				} else if m.Kind == "assistant" {
					score += 10
				} else if m.Kind == "compaction" {
					strong = true
					score += 50
				} else {
					score++
				}
				break
			}
			if m.Kind == "compaction" && (old.Kind == "user" || old.Kind == "assistant") && len([]rune(old.Text)) >= 32 && strings.Contains(m.Text, old.Text) {
				distinctive = true
				matches++
				score += 5
				cursor = j + 1
				break
			}
		}
	}
	if gatewayReplayedTail(incoming, stored) {
		return score + 50
	}
	if strong || distinctive && matches >= 2 && score >= 6 {
		return score
	}
	return 0
}

func gatewayNewMessages(incoming, stored []gatewayMessage) []gatewayMessage {
	// Match ordered occurrences, not a bag of hashes: after a retained assistant
	// answer, a repeated "yes" is a new user turn even if it occurred earlier.
	positions := map[string][]int{}
	for i, m := range stored {
		positions[m.fingerprint()] = append(positions[m.fingerprint()], i)
	}
	cursor := 0
	out := []gatewayMessage{}
	hasHistory := false
	for _, m := range incoming {
		if m.Kind == "assistant" || m.Kind == "tool" || m.Kind == "result" {
			hasHistory = true
			break
		}
	}
	for _, m := range incoming {
		// A client can send only the new user turn (with a session/response ID).
		// Without replayed history, identical text is not a duplicate request.
		if m.Kind == "user" && !hasHistory {
			out = append(out, m)
			continue
		}
		indices := positions[m.fingerprint()]
		if m.Kind == "context" || m.Kind == "compaction" {
			if len(indices) == 0 {
				out = append(out, m)
			}
			continue
		}
		matched := -1
		for _, index := range indices {
			if index >= cursor {
				matched = index
				break
			}
		}
		if matched >= 0 {
			cursor = matched + 1
			continue
		}
		out = append(out, m)
	}
	return out
}
