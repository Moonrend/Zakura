// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
)

// acpRuntimeManager owns long-lived ACP adapter processes on selected runtime
// nodes.  The Go server only transports JSON-RPC; commands always execute in
// the agent's jailed host workspace or workspace container.
type acpRuntimeManager struct {
	h        *handler
	mu       sync.Mutex
	runtimes map[string]*acpLiveRuntime
	starting map[string]*acpRuntimeStart
}

type acpRuntimeStart struct {
	done chan struct{}
	rt   *acpLiveRuntime
	err  error
}

type acpRPCReply struct {
	result json.RawMessage
	err    error
}

type acpInbound struct {
	method string
	id     json.RawMessage
}

type acpLiveRuntime struct {
	manager                  *acpRuntimeManager
	tenantID, agentID, sid   string
	profileID, acpSessionID  string
	runner                   *runnerSession
	processID                string
	writeMethod, closeMethod string
	detach                   func()
	seq                      atomic.Uint64
	mu                       sync.Mutex
	pending                  map[string]chan acpRPCReply
	inbound                  map[string]acpInbound
	buffer                   []byte
	done                     chan struct{}
	closeOne                 sync.Once
	state                    map[string]any
	currentRunID             string
	assistant                strings.Builder
	userID                   string
	toolStarted              map[string]time.Time
	toolRecorded             map[string]bool
}

func newACPRuntimeManager(h *handler) *acpRuntimeManager {
	m := &acpRuntimeManager{h: h, runtimes: map[string]*acpLiveRuntime{}, starting: map[string]*acpRuntimeStart{}}
	go func() {
		<-h.deps.RunContext().Done()
		m.closeAll()
	}()
	return m
}

func (m *acpRuntimeManager) closeAll() {
	m.mu.Lock()
	items := make([]*acpLiveRuntime, 0, len(m.runtimes))
	for _, rt := range m.runtimes {
		items = append(items, rt)
	}
	m.runtimes = map[string]*acpLiveRuntime{}
	m.mu.Unlock()
	for _, rt := range items {
		rt.close(errors.New("server shutting down"))
	}
}

func (m *acpRuntimeManager) ensure(ctx context.Context, tenantID, agentID, sid string) (*acpLiveRuntime, error) {
	key := tenantID + "\x00" + sid
	m.mu.Lock()
	if current := m.runtimes[key]; current != nil {
		select {
		case <-current.done:
			delete(m.runtimes, key)
		default:
			m.mu.Unlock()
			return current, nil
		}
	}
	if inFlight := m.starting[key]; inFlight != nil {
		m.mu.Unlock()
		select {
		case <-inFlight.done:
			return inFlight.rt, inFlight.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	inFlight := &acpRuntimeStart{done: make(chan struct{})}
	m.starting[key] = inFlight
	m.mu.Unlock()

	sess, err := m.h.store.GetSession(ctx, tenantID, agentID, sid)
	if err != nil {
		return m.finishStart(key, inFlight, nil, err)
	}
	if sess.Kind != "acp" {
		return m.finishStart(key, inFlight, nil, errors.New("not an ACP session"))
	}
	var origin struct {
		ProfileID    string `json:"acpProfileId"`
		ACPSessionID string `json:"acpSessionId"`
	}
	_ = json.Unmarshal(sess.Origin, &origin)
	if origin.ProfileID == "" {
		return m.finishStart(key, inFlight, nil, errors.New("ACP session has no profile"))
	}
	profile, err := m.h.acpProfile(ctx, tenantID, agentID, origin.ProfileID)
	if err != nil {
		return m.finishStart(key, inFlight, nil, err)
	}
	rt, err := m.start(ctx, tenantID, agentID, sid, origin.ProfileID, origin.ACPSessionID, sess, profile)
	if err != nil {
		return m.finishStart(key, inFlight, nil, err)
	}
	return m.finishStart(key, inFlight, rt, nil)
}

func (m *acpRuntimeManager) finishStart(key string, inFlight *acpRuntimeStart, rt *acpLiveRuntime, err error) (*acpLiveRuntime, error) {
	m.mu.Lock()
	if m.starting[key] == inFlight {
		delete(m.starting, key)
		inFlight.rt, inFlight.err = rt, err
		if rt != nil {
			m.runtimes[key] = rt
		}
		close(inFlight.done)
	}
	m.mu.Unlock()
	return rt, err
}

func (m *acpRuntimeManager) closeTenant(tenantID string) {
	m.mu.Lock()
	items := []*acpLiveRuntime{}
	for key, rt := range m.runtimes {
		if rt.tenantID == tenantID {
			delete(m.runtimes, key)
			items = append(items, rt)
		}
	}
	m.mu.Unlock()
	for _, rt := range items {
		rt.close(errors.New("tenant runtime stopped"))
	}
}

func stringSlice(value any) []string {
	list, _ := value.([]any)
	out := make([]string, 0, len(list))
	for _, item := range list {
		if text, ok := item.(string); ok && text != "" {
			out = append(out, text)
		}
	}
	return out
}

func stringMap(value any) map[string]string {
	object, _ := value.(map[string]any)
	out := map[string]string{}
	for key, item := range object {
		if text, ok := item.(string); ok {
			out[key] = text
		}
	}
	return out
}

func (m *acpRuntimeManager) start(ctx context.Context, tenantID, agentID, sid, profileID, previousACPSessionID string, sess Session, profile map[string]any) (*acpLiveRuntime, error) {
	command, _ := profile["command"].(string)
	if strings.TrimSpace(command) == "" {
		return nil, errors.New("ACP profile command required")
	}
	argv := append([]string{command}, stringSlice(profile["args"])...)
	env := stringMap(profile["env"])
	var nodeID, spaceID, workspaceKind string
	var rec struct {
		NodeID        string `gorm:"column:node_id"`
		SpaceID       string `gorm:"column:space_id"`
		WorkspaceKind string `gorm:"column:workspace_kind"`
	}
	err := m.h.deps.Gorm.WithContext(ctx).Table("agents AS a").Select("n.id AS node_id, s.id AS space_id, s.workspace_kind AS workspace_kind").Joins("JOIN spaces s ON s.id=a.space_id").Joins("JOIN runtime_nodes n ON n.id=s.runtime_node_id").Where("a.tenant_id=? AND a.id=? AND n.status IN ('online','draining')", tenantID, agentID).Take(&rec).Error
	if err != nil {
		return nil, errors.New("agent runtime node is not online")
	}
	nodeID, spaceID, workspaceKind = rec.NodeID, rec.SpaceID, rec.WorkspaceKind
	runner, err := m.h.hub.get(nodeID)
	if err != nil {
		return nil, err
	}
	workingDir := "/workspace"
	if sess.Project != nil && *sess.Project != "" && !strings.Contains(*sess.Project, "..") && !strings.HasPrefix(*sess.Project, "/") {
		workingDir += "/" + strings.Trim(*sess.Project, "/")
	}
	startMethod, writeMethod, closeMethod := "host.pty.start", "host.pty.write", "host.pty.close"
	params := map[string]any{"spaceId": spaceID, "command": argv, "workingDir": workingDir, "env": env, "cols": 120, "rows": 40}
	if workspaceKind != "host" {
		var containers []struct {
			DockerID string            `json:"dockerId"`
			Labels   map[string]string `json:"labels"`
		}
		if err := runner.call(ctx, "docker.list", map[string]any{"label": "zakura.space=" + spaceID}, &containers); err != nil {
			return nil, err
		}
		dockerID := ""
		for _, container := range containers {
			if container.Labels["zakura.purpose"] == "workspace" || dockerID == "" {
				dockerID = container.DockerID
			}
		}
		if dockerID == "" {
			return nil, errors.New("workspace container is not running")
		}
		startMethod, writeMethod, closeMethod = "docker.exec.start", "docker.exec.write", "docker.exec.close"
		params = map[string]any{"id": dockerID, "command": argv, "workingDir": workingDir, "env": env}
	}
	var started struct {
		ID string `json:"id"`
	}
	if err := runner.call(ctx, startMethod, params, &started); err != nil {
		return nil, err
	}
	if started.ID == "" {
		return nil, errors.New("runtime node returned no ACP process id")
	}
	userID := ""
	if sess.CreatedByUserID != nil {
		userID = *sess.CreatedByUserID
	}
	rt := &acpLiveRuntime{manager: m, tenantID: tenantID, agentID: agentID, sid: sid, profileID: profileID, runner: runner, processID: started.ID, writeMethod: writeMethod, closeMethod: closeMethod, pending: map[string]chan acpRPCReply{}, inbound: map[string]acpInbound{}, done: make(chan struct{}), state: map[string]any{"runtimeId": started.ID, "sessionId": sid, "profileId": profileID, "state": "starting"}, userID: userID, toolStarted: map[string]time.Time{}, toolRecorded: map[string]bool{}}
	lines := make(chan []byte, 128)
	rt.detach = runner.onStream(started.ID, func(channel string, data []byte) {
		if channel == "exit" {
			// Runner stream callbacks execute on its read loop. Closing requires a
			// runner RPC, so move it off that loop to avoid a reply deadlock.
			go rt.close(errors.New("ACP adapter exited"))
			return
		}
		if channel == "stdout" {
			copyData := append([]byte(nil), data...)
			select {
			case lines <- copyData:
			case <-rt.done:
			}
		}
	})
	go rt.consume(lines)

	initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var initialized map[string]any
	if err := rt.call(initCtx, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{"fs": map[string]any{"readTextFile": true, "writeTextFile": true}, "terminal": true, "elicitation": map[string]any{"form": map[string]any{}, "url": map[string]any{}}, "session": map[string]any{"configOptions": map[string]any{"boolean": map[string]any{}}}}, "clientInfo": map[string]any{"name": "zakura", "title": "Zakura", "version": "go-rewrite"}}, &initialized); err != nil {
		rt.close(err)
		return nil, fmt.Errorf("ACP initialize: %w", err)
	}
	_ = rt.notify(initCtx, "notifications/initialized", map[string]any{})
	loadSupported := false
	if caps, _ := initialized["agentCapabilities"].(map[string]any); caps != nil {
		loadSupported, _ = caps["loadSession"].(bool)
		rt.state["promptCapabilities"] = caps["promptCapabilities"]
	}
	openParams := map[string]any{"cwd": workingDir, "mcpServers": []any{}}
	var opened map[string]any
	if previousACPSessionID != "" && loadSupported {
		openParams["sessionId"] = previousACPSessionID
		err = rt.call(initCtx, "session/load", openParams, &opened)
	}
	if previousACPSessionID == "" || !loadSupported || err != nil {
		delete(openParams, "sessionId")
		err = rt.call(initCtx, "session/new", openParams, &opened)
	}
	if err != nil {
		rt.close(err)
		return nil, fmt.Errorf("ACP open session: %w", err)
	}
	rt.acpSessionID, _ = opened["sessionId"].(string)
	if rt.acpSessionID == "" {
		rt.acpSessionID = previousACPSessionID
	}
	if rt.acpSessionID == "" {
		rt.close(errors.New("ACP adapter returned no session id"))
		return nil, errors.New("ACP adapter returned no session id")
	}
	rt.applySessionState(opened)
	rt.state["state"] = "idle"
	rt.state["acpSessionId"] = rt.acpSessionID
	if err := rt.persistSnapshot(context.WithoutCancel(ctx)); err != nil {
		rt.close(err)
		return nil, err
	}
	return rt, nil
}

func (rt *acpLiveRuntime) consume(chunks <-chan []byte) {
	for {
		select {
		case <-rt.done:
			return
		case chunk := <-chunks:
			rt.mu.Lock()
			rt.buffer = append(rt.buffer, chunk...)
			for {
				index := bytes.IndexByte(rt.buffer, '\n')
				if index < 0 {
					break
				}
				line := append([]byte(nil), bytes.TrimSpace(rt.buffer[:index])...)
				rt.buffer = rt.buffer[index+1:]
				rt.mu.Unlock()
				if len(line) != 0 {
					rt.handleLine(line)
				}
				rt.mu.Lock()
			}
			rt.mu.Unlock()
		}
	}
}

func rpcIDKey(raw json.RawMessage) string { return string(bytes.TrimSpace(raw)) }

func rpcIDDisplay(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	return rpcIDKey(raw)
}

func (rt *acpLiveRuntime) handleLine(line []byte) {
	var message struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
		Result  json.RawMessage `json:"result"`
		Error   *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(line, &message) != nil || message.JSONRPC != "2.0" {
		return
	}
	if message.Method == "" {
		key := rpcIDDisplay(message.ID)
		rt.mu.Lock()
		pending := rt.pending[key]
		delete(rt.pending, key)
		rt.mu.Unlock()
		if pending != nil {
			if message.Error != nil {
				pending <- acpRPCReply{err: fmt.Errorf("ACP error %d: %s", message.Error.Code, message.Error.Message)}
			} else {
				pending <- acpRPCReply{result: message.Result}
			}
		}
		return
	}
	var params map[string]any
	_ = json.Unmarshal(message.Params, &params)
	if len(message.ID) == 0 || string(message.ID) == "null" {
		if message.Method == "session/update" {
			rt.handleUpdate(params)
		}
		return
	}
	requestID := rpcIDDisplay(message.ID)
	switch message.Method {
	case "session/request_permission":
		rt.mu.Lock()
		rt.inbound[requestID] = acpInbound{method: message.Method, id: append(json.RawMessage(nil), message.ID...)}
		run := rt.currentRunID
		rt.mu.Unlock()
		params["requestId"] = requestID
		_, _ = rt.manager.h.store.AppendEvent(rt.manager.h.deps.RunContext(), rt.tenantID, rt.agentID, rt.sid, "permission_request", optionalString(run), params)
	case "elicitation/create":
		rt.mu.Lock()
		rt.inbound[requestID] = acpInbound{method: message.Method, id: append(json.RawMessage(nil), message.ID...)}
		run := rt.currentRunID
		rt.mu.Unlock()
		params["requestId"] = requestID
		_, _ = rt.manager.h.store.AppendEvent(rt.manager.h.deps.RunContext(), rt.tenantID, rt.agentID, rt.sid, "elicitation_request", optionalString(run), params)
	default:
		_ = rt.respond(message.ID, nil, &map[string]any{"code": -32601, "message": "Method not supported by Zakura ACP client"})
	}
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (rt *acpLiveRuntime) handleUpdate(params map[string]any) {
	update, _ := params["update"].(map[string]any)
	if update == nil {
		return
	}
	rt.mu.Lock()
	run := rt.currentRunID
	var usage *appdeps.UsageRecord
	switch update["sessionUpdate"] {
	case "agent_message_chunk":
		if content, _ := update["content"].(map[string]any); content != nil && content["type"] == "text" {
			rt.assistant.WriteString(fmt.Sprint(content["text"]))
		}
	case "current_mode_update":
		modes, _ := rt.state["modes"].(map[string]any)
		if modes == nil {
			modes = map[string]any{"available": []any{}}
		}
		modes["currentId"] = update["currentModeId"]
		rt.state["modes"] = modes
	case "config_option_update":
		if options, ok := update["configOptions"].([]any); ok {
			rt.applyConfigOptionsLocked(options)
		}
	case "available_commands_update":
		rt.state["availableCommands"] = update["availableCommands"]
	case "tool_call":
		if id := fmt.Sprint(update["toolCallId"]); id != "" {
			rt.toolStarted[id] = rt.manager.h.store.now()
		}
	case "tool_call_update":
		id, status := fmt.Sprint(update["toolCallId"]), fmt.Sprint(update["status"])
		if id != "" && (status == "completed" || status == "failed") && !rt.toolRecorded[id] && rt.userID != "" {
			rt.toolRecorded[id] = true
			duration := int64(0)
			if started := rt.toolStarted[id]; !started.IsZero() {
				duration = rt.manager.h.store.now().Sub(started).Milliseconds()
			}
			usageStatus := "ok"
			if status == "failed" {
				usageStatus = "error"
			}
			usage = &appdeps.UsageRecord{TenantID: rt.tenantID, UserID: rt.userID, ActorKind: "user", Category: "tool", Action: "tool_called", Status: usageStatus, DurationMS: duration, AgentID: rt.agentID, SessionID: rt.sid, ResourceKind: "tool_call", ResourceID: id, Summary: fmt.Sprint(update["title"])}
		}
	}
	rt.mu.Unlock()
	_, _ = rt.manager.h.store.AppendEvent(rt.manager.h.deps.RunContext(), rt.tenantID, rt.agentID, rt.sid, "session_update", optionalString(run), update)
	if usage != nil && rt.manager.h.deps.RecordUsage != nil {
		_ = rt.manager.h.deps.RecordUsage(rt.manager.h.deps.RunContext(), *usage)
	}
	if update["sessionUpdate"] == "current_mode_update" || update["sessionUpdate"] == "config_option_update" || update["sessionUpdate"] == "available_commands_update" {
		_ = rt.persistSnapshot(rt.manager.h.deps.RunContext())
	}
}

func (rt *acpLiveRuntime) call(ctx context.Context, method string, params any, out any) error {
	id := fmt.Sprintf("%d", rt.seq.Add(1))
	result := make(chan acpRPCReply, 1)
	rt.mu.Lock()
	rt.pending[id] = result
	rt.mu.Unlock()
	if err := rt.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		rt.mu.Lock()
		delete(rt.pending, id)
		rt.mu.Unlock()
		return err
	}
	select {
	case reply := <-result:
		if reply.err != nil {
			return reply.err
		}
		if out != nil && len(reply.result) != 0 && string(reply.result) != "null" {
			return json.Unmarshal(reply.result, out)
		}
		return nil
	case <-ctx.Done():
		rt.mu.Lock()
		delete(rt.pending, id)
		rt.mu.Unlock()
		return ctx.Err()
	case <-rt.done:
		return errors.New("ACP adapter closed")
	}
}

func (rt *acpLiveRuntime) notify(ctx context.Context, method string, params any) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return rt.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	}
}

func (rt *acpLiveRuntime) respond(id json.RawMessage, result any, rpcError *map[string]any) error {
	message := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id)}
	if rpcError != nil {
		message["error"] = *rpcError
	} else {
		message["result"] = result
	}
	return rt.write(message)
}

func (rt *acpLiveRuntime) write(message any) error {
	select {
	case <-rt.done:
		return errors.New("ACP adapter closed")
	default:
	}
	raw, err := json.Marshal(message)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	var ignored map[string]any
	return rt.runner.call(rt.manager.h.deps.RunContext(), rt.writeMethod, map[string]any{"id": rt.processID, "base64": base64.StdEncoding.EncodeToString(raw)}, &ignored)
}

func (rt *acpLiveRuntime) applySessionState(response map[string]any) {
	if modes, _ := response["modes"].(map[string]any); modes != nil {
		rt.state["modes"] = map[string]any{"currentId": modes["currentModeId"], "available": modes["availableModes"]}
	}
	if options, ok := response["configOptions"].([]any); ok {
		rt.applyConfigOptionsLocked(options)
	}
	if rt.state["modes"] == nil {
		rt.state["modes"] = map[string]any{"currentId": "default", "available": []any{}}
	}
	if rt.state["models"] == nil {
		rt.state["models"] = map[string]any{"currentId": nil, "available": []any{}}
	}
	if rt.state["config"] == nil {
		rt.state["config"] = map[string]any{}
	}
}

func (rt *acpLiveRuntime) applyConfigOptionsLocked(options []any) {
	config := map[string]any{}
	models := map[string]any{"currentId": nil, "available": []any{}}
	for _, raw := range options {
		option, _ := raw.(map[string]any)
		id := fmt.Sprint(option["id"])
		if id != "" {
			config[id] = option["currentValue"]
		}
		if strings.Contains(strings.ToLower(id), "model") {
			models["currentId"] = option["currentValue"]
			models["available"] = option["options"]
		}
	}
	rt.state["config"] = config
	rt.state["configOptions"] = options
	rt.state["models"] = models
}

func (rt *acpLiveRuntime) snapshot() map[string]any {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	raw, _ := json.Marshal(rt.state)
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return out
}

func (rt *acpLiveRuntime) persistSnapshot(ctx context.Context) error {
	state := rt.snapshot()
	_, err := rt.manager.h.store.AppendEvent(ctx, rt.tenantID, rt.agentID, rt.sid, "acp.runtime.updated", nil, state)
	if err != nil {
		return err
	}
	sess, err := rt.manager.h.store.GetSession(ctx, rt.tenantID, rt.agentID, rt.sid)
	if err != nil {
		return err
	}
	origin := map[string]any{}
	_ = json.Unmarshal(sess.Origin, &origin)
	origin["runtime"] = "acp"
	origin["acpProfileId"] = rt.profileID
	origin["acpSessionId"] = rt.acpSessionID
	origin["acpRuntimeId"] = rt.processID
	raw, _ := json.Marshal(origin)
	err = rt.manager.h.deps.Gorm.WithContext(ctx).Model(&models.CloudAgentSession{}).Where("tenant_id=? AND agent_id=? AND id=?", rt.tenantID, rt.agentID, rt.sid).Updates(map[string]any{"origin_json": string(raw), "updated_at": runtimeTimeString(rt.manager.h.store.now())}).Error
	return err
}

func (rt *acpLiveRuntime) patch(ctx context.Context, patch map[string]any) error {
	params := map[string]any{"sessionId": rt.acpSessionID}
	method := ""
	if mode, ok := patch["modeId"].(string); ok && mode != "" {
		method, params["modeId"] = "session/set_mode", mode
	}
	if model, ok := patch["modelId"].(string); ok && model != "" {
		method, params["modelId"] = "session/set_model", model
	}
	if config, ok := patch["configId"].(string); ok && config != "" {
		method, params["configId"], params["value"] = "session/set_config_option", config, patch["value"]
		if _, ok := patch["value"].(bool); ok {
			params["type"] = "boolean"
		}
	}
	if method == "" {
		return errors.New("modeId, modelId, or configId required")
	}
	var result map[string]any
	if err := rt.call(ctx, method, params, &result); err != nil {
		// session/set_model is an extension. Standards-only adapters expose
		// model selection as a session config option instead.
		if method != "session/set_model" {
			return err
		}
		rt.mu.Lock()
		configID := ""
		if options, ok := rt.state["configOptions"].([]any); ok {
			for _, raw := range options {
				option, _ := raw.(map[string]any)
				if id := fmt.Sprint(option["id"]); strings.Contains(strings.ToLower(id), "model") {
					configID = id
					break
				}
			}
		}
		rt.mu.Unlock()
		if configID == "" {
			return err
		}
		result = map[string]any{}
		if fallbackErr := rt.call(ctx, "session/set_config_option", map[string]any{"sessionId": rt.acpSessionID, "configId": configID, "value": patch["modelId"]}, &result); fallbackErr != nil {
			return fallbackErr
		}
	}
	rt.mu.Lock()
	if mode, ok := patch["modeId"].(string); ok {
		modes, _ := rt.state["modes"].(map[string]any)
		if modes == nil {
			modes = map[string]any{"available": []any{}}
			rt.state["modes"] = modes
		}
		modes["currentId"] = mode
	}
	if model, ok := patch["modelId"].(string); ok {
		models, _ := rt.state["models"].(map[string]any)
		if models == nil {
			models = map[string]any{"available": []any{}}
			rt.state["models"] = models
		}
		models["currentId"] = model
	}
	if config, ok := patch["configId"].(string); ok {
		options, _ := rt.state["config"].(map[string]any)
		if options == nil {
			options = map[string]any{}
			rt.state["config"] = options
		}
		options[config] = patch["value"]
		if returned, ok := result["configOptions"].([]any); ok {
			rt.state["configOptions"] = returned
		}
	}
	rt.mu.Unlock()
	return rt.persistSnapshot(context.WithoutCancel(ctx))
}

func (rt *acpLiveRuntime) resolveDecision(body map[string]any, permission bool) error {
	requestID := fmt.Sprint(body["requestId"])
	rt.mu.Lock()
	pending, ok := rt.inbound[requestID]
	if ok {
		delete(rt.inbound, requestID)
	}
	rt.mu.Unlock()
	if !ok {
		return errors.New("no pending ACP request")
	}
	var result any
	if permission {
		if cancelled, _ := body["cancelled"].(bool); cancelled || fmt.Sprint(body["optionId"]) == "" {
			result = map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}
		} else {
			result = map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": fmt.Sprint(body["optionId"])}}
		}
	} else if action := fmt.Sprint(body["action"]); action == "accept" || action == "accepted" {
		result = map[string]any{"action": "accept", "content": body["content"]}
	} else {
		result = map[string]any{"action": "cancel"}
	}
	return rt.respond(pending.id, result, nil)
}

func (rt *acpLiveRuntime) prompt(ctx context.Context, runID, content string) error {
	rt.mu.Lock()
	rt.currentRunID = runID
	rt.assistant.Reset()
	rt.state["state"] = "active"
	rt.mu.Unlock()
	_ = rt.persistSnapshot(context.WithoutCancel(ctx))
	var result map[string]any
	err := rt.call(ctx, "session/prompt", map[string]any{"sessionId": rt.acpSessionID, "prompt": []any{map[string]any{"type": "text", "text": content}}}, &result)
	if err != nil && errors.Is(ctx.Err(), context.Canceled) {
		cancelCtx, cancel := context.WithTimeout(rt.manager.h.deps.RunContext(), 3*time.Second)
		defer cancel()
		_ = rt.notify(cancelCtx, "session/cancel", map[string]any{"sessionId": rt.acpSessionID})
	}
	rt.mu.Lock()
	text := rt.assistant.String()
	rt.currentRunID = ""
	rt.state["state"] = "idle"
	rt.mu.Unlock()
	_ = rt.persistSnapshot(context.WithoutCancel(ctx))
	if err != nil {
		return err
	}
	_, err = rt.manager.h.store.AppendEvent(context.WithoutCancel(ctx), rt.tenantID, rt.agentID, rt.sid, "assistant_message", &runID, map[string]any{"content": text, "provider": "acp", "stopReason": result["stopReason"]})
	if err == nil {
		err = rt.manager.h.store.FinishRun(context.WithoutCancel(ctx), rt.tenantID, rt.agentID, rt.sid, runID, "completed", nil, map[string]any{"runId": runID, "stopReason": result["stopReason"]})
	}
	return err
}

func (rt *acpLiveRuntime) close(reason error) {
	rt.closeOne.Do(func() {
		close(rt.done)
		if rt.detach != nil {
			rt.detach()
		}
		rt.mu.Lock()
		for key, pending := range rt.pending {
			delete(rt.pending, key)
			select {
			case pending <- acpRPCReply{err: reason}:
			default:
			}
		}
		for key, inbound := range rt.inbound {
			delete(rt.inbound, key)
			_ = rt.respond(inbound.id, nil, &map[string]any{"code": -32000, "message": "ACP runtime closed"})
		}
		rt.mu.Unlock()
		ctx, cancel := context.WithTimeout(rt.manager.h.deps.RunContext(), 3*time.Second)
		defer cancel()
		var ignored map[string]any
		_ = rt.runner.call(ctx, rt.closeMethod, map[string]any{"id": rt.processID}, &ignored)
		rt.manager.mu.Lock()
		key := rt.tenantID + "\x00" + rt.sid
		if rt.manager.runtimes[key] == rt {
			delete(rt.manager.runtimes, key)
		}
		rt.manager.mu.Unlock()
	})
}
