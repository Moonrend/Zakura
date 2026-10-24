// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
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
	bypassAlwaysAsk        bool // Set only by automation admission, never client run options.
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
		events, err := s.historyTopology(ctx, req.Session, sess.LastSeq)
		if err != nil {
			return Run{}, nil, err
		}
		if req.ReplyToMessageID == "" {
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
		for _, event := range events {
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
	if req.bypassAlwaysAsk {
		runCtx = context.WithValue(runCtx, automationApprovalBypassKey{}, automationApprovalBypass{req.Tenant, req.Agent, req.Session, run.ID})
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
	ctx = withContextCache(ctx, req.Tenant, req.Session)
	cloud := parseCloudConfig(agent.Config)
	space, err := s.store.GetSpace(ctx, req.Tenant, agent.SpaceID)
	if err != nil {
		return err
	}
	target := req.MessageID
	if req.SkipUserMessage {
		target = req.ReplyToMessageID
	}
	current, err := s.store.GetSession(ctx, req.Tenant, req.Agent, req.Session)
	if err != nil {
		return err
	}
	events, err := s.loadContextHistory(ctx, req.Session, target, "", current.LastSeq)
	if err != nil {
		return err
	}
	messages := buildChainMessages(events, target, int(^uint(0)>>1))
	if len(messages) == 0 {
		var attachments any
		_ = json.Unmarshal(req.Attachments, &attachments)
		message := userChatMessage(req.Context.render(req.Content), parseChatAttachments(attachments))
		message.UserMessageID = target
		messages = []chatMessage{message}
	}
	catalog := agentCatalog{}
	if cloud.EnableTools && s.catalogProvider != nil {
		catalog, err = s.catalogProvider(ctx, req.Tenant, req.Agent)
		if err != nil {
			return err
		}
	}
	catalog.Tools = append([]agentTool(nil), catalog.Tools...)
	sort.SliceStable(catalog.Tools, func(i, j int) bool { return catalog.Tools[i].Name < catalog.Tools[j].Name })
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
		input.Skills = append([]promptSkill(nil), s.skillsProvider(ctx, req.Tenant, req.Agent)...)
		sort.SliceStable(input.Skills, func(i, j int) bool { return input.Skills[i].Name < input.Skills[j].Name })
	}
	system := buildSystemPrompt(input)
	turnContext := buildTurnContext(input)
	if s.projectContext != nil {
		project, err := s.projectContext(ctx, req.Tenant, agent.SpaceID, req.Agent, input.Project, opts.Skills, input.Skills)
		if err != nil {
			return err
		}
		ctx = context.WithValue(ctx, agentProjectContextKey{}, project)
		if project != nil {
			system += project.text
			turnContext += project.turnText
		}
		for _, event := range []string{"SessionStart", "UserPromptSubmit"} {
			text, err := s.invokeProjectHooks(ctx, req, live.id, projectHookInput{Event: event, Prompt: req.Content}, false)
			if err != nil {
				return err
			}
			turnContext += text
		}
	}
	model, err := s.turnModel(ctx, req.Tenant, agent, space, sess)
	if err != nil {
		return err
	}
	policy, err := s.contextPolicy(ctx, req.Tenant, model)
	if err != nil {
		return err
	}
	maxRounds := cloud.MaxToolRounds
	if maxRounds <= 0 {
		maxRounds = 64
	}
	maxResult := cloud.MaxToolResultChars
	if maxResult <= 0 {
		maxResult = toolOutputMaxBytes
	}
	messages = append(messages, chatMessage{Role: "user", Content: turnContext})
	if _, err := s.injectSteers(ctx, req, live.id, &messages); err != nil {
		return err
	}
	images := s.contextImages(ctx, req.Tenant, req.Agent, messages)
	// Include the target's resolved attachments; replay replaces that user's
	// event projection with this immutable model-visible version.
	initial := len(messages) - 1
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].UserMessageID == target {
			initial = i
			break
		}
	}
	if err = s.recordContextMessages(ctx, req, live.id, messages[initial:]); err != nil {
		return err
	}
	recoveredLength := false
	compactAt := policy.Trigger
	lastEstimate, lastActual := 0, 0
	templateRecorded := false
	seenCalls := map[string]bool{}
	for round := 0; ; round++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		payload := map[string]any{"model": model, "messages": renderMessages(system, messages, images, "openai"), "stream": true, "max_tokens": policy.Output, "stream_options": map[string]any{"include_usage": true}}
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
		if !templateRecorded {
			if err = s.recordContextTemplate(ctx, req, live.id, system, payload); err != nil {
				return err
			}
			templateRecorded = true
		}
		estimate := estimatePayloadTokens(payload)
		used := estimate
		if lastActual > 0 {
			used = max(estimate, lastActual+estimate-lastEstimate)
		}
		if used >= compactAt {
			compacted, report, compactErr := s.compactWorkingContext(ctx, req, live.id, live.id, messages, payload, policy, "auto", true, 0)
			if compactErr == nil && report.Compacted {
				messages = compacted
				images = s.contextImages(ctx, req.Tenant, req.Agent, messages)
				payload["messages"] = renderMessages(system, messages, images, "openai")
				estimate = estimatePayloadTokens(payload)
				lastActual, lastEstimate = 0, 0
				compactAt = policy.Trigger
			} else {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				// Do not spend another summary request on the same unchanged context.
				compactAt = used + max(1024, policy.Trigger/10)
			}
		}
		result, err := s.modelRound(ctx, req, live.id, model, payload)
		if contextOverflow(err) {
			emergency := policy
			emergency.Target = max(1024, policy.Target/2)
			compacted, report, compactErr := s.compactWorkingContext(ctx, req, live.id, live.id, messages, payload, emergency, "overflow", true, 0)
			if compactErr == nil && report.Compacted {
				messages = compacted
				images = s.contextImages(ctx, req.Tenant, req.Agent, messages)
				payload["messages"] = renderMessages(system, messages, images, "openai")
				estimate = estimatePayloadTokens(payload)
				result, err = s.modelRound(ctx, req, live.id, model, payload)
			}
		}
		if result.Usage != nil {
			lastEstimate, lastActual = estimate, result.Usage.PromptTokens
		}
		if err != nil {
			return err
		}
		if len(result.ToolCalls) > 0 && round >= maxRounds {
			return fmt.Errorf("maximum tool rounds (%d) reached", maxRounds)
		}
		if err := prepareToolCallIDs(result.ToolCalls, live.id, round, seenCalls); err != nil {
			return err
		}
		roundStart := len(messages)
		incomplete := result.FinishReason == "length" || result.FinishReason == "max_tokens" || result.FinishReason == "incomplete" || result.FinishReason == "content_filter"
		if incomplete {
			failure := fmt.Errorf("model response incomplete (%s %s); no tools in this batch were executed. Retry with fewer calls and shorter arguments", result.FinishReason, result.IncompleteReason)
			if len(result.ToolCalls) > 0 {
				messages = append(messages, chatMessage{Role: "assistant", Content: result.Text, ToolCalls: result.ToolCalls})
				if err := s.rejectRoundTools(ctx, req, sess, live.id, result.ToolCalls, maxResult, &messages, failure); err != nil {
					return err
				}
			}
			length := result.FinishReason == "length" || result.FinishReason == "max_tokens" || result.IncompleteReason == "max_output_tokens"
			if !length || recoveredLength || len(result.ToolCalls) == 0 {
				return failure
			}
			recoveredLength = true
		} else if len(result.ToolCalls) > 0 {
			messages = append(messages, chatMessage{Role: "assistant", Content: result.Text, ToolCalls: result.ToolCalls})
			if err := s.runRoundTools(ctx, req, sess, live.id, result.ToolCalls, catalog, cloud.EnableTools, maxResult, &messages); err != nil {
				return err
			}
		} else {
			messages = append(messages, chatMessage{Role: "assistant", Content: result.Text})
		}
		steers, err := s.injectSteers(ctx, req, live.id, &messages)
		if err != nil {
			return err
		}
		if steers > 0 {
			images = s.contextImages(ctx, req.Tenant, req.Agent, messages)
		}
		if err = s.recordContextMessages(ctx, req, live.id, messages[roundStart:]); err != nil {
			return err
		}
		if len(result.ToolCalls) == 0 && steers == 0 {
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
			if err == nil && result.Usage != nil {
				_, err = s.store.AppendEvent(ctx, req.Tenant, req.Agent, req.Session, "run_log", &runID, map[string]any{"level": "info", "message": "Model context usage", "data": result.Usage})
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
	if parallelToolBatch(ctx, calls, catalog) {
		return s.runParallelTools(ctx, req, sess, runID, calls, catalog, enabled, maxResult, messages)
	}
	if err := s.startToolBatch(ctx, req, runID, calls); err != nil {
		return err
	}
	var blocked error
	var hookContext strings.Builder
	for _, call := range calls {
		started := time.Now()
		var result json.RawMessage
		var err error
		executed := false
		preflightErr := s.toolPreflight(ctx, req, call, catalog, enabled)
		switch {
		case blocked != nil:
			err = blocked
		case preflightErr != nil:
			err = preflightErr
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
		message, writeErr := s.settleToolResult(ctx, req, sess, runID, call, toolBatchResult{result: result, err: err, duration: time.Since(started)}, maxResult)
		if writeErr != nil {
			return writeErr
		}
		*messages = append(*messages, message)
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
		*messages = append(*messages, chatMessage{Role: "user", Content: "[Configured hook context]\n" + hookContext.String()})
	}
	if blocked != nil {
		return blocked
	}
	return ctx.Err()
}
