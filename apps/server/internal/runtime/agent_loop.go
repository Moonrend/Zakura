// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

// TurnRequest describes a new message or a new variant of an existing message.
// HasParent distinguishes an omitted parent (append) from an explicit nil (root).
type TurnRequest struct {
	Tenant, Agent, Session string
	Content                string
	Context                *MessageContext
	Attachments, Options   json.RawMessage
	MessageID              string
	QueueOnConflict        bool
	FollowUpMode           string
	ParentRunID            *string
	HasParent              bool
	Continue               bool
	Retry                  bool
	ReplyToMessageID       string
	SkipUserMessage        bool
	UserID, UserName       string
}

func (s *Service) Start(ctx context.Context, req TurnRequest) (Run, *QueueMessage, error) {
	mu := s.sessionLock(req.Session)
	mu.Lock()
	defer mu.Unlock()
	return s.startLocked(ctx, req)
}

func (s *Service) startLocked(ctx context.Context, req TurnRequest) (Run, *QueueMessage, error) {
	sess, err := s.store.GetSession(ctx, req.Tenant, req.Agent, req.Session)
	if err != nil {
		return Run{}, nil, err
	}
	agent, err := s.store.GetAgent(ctx, req.Tenant, req.Agent)
	if err != nil {
		return Run{}, nil, err
	}
	if req.Continue {
		req.Content = continueTurnPrompt
	}
	if req.Retry || req.SkipUserMessage {
		if req.ReplyToMessageID == "" {
			events := s.loadHistoryEvents(ctx, req.Session)
			for i := len(events) - 1; i >= 0; i-- {
				if events[i].Type == "user_message" {
					if steer, _ := events[i].Payload["steer"].(bool); steer {
						continue
					}
					req.ReplyToMessageID, _ = events[i].Payload["messageId"].(string)
					if req.ReplyToMessageID == "" {
						req.ReplyToMessageID = "ev:" + events[i].ID
					}
					break
				}
			}
		}
		if req.ReplyToMessageID == "" {
			return Run{}, nil, errors.New("no user message to retry")
		}
		found := false
		for _, event := range s.loadHistoryEvents(ctx, req.Session) {
			if event.Type != "user_message" {
				continue
			}
			id, _ := event.Payload["messageId"].(string)
			if id == "" {
				id = "ev:" + event.ID
			}
			if id != req.ReplyToMessageID {
				continue
			}
			req.Content, _ = event.Payload["content"].(string)
			req.Context = messageContextFromPayload(event.Payload)
			if len(req.Options) == 0 {
				req.Options, _ = json.Marshal(event.Payload["options"])
			}
			req.Attachments, _ = json.Marshal(event.Payload["attachments"])
			found = true
			break
		}
		if !found {
			return Run{}, nil, ErrNotFound
		}
		req.SkipUserMessage = true
	}
	if !req.SkipUserMessage && strings.TrimSpace(req.Content) == "" && !hasAttachments(req.Attachments) {
		return Run{}, nil, errors.New("content or attachments required")
	}
	if len(req.MessageID) > 200 {
		return Run{}, nil, errors.New("messageId too long")
	}
	if req.MessageID != "" && !req.SkipUserMessage && !req.Retry && !req.Continue {
		var prior []struct {
			RunID   *string `gorm:"column:run_id"`
			Payload string  `gorm:"column:payload_json"`
		}
		if err := s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").Select("run_id,payload_json").Where("session_id=? AND type='user_message'", req.Session).Order("seq DESC").Find(&prior).Error; err != nil {
			return Run{}, nil, err
		}
		for _, event := range prior {
			var message struct {
				MessageID string          `json:"messageId"`
				Content   string          `json:"content"`
				Context   *MessageContext `json:"context"`
			}
			if json.Unmarshal([]byte(event.Payload), &message) == nil && message.MessageID == req.MessageID && event.RunID != nil {
				if message.Content != req.Content || !message.Context.equal(req.Context) {
					return Run{}, nil, ErrConflict
				}
				run, err := s.store.GetRun(ctx, req.Tenant, req.Agent, req.Session, *event.RunID)
				return run, nil, err
			}
		}
		queued, err := s.store.PendingQueue(ctx, req.Tenant, req.Agent, req.Session)
		if err != nil {
			return Run{}, nil, err
		}
		for _, message := range queued {
			if message.ID == req.MessageID {
				if message.Content != strings.TrimSpace(req.Content) || !message.Context.equal(req.Context) {
					return Run{}, nil, ErrConflict
				}
				return Run{}, &message, nil
			}
		}
	}
	if sess.ActiveRunID != nil {
		if !req.QueueOnConflict || req.SkipUserMessage {
			return Run{}, nil, ErrConflict
		}
		mode := req.FollowUpMode
		if mode == "" {
			mode = parseCloudConfig(agent.Config).FollowUpMode
		}
		if mode == "" {
			mode = queueModeSteer
		}
		var receipt *acpQueueReceipt
		if sess.Kind == "acp" {
			mode = queueModeQueue
			if s.acpQueueAdmission != nil {
				receipt, err = s.acpQueueAdmission(ctx, req.Tenant, req.Agent, req.Session)
				if err != nil {
					return Run{}, nil, err
				}
			}
		}
		queued, err := s.store.Enqueue(ctx, req.Tenant, req.Agent, req.Session, QueueMessage{ID: req.MessageID, Content: req.Content, Context: req.Context, Attachments: req.Attachments, Options: req.Options, Mode: mode, UserID: req.UserID, UserName: req.UserName})
		if err == nil && receipt != nil {
			s.rememberACPQueueReceipt(req.Tenant, req.Agent, req.Session, queued, receipt)
		}
		return Run{}, &queued, err
	}
	if req.MessageID == "" && !req.SkipUserMessage {
		req.MessageID = s.store.id()
	}
	run, err := s.store.StartRunWith(ctx, req.Tenant, req.Agent, req.Session, runStartSpec{
		MessageID: req.MessageID, Content: req.Content, Context: req.Context, Attachments: req.Attachments, Options: req.Options,
		HasParent: req.HasParent || req.ParentRunID != nil, ParentRunID: req.ParentRunID, Continue: req.Continue,
		SkipUserMessage: req.SkipUserMessage, ReplyTo: req.ReplyToMessageID, UserID: req.UserID, UserName: req.UserName,
	})
	if err != nil {
		return Run{}, nil, err
	}
	// A turn outlives the HTTP request that accepted it, but not the server.
	runCtx, cancel := context.WithCancel(s.store.deps.RunContext())
	if actor, exists := httpx.PrincipalFrom(ctx); exists {
		runCtx = httpx.WithPrincipal(runCtx, actor)
	}
	if receipt, ok := ctx.Value(acpQueueContextKey{}).(*acpQueueReceipt); ok {
		runCtx = context.WithValue(runCtx, acpQueueContextKey{}, receipt)
	}
	runCtx = context.WithValue(runCtx, computerRunKey{}, run.ID)
	runCtx = context.WithValue(runCtx, disabledToolsKey{}, disabledToolSet(req.Options))
	live := s.registerRun(run.ID, req.Session, cancel)
	go s.executeTurn(runCtx, live, req, agent, sess)
	return run, nil, nil
}

func (s *Service) executeTurn(ctx context.Context, live *liveRun, req TurnRequest, agent Agent, sess Session) {
	status := "completed"
	var turnErr error
	defer func() {
		if recovered := recover(); recovered != nil {
			turnErr = fmt.Errorf("agent turn panic: %v", recovered)
		}
		if live.cancelRequested.Load() || errors.Is(turnErr, context.Canceled) || ctx.Err() != nil {
			status = "cancelled"
		} else if turnErr != nil {
			status = "failed"
		}
		settle, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		var errText *string
		if turnErr != nil && status == "failed" {
			message := turnErr.Error()
			errText = &message
		}
		if status == "cancelled" && live.cancelRequested.Load() {
			_ = s.store.deps.Gorm.WithContext(settle).Table("cloud_agent_runs").Where("id=? AND session_id=?", live.id, req.Session).Update("cancel_requested", true).Error
		}
		mu := s.sessionLock(req.Session)
		mu.Lock()
		_ = s.store.FinishRun(settle, req.Tenant, req.Agent, req.Session, live.id, status, errText, nil)
		mu.Unlock()
		s.unregisterRun(live)
		s.startNext(settle, req.Tenant, req.Agent, req.Session)
	}()
	if err := s.store.guardRunWorkspace(ctx, req.Tenant, req.Agent, req.Session, live.id); err != nil {
		turnErr = err
		return
	}
	if sess.Kind == "acp" {
		if s.acpRunner == nil {
			turnErr = errors.New("ACP runtime is unavailable")
			return
		}
		turnErr = s.acpRunner(ctx, req.Tenant, req.Agent, req.Session, live.id, req.Context.render(req.Content))
		if turnErr == nil {
			turnErr = s.publishBotFallback(ctx, req, sess, live.id, "")
		}
		return
	}
	turnErr = s.chatTurn(ctx, live, req, agent, sess)
}

func (s *Service) chatTurn(ctx context.Context, live *liveRun, req TurnRequest, agent Agent, sess Session) error {
	cloud := parseCloudConfig(agent.Config)
	space, err := s.store.GetSpace(ctx, req.Tenant, agent.SpaceID)
	if err != nil {
		return err
	}
	target := req.MessageID
	if req.SkipUserMessage {
		target = req.ReplyToMessageID
	}
	messages := buildChainMessages(s.loadHistoryEvents(ctx, req.Session), target, int(^uint(0)>>1))
	if len(messages) == 0 {
		var attachments any
		_ = json.Unmarshal(req.Attachments, &attachments)
		messages = []chatMessage{userChatMessage(req.Context.render(req.Content), parseChatAttachments(attachments))}
	}
	catalog := agentCatalog{}
	if cloud.EnableTools && s.catalogProvider != nil {
		catalog, err = s.catalogProvider(ctx, req.Tenant, req.Agent)
		if err != nil {
			return err
		}
	}
	input := promptInput{Agent: agent, Space: space, Cloud: cloud, Now: s.store.now(), Tools: reachableToolNames(catalog, disabledToolsFromContext(ctx)), ServerHints: renderServerHints(catalog)}
	if sess.Project != nil {
		input.Project = *sess.Project
	}
	var opts struct {
		Skills    []string       `json:"skills"`
		Reasoning map[string]any `json:"reasoning"`
	}
	_ = json.Unmarshal(req.Options, &opts)
	input.RequestedSkills = opts.Skills
	if agent.EnableMemory && s.memoryRecall != nil {
		input.Memories = s.memoryRecall(ctx, req.Tenant, req.Agent, req.Content)
	}
	if s.skillsProvider != nil {
		input.Skills = s.skillsProvider(ctx, req.Tenant, req.Agent)
	}
	system := buildSystemPrompt(input)
	if s.projectContext != nil {
		project, err := s.projectContext(ctx, req.Tenant, agent.SpaceID, req.Agent, input.Project, opts.Skills, input.Skills)
		if err != nil {
			return err
		}
		ctx = context.WithValue(ctx, agentProjectContextKey{}, project)
		if project != nil {
			system += project.text
		}
		for _, event := range []string{"SessionStart", "UserPromptSubmit"} {
			text, err := s.invokeProjectHooks(ctx, req, live.id, projectHookInput{Event: event, Prompt: req.Content}, false)
			if err != nil {
				return err
			}
			system += text
		}
	}
	spaceCloud := parseCloudConfig(space.Config)
	model := spaceCloud.Model
	routeID := spaceCloud.ModelRouteID
	if cloud.ModelRouteID != "" || cloud.Model != "" {
		model, routeID = cloud.Model, cloud.ModelRouteID
	}
	if sess.Model != nil && *sess.Model != "" {
		model, routeID = *sess.Model, ""
	}
	if sess.ModelRouteID != nil && *sess.ModelRouteID != "" {
		routeID = *sess.ModelRouteID
	}
	if routeID != "" {
		routes, err := s.store.ListRoutes(ctx, req.Tenant, "chat")
		if err != nil {
			return err
		}
		found := false
		for _, route := range routes {
			if route.ID == routeID && route.Status == "ready" {
				model = route.ID
				found = true
				break
			}
		}
		if !found {
			return errors.New("selected model route is unavailable")
		}
	}
	maxRounds := cloud.MaxToolRounds
	if maxRounds <= 0 {
		maxRounds = 64
	}
	maxResult := cloud.MaxToolResultChars
	if maxResult <= 0 {
		maxResult = toolOutputMaxBytes
	}
	var images map[string]inlineImage
	if s.attachmentReader != nil {
		images = resolveImages(ctx, messages, func(ctx context.Context, path string, max int64) ([]byte, error) {
			return s.attachmentReader(ctx, req.Tenant, req.Agent, path, max)
		})
	}
	for round := 0; ; round++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		messages, err = s.compactContext(ctx, req, live.id, model, messages, sessionHistoryBudget, false)
		if err != nil {
			return err
		}
		payload := map[string]any{"model": model, "messages": renderMessages(system, messages, images, "openai"), "stream": true}
		if tools := declaredTools(catalog, nil, disabledToolsFromContext(ctx)); len(tools) > 0 {
			payload["tools"] = tools
		}
		if sess.Reasoning != nil && *sess.Reasoning != "" {
			payload["reasoning_effort"] = *sess.Reasoning
		}
		if effort, ok := opts.Reasoning["effort"].(string); ok && effort != "" {
			payload["reasoning_effort"] = effort
		}
		if len(opts.Reasoning) > 0 {
			payload["reasoning"] = opts.Reasoning
		}
		result, err := s.modelRound(ctx, req, live.id, model, payload)
		if contextOverflow(err) {
			compacted, compactErr := s.compactContext(ctx, req, live.id, model, messages, sessionHistoryBudget/2, true)
			if compactErr == nil && messageBytes(compacted) < messageBytes(messages) {
				messages = compacted
				payload["messages"] = renderMessages(system, messages, images, "openai")
				result, err = s.modelRound(ctx, req, live.id, model, payload)
			}
		}
		if err != nil {
			return err
		}
		if len(result.ToolCalls) > 0 && round >= maxRounds {
			return fmt.Errorf("maximum tool rounds (%d) reached", maxRounds)
		}
		if len(result.ToolCalls) > 0 {
			for i := range result.ToolCalls {
				if result.ToolCalls[i].ID == "" {
					result.ToolCalls[i].ID = s.store.id()
				}
			}
			messages = append(messages, chatMessage{Role: "assistant", Content: result.Text, ToolCalls: result.ToolCalls})
			if err := s.runRoundTools(ctx, req, sess, live.id, result.ToolCalls, catalog, cloud.EnableTools, maxResult, &messages); err != nil {
				return err
			}
		} else {
			messages = append(messages, chatMessage{Role: "assistant", Content: result.Text})
		}
		steers, err := s.store.drainSteers(ctx, req.Tenant, req.Agent, req.Session)
		if err != nil {
			return err
		}
		for steerIndex, steer := range steers {
			contextText, hookErr := s.invokeProjectHooks(ctx, req, live.id, projectHookInput{Event: "UserPromptSubmit", Prompt: steer.Content}, false)
			if hookErr != nil {
				for i := len(steers) - 1; i >= steerIndex; i-- {
					_ = s.store.requeueFront(context.WithoutCancel(ctx), req.Tenant, req.Agent, req.Session, steers[i])
				}
				return hookErr
			}
			if contextText != "" {
				messages = append(messages, chatMessage{Role: "system", Content: contextText})
			}
			payload := map[string]any{"messageId": steer.ID, "content": steer.Content, "attachments": json.RawMessage(validJSON(steer.Attachments, "[]")), "steer": true}
			if steer.Context != nil {
				payload["context"] = steer.Context
			}
			if steer.UserID != "" {
				payload["userId"], payload["userName"] = steer.UserID, steer.UserName
			}
			if _, err := s.store.AppendEvent(ctx, req.Tenant, req.Agent, req.Session, "user_message", &live.id, payload); err != nil {
				_ = s.store.requeueFront(context.WithoutCancel(ctx), req.Tenant, req.Agent, req.Session, steer)
				return err
			}
			var attachments any
			_ = json.Unmarshal(steer.Attachments, &attachments)
			message := userChatMessage(steer.Context.render(steer.Content), parseChatAttachments(attachments))
			message.UserMessageID = steer.ID
			messages = append(messages, message)
		}
		if len(result.ToolCalls) == 0 && len(steers) == 0 {
			if _, err := s.invokeProjectHooks(ctx, req, live.id, projectHookInput{Event: "Stop"}, true); err != nil {
				return err
			}
			if err := s.publishBotFallback(ctx, req, sess, live.id, result.Text); err != nil {
				return err
			}
			if s.postRun {
				go s.afterTurn(req, agent, sess, cloud, model, result.Text)
			}
			return nil
		}
	}
}

// turnStreamSink buffers small deltas without delaying a provider's first text.
type turnStreamSink struct {
	service               *Service
	ctx                   context.Context
	req                   TurnRequest
	runID, messageID      string
	textBuf, reasoningBuf strings.Builder
	lastFlush             time.Time
	err                   error
}

func (sink *turnStreamSink) text(delta string) {
	sink.textBuf.WriteString(delta)
	sink.tick()
}
func (sink *turnStreamSink) reasoning(delta string) {
	sink.reasoningBuf.WriteString(delta)
	sink.tick()
}
func (sink *turnStreamSink) tick() {
	if sink.lastFlush.IsZero() || sink.textBuf.Len()+sink.reasoningBuf.Len() >= 256 || time.Since(sink.lastFlush) >= 80*time.Millisecond {
		sink.flush()
	}
}
func (sink *turnStreamSink) flush() {
	if sink.err != nil || sink.textBuf.Len()+sink.reasoningBuf.Len() == 0 {
		return
	}
	for _, item := range []struct {
		typ string
		buf *strings.Builder
	}{{"reasoning_delta", &sink.reasoningBuf}, {"assistant_delta", &sink.textBuf}} {
		if item.buf.Len() == 0 {
			continue
		}
		_, err := sink.service.store.AppendEvent(sink.ctx, sink.req.Tenant, sink.req.Agent, sink.req.Session, item.typ, &sink.runID, map[string]any{"messageId": sink.messageID, "delta": item.buf.String()})
		if err != nil {
			sink.err = err
			return
		}
		item.buf.Reset()
	}
	sink.lastFlush = time.Now()
}

func (s *Service) modelRound(ctx context.Context, req TurnRequest, runID, model string, payload map[string]any) (modelRoundResult, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return modelRoundResult{}, err
	}
	for attempt := 0; ; attempt++ {
		mid := s.store.id()
		sink := &turnStreamSink{service: s, ctx: ctx, req: req, runID: runID, messageID: mid}
		result, err := s.readModelRound(ctx, req.Tenant, model, body, sink)
		if err == nil {
			sink.flush()
			if sink.err != nil {
				return result, sink.err
			}
			if result.Text != "" {
				_, err = s.store.AppendEvent(ctx, req.Tenant, req.Agent, req.Session, "assistant_message", &runID, map[string]any{"messageId": mid, "content": result.Text, "model": result.Model, "usage": result.Usage})
			}
			return result, err
		}
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		_, _ = s.store.AppendEvent(ctx, req.Tenant, req.Agent, req.Session, "assistant_rollback", &runID, map[string]any{"messageId": mid})
		var providerErr *providerError
		retryable := errors.Is(err, errStreamInterrupted) || (errors.As(err, &providerErr) && providerErr.Retryable)
		if !retryable || attempt >= 2 {
			return result, err
		}
		_, _ = s.store.AppendEvent(ctx, req.Tenant, req.Agent, req.Session, "run_status", &runID, map[string]any{"status": "retrying", "detail": err.Error(), "attempt": attempt + 1})
		timer := time.NewTimer(s.retryBackoff * time.Duration(attempt+1))
		select {
		case <-ctx.Done():
			timer.Stop()
			return result, ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *Service) readModelRound(ctx context.Context, tenant, model string, payload []byte, sink *turnStreamSink) (modelRoundResult, error) {
	resp, err := s.gateway.Do(ctx, tenant, "chat", "chat", model, payload)
	if err != nil {
		return modelRoundResult{}, err
	}
	defer resp.Body.Close()
	if resp.Status < 200 || resp.Status >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return modelRoundResult{}, &providerError{Status: resp.Status, Message: string(body), Retryable: resp.Status == 429 || resp.Status >= 500}
	}
	reader := bufio.NewReader(resp.Body)
	prefix, _ := reader.Peek(1)
	if strings.Contains(resp.Header.Get("Content-Type"), "event-stream") || (len(prefix) > 0 && prefix[0] != '{' && prefix[0] != '[') {
		return parseModelStream(reader, sink)
	}
	body, err := io.ReadAll(io.LimitReader(reader, maxProviderResponse+1))
	if err != nil {
		return modelRoundResult{}, err
	}
	if len(body) > maxProviderResponse {
		return modelRoundResult{}, errors.New("provider response too large")
	}
	result, err := parseCompletionJSON(body)
	if err == nil {
		sink.reasoning(result.Reasoning)
		sink.text(result.Text)
	}
	return result, err
}

func (s *Service) runRoundTools(ctx context.Context, req TurnRequest, sess Session, runID string, calls []modelToolCall, catalog agentCatalog, enabled bool, maxResult int, messages *[]chatMessage) error {
	allowed := reachableToolNames(catalog, nil)
	for _, call := range calls {
		if _, err := s.store.AppendEvent(ctx, req.Tenant, req.Agent, req.Session, "tool_call_start", &runID, map[string]any{"toolCallId": call.ID, "name": call.Name}); err != nil {
			return err
		}
		if _, err := s.store.AppendEvent(ctx, req.Tenant, req.Agent, req.Session, "tool_call_args", &runID, map[string]any{"toolCallId": call.ID, "arguments": defaultArgs(call.Arguments)}); err != nil {
			return err
		}
	}
	var blocked error
	var hookContext strings.Builder
	for _, call := range calls {
		started := time.Now()
		var result json.RawMessage
		var err error
		executed := false
		switch {
		case blocked != nil:
			err = blocked
		case ctx.Err() != nil:
			err = ctx.Err()
		case !enabled || toolDisabled(ctx, call.Name):
			err = fmt.Errorf("tool %s is disabled for this run", call.Name)
		case s.toolRunner == nil:
			err = errors.New("tool runner is unavailable")
		case s.catalogProvider != nil && !allowed[call.Name]:
			err = fmt.Errorf("tool %s is unavailable", call.Name)
		case !json.Valid([]byte(defaultArgs(call.Arguments))):
			err = errors.New("invalid tool arguments: expected JSON")
		case call.Name == "tool_execute":
			// The dispatcher guards, approves and hooks the concrete target.
			// Asking for the wrapper as well would duplicate every approval.
			result, err = s.toolRunner(ctx, req.Tenant, req.Agent, req.Session, call.ID, call.Name, json.RawMessage(defaultArgs(call.Arguments)))
		default:
			check, approvalErr := s.toolExecutionGuard(ctx, req.Tenant, req.Agent, req.Session, runID, call.ID, call.Name, json.RawMessage(defaultArgs(call.Arguments)))
			err = approvalErr
			if err != nil {
				break
			}
			text, hookErr := s.invokeProjectHooks(ctx, req, runID, projectHookInput{Event: "PreToolUse", ToolName: call.Name, ToolInput: json.RawMessage(defaultArgs(call.Arguments))}, false)
			hookContext.WriteString(text)
			if hookErr != nil {
				err, blocked = hookErr, hookErr
			} else if err = check(); err == nil {
				executed = true
				result, err = s.toolRunner(ctx, req.Tenant, req.Agent, req.Session, call.ID, call.Name, json.RawMessage(defaultArgs(call.Arguments)))
			}
		}
		text := string(result)
		isError := err != nil
		if err != nil {
			text = err.Error()
		} else {
			var parsed struct {
				IsError bool `json:"isError"`
			}
			if json.Unmarshal(result, &parsed) == nil {
				isError = parsed.IsError
			}
		}
		text = shrinkText(text, maxResult)
		settle := context.WithoutCancel(ctx)
		if _, writeErr := s.store.AppendEvent(settle, req.Tenant, req.Agent, req.Session, "tool_call_result", &runID, map[string]any{"toolCallId": call.ID, "name": call.Name, "resultText": text, "isError": isError, "durationMs": time.Since(started).Milliseconds()}); writeErr != nil {
			return writeErr
		}
		*messages = append(*messages, chatMessage{Role: "tool", ToolCallID: call.ID, Content: text})
		usageStatus := "ok"
		if isError {
			usageStatus = "error"
		}
		s.recordToolUsage(settle, sess, req.Tenant, req.Agent, req.Session, call.ID, call.Name, usageStatus, time.Since(started).Milliseconds())
		if executed && blocked == nil && ctx.Err() == nil {
			event := "PostToolUse"
			if isError {
				event = "PostToolUseFailure"
			}
			contextText, hookErr := s.invokeProjectHooks(ctx, req, runID, projectHookInput{Event: event, ToolName: call.Name, ToolInput: json.RawMessage(defaultArgs(call.Arguments)), ToolResponse: text, ToolError: isError}, true)
			if hookErr != nil {
				blocked = hookErr
			}
			hookContext.WriteString(contextText)
		}
	}
	if hookContext.Len() > 0 {
		*messages = append(*messages, chatMessage{Role: "system", Content: hookContext.String()})
	}
	if blocked != nil {
		return blocked
	}
	return ctx.Err()
}
