// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
)

func (h *handler) runBuiltinToolSessions(ctx context.Context, tenant, agent, name string, args map[string]any) (json.RawMessage, error) {
	switch name {
	case "list_sessions":
		return h.runListSessions(ctx, tenant, agent, args)
	case "search_sessions":
		return h.runSearchSessions(ctx, tenant, agent, args)
	case "import_session":
		return h.runImportSession(ctx, tenant, agent, args)
	case "list_routines":
		return h.runListRoutines(ctx, tenant, agent, args)
	case "create_routine":
		return h.runCreateRoutine(ctx, tenant, agent, args)
	case "update_routine":
		return h.runUpdateRoutine(ctx, tenant, agent, args)
	case "pause_routine":
		return h.runPauseRoutine(ctx, tenant, agent, args)
	case "delete_routine":
		return h.runDeleteRoutine(ctx, tenant, agent, args)
	case "run_routine":
		return h.runRunRoutine(ctx, tenant, agent, args)
	case "list_automation_runs":
		return h.runListAutomationRuns(ctx, tenant, agent, args)
	case "apply_patch":
		return h.runApplyPatch(ctx, tenant, agent, args)
	}
	return nil, fmt.Errorf("unknown builtin tool %q", name)
}

func sessionSummary(s Session) map[string]any {
	model := ""
	if s.Model != nil {
		model = *s.Model
	}
	return map[string]any{
		"id":        s.ID,
		"title":     s.Title,
		"kind":      s.Kind,
		"status":    s.Status,
		"model":     model,
		"createdAt": runtimeTimeString(s.CreatedAt),
		"updatedAt": runtimeTimeString(s.UpdatedAt),
	}
}

func sessionSummaries(sessions []Session) []map[string]any {
	out := make([]map[string]any, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, sessionSummary(s))
	}
	return out
}

func (h *handler) runListSessions(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	limit := builtinIntArg(args, "limit", 20)
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	kind := strings.TrimSpace(builtinStringArg(args, "kind"))
	var kinds []string
	if kind != "" {
		kinds = []string{kind}
	}
	sessions, err := h.store.ListSessions(ctx, tenant, agent, kinds, limit, 0)
	if err != nil {
		return nil, err
	}
	return builtinJSON(map[string]any{"sessions": sessionSummaries(sessions)})
}

func (h *handler) runSearchSessions(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	query := strings.TrimSpace(builtinStringArg(args, "query"))
	if query == "" {
		return nil, errors.New("query is required")
	}
	limit := builtinIntArg(args, "limit", 20)
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	sessions, err := h.store.SearchSessions(ctx, tenant, query, limit)
	if err != nil {
		return nil, err
	}
	return builtinJSON(map[string]any{"query": query, "sessions": sessionSummaries(sessions)})
}

func (h *handler) runImportSession(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	title := strings.TrimSpace(builtinStringArg(args, "title"))
	if title == "" {
		title = "Imported session"
	}
	rawMessages, _ := args["messages"].([]any)
	if len(rawMessages) == 0 {
		return nil, errors.New("messages must not be empty")
	}
	type importedMessage struct {
		role    string
		content string
	}
	messages := make([]importedMessage, 0, len(rawMessages))
	for _, item := range rawMessages {
		entry, _ := item.(map[string]any)
		role := strings.TrimSpace(builtinStringArg(entry, "role"))
		if role != "user" && role != "assistant" {
			return nil, errors.New("message role must be user or assistant")
		}
		messages = append(messages, importedMessage{role: role, content: builtinStringArg(entry, "content")})
	}
	sess, err := h.store.CreateSession(ctx, tenant, "", agent, Session{Kind: "chat", Title: title})
	if err != nil {
		return nil, err
	}
	for _, message := range messages {
		eventType := "user_message"
		if message.role == "assistant" {
			eventType = "assistant_message"
		}
		if _, err := h.store.AppendEvent(ctx, tenant, agent, sess.ID, eventType, nil, map[string]any{"content": message.content}); err != nil {
			return nil, err
		}
	}
	return builtinJSON(map[string]any{"sessionId": sess.ID, "imported": len(messages)})
}

func (h *handler) runGetMessages(ctx context.Context, tenant, agent, session string, args json.RawMessage) (json.RawMessage, error) {
	parsed := map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return nil, fmt.Errorf("invalid tool arguments: %w", err)
		}
	}
	sessionID := strings.TrimSpace(builtinStringArg(parsed, "session_id"))
	if sessionID == "" {
		sessionID = session
	}
	if sessionID == "" {
		return nil, errors.New("session_id is required")
	}
	limit := builtinIntArg(parsed, "limit", 200)
	if limit < 1 {
		limit = 200
	}
	events, err := h.store.ListEvents(ctx, tenant, agent, sessionID, 0, 1000)
	if err != nil {
		return nil, err
	}
	messages := make([]map[string]any, 0, len(events))
	for _, ev := range events {
		role := ""
		switch ev.Type {
		case "user_message":
			role = "user"
		case "assistant_message":
			role = "assistant"
		default:
			continue
		}
		var payload struct {
			Content string `json:"content"`
		}
		if json.Unmarshal(ev.Payload, &payload) != nil {
			continue
		}
		messages = append(messages, map[string]any{"role": role, "content": payload.Content, "createdAt": runtimeTimeString(ev.CreatedAt)})
	}
	if len(messages) > limit {
		messages = messages[len(messages)-limit:]
	}
	return builtinJSON(map[string]any{"messages": messages})
}

func (h *handler) runListRoutines(ctx context.Context, tenant, agent string, _ map[string]any) (json.RawMessage, error) {
	rows, err := h.listScheduleRows(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	routines := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		routines = append(routines, map[string]any{
			"id":         row.ID,
			"name":       row.Name,
			"enabled":    row.Enabled,
			"schedule":   row.Pattern,
			"nextRunAt":  row.NextRunAt,
			"lastRunAt":  row.LastRunAt,
			"lastStatus": row.LastStatus,
		})
	}
	return builtinJSON(map[string]any{"routines": routines})
}

func (h *handler) runCreateRoutine(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	name := strings.TrimSpace(builtinStringArg(args, "name"))
	prompt := strings.TrimSpace(builtinStringArg(args, "prompt"))
	schedule := strings.TrimSpace(builtinStringArg(args, "schedule"))
	if name == "" || prompt == "" || schedule == "" {
		return nil, errors.New("name, prompt and schedule are required")
	}
	created, err := h.createScheduleInternal(ctx, tenant, agent, Schedule{Name: name, Prompt: prompt, Pattern: schedule, TriggerKind: "cron", Timezone: "UTC", Enabled: true})
	if err != nil {
		return nil, err
	}
	return builtinJSON(map[string]any{"id": created.ID, "name": created.Name, "schedule": created.Pattern, "nextRunAt": created.NextRunAt})
}

func (h *handler) runUpdateRoutine(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	id := strings.TrimSpace(builtinStringArg(args, "id"))
	if id == "" {
		return nil, errors.New("id is required")
	}
	patch := map[string]any{}
	if value, ok := args["name"]; ok {
		patch["name"] = value
	}
	if value, ok := args["prompt"]; ok {
		patch["prompt"] = value
	}
	if value, ok := args["schedule"]; ok {
		patch["pattern"] = value
	}
	if value, ok := args["enabled"]; ok {
		patch["enabled"] = value
	}
	updated, err := h.patchScheduleInternal(ctx, tenant, agent, id, patch)
	if err != nil {
		return nil, err
	}
	return builtinJSON(map[string]any{"id": updated.ID, "enabled": updated.Enabled, "schedule": updated.Pattern, "nextRunAt": updated.NextRunAt})
}

func (h *handler) runPauseRoutine(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	id := strings.TrimSpace(builtinStringArg(args, "id"))
	if id == "" {
		return nil, errors.New("id is required")
	}
	updated, err := h.patchScheduleInternal(ctx, tenant, agent, id, map[string]any{"enabled": false})
	if err != nil {
		return nil, err
	}
	return builtinJSON(map[string]any{"id": updated.ID, "enabled": updated.Enabled})
}

func (h *handler) runDeleteRoutine(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	id := strings.TrimSpace(builtinStringArg(args, "id"))
	if id == "" {
		return nil, errors.New("id is required")
	}
	if err := h.deleteScheduleInternal(ctx, tenant, agent, id); err != nil {
		return nil, err
	}
	return builtinJSON(map[string]any{"deleted": true, "id": id})
}

func (h *handler) runRunRoutine(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	id := strings.TrimSpace(builtinStringArg(args, "id"))
	if id == "" {
		return nil, errors.New("id is required")
	}
	run, err := h.runScheduleInternal(ctx, tenant, agent, id)
	if err != nil {
		return nil, err
	}
	return builtinJSON(map[string]any{"runId": run.ID, "id": run.ID, "sessionId": run.SessionID, "status": run.Status, "prompt": run.Prompt})
}

func (h *handler) runListAutomationRuns(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	limit := builtinIntArg(args, "limit", 20)
	if limit < 1 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	runs, err := h.listAutomationRunsInternal(ctx, tenant, agent, "", limit)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(runs))
	for _, run := range runs {
		out = append(out, map[string]any{
			"id":         run.ID,
			"kind":       run.Kind,
			"status":     run.Status,
			"prompt":     run.Prompt,
			"resultText": run.ResultText,
			"error":      run.Error,
			"createdAt":  runtimeTimeString(run.CreatedAt),
		})
	}
	return builtinJSON(map[string]any{"runs": out})
}

func (h *handler) findDelegateAgent(ctx context.Context, tenant, ref string) (Agent, error) {
	if found, err := h.store.GetAgent(ctx, tenant, ref); err == nil {
		return found, nil
	}
	var bySlug agentColumns
	if err := h.deps.Gorm.WithContext(ctx).Table("agents").Select(agentColumnsList).Where("tenant_id = ? AND slug = ?", tenant, ref).Take(&bySlug).Error; err == nil {
		return bySlug.agent(), nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return Agent{}, err
	}
	var byName agentColumns
	if err := h.deps.Gorm.WithContext(ctx).Table("agents").Select(agentColumnsList).Where("tenant_id = ? AND name = ?", tenant, ref).Order("created_at DESC, id DESC").Take(&byName).Error; err == nil {
		return byName.agent(), nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return Agent{}, err
	}
	return Agent{}, fmt.Errorf("unknown agent %q", ref)
}

func truncateText(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func (h *handler) lastAssistantMessage(ctx context.Context, tenant, agent, session string) (string, error) {
	events, err := h.store.ListEvents(ctx, tenant, agent, session, 0, 1000)
	if err != nil {
		return "", err
	}
	text := ""
	for _, ev := range events {
		if ev.Type != "assistant_message" {
			continue
		}
		var payload struct {
			Content string `json:"content"`
		}
		if json.Unmarshal(ev.Payload, &payload) == nil {
			text = payload.Content
		}
	}
	return text, nil
}

func (h *handler) runDelegateAgent(ctx context.Context, tenant, agent, session, toolCallID string, args json.RawMessage) (json.RawMessage, error) {
	parsed := map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return nil, fmt.Errorf("invalid tool arguments: %w", err)
		}
	}
	ref := strings.TrimSpace(builtinStringArg(parsed, "agent"))
	prompt := builtinStringArg(parsed, "prompt")
	if ref == "" || strings.TrimSpace(prompt) == "" {
		return nil, errors.New("agent and prompt are required")
	}
	if session == "" {
		return nil, errors.New("delegate_agent requires an active session")
	}
	current, err := h.store.GetSession(ctx, tenant, agent, session)
	if err != nil {
		return nil, err
	}
	if current.Kind == "delegate" {
		return nil, errors.New("delegation is not available in delegated sessions")
	}
	child, err := h.findDelegateAgent(ctx, tenant, ref)
	if err != nil {
		return nil, err
	}
	if child.ID == agent {
		return nil, errors.New("cannot delegate to yourself")
	}
	childSession, err := h.store.CreateSession(ctx, tenant, "", child.ID, Session{Kind: "delegate", Title: "Delegated: " + truncateText(prompt, 60)})
	if err != nil {
		return nil, err
	}
	_, _ = h.store.AppendEvent(ctx, tenant, agent, session, "tool_call_delegate", nil, map[string]any{"childSessionId": childSession.ID, "childAgentId": child.ID})
	if toolCallID != "" {
		_, _ = h.store.AppendEvent(ctx, tenant, agent, session, "tool_call_result", nil, map[string]any{"toolCallId": toolCallID, "childSessionId": childSession.ID, "childAgentId": child.ID})
	}
	run, queued, err := h.service.StartTurn(ctx, tenant, child.ID, childSession.ID, prompt, nil, nil, false)
	if err != nil {
		return nil, err
	}
	if queued != nil {
		return nil, errors.New("target agent is busy")
	}
	pollCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-pollCtx.Done():
			return nil, errors.New("delegation timed out")
		case <-ticker.C:
		}
		current, err := h.store.GetRun(pollCtx, tenant, child.ID, childSession.ID, run.ID)
		if err != nil {
			return nil, err
		}
		switch current.Status {
		case "completed":
			response, err := h.lastAssistantMessage(pollCtx, tenant, child.ID, childSession.ID)
			if err != nil {
				return nil, err
			}
			return builtinJSON(map[string]any{"childSessionId": childSession.ID, "childAgentId": child.ID, "status": current.Status, "response": response})
		case "failed":
			message := ""
			if current.Error != nil {
				message = *current.Error
			}
			return nil, errors.New("delegated run failed: " + message)
		case "cancelled":
			return nil, errors.New("delegated run cancelled")
		}
	}
}

func runtimeOutputSummary(results ...map[string]any) string {
	for _, result := range results {
		if result == nil {
			continue
		}
		for _, key := range []string{"stderr", "stdout"} {
			if value, ok := result[key].(string); ok && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}
	return "patch did not apply"
}

func (h *handler) runApplyPatch(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	patch := builtinStringArg(args, "patch")
	if strings.TrimSpace(patch) == "" {
		return nil, errors.New("patch is required")
	}
	remote, selected, err := h.remoteWorkspace(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if !selected {
		return nil, errors.New("no runtime node bound to this space")
	}
	nonce := make([]byte, 4)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	rel := ".zakura/patches/" + hex.EncodeToString(nonce) + ".patch"
	if _, err := remote.write(ctx, "/"+rel, []byte(patch)); err != nil {
		return nil, err
	}
	result, applyErr := h.runtimeExec(ctx, tenant, agent, "bash", "-lc", "git apply --whitespace=nowarn "+rel)
	if applyErr != nil {
		fallback, fallbackErr := h.runtimeExec(ctx, tenant, agent, "bash", "-lc", "patch -p1 --fuzz=3 < "+rel)
		if fallbackErr != nil {
			_, _ = h.runtimeExec(ctx, tenant, agent, "bash", "-lc", "rm -f "+rel)
			return nil, fmt.Errorf("apply_patch failed: %s", runtimeOutputSummary(fallback, result))
		}
		result = fallback
	}
	_, _ = h.runtimeExec(ctx, tenant, agent, "bash", "-lc", "rm -f "+rel)
	stdout := ""
	if result != nil {
		if value, ok := result["stdout"].(string); ok {
			stdout = value
		}
	}
	return builtinJSON(map[string]any{"applied": true, "stdout": stdout})
}
