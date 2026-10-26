// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"path"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const acpCallbackFileLimit = 1 << 20

type acpTerminal struct {
	mu              sync.Mutex
	id, closeMethod string
	job             bool
	output          string
	truncated       bool
	limit           int
	exitStatus      map[string]any
	done            chan struct{}
	once            sync.Once
	detach          func()
}

// ACP paths are logical workspace paths, never arbitrary API/runner host paths.
// Validate before cleaning so parent traversal cannot be hidden by path.Clean.
func acpWorkspacePath(raw string) (string, error) {
	if raw == "" || strings.ContainsAny(raw, "\\\x00:") {
		return "", errors.New("invalid ACP workspace path")
	}
	safe, err := runnerWorkspacePath(raw)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(safe, "/") && safe != "/workspace" && !strings.HasPrefix(safe, "/workspace/") {
		return "", errors.New("ACP path must be inside /workspace")
	}
	return path.Clean("/workspace/" + strings.TrimPrefix(strings.TrimPrefix(safe, "/workspace"), "/")), nil
}

func (rt *acpLiveRuntime) validSession(params map[string]any) bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	requested, _ := params["sessionId"].(string)
	return rt.acpSessionID == "" || requested == rt.acpSessionID
}

func (rt *acpLiveRuntime) handleCallback(method string, id json.RawMessage, params map[string]any) {
	ctx := rt.manager.h.deps.RunContext()
	var cancel context.CancelFunc
	if method == "terminal/wait_for_exit" || method == "session/request_permission" || method == "fs/read_text_file" || method == "fs/write_text_file" || method == "terminal/create" {
		ctx, cancel = context.WithCancel(ctx)
	} else {
		ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
	}
	defer cancel()
	cancelled := ctx.Done()
	go func() {
		select {
		case <-rt.done:
			cancel()
		case <-cancelled:
		}
	}()
	rt.mu.Lock()
	sessionID := rt.acpSessionID
	rt.mu.Unlock()
	if requested, _ := params["sessionId"].(string); requested == "" || (sessionID != "" && requested != sessionID) {
		_ = rt.respond(id, nil, &map[string]any{"code": -32602, "message": "ACP sessionId mismatch"})
		return
	}
	var actorErr error
	ctx, actorErr = rt.approvalContext(ctx)
	if actorErr != nil {
		_ = rt.respond(id, nil, &map[string]any{"code": -32602, "message": actorErr.Error()})
		return
	}
	if method == "session/request_permission" || method == "elicitation/create" {
		rt.queueDecision(ctx, method, id, params)
		return
	}
	var result any
	var err error
	switch method {
	case "fs/read_text_file", "fs/write_text_file":
		var target string
		target, err = acpWorkspacePath(builtinStringArg(params, "path"))
		if err != nil {
			break
		}
		if rt.spaceID == "" {
			err = errors.New("ACP Space workspace unavailable")
			break
		}
		// Deliberately do not use remoteWorkspace(ctx,agent) or pinnedExecution:
		// callbacks always use the server workspace captured at adapter launch.
		remote := rt.workspaceRemote()
		if method == "fs/read_text_file" {
			if err = rt.approveCallback(ctx, method, id, params); err != nil {
				break
			}
			if _, err = rt.approvalContext(ctx); err != nil {
				break
			}
			var data []byte
			data, _, err = remote.read(ctx, target, acpCallbackFileLimit+1)
			if err == nil && len(data) > acpCallbackFileLimit {
				err = errors.New("ACP file exceeds text limit")
			}
			if err == nil && !utf8.Valid(data) {
				err = errors.New("ACP file is not UTF-8")
			}
			if err == nil {
				line, limit := builtinIntArg(params, "line", 1), builtinIntArg(params, "limit", 0)
				if line < 1 || limit < 0 {
					err = errors.New("invalid ACP line window")
					break
				}
				lines := strings.Split(string(data), "\n")
				start := min(line-1, len(lines))
				end := len(lines)
				if limit > 0 && limit < end-start {
					end = start + limit
				}
				result = map[string]any{"content": strings.Join(lines[start:end], "\n")}
			}
		} else {
			content, ok := params["content"].(string)
			if !ok || len(content) > acpCallbackFileLimit {
				err = errors.New("invalid ACP text content")
				break
			}
			if err = rt.approveCallback(ctx, method, id, params); err != nil {
				break
			}
			if _, err = rt.approvalContext(ctx); err != nil {
				break
			}
			_, err = remote.write(ctx, target, []byte(content))
			result = map[string]any{}
		}
	case "terminal/create":
		if err = rt.approveCallback(ctx, method, id, params); err != nil {
			break
		}
		if _, err = rt.approvalContext(ctx); err != nil {
			break
		}
		result, err = rt.createTerminal(ctx, params)
	case "terminal/output", "terminal/wait_for_exit", "terminal/kill", "terminal/release":
		result, err = rt.terminalCallback(ctx, method, params)
	default:
		_ = rt.respond(id, nil, &map[string]any{"code": -32601, "message": "Method not supported by Zakura ACP client"})
		return
	}
	if err != nil {
		_ = rt.respond(id, nil, &map[string]any{"code": -32602, "message": err.Error()})
		return
	}
	_ = rt.respond(id, result, nil)
}

func (rt *acpLiveRuntime) queueDecision(ctx context.Context, method string, id json.RawMessage, params map[string]any) {
	requestID := rpcIDDisplay(id)
	if requestID == "" {
		_ = rt.respond(id, nil, &map[string]any{"code": -32602, "message": "Invalid ACP request id"})
		return
	}
	options := map[string]string{}
	if method == "session/request_permission" {
		list, _ := params["options"].([]any)
		for _, raw := range list {
			option, _ := raw.(map[string]any)
			key, kind := builtinStringArg(option, "optionId"), builtinStringArg(option, "kind")
			if key == "" || options[key] != "" || (kind != "allow_once" && kind != "allow_always" && kind != "reject_once" && kind != "reject_always") {
				_ = rt.respond(id, nil, &map[string]any{"code": -32602, "message": "Invalid ACP permission options"})
				return
			}
			options[key] = kind
		}
		if len(options) == 0 {
			_ = rt.respond(id, nil, &map[string]any{"code": -32602, "message": "ACP permission options required"})
			return
		}
		rt.gatePermission(ctx, id, params, options)
		return
	}
	rt.mu.Lock()
	if _, exists := rt.inbound[requestID]; exists || len(rt.inbound) >= 128 {
		rt.mu.Unlock()
		_ = rt.respond(id, nil, &map[string]any{"code": -32602, "message": "Duplicate or excessive ACP request id"})
		return
	}
	select {
	case <-rt.done:
		rt.mu.Unlock()
		return
	default:
	}
	rt.inbound[requestID] = acpInbound{method: method, id: append(json.RawMessage(nil), id...), options: options}
	run := rt.currentRunID
	rt.mu.Unlock()
	params["requestId"] = requestID
	event := "permission_request"
	if method == "elicitation/create" {
		event = "elicitation_request"
	}
	if _, err := rt.manager.h.store.AppendEvent(ctx, rt.tenantID, rt.agentID, rt.sid, event, optionalString(run), params); err != nil {
		rt.mu.Lock()
		delete(rt.inbound, requestID)
		rt.mu.Unlock()
		_ = rt.respond(id, nil, &map[string]any{"code": -32603, "message": "ACP request could not be persisted"})
	}
}

func (rt *acpLiveRuntime) permissionAllowed(ctx context.Context, params map[string]any) (bool, error) {
	_, raw, err := rt.manager.h.acpSpace(ctx, rt.tenantID, rt.agentID, rt.spaceID)
	if err != nil {
		return false, err
	}
	cfg := parseACPConfig(acpMap(raw))
	if cfg.PermissionPolicy == "allow" {
		return true, nil
	}
	tool, _ := params["toolCall"].(map[string]any)
	kind := builtinStringArg(tool, "kind")
	locations, _ := tool["locations"].([]any)
	for _, grant := range cfg.PermissionGrants {
		if grant.Kind != kind {
			continue
		}
		if grant.PathPrefix == "" {
			return true, nil
		}
		prefix, err := acpWorkspacePath(grant.PathPrefix)
		if err != nil || len(locations) == 0 {
			continue
		}
		all := true
		for _, raw := range locations {
			loc, _ := raw.(map[string]any)
			p, err := acpWorkspacePath(builtinStringArg(loc, "path"))
			if err != nil || (p != prefix && !strings.HasPrefix(p, prefix+"/")) {
				all = false
				break
			}
		}
		if all {
			return true, nil
		}
	}
	return false, nil
}

func (rt *acpLiveRuntime) createTerminal(ctx context.Context, params map[string]any) (any, error) {
	command := builtinStringArg(params, "command")
	if command == "" || strings.ContainsRune(command, 0) {
		return nil, errors.New("ACP terminal command required")
	}
	cwd := builtinStringArg(params, "cwd")
	if cwd == "" {
		cwd = rt.workingDir
	}
	cwd, err := acpWorkspacePath(cwd)
	if err != nil {
		return nil, err
	}
	limit := builtinIntArg(params, "outputByteLimit", 65536)
	if limit < 1 || limit > acpCallbackFileLimit {
		return nil, errors.New("invalid ACP terminal output limit")
	}
	env := map[string]string{}
	if list, ok := params["env"].([]any); ok {
		for _, raw := range list {
			item, _ := raw.(map[string]any)
			name := builtinStringArg(item, "name")
			if name == "" || strings.ContainsAny(name, "=\x00") {
				return nil, errors.New("invalid ACP terminal environment")
			}
			env[name] = builtinStringArg(item, "value")
		}
	}
	rt.mu.Lock()
	if len(rt.terminals) >= 32 {
		rt.mu.Unlock()
		return nil, errors.New("too many ACP terminals")
	}
	rt.mu.Unlock()
	space, err := rt.workspaceSpace(ctx)
	if err != nil {
		return nil, err
	}
	method, closeMethod := "host.exec.start", "host.exec.kill"
	args := map[string]any{"spaceId": rt.spaceID, "command": append([]string{command}, stringSlice(params["args"])...), "workingDir": cwd, "env": env}
	if space.WorkspaceKind != "host" {
		obs, err := rt.manager.h.observeSpaceWorkspace(ctx, space)
		if err != nil {
			return nil, err
		}
		if obs.Container.DockerID == "" || obs.Container.Status != "running" {
			return nil, errors.New("workspace container is not running")
		}
		method, closeMethod = "docker.exec.start", "docker.exec.close"
		args["id"] = obs.Container.DockerID
		delete(args, "spaceId")
	}
	var started struct {
		ID string `json:"id"`
	}
	if err = rt.workspaceRemote().call(ctx, method, args, &started); err != nil {
		return nil, err
	}
	if started.ID == "" {
		return nil, errors.New("runner returned no ACP terminal id")
	}
	terminal := &acpTerminal{id: started.ID, closeMethod: closeMethod, job: method == "host.exec.start", limit: limit, done: make(chan struct{})}
	if !terminal.job {
		terminal.detach = rt.runner.onStream(started.ID, func(channel string, data []byte) {
			terminal.mu.Lock()
			defer terminal.mu.Unlock()
			if channel == "exit" {
				terminal.exitStatus = map[string]any{}
				var status struct {
					ExitCode *int    `json:"exitCode"`
					Signal   *string `json:"signal"`
				}
				if json.Unmarshal(data, &status) == nil {
					if status.ExitCode != nil {
						terminal.exitStatus["exitCode"] = *status.ExitCode
					}
					if status.Signal != nil {
						terminal.exitStatus["signal"] = *status.Signal
					}
				}
				terminal.once.Do(func() { close(terminal.done) })
				return
			}
			if channel == "stdout" || channel == "stderr" {
				terminal.setOutput(terminal.output + string(data))
			}
		})
	}
	rt.mu.Lock()
	select {
	case <-rt.done:
		rt.mu.Unlock()
		if terminal.detach != nil {
			terminal.detach()
		}
		_ = rt.closeWorkspaceStream(ctx, closeMethod, started.ID)
		return nil, errors.New("ACP adapter closed")
	default:
	}
	if len(rt.terminals) >= 32 {
		rt.mu.Unlock()
		if terminal.detach != nil {
			terminal.detach()
		}
		_ = rt.closeWorkspaceStream(ctx, closeMethod, started.ID)
		return nil, errors.New("too many ACP terminals")
	}
	rt.terminals[started.ID] = terminal
	rt.mu.Unlock()
	return map[string]any{"terminalId": started.ID}, nil
}

func (t *acpTerminal) setOutput(output string) {
	if len(output) > t.limit {
		output = output[len(output)-t.limit:]
		for len(output) > 0 && !utf8.RuneStart(output[0]) {
			output = output[1:]
		}
		t.truncated = true
	}
	t.output = output
}

func (rt *acpLiveRuntime) refreshTerminal(ctx context.Context, t *acpTerminal) error {
	if !t.job {
		return nil
	}
	var snap struct {
		Stdout   string `json:"stdout"`
		Stderr   string `json:"stderr"`
		ExitCode *int   `json:"exitCode"`
	}
	if err := rt.runner.call(ctx, "host.exec.get", map[string]any{"id": t.id}, &snap); err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.setOutput(snap.Stdout + snap.Stderr)
	if snap.ExitCode != nil {
		t.exitStatus = map[string]any{"exitCode": *snap.ExitCode}
		t.once.Do(func() { close(t.done) })
	}
	return nil
}

func (rt *acpLiveRuntime) terminalCallback(ctx context.Context, method string, params map[string]any) (any, error) {
	id := builtinStringArg(params, "terminalId")
	rt.mu.Lock()
	terminal := rt.terminals[id]
	rt.mu.Unlock()
	if terminal == nil {
		return nil, errors.New("unknown ACP terminal id")
	}
	if method == "terminal/kill" || method == "terminal/release" {
		if err := rt.closeWorkspaceStream(ctx, terminal.closeMethod, id); err != nil {
			return nil, err
		}
		if method == "terminal/release" {
			rt.mu.Lock()
			delete(rt.terminals, id)
			rt.mu.Unlock()
			if terminal.detach != nil {
				terminal.detach()
			}
			terminal.once.Do(func() { close(terminal.done) })
		}
		return map[string]any{}, nil
	}
	if err := rt.refreshTerminal(ctx, terminal); err != nil {
		return nil, err
	}
	if method == "terminal/wait_for_exit" {
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-terminal.done:
				terminal.mu.Lock()
				status := terminal.exitStatus
				terminal.mu.Unlock()
				if status == nil {
					return nil, errors.New("ACP terminal released")
				}
				return status, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-ticker.C:
				if err := rt.refreshTerminal(ctx, terminal); err != nil {
					return nil, err
				}
			}
		}
	}
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	out := map[string]any{"output": terminal.output, "truncated": terminal.truncated}
	if terminal.exitStatus != nil {
		out["exitStatus"] = terminal.exitStatus
	}
	return out, nil
}
