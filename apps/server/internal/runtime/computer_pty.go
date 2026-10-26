// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/ssh"
)

// computerTerminalUnavailable is the single refusal surfaced whenever a
// dedicated computer cannot host an interactive shell. It never names a
// provider internals or a fallback host.
const computerTerminalUnavailable = "terminal is not available on this computer"

const (
	computerPTYDefaultCols = 120
	computerPTYDefaultRows = 30
)

// resolveComputerTerminal resolves the interactive-shell target for a computer.
// An explicit computer id (or an immutable run) pins the exact target, while an
// empty id resolves the chat's computer: its choice, else the Space server
// computer. The server computer's shell is the agent workspace terminal, so it
// is refused here, as is a computer without the PTY capability or without an
// active ready runtime; nothing is silently downgraded to another host.
// Authorized resolution records activity so an idle temporary runtime is renewed.
func (h *handler) resolveComputerTerminal(ctx context.Context, tenantID, spaceID, computerID, sessionID string) (*resolvedExecution, error) {
	run, _ := ctx.Value(computerRunKey{}).(string)
	var c computers.Computer
	var err error
	switch {
	case run != "":
		c, err = h.computerStore().ResolveRunComputer(ctx, tenantID, spaceID, run, computerID)
	case computerID != "":
		c, err = h.computerStore().Get(ctx, tenantID, spaceID, computerID)
	default:
		if sessionID == "" {
			return nil, errors.New(computerTerminalUnavailable)
		}
		c, _, err = h.computerStore().SessionComputer(ctx, tenantID, spaceID, sessionID)
	}
	if err != nil {
		return nil, err
	}
	return h.resolveReadyComputerTerminal(ctx, tenantID, spaceID, c, sessionID)
}

// resolveReadyComputerTerminal rejects the server computer, an ungranted
// capability, or a missing runtime and otherwise pins the active ready
// incarnation.
func (h *handler) resolveReadyComputerTerminal(ctx context.Context, tenantID, spaceID string, c computers.Computer, sessionID string) (*resolvedExecution, error) {
	if c.IsServer() || !c.Has(computers.PTY) {
		return nil, errors.New(computerTerminalUnavailable)
	}
	scope, err := c.Scope(sessionID)
	if err != nil {
		return nil, err
	}
	now := h.store.now()
	active, err := h.computerStore().ActiveRuntime(ctx, tenantID, spaceID, c.ID, scope)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errors.New(computerTerminalUnavailable)
		}
		return nil, err
	}
	target := computers.Target{TenantID: tenantID, SpaceID: spaceID, ComputerID: c.ID, RuntimeID: active.ID, Incarnation: active.Incarnation}
	if err = computers.CheckTarget(target, c, active, scope, computers.PTY, false, now); err != nil {
		return nil, fmt.Errorf("%s: %w", computerTerminalUnavailable, err)
	}
	if err = h.computerStore().RecordActivity(ctx, target, scope, now); err != nil {
		return nil, err
	}
	return &resolvedExecution{spaceID: spaceID, nodeID: c.RuntimeNodeID, containerID: active.ExternalID, hostRoot: active.RootPath, computer: c, runtime: active}, nil
}

// computerPTYStream is one attached interactive shell. Output flows to the sink
// passed to startComputerPTY; input, resize and close are transport-specific.
type computerPTYStream struct {
	ID          string
	streamOwner string
	closeMethod string
	write       func(data []byte) error
	resize      func(cols, rows int) error
	close       func() error
}

// startComputerPTY attaches an interactive login shell on the resolved computer.
// server and temporary use the runner's docker exec stream; ssh and railway use
// a real SSH session. Everything else is refused.
func (h *handler) startComputerPTY(ctx context.Context, exec *resolvedExecution, cols, rows int, sink func(string, []byte)) (*computerPTYStream, error) {
	if exec == nil {
		return nil, errors.New(computerTerminalUnavailable)
	}
	if cols <= 0 {
		cols = computerPTYDefaultCols
	}
	if rows <= 0 {
		rows = computerPTYDefaultRows
	}
	switch exec.computer.Provider {
	case computers.Server, computers.Temporary:
		return h.startRunnerComputerPTY(ctx, exec, cols, rows, sink)
	case computers.SSH, computers.Railway:
		return h.startSSHComputerPTY(ctx, exec, cols, rows, sink)
	default:
		return nil, errors.New(computerTerminalUnavailable)
	}
}

// startRunnerComputerPTY starts a login shell with a TTY inside the computer's
// own container through the runner.
func (h *handler) startRunnerComputerPTY(ctx context.Context, exec *resolvedExecution, cols, rows int, sink func(string, []byte)) (*computerPTYStream, error) {
	if strings.TrimSpace(exec.containerID) == "" || strings.TrimSpace(exec.nodeID) == "" {
		return nil, errors.New(computerTerminalUnavailable)
	}
	session, err := h.hub.get(exec.nodeID)
	if err != nil {
		return nil, err
	}
	owner, err := workspaceStreamOwner(ctx, session)
	if err != nil {
		return nil, err
	}
	var started struct {
		ID string `json:"id"`
	}
	if err := session.call(ctx, "docker.exec.start", map[string]any{"id": exec.containerID, "command": []string{"bash", "-l"}, "workingDir": "/workspace", "tty": true, "cols": cols, "rows": rows}, &started); err != nil || started.ID == "" {
		return nil, errors.New(computerTerminalUnavailable)
	}
	unsubscribe := session.onStream(started.ID, func(channel string, data []byte) {
		switch channel {
		case "stdout", "stderr":
			sink(channel, data)
		case "exit":
			sink("exit", nil)
		case "error":
			sink("error", []byte("terminal connection lost"))
		}
	})
	var once sync.Once
	var closeErr error
	return &computerPTYStream{
		ID: started.ID, streamOwner: owner, closeMethod: "docker.exec.close",
		write: func(data []byte) error {
			return session.call(ctx, "docker.exec.write", map[string]any{"id": started.ID, "base64": base64.StdEncoding.EncodeToString(data)}, nil)
		},
		resize: func(cols, rows int) error {
			return session.call(ctx, "docker.exec.resize", map[string]any{"id": started.ID, "cols": cols, "rows": rows}, nil)
		},
		close: func() error {
			once.Do(func() {
				unsubscribe()
				cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				defer cancel()
				closeErr = closeWorkspaceStream(cleanup, session, "docker.exec.close", started.ID, owner)
			})
			return closeErr
		},
	}, nil
}

// ptySinkWriter forwards an SSH session stream into the terminal sink.
type ptySinkWriter struct {
	sink    func(string, []byte)
	channel string
}

func (w ptySinkWriter) Write(p []byte) (int, error) {
	data := append([]byte(nil), p...)
	w.sink(w.channel, data)
	return len(p), nil
}

// startSSHComputerPTY opens a dedicated SSH session with a requested PTY and an
// interactive login shell.
func (h *handler) startSSHComputerPTY(ctx context.Context, exec *resolvedExecution, cols, rows int, sink func(string, []byte)) (*computerPTYStream, error) {
	if exec.computer.Provider != computers.SSH && exec.computer.Provider != computers.Railway {
		return nil, errors.New(computerTerminalUnavailable)
	}
	dial, err := h.sshExecDialConfig(ctx, exec)
	if err != nil {
		return nil, err
	}
	client, err := computers.DialSSH(ctx, dial)
	if err != nil {
		return nil, err
	}
	session, err := client.NewSession()
	if err != nil {
		_ = client.Close()
		return nil, errors.New("ssh session could not be opened")
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := session.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, errors.New("ssh pty could not be allocated")
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, errors.New("ssh session streams are unavailable")
	}
	session.Stdout = ptySinkWriter{sink: sink, channel: "stdout"}
	session.Stderr = ptySinkWriter{sink: sink, channel: "stderr"}
	if err := session.Shell(); err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, errors.New("ssh shell could not be started")
	}
	go func() {
		_ = session.Wait()
		sink("exit", nil)
	}()
	var once sync.Once
	return &computerPTYStream{
		ID:     "ssh",
		write:  func(data []byte) error { _, err := stdin.Write(data); return err },
		resize: func(cols, rows int) error { return session.WindowChange(rows, cols) },
		close: func() error {
			once.Do(func() {
				_ = stdin.Close()
				_ = session.Close()
				_ = client.Close()
			})
			// Closing SSH transport does not prove remote descendants exited.
			return nil
		},
	}, nil
}

// bridgeComputerTerminal drives the existing workspace websocket framing against
// a computer's PTY, producing the same message shapes the terminal dialog
// already understands.
func (h *handler) bridgeComputerTerminal(ctx context.Context, bridge *workspaceBridge, exec *resolvedExecution, cols, rows int) {
	writeJSON := func(v map[string]any) {
		raw, _ := json.Marshal(v)
		_ = bridge.write(0x1, raw)
	}
	closed := make(chan struct{})
	var once sync.Once
	sink := func(channel string, data []byte) {
		switch channel {
		case "stdout", "stderr":
			if len(data) > 0 {
				writeJSON(map[string]any{"type": "output", "data": string(data)})
			}
		case "exit":
			writeJSON(map[string]any{"type": "exit", "code": 0})
			once.Do(func() { close(closed) })
			_ = bridge.conn.Close()
		case "error":
			writeJSON(map[string]any{"type": "error", "message": "terminal connection lost"})
			once.Do(func() { close(closed) })
			_ = bridge.conn.Close()
		}
	}
	stream, err := h.startComputerPTY(ctx, exec, cols, rows, sink)
	if err != nil {
		bridge.cleanupErr = err
		writeJSON(map[string]any{"type": "error", "message": err.Error()})
		return
	}
	defer func() {
		err := stream.close()
		bridge.cleanupErr = errors.Join(bridge.cleanupErr, err)
		bridge.remoteClosed = err == nil && (bridge.journalID == "" || stream.streamOwner == bridge.streamOwner)
	}()
	if bridge.journalID != "" && stream.streamOwner != bridge.streamOwner {
		bridge.cleanupErr = errors.New("terminal executor changed during allocation")
		return
	}
	if err := bridge.allocated(stream.ID, stream.closeMethod); err != nil {
		bridge.cleanupErr = err
		return
	}
	writeJSON(map[string]any{"type": "ready", "sessionId": stream.ID, "command": "bash -l"})
	for {
		opcode, payload, err := readWSFrameSized(bridge.rw.Reader, 1<<20)
		if err != nil || opcode == 0x8 {
			return
		}
		if opcode == 0x9 {
			_ = bridge.write(0xA, payload)
			continue
		}
		if opcode != 0x1 {
			continue
		}
		var message struct {
			Type       string `json:"type"`
			Data       string `json:"data"`
			Cols, Rows int
		}
		if json.Unmarshal(payload, &message) != nil {
			message.Type, message.Data = "input", string(payload)
		}
		switch message.Type {
		case "resize":
			if err := stream.resize(message.Cols, message.Rows); err != nil {
				return
			}
		case "input":
			if err := stream.write([]byte(message.Data)); err != nil {
				return
			}
		}
		select {
		case <-closed:
			return
		default:
		}
	}
}

// computerTerminalTicket issues a one-time ticket for a dedicated computer's
// interactive shell. The ticket pins the exact tenant/space/computer/runtime/
// incarnation identity so the proxy can re-verify it at attach time.
func (h *handler) computerTerminalTicket(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	spaceID := chi.URLParam(r, "id")
	computerID := chi.URLParam(r, "cid")
	if !computerScopeAllowed(p, spaceID, "") {
		httpx.Error(w, http.StatusForbidden, "computer scope denied")
		return
	}
	if _, err := h.store.GetSpace(r.Context(), p.TenantID, spaceID); err != nil {
		statusErr(w, err)
		return
	}
	if c, err := h.computerStore().Get(r.Context(), p.TenantID, spaceID, computerID); err == nil && c.IsServer() {
		h.issueSpaceWorkspaceTicket(w, r, "terminal")
		return
	}
	var in struct {
		SessionID string `json:"sessionId"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in)
	}
	sessionID := strings.TrimSpace(in.SessionID)
	if sessionID != "" {
		if err := h.computerTerminalSession(r.Context(), p, spaceID, sessionID); err != nil {
			httpx.Error(w, http.StatusForbidden, "terminal session scope denied")
			return
		}
	}
	exec, err := h.resolveComputerTerminal(r.Context(), p.TenantID, spaceID, computerID, sessionID)
	if err != nil {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	expires := h.store.now().Add(45 * time.Second)
	if p.OAuth {
		if p.OAuthExpiresAt.IsZero() || !p.OAuthExpiresAt.After(h.store.now()) {
			httpx.Error(w, http.StatusForbidden, "terminal principal required")
			return
		}
		if p.OAuthExpiresAt.Before(expires) {
			expires = p.OAuthExpiresAt
		}
	}
	identity := "user:" + p.UserID
	if p.APIKey {
		identity = "key:" + p.APIKeyID
	}
	binding := acpLoginTicket{Principal: identity, Tenant: p.TenantID, Space: spaceID, Computer: computerID, Profile: "computer-terminal", Node: exec.nodeID, AuthSession: p.SessionID, ActorSpace: p.SpaceID, ActorAgent: p.AgentID, OAuth: p.OAuth, OAuthScope: p.OAuthScope, Expires: expires.UnixMilli(), Nonce: rand.Text()}
	if p.OAuth {
		binding.OAuthExpiry = p.OAuthExpiresAt.UnixMilli()
	}
	binding.ConfigHash = computerTerminalDigest(exec.computer, exec.runtime)
	actor, err := h.workspaceTicketActor(r.Context(), binding)
	if err != nil || h.authorizeLocalNode(r.Context(), actor, exec.nodeID) != nil {
		httpx.Error(w, http.StatusForbidden, "terminal principal required")
		return
	}
	ticket := workspaceConnectionTicket{TenantID: p.TenantID, Kind: "terminal", SpaceID: spaceID, ComputerID: computerID, SessionID: sessionID, RuntimeID: exec.runtime.ID, Incarnation: exec.runtime.Incarnation, NodeID: exec.nodeID, Expires: binding.Expires, Authorization: &binding}
	body := base64.RawURLEncoding.EncodeToString(rawJSON(ticket))
	mac := hmac.New(sha256.New, h.deps.Secret)
	_, _ = mac.Write([]byte("computer-terminal:" + body))
	token := body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if _, err = h.deps.DB.ExecContext(r.Context(), h.deps.Rebind(`INSERT INTO runtime_connection_tickets(token_hash,principal_id,tenant_id,space_id,profile_id,node_id,computer_id,config_hash,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`), acpLoginDigest([]byte(token)), identity, p.TenantID, spaceID, binding.Profile, exec.nodeID, computerID, binding.ConfigHash, binding.Expires); err != nil {
		statusErr(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	httpx.JSON(w, http.StatusOK, map[string]any{
		"ticket": token,
		"url":    strings.TrimRight(h.deps.PublicURL, "/") + "/api/spaces/" + url.PathEscape(spaceID) + "/computers/" + url.PathEscape(computerID) + "/terminal-proxy?token=" + url.QueryEscape(token),
	})
}

// verifyComputerTicket validates a computer terminal ticket against the exact
// space and computer in the proxy path. A legacy agent ticket never satisfies it
// because its computer identity is empty.
func (h *handler) verifyComputerTicket(ctx context.Context, raw, spaceID, computerID string) (workspaceConnectionTicket, error) {
	var ticket workspaceConnectionTicket
	if len(raw) > 4096 {
		return ticket, errors.New("invalid ticket")
	}
	body, signature, ok := strings.Cut(raw, ".")
	if !ok || body == "" || signature == "" {
		return ticket, errors.New("invalid ticket")
	}
	given, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return ticket, errors.New("invalid ticket")
	}
	mac := hmac.New(sha256.New, h.deps.Secret)
	_, _ = mac.Write([]byte("computer-terminal:" + body))
	expected := mac.Sum(nil)
	if len(given) != len(expected) || subtle.ConstantTimeCompare(given, expected) != 1 {
		return ticket, errors.New("invalid ticket")
	}
	payload, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil || json.Unmarshal(payload, &ticket) != nil || ticket.Kind != "terminal" || ticket.TenantID == "" || ticket.SpaceID != spaceID || ticket.ComputerID != computerID || ticket.RuntimeID == "" || ticket.Incarnation == "" || ticket.Expires <= h.store.now().UnixMilli() {
		return workspaceConnectionTicket{}, errors.New("invalid or expired ticket")
	}
	binding := ticket.Authorization
	if binding == nil || binding.Tenant != ticket.TenantID || binding.Space != spaceID || binding.Computer != computerID || binding.Node != ticket.NodeID || binding.Profile != "computer-terminal" || binding.Expires != ticket.Expires || binding.Nonce == "" || binding.ConfigHash == "" {
		return workspaceConnectionTicket{}, errors.New("invalid ticket authorization")
	}
	if _, err := h.workspaceTicketActor(ctx, *binding); err != nil {
		return workspaceConnectionTicket{}, err
	}
	return ticket, nil
}

func computerTerminalDigest(c computers.Computer, runtime computers.Runtime) string {
	return acpLoginDigest(rawJSON([]any{c, c.SecretRef, runtime.ID, runtime.Incarnation, runtime.ExternalID, runtime.RootPath, runtime.SessionScope}))
}

func (h *handler) consumeComputerTicket(ctx context.Context, ticket workspaceConnectionTicket, raw string) error {
	binding := ticket.Authorization
	result, err := h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE runtime_connection_tickets SET used_at=? WHERE token_hash=? AND principal_id=? AND tenant_id=? AND space_id=? AND profile_id=? AND node_id=? AND computer_id=? AND config_hash=? AND expires_at=? AND expires_at>? AND used_at IS NULL`), h.store.now().UnixMilli(), acpLoginDigest([]byte(raw)), binding.Principal, ticket.TenantID, ticket.SpaceID, binding.Profile, ticket.NodeID, ticket.ComputerID, binding.ConfigHash, ticket.Expires, h.store.now().UnixMilli())
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return errors.New("invalid or used ticket")
	}
	return nil
}

func (h *handler) computerTerminalSession(ctx context.Context, actor httpx.Principal, space, session string) error {
	var agent string
	if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT s.agent_id FROM cloud_agent_sessions s JOIN agents a ON a.id=s.agent_id WHERE s.id=? AND s.tenant_id=? AND a.space_id=?`), session, actor.TenantID, space).Scan(&agent); err != nil {
		return err
	}
	_, err := h.store.GetSession(ctx, actor.TenantID, agent, session)
	if err != nil {
		return err
	}
	return httpx.AuthorizeResource(ctx, h.deps, actor, space, agent)
}

func (h *handler) computerTicketTarget(ctx context.Context, ticket workspaceConnectionTicket) (*resolvedExecution, context.Context, error) {
	actor, err := h.workspaceTicketActor(ctx, *ticket.Authorization)
	if err != nil {
		return nil, ctx, err
	}
	ctx = httpx.WithPrincipal(ctx, actor)
	if ticket.SessionID != "" {
		if err := h.computerTerminalSession(ctx, actor, ticket.SpaceID, ticket.SessionID); err != nil {
			return nil, ctx, err
		}
	}
	if err := h.requireSpaceNotDeleting(ctx, ticket.TenantID, ticket.SpaceID); err != nil {
		return nil, ctx, err
	}
	if err := h.requireSpaceInfrastructureAvailable(ctx, ticket.TenantID, ticket.SpaceID); err != nil {
		return nil, ctx, err
	}
	c, err := h.computerStore().Get(ctx, ticket.TenantID, ticket.SpaceID, ticket.ComputerID)
	if err != nil || c.IsServer() || !c.Has(computers.PTY) || c.RuntimeNodeID != ticket.NodeID {
		return nil, ctx, errors.New(computerTerminalUnavailable)
	}
	var deleting bool
	if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT deletion_pending FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), ticket.TenantID, ticket.SpaceID, ticket.ComputerID).Scan(&deleting); err != nil {
		return nil, ctx, err
	}
	if deleting {
		return nil, ctx, computers.ErrOwnerDeleting
	}
	if err := h.authorizeLocalNode(ctx, actor, c.RuntimeNodeID); err != nil {
		return nil, ctx, err
	}
	target := computers.Target{TenantID: ticket.TenantID, SpaceID: ticket.SpaceID, ComputerID: ticket.ComputerID, RuntimeID: ticket.RuntimeID, Incarnation: ticket.Incarnation}
	runtime, err := h.computerStore().GetRuntime(ctx, target)
	if err != nil {
		return nil, ctx, err
	}
	if err = computers.CheckTarget(target, c, runtime, ticket.SessionID, computers.PTY, false, h.store.now()); err != nil {
		return nil, ctx, err
	}
	if computerTerminalDigest(c, runtime) != ticket.Authorization.ConfigHash {
		return nil, ctx, errors.New("terminal target changed")
	}
	return &resolvedExecution{spaceID: ticket.SpaceID, nodeID: c.RuntimeNodeID, containerID: runtime.ExternalID, hostRoot: runtime.RootPath, computer: c, runtime: runtime}, ctx, nil
}

func (h *handler) renewComputerTerminal(ctx context.Context, ticket workspaceConnectionTicket) error {
	exec, _, err := h.computerTicketTarget(ctx, ticket)
	if err != nil {
		return err
	}
	target := computers.Target{TenantID: ticket.TenantID, SpaceID: ticket.SpaceID, ComputerID: ticket.ComputerID, RuntimeID: ticket.RuntimeID, Incarnation: ticket.Incarnation}
	return h.computerStore().RecordActivity(ctx, target, exec.runtime.SessionScope, h.store.now())
}

func (h *handler) watchComputerTerminal(ctx context.Context, bridge *workspaceBridge, ticket workspaceConnectionTicket, ticks <-chan time.Time) {
	for {
		select {
		case <-ctx.Done():
			_ = bridge.conn.Close()
			return
		case <-bridge.done:
			return
		case _, ok := <-ticks:
			if !ok {
				return
			}
			check, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := h.renewComputerTerminal(check, ticket)
			cancel()
			if err != nil {
				_ = bridge.conn.Close()
				return
			}
		}
	}
}

// computerTerminalProxy upgrades a verified computer ticket to a websocket and
// bridges it to the computer's PTY. The pinned runtime is re-checked for a
// ready state and an intact PTY capability before any shell is started.
func (h *handler) computerTerminalProxy(w http.ResponseWriter, r *http.Request) {
	spaceID := chi.URLParam(r, "id")
	computerID := chi.URLParam(r, "cid")
	ticket, err := h.verifyComputerTicket(r.Context(), r.URL.Query().Get("token"), spaceID, computerID)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid ticket")
		return
	}
	lease, err := h.acquireSpaceInfrastructure(r.Context(), ticket.TenantID, ticket.SpaceID)
	if err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	defer lease.release()
	exec, actorCtx, err := h.computerTicketTarget(r.Context(), ticket)
	if err != nil {
		httpx.Error(w, http.StatusConflict, computerTerminalUnavailable)
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		httpx.Error(w, http.StatusUpgradeRequired, "websocket upgrade required")
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	keyBytes, keyErr := base64.StdEncoding.DecodeString(key)
	hijacker, ok := w.(http.Hijacker)
	if !ok || keyErr != nil || len(keyBytes) != 16 || r.Header.Get("Sec-WebSocket-Version") != "13" {
		httpx.Error(w, http.StatusBadRequest, "invalid websocket handshake")
		return
	}
	if err := h.consumeComputerTicket(actorCtx, ticket, r.URL.Query().Get("token")); err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid ticket")
		return
	}
	if err := h.renewComputerTerminal(actorCtx, ticket); err != nil {
		httpx.Error(w, http.StatusConflict, computerTerminalUnavailable)
		return
	}
	var row *workspaceConnection
	if exec.computer.Provider == computers.Server || exec.computer.Provider == computers.Temporary {
		row, err = h.beginComputerTerminalConnection(actorCtx, lease, exec)
		if err != nil {
			h.serverComputerLifecycleError(w, err)
			return
		}
	}
	var bridge *workspaceBridge
	allocationAttempted := false
	defer func() {
		if row != nil {
			err := h.finishWorkspaceConnection(row, !allocationAttempted || (bridge != nil && bridge.remoteClosed))
			if bridge != nil {
				bridge.cleanupErr = errors.Join(bridge.cleanupErr, err)
			}
		}
		if bridge != nil {
			liveWorkspaceBridges.Lock()
			delete(liveWorkspaceBridges.items, bridge)
			close(bridge.done)
			liveWorkspaceBridges.Unlock()
		}
	}()
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	acceptHash := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(acceptHash[:])
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
	if rw.Flush() != nil {
		return
	}
	bridge = &workspaceBridge{conn: conn, rw: rw, done: make(chan struct{}), ready: func(id, method string) error {
		if row != nil {
			if err := h.activateWorkspaceConnection(actorCtx, lease, row, id, method); err != nil {
				return err
			}
		}
		lease.release()
		return nil
	}}
	if row != nil {
		bridge.journalID, bridge.streamOwner = row.ID, row.StreamOwner
	}
	actor, _ := httpx.PrincipalFrom(actorCtx)
	ticket.UserID = actor.UserID
	liveWorkspaceBridges.Lock()
	liveWorkspaceBridges.items[bridge] = ticket
	liveWorkspaceBridges.Unlock()
	ctx, cancel := context.WithCancel(httpx.WithPrincipal(h.deps.RunContext(), actor))
	defer cancel()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		h.watchComputerTerminal(ctx, bridge, ticket, ticker.C)
	}()
	allocationAttempted = true
	h.bridgeComputerTerminal(ctx, bridge, exec, 0, 0)
}
