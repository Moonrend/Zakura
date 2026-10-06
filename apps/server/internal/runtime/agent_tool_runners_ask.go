// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

func builtinBoolArg(args map[string]any, key string) bool {
	value, _ := args[key].(bool)
	return value
}

type askUserQuestionRow struct {
	Status     string  `gorm:"column:status"`
	AnswerJSON string  `gorm:"column:answer_json"`
	ExpiresAt  *string `gorm:"column:expires_at"`
}

func (h *handler) runAskUserTool(ctx context.Context, tenant, agent, session, toolCallID string, args json.RawMessage) (json.RawMessage, error) {
	parsed := map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return nil, fmt.Errorf("invalid tool arguments: %w", err)
		}
	}
	question := strings.TrimSpace(builtinStringArg(parsed, "question"))
	if question == "" {
		return nil, errors.New("question is required")
	}
	optionsRaw := json.RawMessage("[]")
	if value, ok := parsed["options"]; ok {
		if encoded, err := json.Marshal(value); err == nil {
			optionsRaw = encoded
		}
	}
	defaultRaw := json.RawMessage("[]")
	hasDefaults := false
	if value, ok := parsed["defaultOptionIds"]; ok {
		if encoded, err := json.Marshal(value); err == nil {
			defaultRaw = encoded
		}
		if list, ok := value.([]any); ok && len(list) > 0 {
			hasDefaults = true
		}
	}
	mode := strings.TrimSpace(builtinStringArg(parsed, "mode"))
	if mode != "async" {
		mode = "sync"
	}
	timeoutSeconds := builtinIntArg(parsed, "timeoutSeconds", 600)
	if timeoutSeconds < 15 {
		timeoutSeconds = 15
	}
	if timeoutSeconds > 3600 {
		timeoutSeconds = 3600
	}
	timeoutAction := "skip"
	if hasDefaults {
		timeoutAction = "default"
	}
	requestID, err := h.store.CreateQuestion(ctx, tenant, agent, session, "", toolCallID, QuestionRequest{
		Question:         question,
		Options:          optionsRaw,
		AllowMultiple:    builtinBoolArg(parsed, "allowMultiple"),
		Secret:           builtinBoolArg(parsed, "secret"),
		Mode:             mode,
		TimeoutSeconds:   &timeoutSeconds,
		TimeoutAction:    timeoutAction,
		DefaultOptionIDs: defaultRaw,
		Placeholder:      builtinStringArg(parsed, "placeholder"),
	})
	if err != nil {
		return nil, err
	}
	if mode == "async" {
		return builtinJSON(map[string]any{"requestId": requestID, "status": "sent", "summary": "Question sent to the user asynchronously. The answer will arrive as a new message."})
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		row, err := h.getAskUserQuestion(ctx, requestID, tenant, agent, session)
		if err != nil {
			if ctx.Err() != nil {
				return nil, errors.New("ask_user cancelled")
			}
			return nil, err
		}
		if row.Status != "pending" {
			return askUserResult(row, requestID)
		}
		if row.ExpiresAt != nil {
			expires := parseTime(*row.ExpiresAt)
			if !expires.IsZero() && !expires.After(h.store.now()) {
				_, _ = h.store.ExpireInteractions(ctx)
				row, err = h.getAskUserQuestion(ctx, requestID, tenant, agent, session)
				if err != nil {
					if ctx.Err() != nil {
						return nil, errors.New("ask_user cancelled")
					}
					return nil, err
				}
				if row.Status == "pending" {
					return builtinJSON(map[string]any{"requestId": requestID, "status": "timeout", "summary": "The question timed out before the user replied."})
				}
				return askUserResult(row, requestID)
			}
		}
		select {
		case <-ctx.Done():
			return nil, errors.New("ask_user cancelled")
		case <-ticker.C:
		}
	}
}

func (h *handler) getAskUserQuestion(ctx context.Context, requestID, tenant, agent, session string) (askUserQuestionRow, error) {
	var row askUserQuestionRow
	err := h.deps.Gorm.WithContext(ctx).Table("agent_user_questions").Select("status, answer_json, expires_at").Where("id = ? AND tenant_id = ? AND agent_id = ? AND session_id = ?", requestID, tenant, agent, session).Take(&row).Error
	if err != nil {
		return askUserQuestionRow{}, err
	}
	return row, nil
}

func askUserResult(row askUserQuestionRow, requestID string) (json.RawMessage, error) {
	switch row.Status {
	case "cancelled":
		return builtinJSON(map[string]any{"requestId": requestID, "status": "cancelled", "summary": "The user cancelled the question."})
	case "timeout":
		return builtinJSON(map[string]any{"requestId": requestID, "status": "timeout", "summary": "The question timed out before the user replied."})
	}
	text := ""
	var selected any
	answer := map[string]any{}
	if err := json.Unmarshal([]byte(row.AnswerJSON), &answer); err == nil && (answer["cancelled"] != nil || answer["text"] != nil || answer["selected"] != nil) {
		if cancelled, _ := answer["cancelled"].(bool); cancelled {
			return builtinJSON(map[string]any{"requestId": requestID, "status": "cancelled", "summary": "The user cancelled the question."})
		}
		if value, ok := answer["text"].(string); ok {
			text = value
		}
		selected = answer["selected"]
	} else {
		var list []string
		if json.Unmarshal([]byte(row.AnswerJSON), &list) == nil && len(list) > 0 {
			selected = list
		}
	}
	summary := "User answered."
	switch {
	case strings.TrimSpace(text) != "" && selected != nil:
		summary = "User answered: " + text + "; selected: " + joinAnswerValues(selected)
	case strings.TrimSpace(text) != "":
		summary = "User answered: " + text
	case selected != nil:
		summary = "User selected: " + joinAnswerValues(selected)
	}
	out := map[string]any{"requestId": requestID, "status": "answered", "summary": summary}
	if text != "" {
		out["text"] = text
	}
	if selected != nil {
		out["selected"] = selected
	}
	return builtinJSON(out)
}

func joinAnswerValues(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []string:
		return strings.Join(v, ", ")
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			parts = append(parts, fmt.Sprint(item))
		}
		return strings.Join(parts, ", ")
	}
	return fmt.Sprint(value)
}
