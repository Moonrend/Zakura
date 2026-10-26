// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

func prepareToolCallIDs(calls []modelToolCall, run string, round int, seen map[string]bool) error {
	batch := map[string]bool{}
	for i := range calls {
		if calls[i].ID == "" {
			calls[i].ID = fmt.Sprintf("call_%s_%d_%d", run, round, i)
		}
		if calls[i].Name == "" {
			return errors.New("model tool call is missing its name")
		}
		id := calls[i].ID
		if seen[id] || batch[id] {
			return fmt.Errorf("duplicate model tool call ID %q", id)
		}
		batch[id] = true
	}
	for id := range batch {
		seen[id] = true
	}
	return nil
}

func parallelToolBatch(ctx context.Context, calls []modelToolCall, catalog agentCatalog) bool {
	if len(calls) < 2 {
		return false
	}
	if project := turnProjectContext(ctx); project != nil {
		for _, pkg := range project.hooks {
			for _, event := range []string{"PreToolUse", "PostToolUse", "PostToolUseFailure"} {
				if len(pkg.Events[event]) > 0 {
					return false
				}
			}
		}
	}
	for _, call := range calls {
		tool := catalogTool(catalog, call.Name)
		if tool.Kind != "builtin" || !tool.Parallel {
			return false
		}
	}
	return true
}

func (s *Service) startToolBatch(ctx context.Context, req TurnRequest, run string, calls []modelToolCall) error {
	if _, err := s.store.GetSession(ctx, req.Tenant, req.Agent, req.Session); err != nil {
		return err
	}
	return s.store.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, call := range calls {
			if _, err := s.store.appendEventTx(ctx, tx, req.Session, "tool_call_start", &run, map[string]any{"toolCallId": call.ID, "name": call.Name}); err != nil {
				return err
			}
			if _, err := s.store.appendEventTx(ctx, tx, req.Session, "tool_call_args", &run, map[string]any{"toolCallId": call.ID, "arguments": defaultArgs(call.Arguments)}); err != nil {
				return err
			}
		}
		return nil
	})
}

type toolBatchResult struct {
	index    int
	result   json.RawMessage
	err      error
	duration time.Duration
}

func (s *Service) settleToolResult(ctx context.Context, req TurnRequest, sess Session, run string, call modelToolCall, outcome toolBatchResult, maxResult int) (chatMessage, error) {
	text, isError := string(outcome.result), outcome.err != nil
	if outcome.err != nil {
		text = outcome.err.Error()
	} else {
		var parsed struct {
			IsError bool `json:"isError"`
		}
		if json.Unmarshal(outcome.result, &parsed) == nil {
			isError = parsed.IsError
		}
	}
	text = shrinkText(text, maxResult)
	settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	_, err := s.store.AppendEvent(settle, req.Tenant, req.Agent, req.Session, "tool_call_result", &run, map[string]any{"toolCallId": call.ID, "name": call.Name, "resultText": text, "isError": isError, "durationMs": outcome.duration.Milliseconds()})
	if err != nil {
		return chatMessage{}, err
	}
	status := "ok"
	if isError {
		status = "error"
	}
	s.recordToolUsage(settle, sess, req.Tenant, req.Agent, req.Session, call.ID, call.Name, status, outcome.duration.Milliseconds())
	return chatMessage{Role: "tool", ToolCallID: call.ID, Content: text}, nil
}

func (s *Service) rejectRoundTools(ctx context.Context, req TurnRequest, sess Session, run string, calls []modelToolCall, maxResult int, messages *[]chatMessage, failure error) error {
	if err := s.startToolBatch(ctx, req, run, calls); err != nil {
		return err
	}
	for _, call := range calls {
		message, err := s.settleToolResult(ctx, req, sess, run, call, toolBatchResult{err: failure}, maxResult)
		if err != nil {
			return err
		}
		*messages = append(*messages, message)
	}
	return nil
}

func (s *Service) toolPreflight(ctx context.Context, req TurnRequest, call modelToolCall, catalog agentCatalog, enabled bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !enabled || toolDisabled(ctx, call.Name) {
		return fmt.Errorf("tool %s is disabled for this run", call.Name)
	}
	if s.toolRunner == nil {
		return errors.New("tool runner is unavailable")
	}
	if s.catalogProvider != nil && !reachableToolNames(catalog, nil)[call.Name] {
		return fmt.Errorf("tool %s is unavailable", call.Name)
	}
	return validateToolArguments(catalogTool(catalog, call.Name), json.RawMessage(defaultArgs(call.Arguments)))
}

func (s *Service) runParallelTools(ctx context.Context, req TurnRequest, sess Session, run string, calls []modelToolCall, catalog agentCatalog, enabled bool, maxResult int, messages *[]chatMessage) error {
	if err := s.startToolBatch(ctx, req, run, calls); err != nil {
		return err
	}
	checks := make([]func() error, len(calls))
	failures := make([]error, len(calls))
	for i, call := range calls {
		failures[i] = s.toolPreflight(ctx, req, call, catalog, enabled)
		if failures[i] == nil {
			checks[i], failures[i] = s.toolExecutionGuard(ctx, req.Tenant, req.Agent, req.Session, run, call.ID, call.Name, json.RawMessage(defaultArgs(call.Arguments)))
		}
	}
	execCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan toolBatchResult, len(calls))
	ordered := make([]chatMessage, len(calls))
	next, active, completed := 0, 0, 0
	var writeErr error
	settled := make([]bool, len(calls))
	store := func(out toolBatchResult) {
		message, err := s.settleToolResult(ctx, req, sess, run, calls[out.index], out, maxResult)
		ordered[out.index] = message
		settled[out.index] = true
		completed++
		if err != nil {
			writeErr = errors.Join(writeErr, err)
			cancel()
		}
	}
	var timer *time.Timer
	var deadline <-chan time.Time
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	cancelled := execCtx.Done()
	for completed < len(calls) {
		for next < len(calls) && active < 4 {
			i := next
			next++
			failure := failures[i]
			if execCtx.Err() != nil {
				failure = fmt.Errorf("tool not started: %w", execCtx.Err())
			}
			if failure != nil {
				store(toolBatchResult{index: i, err: failure})
				continue
			}
			active++
			go func() {
				out := toolBatchResult{index: i}
				started := time.Now()
				defer func() {
					if recovered := recover(); recovered != nil {
						out.err = fmt.Errorf("tool panic: %v", recovered)
					}
					out.duration = time.Since(started)
					results <- out
				}()
				if out.err = execCtx.Err(); out.err != nil {
					return
				}
				if out.err = checks[i](); out.err != nil {
					return
				}
				if out.err = execCtx.Err(); out.err != nil {
					return
				}
				call := calls[i]
				out.result, out.err = s.toolRunner(execCtx, req.Tenant, req.Agent, req.Session, call.ID, call.Name, json.RawMessage(defaultArgs(call.Arguments)))
			}()
		}
		if completed == len(calls) {
			break
		}
		select {
		case out := <-results:
			active--
			store(out)
		case <-cancelled:
			cancelled = nil
			timer = time.NewTimer(2 * time.Second)
			deadline = timer.C
		case <-deadline:
			// Preserve completions already delivered before declaring unknown outcomes.
		drain:
			for {
				select {
				case out := <-results:
					store(out)
				default:
					break drain
				}
			}
			for i := range calls {
				if !settled[i] {
					failure := errors.New("tool interrupted; execution outcome is unknown")
					if i >= next {
						failure = errors.New("tool not started: batch cancelled")
					}
					store(toolBatchResult{index: i, err: failure})
				}
			}
		}
	}
	if writeErr != nil {
		return writeErr
	}
	*messages = append(*messages, ordered...)
	return ctx.Err()
}
