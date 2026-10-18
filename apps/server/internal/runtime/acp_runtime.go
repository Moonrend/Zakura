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
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

// acpRuntimeManager owns long-lived ACP adapter processes on selected runtime
// nodes.  The Go server only transports JSON-RPC; commands always execute in
// the agent's jailed host workspace or workspace container.
type acpRuntimeManager struct {
	h         *handler
	mu        sync.Mutex
	runtimes  map[string]*acpLiveRuntime
	starting  map[string]*acpRuntimeStart
	mcpGrants map[string]*acpMCPGrant
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

type acpRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *acpRPCError) Error() string { return fmt.Sprintf("ACP error %d: %s", e.Code, e.Message) }
func acpAuthRequired(err error) bool {
	var rpcErr *acpRPCError
	return errors.As(err, &rpcErr) && rpcErr.Code == -32000
}

type acpInbound struct {
	method  string
	id      json.RawMessage
	options map[string]string
}

type acpLiveRuntime struct {
	manager                  *acpRuntimeManager
	tenantID, agentID, sid   string
	profileID, acpSessionID  string
	adapterImage             string
	runner                   *runnerSession
	processID                string
	containerID              string
	computerID               string
	writeMethod, closeMethod string
	detach                   func()
	seq                      atomic.Uint64
	mu                       sync.Mutex
	pending                  map[string]chan acpRPCReply
	inbound                  map[string]acpInbound
	buffer                   []byte
	done                     chan struct{}
	closeOne                 sync.Once
	closeErr                 error
	state                    map[string]any
	currentRunID             string
	assistant                strings.Builder
	userID                   string
	toolStarted              map[string]time.Time
	toolRecorded             map[string]bool
	spaceID, workingDir      string
	previousSessionID        string
	loadSupported            bool
	authMu                   sync.Mutex
	approvalMu               sync.Mutex
	approvalUpdatePending    atomic.Bool
	terminals                map[string]*acpTerminal
	callbackSlots            chan struct{}
	snapshotMu               sync.Mutex
	mcpHTTP                  bool
	mcpActor                 *httpx.Principal
	mcpGrantHash             string
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
	required, policyErr := m.h.agentSandboxRequired(ctx, tenantID, agentID)
	if policyErr != nil {
		return nil, policyErr
	}
	if required {
		return nil, errors.New("ACP adapters are unavailable for sandbox agents")
	}
	// Check ownership before consulting either the live or in-flight cache.
	// A cached process must never make a session usable by another agent.
	sess, err := m.h.store.GetSession(ctx, tenantID, agentID, sid)
	if err != nil {
		return nil, err
	}
	if sess.Kind != "acp" {
		return nil, errors.New("not an ACP session")
	}
	key := tenantID + "\x00" + sid
	m.mu.Lock()
	if current := m.runtimes[key]; current != nil {
		select {
		case <-current.done:
			m.mu.Unlock()
			// done revokes callbacks before cleanup finishes. Wait for its outcome
			// before replacing the process, and retain unconfirmed cleanup.
			if err := current.close(nil); err != nil {
				return nil, err
			}
			m.mu.Lock()
			if m.runtimes[key] == current {
				delete(m.runtimes, key)
			}
			m.mu.Unlock()
			return m.ensure(ctx, tenantID, agentID, sid)
		default:
			m.mu.Unlock()
			if err := current.validateMCPCaller(ctx); err != nil {
				return nil, err
			}
			return current, nil
		}
	}
	if inFlight := m.starting[key]; inFlight != nil {
		m.mu.Unlock()
		select {
		case <-inFlight.done:
			if inFlight.err == nil && inFlight.rt != nil {
				if err := inFlight.rt.validateMCPCaller(ctx); err != nil {
					return nil, err
				}
			}
			return inFlight.rt, inFlight.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	inFlight := &acpRuntimeStart{done: make(chan struct{})}
	m.starting[key] = inFlight
	m.mu.Unlock()

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

// snapshot is a read-only GET hook: it never relaunches an exited adapter.
// A nil snapshot means a session has never started and the caller may ensure it.
func (m *acpRuntimeManager) snapshot(ctx context.Context, tenantID, agentID, sid string) (map[string]any, error) {
	sess, err := m.h.store.GetSession(ctx, tenantID, agentID, sid)
	if err != nil {
		return nil, err
	}
	if sess.Kind != "acp" {
		return nil, errors.New("not an ACP session")
	}
	m.mu.Lock()
	rt := m.runtimes[tenantID+"\x00"+sid]
	m.mu.Unlock()
	if rt != nil {
		state := rt.snapshot()
		if rt.validateMCPCaller(ctx) != nil {
			state["mcpReconnectRequired"] = true
		}
		return state, nil
	}
	var origin map[string]any
	_ = json.Unmarshal(sess.Origin, &origin)
	state, _ := origin["acpRuntimeState"].(map[string]any)
	// A prior process cannot still be live after server restart. Keep the
	// durable terminal states, and let ensure recover prior live sessions.
	if state != nil && (state["state"] == "closed" || state["state"] == "error") {
		return state, nil
	}
	return nil, nil
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
	if list, ok := value.([]string); ok {
		return append([]string(nil), list...)
	}
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
	if object, ok := value.(map[string]string); ok {
		out := map[string]string{}
		for key, text := range object {
			out[key] = text
		}
		return out
	}
	object, _ := value.(map[string]any)
	out := map[string]string{}
	for key, item := range object {
		if text, ok := item.(string); ok {
			out[key] = text
		}
	}
	return out
}

func (m *acpRuntimeManager) start(ctx context.Context, tenantID, agentID, sid, profileID, previousACPSessionID string, sess Session, profile map[string]any) (_ *acpLiveRuntime, startErr error) {
	command, _ := profile["command"].(string)
	if strings.TrimSpace(command) == "" {
		return nil, errors.New("ACP profile command required")
	}
	argv := append([]string{command}, stringSlice(profile["args"])...)
	env := stringMap(profile["env"])
	workingDir := "/workspace"
	if sess.Project != nil && *sess.Project != "" && !strings.Contains(*sess.Project, "..") && !strings.HasPrefix(*sess.Project, "/") {
		workingDir += "/" + strings.Trim(*sess.Project, "/")
	}
	agent, err := m.h.store.GetAgent(ctx, tenantID, agentID)
	if err != nil {
		return nil, err
	}
	lease, err := m.h.acquireSpaceInfrastructure(ctx, tenantID, agent.SpaceID)
	if err != nil {
		return nil, err
	}
	defer lease.release()
	exec, acpErr := resolveACPHost(ctx, m.h, tenantID, agentID, sid)
	if acpErr != nil {
		return nil, acpErr
	}
	if exec.spaceID != lease.Space.ID {
		return nil, errors.New("ACP session Space changed during startup")
	}
	var pinnedHost string
	if len(sess.Origin) > 0 {
		var origin struct {
			ACPComputerID string `json:"acpComputerId"`
		}
		_ = json.Unmarshal(sess.Origin, &origin)
		pinnedHost = origin.ACPComputerID
	}
	resolvedHost := ""
	if exec != nil {
		resolvedHost = exec.computer.ID
	}
	if pinnedHost != "" && pinnedHost != resolvedHost {
		return nil, errors.New("ACP session host computer changed; start a new session")
	}
	runner, err := m.h.hub.get(exec.nodeID)
	if err != nil {
		return nil, err
	}
	authToken := m.h.store.id()
	if err = m.h.acquireACPAuthLock(ctx, tenantID, exec.spaceID, profileID, "protocol", authToken, workspaceLeaseDuration, exec); err != nil {
		return nil, err
	}
	if err = lease.bindSharedProfile(ctx, profileID); err != nil {
		_ = m.h.releaseACPAuthLock(context.WithoutCancel(ctx), tenantID, exec.spaceID, profileID, authToken)
		return nil, err
	}
	remoteEffect := false
	defer func() {
		if startErr != nil && remoteEffect {
			// A timeout, missing process ID, or failed initialization does not prove
			// remote writes/processes stopped. Keep both durable claims for recovery.
			startErr = lease.uncertain(startErr)
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := m.h.releaseACPAuthLock(cleanupCtx, tenantID, exec.spaceID, profileID, authToken); err != nil && startErr == nil {
			startErr = lease.uncertain(err)
		}
	}()
	var params map[string]any
	var containerID string
	startMethod, writeMethod, closeMethod := "host.pty.start", "host.pty.write", "host.pty.close"
	if image, _ := profile["image"].(string); image != "" {
		setup, _ := profile["setup"].(acpSetup)
		preferred := ""
		if sess.Model != nil {
			preferred = *sess.Model
		}
		if err := lease.check(ctx); err != nil {
			return nil, err
		}
		remoteEffect = true
		fileEnv, prepareErr := m.h.prepareACPFiles(ctx, runner, exec, profileID, setup, preferred)
		if prepareErr != nil {
			return nil, prepareErr
		}
		for key, value := range fileEnv {
			env[key] = value
		}
		containerID, err = m.h.startACPContainer(ctx, runner, exec, sid, profileID, image, workingDir, env)
		if err != nil {
			return nil, err
		}
		startMethod, writeMethod, closeMethod = "docker.attach", "docker.exec.write", "docker.exec.close"
		params = map[string]any{"id": containerID}
	} else {
		space, spaceErr := m.h.store.GetSpace(ctx, tenantID, exec.spaceID)
		if spaceErr != nil {
			return nil, spaceErr
		}
		params = map[string]any{"spaceId": exec.spaceID, "command": argv, "workingDir": workingDir, "env": env, "cols": 120, "rows": 40}
		if space.WorkspaceKind != "host" {
			observation, observeErr := m.h.observeSpaceWorkspace(ctx, space)
			if observeErr != nil {
				return nil, observeErr
			}
			workspaceID := observation.Container.DockerID
			if workspaceID == "" || observation.Container.Status != "running" {
				return nil, errors.New("workspace container is not running")
			}
			startMethod, writeMethod, closeMethod = "docker.exec.start", "docker.exec.write", "docker.exec.close"
			params = map[string]any{"id": workspaceID, "command": argv, "workingDir": workingDir, "env": env}
		}
	}
	var started struct {
		ID string `json:"id"`
	}
	if containerID != "" {
		defer func() {
			if started.ID == "" {
				cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
				defer cancel()
				_ = runner.call(cleanupCtx, "docker.stop", map[string]any{"id": containerID, "remove": true}, nil)
			}
		}()
	}
	if err = lease.check(ctx); err != nil {
		return nil, err
	}
	remoteEffect = true
	if err := runner.call(ctx, startMethod, params, &started); err != nil {
		started.ID = ""
		return nil, err
	}
	if started.ID == "" {
		return nil, errors.New("runtime node returned no ACP process id")
	}
	userID := ""
	if sess.CreatedByUserID != nil {
		userID = *sess.CreatedByUserID
	}
	rt := &acpLiveRuntime{manager: m, tenantID: tenantID, agentID: agentID, sid: sid, profileID: profileID, runner: runner, processID: started.ID, containerID: containerID, computerID: resolvedHost, writeMethod: writeMethod, closeMethod: closeMethod, pending: map[string]chan acpRPCReply{}, inbound: map[string]acpInbound{}, done: make(chan struct{}), state: map[string]any{"runtimeId": started.ID, "sessionId": sid, "profileId": profileID, "state": "starting"}, userID: userID, toolStarted: map[string]time.Time{}, toolRecorded: map[string]bool{}}
	rt.spaceID, rt.workingDir, rt.previousSessionID = exec.spaceID, workingDir, previousACPSessionID
	rt.adapterImage, _ = profile["image"].(string)
	if actor, exists := httpx.PrincipalFrom(ctx); exists {
		rt.mcpActor = &actor
	}
	rt.terminals = map[string]*acpTerminal{}
	rt.callbackSlots = make(chan struct{}, 32)
	rt.mu.Lock()
	rt.applySessionState(nil)
	rt.mu.Unlock()
	lines := make(chan runnerStreamEvent, 128)
	rt.detach = runner.onStream(started.ID, func(channel string, data []byte) {
		if channel == "stdout" || channel == "exit" || channel == "error" {
			select {
			case lines <- runnerStreamEvent{channel: channel, data: append([]byte(nil), data...)}:
			case <-rt.done:
			}
		}
	})
	go rt.consume(lines)

	initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var initialized map[string]any
	if err := rt.call(initCtx, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{"auth": map[string]any{"terminal": true}, "fs": map[string]any{"readTextFile": true, "writeTextFile": true}, "terminal": true, "elicitation": map[string]any{"form": map[string]any{}, "url": map[string]any{}}, "session": map[string]any{"configOptions": map[string]any{"boolean": map[string]any{}}}}, "clientInfo": map[string]any{"name": "zakura", "title": "Zakura", "version": "go-rewrite"}}, &initialized); err != nil {
		rt.close(err)
		return nil, fmt.Errorf("ACP initialize: %w", err)
	}
	_ = rt.notify(initCtx, "notifications/initialized", map[string]any{})
	rt.mu.Lock()
	rt.state["authMethods"] = initialized["authMethods"]
	if rt.state["authMethods"] == nil {
		rt.state["authMethods"] = []any{}
	}
	rt.state["authRequired"], rt.state["authenticated"] = false, false
	if caps, _ := initialized["agentCapabilities"].(map[string]any); caps != nil {
		rt.loadSupported, _ = caps["loadSession"].(bool)
		mcpCaps, _ := caps["mcpCapabilities"].(map[string]any)
		rt.mcpHTTP, _ = mcpCaps["http"].(bool)
		rt.state["promptCapabilities"] = caps["promptCapabilities"]
		auth, _ := caps["auth"].(map[string]any)
		_, logoutSupported := auth["logout"].(map[string]any)
		rt.state["logoutSupported"] = logoutSupported
	}
	rt.mu.Unlock()
	if err := rt.openSession(initCtx); err != nil {
		if !acpAuthRequired(err) {
			rt.close(err)
			return nil, fmt.Errorf("ACP open session: %w", err)
		}
		// Authentication is a live protocol exchange. Keep this initialized
		// adapter so a later authenticate call can unblock session creation.
		rt.mu.Lock()
		rt.state["state"], rt.state["authRequired"] = "auth_required", true
		rt.mu.Unlock()
	}
	if err := rt.persistSnapshot(context.WithoutCancel(ctx)); err != nil {
		rt.close(err)
		return nil, err
	}
	return rt, nil
}

func (rt *acpLiveRuntime) openSession(ctx context.Context) (openErr error) {
	servers, err := rt.mcpSessionServers(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if openErr != nil {
			rt.revokeMCPGrant()
		}
	}()
	params := map[string]any{"cwd": rt.workingDir, "mcpServers": servers}
	var opened map[string]any
	if rt.previousSessionID != "" && rt.loadSupported {
		params["sessionId"] = rt.previousSessionID
		err = rt.call(ctx, "session/load", params, &opened)
		if acpAuthRequired(err) {
			return &acpRPCError{Code: -32000, Message: "ACP authentication required"}
		}
	}
	if rt.previousSessionID == "" || !rt.loadSupported || err != nil {
		delete(params, "sessionId")
		err = rt.call(ctx, "session/new", params, &opened)
	}
	if err != nil {
		if len(servers) != 0 {
			if acpAuthRequired(err) {
				return &acpRPCError{Code: -32000, Message: "ACP authentication required"}
			}
			// An adapter error may echo request headers. Never persist a grant
			// through lifecycle snapshots/events or return it to the dashboard.
			return errors.New("ACP session initialization with MCP failed; reopen the session")
		}
		return err
	}
	id, _ := opened["sessionId"].(string)
	if id == "" {
		return errors.New("ACP adapter returned no session id")
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	select {
	case <-rt.done:
		return errors.New("ACP adapter closed")
	default:
	}
	rt.acpSessionID = id
	rt.applySessionState(opened)
	rt.state["state"], rt.state["acpSessionId"] = "idle", id
	rt.state["authRequired"] = false
	delete(rt.state, "error")
	return nil
}

func (rt *acpLiveRuntime) authenticate(ctx context.Context, methodID string) error {
	rt.authMu.Lock()
	defer rt.authMu.Unlock()
	rt.mu.Lock()
	valid := false
	if methods, ok := rt.state["authMethods"].([]any); ok {
		for _, raw := range methods {
			method, _ := raw.(map[string]any)
			kind, _ := method["type"].(string)
			if methodID != "" && method["id"] == methodID && (kind == "" || kind == "agent") {
				valid = true
			}
		}
	}
	active := rt.currentRunID != ""
	rt.mu.Unlock()
	if !valid {
		return errors.New("unsupported ACP authentication method")
	}
	if active {
		return errors.New("ACP session is active")
	}
	if err := rt.call(ctx, "authenticate", map[string]any{"methodId": methodID}, nil); err != nil {
		return err
	}
	rt.mu.Lock()
	rt.state["authenticated"], rt.state["authRequired"] = true, false
	needsSession := rt.acpSessionID == ""
	rt.mu.Unlock()
	if needsSession {
		if err := rt.openSession(ctx); err != nil {
			rt.mu.Lock()
			rt.state["state"], rt.state["error"] = "error", err.Error()
			if acpAuthRequired(err) {
				rt.state["state"], rt.state["authRequired"] = "auth_required", true
			}
			rt.mu.Unlock()
			_ = rt.persistSnapshot(context.WithoutCancel(ctx))
			return err
		}
	}
	return rt.persistSnapshot(context.WithoutCancel(ctx))
}

func (rt *acpLiveRuntime) logout(ctx context.Context) error {
	rt.authMu.Lock()
	defer rt.authMu.Unlock()
	rt.mu.Lock()
	supported, active := rt.state["logoutSupported"] == true, rt.currentRunID != ""
	rt.mu.Unlock()
	if !supported {
		return errors.New("ACP adapter does not support logout")
	}
	if active {
		return errors.New("ACP session is active")
	}
	rt.revokeMCPGrant()
	if err := rt.call(ctx, "logout", map[string]any{}, nil); err != nil {
		return err
	}
	rt.mu.Lock()
	rt.acpSessionID = ""
	rt.state["acpSessionId"] = ""
	rt.state["authenticated"], rt.state["authRequired"], rt.state["state"] = false, true, "auth_required"
	rt.mu.Unlock()
	return rt.persistSnapshot(context.WithoutCancel(ctx))
}

func (rt *acpLiveRuntime) consume(chunks <-chan runnerStreamEvent) {
	for {
		select {
		case <-rt.done:
			return
		case event := <-chunks:
			// Consume all preceding output before recording exit; a final prompt
			// response may be in the same startup/exit burst.
			if event.channel == "exit" {
				rt.close(errors.New("ACP adapter exited"))
				return
			}
			if event.channel == "error" {
				rt.close(fmt.Errorf("ACP runner disconnected: %s", string(event.data)))
				return
			}
			chunk := event.data
			rt.mu.Lock()
			rt.buffer = append(rt.buffer, chunk...)
			for {
				index := bytes.IndexByte(rt.buffer, '\n')
				if index < 0 {
					if len(rt.buffer) > 4<<20 {
						rt.mu.Unlock()
						rt.close(errors.New("ACP protocol line exceeds limit"))
						return
					}
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
		Error   *acpRPCError    `json:"error"`
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
				pending <- acpRPCReply{err: message.Error}
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
	if params == nil {
		params = map[string]any{}
	}
	// Callback work can call runner RPCs or wait for a terminal. It must never
	// block parsing a following ACP response (including initialize/authenticate).
	id := append(json.RawMessage(nil), message.ID...)
	if rt.callbackSlots != nil {
		select {
		case rt.callbackSlots <- struct{}{}:
		default:
			go rt.close(errors.New("too many pending ACP callbacks"))
			return
		}
	}
	go func() {
		if rt.callbackSlots != nil {
			defer func() { <-rt.callbackSlots }()
		}
		rt.handleCallback(message.Method, id, params)
	}()
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (rt *acpLiveRuntime) handleUpdate(params map[string]any) {
	if !rt.validSession(params) {
		return
	}
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
	if (update["sessionUpdate"] == "current_mode_update" || update["sessionUpdate"] == "config_option_update") && rt.auditedClaudeACP() && rt.approvalUpdatePending.CompareAndSwap(false, true) {
		// Keep response parsing available while a policy check closes the process.
		go func() {
			defer rt.approvalUpdatePending.Store(false)
			rt.enforceActiveApprovalPolicy()
		}()
	}
}

func (rt *acpLiveRuntime) call(ctx context.Context, method string, params any, out any) error {
	id := fmt.Sprintf("%d", rt.seq.Add(1))
	result := make(chan acpRPCReply, 1)
	rt.mu.Lock()
	rt.pending[id] = result
	rt.mu.Unlock()
	if err := rt.writeContext(ctx, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
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
		rt.mu.Lock()
		delete(rt.pending, id)
		rt.mu.Unlock()
		return errors.New("ACP adapter closed")
	}
}

func (rt *acpLiveRuntime) notify(ctx context.Context, method string, params any) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return rt.writeContext(ctx, map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
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
	ctx, cancel := context.WithTimeout(rt.manager.h.deps.RunContext(), 10*time.Second)
	defer cancel()
	return rt.writeContext(ctx, message)
}

func (rt *acpLiveRuntime) writeContext(ctx context.Context, message any) error {
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
	return rt.runner.call(ctx, rt.writeMethod, map[string]any{"id": rt.processID, "base64": base64.StdEncoding.EncodeToString(raw)}, &ignored)
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
	rt.snapshotMu.Lock()
	defer rt.snapshotMu.Unlock()
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
	origin["acpRuntimeId"] = rt.processID
	origin["acpRuntimeState"] = state
	if sessionID, exists := state["acpSessionId"]; exists {
		origin["acpSessionId"] = sessionID
	}
	if rt.computerID != "" {
		origin["acpComputerId"] = rt.computerID
	}
	raw, _ := json.Marshal(origin)
	err = rt.manager.h.deps.Gorm.WithContext(ctx).Model(&models.CloudAgentSession{}).Where("tenant_id=? AND agent_id=? AND id=?", rt.tenantID, rt.agentID, rt.sid).Updates(map[string]any{"origin_json": string(raw), "updated_at": runtimeTimeString(rt.manager.h.store.now())}).Error
	return err
}

func (rt *acpLiveRuntime) patch(ctx context.Context, patch map[string]any) error {
	rt.authMu.Lock()
	defer rt.authMu.Unlock()
	rt.mu.Lock()
	sessionID := rt.acpSessionID
	required := rt.state["authRequired"] == true
	rt.mu.Unlock()
	if sessionID == "" || required {
		return &acpRPCError{Code: -32000, Message: "Authentication required"}
	}
	if err := rt.checkApprovalModePatch(ctx, patch); err != nil {
		return err
	}
	params := map[string]any{"sessionId": sessionID}
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
		if fallbackErr := rt.call(ctx, "session/set_config_option", map[string]any{"sessionId": sessionID, "configId": configID, "value": patch["modelId"]}, &result); fallbackErr != nil {
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
	requestID, ok := body["requestId"].(string)
	if !ok || requestID == "" {
		return errors.New("requestId required")
	}
	rt.mu.Lock()
	pending, ok := rt.inbound[requestID]
	if ok && pending.method == "session/request_permission" {
		rt.mu.Unlock()
		return errors.New("use the shared tool approval request")
	}
	if !ok {
		rt.mu.Unlock()
		return errors.New("no pending ACP request")
	}
	if permission != (pending.method == "session/request_permission") {
		rt.mu.Unlock()
		return errors.New("ACP request type mismatch")
	}
	var result any
	cancelled, _ := body["cancelled"].(bool)
	if permission {
		if cancelled {
			result = map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}
		} else {
			optionID, _ := body["optionId"].(string)
			if optionID == "" || pending.options[optionID] == "" {
				rt.mu.Unlock()
				return errors.New("invalid ACP permission optionId")
			}
			result = map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": optionID}}
		}
	} else {
		action, hasAction := body["action"].(string)
		if cancelled {
			action = "cancel"
		} else if !hasAction {
			if value, exists := body["cancelled"]; exists && value == false {
				action = "accept"
			}
		}
		if action == "accepted" {
			action = "accept"
		}
		if action != "accept" && action != "decline" && action != "cancel" {
			rt.mu.Unlock()
			return errors.New("invalid ACP elicitation action")
		}
		result = map[string]any{"action": action}
		if action == "accept" {
			result.(map[string]any)["content"] = body["content"]
		}
	}
	delete(rt.inbound, requestID)
	rt.mu.Unlock()
	return rt.respond(pending.id, result, nil)
}

func (rt *acpLiveRuntime) prompt(ctx context.Context, runID, content string) error {
	rt.authMu.Lock()
	defer rt.authMu.Unlock()
	rt.mu.Lock()
	if rt.acpSessionID == "" || rt.state["authRequired"] == true {
		rt.mu.Unlock()
		return &acpRPCError{Code: -32000, Message: "Authentication required"}
	}
	rt.mu.Unlock()
	if err := rt.constrainApprovalMode(ctx); err != nil {
		return err
	}
	if err := rt.checkApprovalCompatibility(ctx); err != nil {
		return err
	}
	rt.mu.Lock()
	select {
	case <-rt.done:
		rt.mu.Unlock()
		return errors.New("ACP adapter closed")
	default:
	}
	if rt.acpSessionID == "" || rt.state["authRequired"] == true {
		rt.mu.Unlock()
		return &acpRPCError{Code: -32000, Message: "Authentication required"}
	}
	if rt.currentRunID != "" {
		rt.mu.Unlock()
		return errors.New("ACP session is active")
	}
	sessionID := rt.acpSessionID
	rt.currentRunID = runID
	rt.assistant.Reset()
	rt.state["state"] = "active"
	rt.mu.Unlock()
	_ = rt.persistSnapshot(context.WithoutCancel(ctx))
	if rt.auditedClaudeACP() {
		// Recheck after publishing the active identity to cover a concurrent save.
		rt.enforceActiveApprovalPolicy()
		stopped, watcherDone := make(chan struct{}), make(chan struct{})
		ticker := time.NewTicker(time.Second)
		defer func() {
			ticker.Stop()
			close(stopped)
			<-watcherDone
		}()
		go func() {
			defer close(watcherDone)
			rt.watchApprovalPolicy(ctx, ticker.C, stopped)
		}()
	}
	var result map[string]any
	err := rt.call(ctx, "session/prompt", map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": content}, map[string]any{"type": "text", "text": "Zakura host rendering capabilities (platform context, not a user request):\n" + generativeUIPrompt}}}, &result)
	if err != nil && errors.Is(ctx.Err(), context.Canceled) {
		cancelCtx, cancel := context.WithTimeout(rt.manager.h.deps.RunContext(), 3*time.Second)
		defer cancel()
		_ = rt.notify(cancelCtx, "session/cancel", map[string]any{"sessionId": sessionID})
	}
	rt.mu.Lock()
	text := rt.assistant.String()
	rt.currentRunID = ""
	select {
	case <-rt.done: // close already recorded the terminal lifecycle state
	default:
		rt.state["state"] = "idle"
		if err != nil && ctx.Err() == nil {
			rt.state["state"], rt.state["error"] = "error", err.Error()
		}
		if acpAuthRequired(err) {
			rt.state["state"], rt.state["authRequired"] = "auth_required", true
		}
	}
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

func (rt *acpLiveRuntime) close(reason error) error {
	rt.closeOne.Do(func() {
		rt.revokeMCPGrant()
		if reason == nil {
			reason = errors.New("ACP adapter closed")
		}
		rt.mu.Lock()
		rt.state["state"] = "closed"
		rt.state["error"] = reason.Error()
		if reason.Error() != "server shutting down" && reason.Error() != "tenant runtime stopped" && reason.Error() != "ACP adapter closed" {
			rt.state["state"] = "error"
		}
		close(rt.done)
		for key, pending := range rt.pending {
			delete(rt.pending, key)
			select {
			case pending <- acpRPCReply{err: reason}:
			default:
			}
		}
		rt.inbound = map[string]acpInbound{}
		terminals := rt.terminals
		rt.terminals = map[string]*acpTerminal{}
		rt.mu.Unlock()
		if rt.manager.h.store != nil {
			settle, cancel := context.WithTimeout(context.WithoutCancel(rt.manager.h.deps.RunContext()), 3*time.Second)
			_ = rt.manager.h.store.cancelApprovals(settle, rt.tenantID, rt.agentID, rt.sid, "")
			cancel()
		}
		if rt.detach != nil {
			rt.detach()
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(rt.manager.h.deps.RunContext()), 3*time.Second)
		defer cancel()
		// Persist terminal state before cleanup RPCs, which may fail or time out.
		_ = rt.persistSnapshot(ctx)
		for _, terminal := range terminals {
			if terminal.detach != nil {
				terminal.detach()
			}
			terminal.once.Do(func() { close(terminal.done) })
			if rt.runner.call(ctx, terminal.closeMethod, map[string]any{"id": terminal.id}, nil) != nil {
				rt.closeErr = errACPCleanupUnconfirmed
			}
		}
		if rt.runner.call(ctx, rt.closeMethod, map[string]any{"id": rt.processID}, nil) != nil {
			rt.closeErr = errACPCleanupUnconfirmed
		}
		if rt.containerID != "" {
			if rt.runner.call(ctx, "docker.stop", map[string]any{"id": rt.containerID, "remove": true}, nil) != nil {
				rt.closeErr = errACPCleanupUnconfirmed
			}
		}
		if rt.closeErr != nil {
			rt.mu.Lock()
			rt.state["state"], rt.state["error"] = "error", rt.closeErr.Error()
			rt.mu.Unlock()
			persistCtx, persistCancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
			defer persistCancel()
			_ = rt.persistSnapshot(persistCtx)
		}
		// Keep the closed runtime snapshot in the manager until explicit ensure
		// recovery replaces it. GET must not silently restart failed adapters.
	})
	return rt.closeErr
}
