// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

//go:embed generative_ui_prompt.txt
var generativeUIPrompt string

//go:embed generative_ui_catalog.json
var generativeUICatalog []byte

const uiMaxBytes = 131072

var uiKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`)
var uiFence = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})([^\\r\\n]*)$")

func validUIKey(key string) bool {
	return uiKey.MatchString(key) && key != "__proto__" && key != "constructor" && key != "prototype"
}
func uiPath(value any) (string, bool) {
	p, ok := value.(string)
	return strings.TrimPrefix(p, "/"), ok && strings.HasPrefix(p, "/") && validUIKey(strings.TrimPrefix(p, "/"))
}

type uiBlock struct {
	Content string
	Closed  bool
}

func uiBlocks(content string) []uiBlock {
	var out []uiBlock
	fence := ""
	ui := false
	var body strings.Builder
	for _, line := range strings.SplitAfter(content, "\n") {
		clean := strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if fence == "" {
			match := uiFence.FindStringSubmatch(clean)
			if match != nil {
				fence = match[1]
				ui = strings.TrimSpace(match[2]) == "json-render"
				if ui {
					body.Reset()
					continue
				}
			}
		} else {
			closeLine := strings.TrimLeft(clean, " ")
			spaces := len(clean) - len(closeLine)
			token := strings.TrimRight(closeLine, " \t")
			if spaces <= 3 && len(token) >= len(fence) && strings.Trim(token, string(fence[0])) == "" {
				if ui {
					out = append(out, uiBlock{body.String(), true})
					body.Reset()
					fence = ""
					ui = false
					continue
				}
				fence = ""
			}
		}
		if ui {
			body.WriteString(line)
		}
	}
	if ui {
		out = append(out, uiBlock{body.String(), false})
	}
	return out
}

func uiContentDigest(content string) string {
	sum := sha256.Sum256([]byte(strings.ReplaceAll(content, "\r\n", "\n")))
	return hex.EncodeToString(sum[:])
}

func safeUIValue(value any, depth int, count *int) error {
	*count++
	if *count > 10000 || depth > 20 {
		return errors.New("UI structure exceeds limits")
	}
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
			if key == "__proto__" || key == "constructor" || key == "prototype" {
				return errors.New("invalid UI key")
			}
			if err := safeUIValue(item, depth+1, count); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range v {
			if err := safeUIValue(item, depth+1, count); err != nil {
				return err
			}
		}
	}
	return nil
}

func parseUISpec(body string) (map[string]any, error) {
	if len(body) > uiMaxBytes {
		return nil, errors.New("UI exceeds size limit")
	}
	var whole map[string]any
	if json.Unmarshal([]byte(body), &whole) == nil && whole["op"] == nil {
		return whole, validateUISpec(whole)
	}
	spec := map[string]any{}
	operations := 0
	for _, line := range strings.Split(body, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		operations++
		if operations > 500 {
			return nil, errors.New("too many UI operations")
		}
		var patch map[string]any
		if json.Unmarshal([]byte(line), &patch) != nil {
			return nil, errors.New("invalid UI patch")
		}
		op, _ := patch["op"].(string)
		path, _ := patch["path"].(string)
		if op != "add" && op != "replace" && op != "remove" {
			return nil, errors.New("unsupported UI operation")
		}
		for key := range patch {
			if key != "op" && key != "path" && key != "value" {
				return nil, errors.New("invalid UI operation field")
			}
		}
		if !strings.HasPrefix(path, "/") {
			return nil, errors.New("invalid UI path")
		}
		parts := strings.Split(path[1:], "/")
		if len(parts) > 8 {
			return nil, errors.New("invalid UI path")
		}
		for _, key := range parts {
			if !validUIKey(key) {
				return nil, errors.New("invalid UI path")
			}
		}
		if parts[0] != "root" && parts[0] != "elements" && parts[0] != "state" && parts[0] != "catalogVersion" {
			return nil, errors.New("invalid UI root")
		}
		parent := spec
		for _, key := range parts[:len(parts)-1] {
			next, ok := parent[key].(map[string]any)
			if !ok {
				return nil, errors.New("UI parent is missing")
			}
			parent = next
		}
		key := parts[len(parts)-1]
		if _, exists := parent[key]; op != "add" && !exists {
			return nil, errors.New("UI patch target is missing")
		}
		if op == "remove" {
			delete(parent, key)
		} else {
			value, exists := patch["value"]
			if !exists {
				return nil, errors.New("UI patch value missing")
			}
			parent[key] = value
		}
	}
	return spec, validateUISpec(spec)
}

func validateUIState(state map[string]any) error {
	if state == nil || len(state) > 64 {
		return errors.New("invalid UI state")
	}
	for key, value := range state {
		if !validUIKey(key) {
			return errors.New("invalid UI state field")
		}
		switch v := value.(type) {
		case nil, bool, float64:
		case string:
			if len(utf16.Encode([]rune(v))) > 8000 {
				return errors.New("UI field too long")
			}
		default:
			return errors.New("UI state must contain scalar values")
		}
	}
	raw, _ := json.Marshal(state)
	if len(raw) > 32768 {
		return errors.New("UI state too large")
	}
	return nil
}

func validateUISpec(spec map[string]any) error {
	count := 0
	if err := safeUIValue(spec, 0, &count); err != nil {
		return err
	}
	for key := range spec {
		if key != "root" && key != "elements" && key != "state" && key != "catalogVersion" {
			return errors.New("unsupported UI configuration")
		}
	}
	if v, ok := spec["catalogVersion"]; ok && v != float64(1) {
		return errors.New("unsupported UI catalog version")
	}
	state, _ := spec["state"].(map[string]any)
	if state == nil {
		state = map[string]any{}
	}
	if err := validateUIState(state); err != nil {
		return err
	}
	elements, ok := spec["elements"].(map[string]any)
	if !ok || len(elements) > 150 {
		return errors.New("invalid UI elements")
	}
	var catalog struct {
		Components map[string]map[string]any `json:"components"`
	}
	if err := json.Unmarshal(generativeUICatalog, &catalog); err != nil {
		return err
	}
	for id, raw := range elements {
		if !validUIKey(id) {
			return errors.New("invalid UI element id")
		}
		element, ok := raw.(map[string]any)
		if !ok {
			return errors.New("invalid UI element")
		}
		name, _ := element["type"].(string)
		schema, ok := catalog.Components[name]
		if !ok {
			return errors.New("unknown UI component")
		}
		for key := range element {
			if key != "type" && key != "props" && key != "children" && key != "visible" && key != "on" {
				return errors.New("unsupported UI behavior")
			}
		}
		props, ok := element["props"].(map[string]any)
		if !ok {
			return errors.New("invalid UI props")
		}
		if err := validateUIProps(props, schema, state); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		for prop, value := range props {
			if expr, ok := value.(map[string]any); ok {
				if _, bound := expr["$bindState"]; bound && !((prop == "value" && (name == "Input" || name == "Select" || name == "Slider")) || (prop == "checked" && name == "Checkbox")) {
					return errors.New("invalid UI binding")
				}
			}
		}
		if visible, exists := element["visible"]; exists {
			if _, ok := visible.(bool); !ok {
				expr, ok := visible.(map[string]any)
				if !ok || len(expr) != 1 {
					return errors.New("invalid visibility")
				}
				key, valid := uiPath(expr["$state"])
				if _, ok := state[key].(bool); !valid || !ok {
					return errors.New("visibility requires a boolean state")
				}
			}
		}
		if children, exists := element["children"]; exists {
			list, ok := children.([]any)
			if !ok || len(list) > 150 {
				return errors.New("invalid UI children")
			}
			for _, child := range list {
				if _, ok := child.(string); !ok {
					return errors.New("invalid UI child")
				}
			}
		}
		if rawOn, exists := element["on"]; exists {
			on, ok := rawOn.(map[string]any)
			if !ok || name != "Button" || len(on) != 1 {
				return errors.New("only button presses can execute UI actions")
			}
			binding, ok := on["press"].(map[string]any)
			if !ok {
				if list, ok := on["press"].([]any); ok && len(list) == 1 {
					binding, ok = list[0].(map[string]any)
					if !ok {
						return errors.New("invalid button action")
					}
				} else {
					return errors.New("invalid button action")
				}
			}
			if len(binding) > 2 {
				return errors.New("invalid button action")
			}
			for key := range binding {
				if key != "action" && key != "params" {
					return errors.New("invalid button action field")
				}
			}
			params, _ := binding["params"].(map[string]any)
			switch binding["action"] {
			case "continueConversation":
				message, _ := params["message"].(string)
				if strings.TrimSpace(message) == "" || len([]rune(message)) > 2000 || len(params) != 1 {
					return errors.New("invalid continue message")
				}
			case "setState":
				key, ok := uiPath(params["statePath"])
				initial, exists := state[key]
				value, provided := params["value"]
				if !ok || !exists || !provided || len(params) != 2 || reflect.TypeOf(initial) != reflect.TypeOf(value) {
					return errors.New("invalid state action")
				}
				if err := validateUIState(map[string]any{key: value}); err != nil {
					return err
				}
			default:
				return errors.New("unsupported UI action")
			}
		}
	}
	expanded := 0
	var walk func(string, map[string]bool) error
	walk = func(id string, parents map[string]bool) error {
		expanded++
		if expanded > 400 || len(parents) > 16 || parents[id] {
			return errors.New("cyclic or oversized UI tree")
		}
		raw, ok := elements[id].(map[string]any)
		if !ok {
			return errors.New("UI child missing")
		}
		next := map[string]bool{}
		for k, v := range parents {
			next[k] = v
		}
		next[id] = true
		children, _ := raw["children"].([]any)
		for _, child := range children {
			if err := walk(child.(string), next); err != nil {
				return err
			}
		}
		return nil
	}
	root, _ := spec["root"].(string)
	if err := walk(root, map[string]bool{}); err != nil {
		return err
	}
	for id := range elements {
		if err := walk(id, map[string]bool{}); err != nil {
			return err
		}
	}
	return nil
}

// The generated JSON schemas are the same prop contracts used by the web catalog.
func validateUIProps(value any, schema map[string]any, state map[string]any) error {
	if expr, ok := value.(map[string]any); ok {
		for key := range expr {
			if strings.HasPrefix(key, "$") {
				switch key {
				case "$state", "$bindState":
					path, valid := uiPath(expr[key])
					v, exists := state[path]
					if !valid || !exists || len(expr) != 1 {
						return errors.New("invalid state expression")
					}
					return validateUIProps(v, schema, nil)
				case "$computed":
					name, _ := expr[key].(string)
					if name != "calculate" && name != "formatNumber" && name != "filterRows" {
						return errors.New("unknown UI computation")
					}
					if len(expr) > 2 {
						return errors.New("invalid computation")
					}
					return validateUIExpressions(expr["args"], state, 0)
				default:
					return errors.New("unknown UI expression")
				}
			}
		}
	}
	if variants, ok := schema["anyOf"].([]any); ok {
		for _, variant := range variants {
			if sub, ok := variant.(map[string]any); ok && validateUIProps(value, sub, state) == nil {
				return nil
			}
		}
		return errors.New("invalid property type")
	}
	if choices, ok := schema["enum"].([]any); ok {
		for _, choice := range choices {
			if reflect.DeepEqual(choice, value) {
				return nil
			}
		}
		return errors.New("invalid property value")
	}
	switch schema["type"] {
	case "string":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected string")
		}
		if max, ok := schema["maxLength"].(float64); ok && len([]rune(v)) > int(max) {
			return errors.New("text too long")
		}
	case "number", "integer":
		v, ok := value.(float64)
		if !ok {
			return errors.New("expected number")
		}
		if minimum, ok := schema["exclusiveMinimum"].(float64); ok && v <= minimum {
			return errors.New("number out of range")
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return errors.New("expected boolean")
		}
	case "null":
		if value != nil {
			return errors.New("expected null")
		}
	case "array":
		list, ok := value.([]any)
		if !ok {
			return errors.New("expected array")
		}
		if max, ok := schema["maxItems"].(float64); ok && len(list) > int(max) {
			return errors.New("array too long")
		}
		if min, ok := schema["minItems"].(float64); ok && len(list) < int(min) {
			return errors.New("array too short")
		}
		if sub, ok := schema["items"].(map[string]any); ok {
			for _, item := range list {
				if err := validateUIProps(item, sub, state); err != nil {
					return err
				}
			}
		}
	case "object":
		obj, ok := value.(map[string]any)
		if !ok {
			return errors.New("expected object")
		}
		properties, _ := schema["properties"].(map[string]any)
		required, _ := schema["required"].([]any)
		for _, raw := range required {
			if _, ok := obj[raw.(string)]; !ok {
				return errors.New("required property missing")
			}
		}
		for key, item := range obj {
			if sub, ok := properties[key].(map[string]any); ok {
				if err := validateUIProps(item, sub, state); err != nil {
					return err
				}
			} else if schema["additionalProperties"] == false {
				return errors.New("unknown property")
			} else if sub, ok := schema["additionalProperties"].(map[string]any); ok {
				if err := validateUIProps(item, sub, state); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
func validateUIExpressions(value any, state map[string]any, depth int) error {
	if depth > 15 {
		return errors.New("UI expression too deep")
	}
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
			if strings.HasPrefix(key, "$") {
				if key == "$state" || key == "$bindState" {
					path, ok := uiPath(item)
					if _, exists := state[path]; !ok || !exists {
						return errors.New("invalid state expression")
					}
				} else if key == "$computed" {
					if item != "calculate" && item != "formatNumber" && item != "filterRows" {
						return errors.New("unknown computation")
					}
				} else {
					return errors.New("unknown expression")
				}
			}
			if err := validateUIExpressions(item, state, depth+1); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range v {
			if err := validateUIExpressions(item, state, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

type uiStateRequest struct {
	MessageID        string         `json:"messageId"`
	BlockIndex       int            `json:"blockIndex"`
	CatalogVersion   int            `json:"catalogVersion"`
	ContentHash      string         `json:"contentHash"`
	ExpectedRevision int            `json:"expectedRevision"`
	State            map[string]any `json:"state"`
}
type uiStateSnapshot struct {
	MessageID      string         `json:"messageId"`
	BlockIndex     int            `json:"blockIndex"`
	CatalogVersion int            `json:"catalogVersion"`
	ContentHash    string         `json:"contentHash"`
	Revision       int            `json:"revision"`
	State          map[string]any `json:"state"`
}

func (h *handler) saveUIState(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, session := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	if _, err := h.store.GetSession(r.Context(), p.TenantID, agent, session); err != nil {
		statusErr(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 65536)
	var in uiStateRequest
	if httpx.DecodeJSON(r, &in) != nil || in.MessageID == "" || in.BlockIndex < 0 || in.BlockIndex > 30 || in.CatalogVersion != 1 || in.ExpectedRevision < 0 {
		httpx.Error(w, 400, "invalid UI state request")
		return
	}
	if err := validateUIState(in.State); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	snapshot, err := h.store.saveUIState(r.Context(), p.TenantID, agent, session, in)
	if err != nil {
		if errors.Is(err, ErrConflict) || errors.Is(err, ErrNotFound) {
			statusErr(w, err)
		} else {
			httpx.Error(w, 400, err.Error())
		}
		return
	}
	httpx.JSON(w, 200, snapshot)
}

func (s *Store) saveUIState(ctx context.Context, tenant, agent, session string, in uiStateRequest) (uiStateSnapshot, error) {
	var out uiStateSnapshot
	err := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Table("cloud_agent_sessions").Where("tenant_id=? AND agent_id=? AND id=?", tenant, agent, session).UpdateColumn("last_seq", gorm.Expr("last_seq"))
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return ErrNotFound
		}
		var owner struct {
			Origin string `gorm:"column:origin_json"`
		}
		if err := tx.Table("cloud_agent_sessions").Select("origin_json").Where("id=?", session).Take(&owner).Error; err != nil {
			return err
		}
		var origin map[string]any
		_ = json.Unmarshal([]byte(owner.Origin), &origin)
		if origin["channel"] == "openai-gateway" {
			return errors.New("gateway sessions are read-only")
		}
		var rows []struct {
			ID      string  `gorm:"column:id"`
			Type    string  `gorm:"column:type"`
			RunID   *string `gorm:"column:run_id"`
			Payload string  `gorm:"column:payload_json"`
		}
		if err := tx.Table("cloud_agent_events").Select("id,type,run_id,payload_json").Where("session_id=? AND type IN ?", session, []string{"assistant_message", "assistant_rollback", "ui_state_updated"}).Order("seq").Find(&rows).Error; err != nil {
			return err
		}
		content := ""
		var runID *string
		found, rolledBack := false, false
		revision := 0
		for _, row := range rows {
			var payload map[string]any
			if json.Unmarshal([]byte(row.Payload), &payload) != nil {
				continue
			}
			mid, _ := payload["messageId"].(string)
			if mid == "" {
				mid = row.ID
			}
			if mid != in.MessageID {
				continue
			}
			switch row.Type {
			case "assistant_message":
				content, _ = payload["content"].(string)
				if content == "" {
					content, _ = payload["text"].(string)
				}
				runID = row.RunID
				found = true
			case "assistant_rollback":
				rolledBack = true
			case "ui_state_updated":
				var snapshot uiStateSnapshot
				if json.Unmarshal([]byte(row.Payload), &snapshot) == nil && snapshot.BlockIndex == in.BlockIndex && snapshot.ContentHash == in.ContentHash && snapshot.Revision > revision {
					revision = snapshot.Revision
				}
			}
		}
		if !found || rolledBack {
			return ErrNotFound
		}
		blocks := uiBlocks(content)
		if in.BlockIndex >= len(blocks) || !blocks[in.BlockIndex].Closed {
			return errors.New("UI block is not complete")
		}
		block := blocks[in.BlockIndex]
		if uiContentDigest(block.Content) != in.ContentHash {
			return ErrConflict
		}
		spec, err := parseUISpec(block.Content)
		if err != nil {
			return err
		}
		defaults, _ := spec["state"].(map[string]any)
		if len(defaults) != len(in.State) {
			return errors.New("UI state fields differ")
		}
		for key, value := range in.State {
			initial, exists := defaults[key]
			if !exists || reflect.TypeOf(initial) != reflect.TypeOf(value) {
				return errors.New("UI state type differs")
			}
		}
		if revision != in.ExpectedRevision {
			return ErrConflict
		}
		out = uiStateSnapshot{in.MessageID, in.BlockIndex, 1, in.ContentHash, revision + 1, in.State}
		_, err = s.appendEventTx(ctx, tx, session, "ui_state_updated", runID, out)
		return err
	})
	return out, err
}
