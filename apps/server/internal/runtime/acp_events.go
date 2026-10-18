// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

func newEventID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func sortStrings(values []string) { sort.Strings(values) }

// acpTimelineEvent is one Cloud Agent event derived from an ACP session/update.
// The web timeline renders assistant_delta / reasoning_delta / tool_call_* /
// acp_plan / run_log; raw ACP updates are never shown.
type acpTimelineEvent struct {
	Type    string
	Payload map[string]any
}

type acpUpdateEffect struct {
	events          []acpTimelineEvent
	runStatus       string
	rotateAssistant bool
	assistantText   string
	commands        []any
	modeID          string
	configOptions   any
	hasConfig       bool
	sessionTitle    string
}

var acpKindToolName = map[string]string{"read": "fs_read", "edit": "fs_write", "write": "fs_write", "delete": "fs_delete", "move": "fs_move", "search": "search", "execute": "shell_exec", "fetch": "web_fetch", "think": "think", "switch_mode": "switch_mode"}

func acpText(value any) string {
	text, _ := value.(string)
	return text
}

func acpToolName(update map[string]any) string {
	if name := strings.TrimSpace(acpText(update["name"])); name != "" && strings.ToLower(name) != "other" {
		return name
	}
	kind := strings.TrimSpace(acpText(update["kind"]))
	if mapped := acpKindToolName[kind]; kind != "other" && mapped != "" {
		return mapped
	}
	if title := strings.TrimSpace(acpText(update["title"])); title != "" {
		return title
	}
	if kind != "" && kind != "other" {
		return kind
	}
	return "tool"
}

func acpToolArguments(update map[string]any) string {
	location := ""
	if locations, ok := update["locations"].([]any); ok {
		for _, raw := range locations {
			item, _ := raw.(map[string]any)
			if path := strings.TrimSpace(acpText(item["path"])); path != "" {
				location = path
				break
			}
		}
	}
	raw := update["rawInput"]
	if text, ok := raw.(string); ok {
		var parsed any
		if json.Unmarshal([]byte(text), &parsed) != nil {
			out := map[string]any{"command": text}
			if location != "" {
				out["path"] = location
			}
			encoded, _ := json.Marshal(out)
			return string(encoded)
		}
		raw = parsed
	}
	if raw == nil {
		if location == "" {
			return ""
		}
		encoded, _ := json.Marshal(map[string]any{"path": location})
		return string(encoded)
	}
	object, ok := raw.(map[string]any)
	if !ok {
		out := map[string]any{"value": raw}
		if location != "" {
			out["path"] = location
		}
		encoded, _ := json.Marshal(out)
		return string(encoded)
	}
	out := map[string]any{}
	for key, value := range object {
		out[key] = value
	}
	alias := func(target string, keys ...string) {
		if _, exists := out[target]; exists {
			return
		}
		for _, key := range keys {
			if text := strings.TrimSpace(acpText(object[key])); text != "" {
				out[target] = text
				return
			}
		}
	}
	alias("path", "file_path", "filePath", "target_file", "targetFile")
	alias("command", "cmd")
	alias("query", "q", "pattern")
	alias("url", "uri")
	if _, exists := out["path"]; !exists && location != "" {
		out["path"] = location
	}
	encoded, _ := json.Marshal(out)
	return string(encoded)
}

func acpDiffs(content any) []map[string]any {
	list, _ := content.([]any)
	out := []map[string]any{}
	for _, raw := range list {
		item, _ := raw.(map[string]any)
		if item["type"] != "diff" {
			continue
		}
		path, okPath := item["path"].(string)
		newText, okNew := item["newText"].(string)
		if !okPath || !okNew {
			continue
		}
		diff := map[string]any{"path": path, "newText": newText}
		if oldText, ok := item["oldText"].(string); ok {
			diff["oldText"] = oldText
		}
		out = append(out, diff)
	}
	return out
}

func acpFence(mime string) string {
	for _, candidate := range []string{"json", "javascript", "typescript", "python", "markdown", "html", "xml", "yaml"} {
		if strings.Contains(mime, candidate) {
			return candidate
		}
	}
	return ""
}

func acpRenderBlock(block map[string]any) string {
	if block == nil {
		return ""
	}
	label := func(fallback string) string {
		for _, key := range []string{"title", "name"} {
			if text := acpText(block[key]); text != "" {
				return text
			}
		}
		return fallback
	}
	switch block["type"] {
	case "text":
		return acpText(block["text"])
	case "image":
		mime := acpText(block["mimeType"])
		if mime == "" {
			mime = "image/png"
		}
		if data := acpText(block["data"]); data != "" {
			return "![" + label("image") + "](data:" + mime + ";base64," + data + ")"
		}
		if uri := acpText(block["uri"]); uri != "" {
			return "![" + label("image") + "](" + uri + ")"
		}
		return "[" + label("image") + "]"
	case "audio":
		if uri := acpText(block["uri"]); uri != "" {
			return "[" + label("audio") + "](" + uri + ")"
		}
		return "[" + label("audio") + "]"
	case "resource_link":
		uri := acpText(block["uri"])
		name := label(uri)
		if name == "" {
			name = "resource"
		}
		if uri != "" {
			return "[" + name + "](" + uri + ")"
		}
		return "[" + name + "]"
	case "resource":
		resource, _ := block["resource"].(map[string]any)
		if resource == nil {
			return ""
		}
		name := label(acpText(resource["uri"]))
		if name == "" {
			name = "resource"
		}
		mime := acpText(resource["mimeType"])
		if text := acpText(resource["text"]); text != "" {
			return "**" + name + "**\n\n```" + acpFence(mime) + "\n" + text + "\n```"
		}
		if blob := acpText(resource["blob"]); blob != "" && strings.HasPrefix(mime, "image/") {
			return "![" + name + "](data:" + mime + ";base64," + blob + ")"
		}
		if uri := acpText(resource["uri"]); uri != "" {
			return "[" + name + "](" + uri + ")"
		}
		return "[" + name + "]"
	}
	return acpText(block["text"])
}

func acpRenderContent(content any) string {
	switch value := content.(type) {
	case map[string]any:
		return acpRenderBlock(value)
	case []any:
		var b strings.Builder
		for _, raw := range value {
			block, _ := raw.(map[string]any)
			b.WriteString(acpRenderBlock(block))
		}
		return b.String()
	}
	return ""
}

func acpToolResult(update map[string]any, toolCallID string) acpTimelineEvent {
	contentBlocks := update["contentBlocks"]
	if contentBlocks == nil {
		contentBlocks = update["content"]
	}
	diffs := acpDiffs(contentBlocks)
	result := acpText(update["title"])
	if raw, ok := update["rawOutput"]; ok && raw != nil {
		if text, isText := raw.(string); isText {
			result = text
		} else {
			encoded, _ := json.Marshal(raw)
			result = string(encoded)
		}
	}
	if result == "" {
		if text := acpRenderToolContent(contentBlocks); text != "" {
			result = text
		}
	}
	if result == "" && len(diffs) > 0 {
		parts := []string{}
		for _, diff := range diffs {
			oldText, _ := diff["oldText"].(string)
			parts = append(parts, fmt.Sprintf("--- %s\n%s\n+++ %s\n%s", diff["path"], acpTruncate(oldText, 4000), diff["path"], acpTruncate(diff["newText"].(string), 4000)))
		}
		result = strings.Join(parts, "\n\n")
	}
	payload := map[string]any{"toolCallId": toolCallID, "name": acpToolName(update), "isError": update["status"] == "failed", "resultText": acpTruncate(result, 12_000), "durationMs": 0}
	if len(diffs) > 0 {
		payload["diffs"] = diffs
	}
	return acpTimelineEvent{Type: "tool_call_result", Payload: payload}
}

// acpRenderToolContent extracts text from ToolCallContent items, which wrap a
// ContentBlock as {"type":"content","content":{...}}.
func acpRenderToolContent(content any) string {
	list, _ := content.([]any)
	var b strings.Builder
	for _, raw := range list {
		item, _ := raw.(map[string]any)
		if item["type"] == "content" {
			inner, _ := item["content"].(map[string]any)
			b.WriteString(acpRenderBlock(inner))
		}
	}
	return b.String()
}

func acpTruncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

func utf8RuneStart(b byte) bool { return b&0xC0 != 0x80 }

// translateACPUpdate maps one session/update to timeline events and runtime
// side effects. It mirrors appendAcpUpdate in the TypeScript runtime.
func translateACPUpdate(update map[string]any, assistantID, thoughtID string) acpUpdateEffect {
	kind := acpText(update["sessionUpdate"])
	effect := acpUpdateEffect{}
	emit := func(typ string, payload map[string]any) {
		effect.events = append(effect.events, acpTimelineEvent{Type: typ, Payload: payload})
	}
	switch kind {
	case "agent_message_chunk", "agent_message":
		if text := acpRenderContent(update["content"]); text != "" {
			emit("assistant_delta", map[string]any{"messageId": assistantID, "delta": text})
			effect.assistantText, effect.runStatus = text, "streaming"
		}
	case "agent_thought_chunk", "agent_thought":
		if text := acpRenderContent(update["content"]); text != "" {
			emit("reasoning_delta", map[string]any{"messageId": thoughtID, "delta": text})
			effect.runStatus = "thinking"
		}
	case "tool_call":
		id := acpText(update["toolCallId"])
		if id == "" {
			id = "acp_" + newEventID()
		}
		emit("tool_call_start", map[string]any{"toolCallId": id, "name": acpToolName(update), "title": update["title"]})
		if args := acpToolArguments(update); args != "" {
			emit("tool_call_args", map[string]any{"toolCallId": id, "arguments": args})
		}
		if status := acpText(update["status"]); status == "completed" || status == "failed" {
			result := acpToolResult(update, id)
			effect.events = append(effect.events, result)
		}
		effect.rotateAssistant, effect.runStatus = true, "tool"
	case "tool_call_update":
		id := acpText(update["toolCallId"])
		if id == "" {
			return effect
		}
		contentBlocks := update["contentBlocks"]
		if contentBlocks == nil {
			contentBlocks = update["content"]
		}
		status := acpText(update["status"])
		if status == "completed" || status == "failed" {
			effect.events = append(effect.events, acpToolResult(update, id))
		} else if update["title"] != nil || update["rawOutput"] != nil || len(acpDiffs(contentBlocks)) > 0 {
			emit("tool_call_progress", map[string]any{"toolCallId": id, "message": update["title"]})
		}
		effect.runStatus = "tool"
	case "tool_call_content_chunk":
		id := acpText(update["toolCallId"])
		if text := acpRenderContent(update["content"]); id != "" && text != "" {
			emit("tool_call_progress", map[string]any{"toolCallId": id, "message": text})
			effect.runStatus = "tool"
		}
	case "plan", "plan_update", "plan_removed":
		entries := []any{}
		if kind != "plan_removed" {
			list, _ := update["entries"].([]any)
			for _, raw := range list {
				entry, _ := raw.(map[string]any)
				entries = append(entries, map[string]any{"content": acpText(entry["content"]), "status": entry["status"], "priority": entry["priority"]})
			}
		}
		emit("acp_plan", map[string]any{"entries": entries})
	case "usage_update":
		emit("run_log", map[string]any{"level": "info", "message": "ACP 用量", "data": map[string]any{"cost": update["used"]}})
	case "available_commands_update":
		commands := []any{}
		list, _ := update["availableCommands"].([]any)
		for _, raw := range list {
			command, _ := raw.(map[string]any)
			if name := acpText(command["name"]); name != "" {
				commands = append(commands, map[string]any{"name": name, "description": command["description"]})
			}
		}
		effect.commands = commands
		emit("session_update", map[string]any{"acpCommands": commands})
	case "current_mode_update":
		if mode := strings.TrimSpace(acpText(update["currentModeId"])); mode != "" {
			effect.modeID = mode
			emit("session_update", map[string]any{"acpModeId": mode})
		}
	case "config_option_update":
		if options, ok := update["configOptions"]; ok {
			effect.configOptions, effect.hasConfig = options, true
		}
	case "state_update":
		if options, ok := update["configOptions"]; ok {
			effect.configOptions, effect.hasConfig = options, true
		} else if mode := strings.TrimSpace(acpText(update["currentModeId"])); mode != "" {
			effect.modeID = mode
			emit("session_update", map[string]any{"acpModeId": mode})
		}
	case "session_info_update":
		effect.sessionTitle = strings.TrimSpace(acpText(update["title"]))
	case "user_message", "user_message_chunk":
		if text := acpRenderContent(update["content"]); text != "" {
			emit("run_log", map[string]any{"level": "debug", "message": "ACP 用户消息回显", "data": map[string]any{"text": text}})
		}
	case "terminal_update", "terminal_output_chunk":
		text := acpRenderContent(update["content"])
		if text == "" {
			text = acpText(update["output"])
		}
		if text != "" {
			payload := map[string]any{"level": "info", "message": text}
			if terminal := acpText(update["terminalId"]); terminal != "" {
				payload["data"] = map[string]any{"terminalId": terminal}
			}
			emit("run_log", payload)
			effect.runStatus = "tool"
		}
	}
	return effect
}

// acpStateOnlyUpdate reports whether an update only changes runtime state.
// Content updates outside a Run come from session/load history replay or from
// a turn that has already been cancelled; replaying them would duplicate the
// persisted timeline.
func acpStateOnlyUpdate(kind string) bool {
	switch kind {
	case "available_commands_update", "current_mode_update", "config_option_update", "state_update", "session_info_update":
		return true
	}
	return false
}

type acpOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func flattenACPOptions(raw any) []acpOption {
	list, _ := raw.([]any)
	out := []acpOption{}
	for _, item := range list {
		option, _ := item.(map[string]any)
		if option == nil {
			continue
		}
		id := acpText(option["value"])
		if id == "" {
			id = acpText(option["modelId"])
		}
		if id == "" {
			id = acpText(option["id"])
			if _, nested := option["options"].([]any); nested {
				id = ""
			}
		}
		if id != "" {
			name := strings.TrimSpace(acpText(option["name"]))
			if name == "" {
				name = strings.TrimSpace(acpText(option["title"]))
			}
			if name == "" {
				name = id
			}
			out = append(out, acpOption{ID: id, Name: name})
		} else if nested, ok := option["options"].([]any); ok {
			out = append(out, flattenACPOptions(nested)...)
		}
	}
	return out
}

var acpReasonPattern = regexp.MustCompile(`(?i)thought|reason`)
var acpModeLike = regexp.MustCompile(`(?i)mode|thought|reason`)

func acpIsModelOption(id, category, name string) bool {
	if category == "model" {
		return true
	}
	if category == "mode" || category == "thought_level" || category == "model_config" {
		return false
	}
	lower := strings.ToLower(id)
	if lower == "model" || strings.HasSuffix(lower, "-model") || strings.HasSuffix(lower, "_model") || strings.HasSuffix(lower, ".model") {
		return true
	}
	return strings.ToLower(strings.TrimSpace(name)) == "model"
}

// acpModelState is the {currentId, available, configId} block the composer
// renders for models and (as current) reasoning effort.
type acpModelState struct {
	models    map[string]any
	reasoning map[string]any
}

func parseACPConfigOptions(raw any) acpModelState {
	list, _ := raw.([]any)
	state := acpModelState{}
	var fallback map[string]any
	for _, item := range list {
		option, _ := item.(map[string]any)
		id := strings.TrimSpace(acpText(option["id"]))
		if id == "" {
			continue
		}
		if typ := acpText(option["type"]); typ != "" && typ != "select" {
			continue
		}
		available := flattenACPOptions(option["options"])
		if len(available) == 0 {
			continue
		}
		current := acpText(option["currentValue"])
		if current == "" {
			current = acpText(option["current_value"])
		}
		if current == "" {
			current = available[0].ID
		}
		category, label := acpText(option["category"]), acpText(option["name"])
		switch {
		case acpIsModelOption(id, category, label):
			state.models = map[string]any{"currentId": current, "available": available, "configId": id}
		case category == "thought_level" || acpReasonPattern.MatchString(id):
			state.reasoning = map[string]any{"current": current, "available": available, "configId": id}
		case fallback == nil && category != "mode" && !acpModeLike.MatchString(id+" "+label):
			fallback = map[string]any{"currentId": current, "available": available, "configId": id}
		}
	}
	if state.models == nil && fallback != nil {
		state.models = fallback
	}
	return state
}

const acpUnstableModelConfigID = "_unstable_model"

// parseACPSessionModelState reads models and reasoning from session/new,
// session/load or config_option_update. Gemini CLI and friends announce
// models through the unstable top-level "models" block instead.
func parseACPSessionModelState(raw any) acpModelState {
	if list, ok := raw.([]any); ok {
		return parseACPConfigOptions(list)
	}
	object, _ := raw.(map[string]any)
	if object == nil {
		return acpModelState{}
	}
	options := object["configOptions"]
	if options == nil {
		options = object["config_options"]
	}
	state := parseACPConfigOptions(options)
	if state.models == nil {
		if block, _ := object["models"].(map[string]any); block != nil {
			list := block["availableModels"]
			if list == nil {
				list = block["available"]
			}
			if available := flattenACPOptions(list); len(available) > 0 {
				current := acpText(block["currentModelId"])
				if current == "" {
					current = acpText(block["currentId"])
				}
				if current == "" {
					current = available[0].ID
				}
				state.models = map[string]any{"currentId": current, "available": available, "configId": acpUnstableModelConfigID}
			}
		}
	}
	return state
}

func parseACPModes(raw any) map[string]any {
	modes, _ := raw.(map[string]any)
	if modes == nil {
		return nil
	}
	list, _ := modes["availableModes"].([]any)
	available := []acpOption{}
	for _, item := range list {
		mode, _ := item.(map[string]any)
		id := acpText(mode["id"])
		if id == "" {
			continue
		}
		name := acpText(mode["name"])
		if name == "" {
			name = id
		}
		available = append(available, acpOption{ID: id, Name: name})
	}
	return map[string]any{"currentId": acpText(modes["currentModeId"]), "available": available}
}

// acpVisibleModels overlays the Zakura gateway catalogue on a routed adapter:
// adapters announce their own built-in model names, which are not valid
// gateway aliases.
func acpVisibleModels(adapter map[string]any, gateway []acpGatewayModel, previous map[string]any, preferred []string, routed bool) map[string]any {
	if !routed || len(gateway) == 0 {
		return adapter
	}
	candidates := []string{}
	if previous != nil {
		candidates = append(candidates, acpText(previous["currentId"]))
	}
	candidates = append(candidates, preferred...)
	if adapter != nil {
		candidates = append(candidates, acpText(adapter["currentId"]))
	}
	current := gateway[0].ID
	for _, candidate := range candidates {
		candidate = strings.TrimPrefix(strings.TrimSpace(candidate), "zakura/")
		found := false
		for _, model := range gateway {
			if model.ID == candidate && candidate != "" {
				found = true
				break
			}
		}
		if found {
			current = candidate
			break
		}
	}
	available := make([]acpOption, 0, len(gateway))
	for _, model := range gateway {
		name := model.Name
		if name == "" {
			name = model.ID
		}
		available = append(available, acpOption{ID: model.ID, Name: name})
	}
	out := map[string]any{"currentId": current, "available": available}
	if adapter != nil && adapter["configId"] != nil {
		out["configId"] = adapter["configId"]
	} else if previous != nil && previous["configId"] != nil {
		out["configId"] = previous["configId"]
	}
	return out
}

// acpElicitationFields flattens a JSON Schema form into the field list the
// elicitation card renders.
func acpElicitationFields(params map[string]any) []map[string]any {
	schema, _ := params["requestedSchema"].(map[string]any)
	properties, _ := schema["properties"].(map[string]any)
	if properties == nil {
		return nil
	}
	required := map[string]bool{}
	if list, ok := schema["required"].([]any); ok {
		for _, item := range list {
			if id, ok := item.(string); ok {
				required[id] = true
			}
		}
	}
	ids := make([]string, 0, len(properties))
	for id := range properties {
		ids = append(ids, id)
	}
	sortStrings(ids)
	fields := []map[string]any{}
	for _, id := range ids {
		if len(fields) >= 16 {
			break
		}
		property, _ := properties[id].(map[string]any)
		typ := acpText(property["type"])
		if typ == "" {
			typ = "string"
		}
		title := acpText(property["title"])
		if title == "" {
			title = acpText(property["description"])
		}
		if title == "" {
			title = id
		}
		field := map[string]any{"id": id, "type": typ, "title": title, "required": required[id]}
		if values, ok := property["enum"].([]any); ok {
			options := []string{}
			for _, value := range values {
				if text, ok := value.(string); ok && text != "" {
					options = append(options, text)
				}
			}
			if len(options) > 0 {
				field["options"] = options
			}
		}
		fields = append(fields, field)
	}
	if len(fields) == 0 {
		return nil
	}
	return fields
}
