// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	codemodeDefaultMS = 120000
	codemodeMinMS     = 1000
	codemodeMaxMS     = 600000
	codemodeCallMS    = 60000
	codemodeMaxCalls  = 128
	codemodeWorkers   = 4
)

//go:embed codemode_harness.mjs
var codemodeHarnessJS string

type codemodeEvent struct {
	data []byte
	exit bool
	err  error
}

func (h *handler) runCodemodeCall(ctx context.Context, tenant, agent, session, call, name string, args json.RawMessage) (result json.RawMessage, callErr error) {
	run, _ := ctx.Value(computerRunKey{}).(string)
	if h.service == nil || session == "" || run == "" {
		return nil, errors.New("codemode tool calls require an active run")
	}
	sess, err := h.store.GetSession(ctx, tenant, agent, session)
	if err != nil {
		return nil, err
	}
	parent, _, _ := strings.Cut(call, "/")
	if _, err := h.store.AppendEvent(ctx, tenant, agent, session, "tool_call_start", &run, map[string]any{"toolCallId": call, "name": name, "parentToolCallId": parent}); err != nil {
		return nil, err
	}
	if _, err := h.store.AppendEvent(ctx, tenant, agent, session, "tool_call_args", &run, map[string]any{"toolCallId": call, "arguments": string(args), "parentToolCallId": parent}); err != nil {
		return nil, err
	}
	started, executed := time.Now(), false
	req := TurnRequest{Tenant: tenant, Agent: agent, Session: session}
	defer func() {
		text, isError := string(result), callErr != nil
		if callErr != nil {
			text = callErr.Error()
		} else {
			var parsed struct {
				IsError bool `json:"isError"`
			}
			if json.Unmarshal(result, &parsed) == nil {
				isError = parsed.IsError
			}
		}
		text = shrinkText(text, 80000)
		settle := context.WithoutCancel(ctx)
		duration := time.Since(started).Milliseconds()
		_, writeErr := h.store.AppendEvent(settle, tenant, agent, session, "tool_call_result", &run, map[string]any{"toolCallId": call, "name": name, "resultText": text, "isError": isError, "durationMs": duration, "parentToolCallId": parent})
		status := "ok"
		if isError {
			status = "error"
		}
		h.service.recordToolUsage(settle, sess, tenant, agent, session, call, name, status, duration)
		if executed && ctx.Err() == nil {
			event := "PostToolUse"
			if isError {
				event = "PostToolUseFailure"
			}
			_, hookErr := h.service.invokeProjectHooks(ctx, req, run, projectHookInput{Event: event, ToolName: name, ToolInput: args, ToolResponse: text, ToolError: isError}, true)
			writeErr = errors.Join(writeErr, hookErr)
		}
		callErr = errors.Join(callErr, writeErr)
	}()
	catalog, err := h.cachedAgentToolCatalog(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if !reachableToolNames(catalog, disabledToolsFromContext(ctx))[name] {
		return nil, fmt.Errorf("tool %s is unavailable; use tool_search to discover tools", name)
	}
	var object map[string]any
	if json.Unmarshal(args, &object) != nil || object == nil {
		return nil, errors.New("tool arguments must be a JSON object")
	}
	check, err := h.service.toolExecutionGuard(ctx, tenant, agent, session, run, call, name, args)
	if err != nil {
		return nil, err
	}
	if _, err := h.service.invokeProjectHooks(ctx, req, run, projectHookInput{Event: "PreToolUse", ToolName: name, ToolInput: args}, false); err != nil {
		return nil, err
	}
	if err := check(); err != nil {
		return nil, err
	}
	executed = true
	return h.dispatchAgentTool(ctx, tenant, agent, session, call, name, args)
}

func (h *handler) runCodemodeTool(ctx context.Context, tenant, agent, session, toolCallID string, args json.RawMessage) (json.RawMessage, error) {
	parsed := map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return nil, fmt.Errorf("invalid tool arguments: %w", err)
		}
	}
	code := builtinStringArg(parsed, "code")
	if strings.TrimSpace(code) == "" {
		return nil, errors.New("code required")
	}
	if len(code) > 256<<10 {
		return nil, errors.New("codemode source exceeds 256 KiB")
	}
	timeoutMS := builtinIntArg(parsed, "timeout_ms", codemodeDefaultMS)
	if timeoutMS < codemodeMinMS {
		timeoutMS = codemodeMinMS
	}
	if timeoutMS > codemodeMaxMS {
		timeoutMS = codemodeMaxMS
	}
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()

	a, err := h.store.GetAgent(runCtx, tenant, agent)
	if err != nil {
		return nil, err
	}
	target, err := h.resolveSpaceWorkspaceTarget(runCtx, tenant, a.SpaceID, "terminal")
	if err != nil {
		return nil, err
	}
	remote := &remoteWorkspace{runner: target.runner, spaceID: target.space.ID}
	if _, err := remote.write(runCtx, "/.zakura/codemode/harness.mjs", []byte(codemodeHarnessJS)); err != nil {
		return nil, err
	}
	runner := target.runner
	command := []string{"node", ".zakura/codemode/harness.mjs"}
	startMethod, writeMethod, closeMethod := "host.pty.start", "host.pty.write", "host.pty.close"
	params := map[string]any{"spaceId": remote.spaceID, "command": command, "workingDir": "/", "env": map[string]string{}, "cols": 120, "rows": 40}
	if target.container != "" {
		startMethod, writeMethod, closeMethod = "docker.exec.start", "docker.exec.write", "docker.exec.close"
		params = map[string]any{"id": target.container, "command": command, "workingDir": "/workspace", "env": map[string]string{}}
	}
	var started struct {
		ID string `json:"id"`
	}
	if err := runner.call(runCtx, startMethod, params, &started); err != nil {
		return nil, err
	}
	if started.ID == "" {
		return nil, errors.New("workspace returned no process id")
	}
	processID := started.ID

	events := make(chan codemodeEvent, 256)
	streamDone := make(chan struct{})
	var exitOnce sync.Once
	var pendingBytes atomic.Int64
	detach := runner.onStream(processID, func(channel string, data []byte) {
		event := codemodeEvent{}
		switch channel {
		case "exit":
			exitOnce.Do(func() {
				select {
				case events <- codemodeEvent{exit: true}:
				case <-streamDone:
				case <-runCtx.Done():
				}
			})
			return
		case "error":
			event.err = errors.New("codemode runner connection lost")
		case "stdout":
			if pendingBytes.Add(int64(len(data))) > 4<<20 {
				pendingBytes.Add(-int64(len(data)))
				cancel()
				return
			}
			event.data = append([]byte(nil), data...)
		default:
			return
		}
		select {
		case events <- event:
		case <-streamDone:
			pendingBytes.Add(-int64(len(event.data)))
		case <-runCtx.Done():
			pendingBytes.Add(-int64(len(event.data)))
		}
	})
	defer func() {
		close(streamDone)
		detach()
		closeCtx, closeCancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer closeCancel()
		var ignored map[string]any
		_ = runner.call(closeCtx, closeMethod, map[string]any{"id": processID}, &ignored)
	}()

	writeMessage := func(message any) error {
		raw, err := json.Marshal(message)
		if err != nil {
			return err
		}
		raw = append(raw, '\n')
		// Large intermediate MCP results stay structured, but each runner frame
		// must remain below the transport limit. Only this event loop writes.
		for len(raw) > 0 {
			n := min(len(raw), 32<<10)
			var ignored map[string]any
			if err := runner.call(runCtx, writeMethod, map[string]any{"id": processID, "base64": base64.StdEncoding.EncodeToString(raw[:n])}, &ignored); err != nil {
				return err
			}
			raw = raw[n:]
		}
		return nil
	}
	if err := writeMessage(map[string]any{"op": "run", "code": code}); err != nil {
		return nil, err
	}

	startedAt := time.Now()
	type callJob struct {
		id       int
		name     string
		args     json.RawMessage
		discover bool
	}
	jobs := make(chan callJob, codemodeMaxCalls)
	results := make(chan map[string]any, codemodeWorkers)
	var workers sync.WaitGroup
	for i := 0; i < codemodeWorkers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				select {
				case <-runCtx.Done():
					return
				case job := <-jobs:
					if runCtx.Err() != nil {
						return
					}
					callCtx, callCancel := context.WithTimeout(runCtx, codemodeCallMS*time.Millisecond)
					callCtx = context.WithValue(callCtx, codemodeContextKey{}, true)
					var result json.RawMessage
					var callErr error
					if job.discover {
						result, callErr = h.runToolSearchTool(callCtx, tenant, agent, session, "", job.args)
					} else if job.name == "codemode" || job.name == "tool_execute" {
						callErr = errors.New("codemode cannot start codemode scripts or tool_execute; call the target tool directly")
					} else {
						callID := fmt.Sprintf("%s/codemode-%d", toolCallID, job.id)
						result, callErr = h.runCodemodeCall(callCtx, tenant, agent, session, callID, job.name, job.args)
					}
					callCancel()
					response := map[string]any{"op": "result", "id": job.id, "ok": callErr == nil}
					if callErr != nil {
						response["error"] = callErr.Error()
					} else if json.Valid(result) {
						response["result"] = result
					} else {
						response["result"] = string(result)
					}
					select {
					case results <- response:
					case <-runCtx.Done():
						return
					}
				}
			}
		}()
	}
	defer func() { cancel(); workers.Wait() }()
	var buffer []byte
	var output json.RawMessage
	var scriptError string
	var truncated bool
	finished := false
	seenCalls := map[int]bool{}
	for !finished {
		select {
		case <-runCtx.Done():
			return nil, fmt.Errorf("codemode script did not finish: %w", runCtx.Err())
		case result := <-results:
			if err := writeMessage(result); err != nil {
				return nil, err
			}
		case event := <-events:
			pendingBytes.Add(-int64(len(event.data)))
			if event.err != nil {
				return nil, event.err
			}
			if event.exit {
				return nil, errors.New("codemode script did not finish")
			}
			buffer = append(buffer, event.data...)
			if len(buffer) > 4<<20 {
				return nil, errors.New("codemode protocol output exceeds limit")
			}
			for {
				index := bytes.IndexByte(buffer, '\n')
				if index < 0 {
					break
				}
				line := bytes.TrimSpace(buffer[:index])
				buffer = buffer[index+1:]
				if len(line) == 0 {
					continue
				}
				var message struct {
					Op        string          `json:"op"`
					ID        int             `json:"id"`
					Name      string          `json:"name"`
					Args      json.RawMessage `json:"args"`
					OK        bool            `json:"ok"`
					Error     string          `json:"error"`
					Output    json.RawMessage `json:"output"`
					Truncated bool            `json:"truncated"`
				}
				if json.Unmarshal(line, &message) != nil {
					continue
				}
				switch message.Op {
				case "call", "discover":
					if message.ID <= 0 || seenCalls[message.ID] {
						return nil, errors.New("codemode returned an invalid or repeated tool call")
					}
					if len(seenCalls) >= codemodeMaxCalls {
						return nil, errors.New("codemode tool call limit exceeded (128)")
					}
					seenCalls[message.ID] = true
					callArgs := message.Args
					if len(callArgs) == 0 {
						callArgs = json.RawMessage("{}")
					}
					jobs <- callJob{id: message.ID, name: message.Name, args: callArgs, discover: message.Op == "discover"}
				case "done":
					if !message.OK {
						scriptError = "codemode script failed: " + message.Error
					}
					truncated = message.Truncated
					output = message.Output
					if len(output) == 0 {
						output = json.RawMessage("[]")
					}
					finished = true
				}
				if finished {
					break
				}
			}
		}
	}
	result := map[string]any{"output": output, "wallMs": time.Since(startedAt).Milliseconds(), "truncated": truncated}
	if scriptError != "" {
		result["isError"], result["error"] = true, scriptError
	}
	raw, err := builtinJSON(result)
	if err != nil {
		return nil, err
	}
	if len(raw) > toolOutputMaxBytes {
		var lines []string
		if json.Unmarshal(output, &lines) != nil {
			return nil, errors.New("invalid codemode output: expected text array")
		}
		text := strings.Join(lines, "\n")
		bounded, _ := h.truncateToolText(ctx, tenant, agent, text, "codemode")
		result["output"], result["truncated"] = []string{bounded}, true
		return builtinJSON(result)
	}
	return raw, nil
}
