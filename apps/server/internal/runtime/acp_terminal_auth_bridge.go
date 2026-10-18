// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func (h *handler) releaseUnstartedACPTerminalAuth(attempt *acpTerminalAuthAttempt) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	t := attempt.ticket
	return h.releaseACPAuthLock(ctx, t.Tenant, t.Space, t.Profile, t.Nonce)
}

func (h *handler) acpTerminalAuthProxy(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "websocket upgrade required", 426)
		return
	}
	key, err := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	hijacker, ok := w.(http.Hijacker)
	if err != nil || len(key) != 16 || !ok {
		http.Error(w, "invalid websocket handshake", 400)
		return
	}
	attempt, err := h.consumeACPTerminalAuth(r.Context(), r.URL.Query().Get("token"), chi.URLParam(r, "id"), chi.URLParam(r, "sid"))
	if err != nil {
		http.Error(w, "invalid terminal ticket", 401)
		return
	}
	handedToBridge := false
	defer func() {
		if !handedToBridge {
			_ = h.releaseUnstartedACPTerminalAuth(attempt)
		}
	}()
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	hash := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + wsGUID))
	_, err = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(hash[:]) + "\r\n\r\n")
	if err != nil || rw.Flush() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(h.deps.RunContext(), acpLoginSessionLimit)
	defer cancel()
	go func() { <-ctx.Done(); _ = conn.Close() }()
	handedToBridge = true
	h.bridgeACPTerminalAuth(ctx, &workspaceBridge{conn: conn, rw: rw}, attempt)
}

// completeACPTerminalAuth only reconnects after a positively observed exit zero.
// Unknown exits/disconnects never mutate the live protocol runtime.
func (h *handler) completeACPTerminalAuth(ctx context.Context, attempt *acpTerminalAuthAttempt, exitCode *int) error {
	if exitCode == nil || *exitCode != 0 {
		return nil
	}
	ticket := attempt.ticket
	if h.validateACPTerminalAuthPrincipal(ctx, ticket.Principal, ticket.Tenant, ticket.Space, ticket.Agent) != nil {
		return errors.New("terminal authorization expired")
	}
	current, err := h.resolveACPTerminalAuth(ctx, ticket.Tenant, ticket.Agent, ticket.Session, ticket.Method)
	if err != nil || current.runtime != attempt.runtime || current.ticket.ConfigHash != ticket.ConfigHash {
		return errors.New("ACP runtime changed during terminal authentication")
	}
	actor := attempt.actor
	identity := "user:" + actor.UserID
	if actor.APIKey {
		identity = "key:" + actor.APIKeyID
	}
	if actor.TenantID != ticket.Tenant || identity != ticket.Principal || actor.OAuth && !actor.OAuthExpiresAt.After(h.store.now()) {
		return errors.New("terminal original authorization expired; reconnect with current authorization")
	}
	_, err = h.reconnectACP(httpx.WithPrincipal(ctx, actor), actor, ticket.Agent, ticket.Session)
	return err
}

func acpTerminalAuthEnvironment(attempt *acpTerminalAuthAttempt) map[string]string {
	env := map[string]string{}
	for k, v := range attempt.descriptor.Env {
		env[k] = v
	}
	home := "/workspace/.zakura/acp/" + attempt.ticket.Profile + "/home"
	// Descriptor overlays may select a login mode, never a different credential
	// identity. Keep the same storage roots as prepareACPFiles and ACP runtime.
	for name, value := range acpProfileStorageEnv(attempt.ticket.Profile, home) {
		env[name] = value
	}
	return env
}

// Order is a safety boundary: an active profile writer lease must be gone
// before ensure can acquire the runtime's own writer lease. Unknown create or
// cleanup/release failure never reaches reconnect.
func finishACPTerminalAuthBridge(remoteStarted, createKnown bool, code *int, cleanup, release, complete func() error) error {
	if remoteStarted {
		cleanupErr := cleanup()
		if !createKnown {
			return errors.New("ACP login creation is unconfirmed; profile authentication remains locked")
		}
		if cleanupErr != nil {
			return errors.New("ACP login cleanup is unconfirmed; profile authentication remains locked")
		}
	}
	if err := release(); err != nil {
		return errors.New("ACP authentication lock release failed; reconnect was not attempted")
	}
	if remoteStarted && code != nil && *code == 0 {
		if err := complete(); err != nil {
			return errors.New("ACP login ended, but Agent reconnect failed; refresh runtime status")
		}
	}
	return nil
}

func (h *handler) bridgeACPTerminalAuth(ctx context.Context, bridge *workspaceBridge, attempt *acpTerminalAuthAttempt) {
	name := "zakura-acp-auth-" + acpLoginDigest([]byte(attempt.ticket.Nonce))[:24]
	remoteStarted, createKnown := false, true
	var observedExit *int
	var receivedExit bool
	var unlockAuth func()
	// Register before local auth/runtime validation: those failures have no
	// remote effect and must release the consumed ticket's exact lease.
	defer func() {
		defer func() {
			if unlockAuth != nil {
				unlockAuth()
			}
		}()
		err := finishACPTerminalAuthBridge(remoteStarted, createKnown, observedExit,
			func() error { return h.finalizeACPLoginContainer(attempt.target, name) },
			func() error { return h.releaseUnstartedACPTerminalAuth(attempt) },
			func() error {
				// Login cleanup and its lease release are already confirmed. The
				// shared reconnect path acquires authMu itself before process close.
				if unlockAuth != nil {
					unlockAuth()
					unlockAuth = nil
				}
				reconnectCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
				defer cancel()
				return h.completeACPTerminalAuth(reconnectCtx, attempt, observedExit)
			})
		if err != nil {
			raw, _ := json.Marshal(map[string]any{"type": "error", "message": err.Error()})
			_ = bridge.write(0x1, raw)
			return
		}
		if receivedExit {
			raw, _ := json.Marshal(map[string]any{"type": "exit", "code": observedExit})
			_ = bridge.write(0x1, raw)
		}
	}()
	rt := attempt.runtime
	if !rt.authMu.TryLock() {
		_ = bridge.write(0x1, []byte(`{"type":"error","message":"ACP authentication is busy"}`))
		return
	}
	unlockAuth = rt.authMu.Unlock
	current, err := h.resolveACPTerminalAuth(ctx, attempt.ticket.Tenant, attempt.ticket.Agent, attempt.ticket.Session, attempt.ticket.Method)
	if err != nil || current.runtime != rt || current.ticket.ConfigHash != attempt.ticket.ConfigHash {
		_ = bridge.write(0x1, []byte(`{"type":"error","message":"ACP authentication changed"}`))
		return
	}
	setupCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	remoteStarted = true
	container, err := h.startACPLogin(setupCtx, attempt.target, name)
	cancel()
	if err != nil {
		// An empty list after a timed-out create is not proof a late create cannot
		// arrive. Cleanup is attempted, but its active writer lease stays retained.
		createKnown = false
		message := acpLoginStartMessage(err, "ACP authentication terminal could not start")
		raw, _ := json.Marshal(map[string]any{"type": "error", "message": message})
		_ = bridge.write(0x1, raw)
		return
	}
	var started struct {
		ID string `json:"id"`
	}
	if err = attempt.target.runner.call(ctx, "docker.exec.start", map[string]any{"id": container, "command": attempt.command, "workingDir": rt.workingDir, "env": acpTerminalAuthEnvironment(attempt), "tty": true, "cols": 80, "rows": 24}, &started); err != nil || started.ID == "" {
		_ = bridge.write(0x1, []byte(`{"type":"error","message":"ACP interactive authentication unavailable"}`))
		return
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = attempt.target.runner.call(closeCtx, "docker.exec.close", map[string]any{"id": started.ID}, nil)
	}()
	exited := make(chan *int, 1)
	detach := attempt.target.runner.onStream(started.ID, func(channel string, data []byte) {
		if channel == "stdout" {
			raw, _ := json.Marshal(map[string]any{"type": "output", "data": string(data)})
			if bridge.write(0x1, raw) != nil {
				_ = bridge.conn.Close()
			}
		}
		if channel == "exit" {
			var status struct {
				ExitCode *int `json:"exitCode"`
			}
			_ = json.Unmarshal(data, &status)
			select {
			case exited <- status.ExitCode:
			default:
			}
			// Wake only the read side. Keep writes usable so final cleanup/reconnect
			// failure can be reported before the proxy closes this websocket.
			_ = bridge.conn.SetReadDeadline(time.Now())
		}
	})
	defer detach()
	watchCtx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-watchCtx.Done():
				return
			case <-ticker.C:
				t := attempt.ticket
				if h.validateACPTerminalAuthPrincipal(watchCtx, t.Principal, t.Tenant, t.Space, t.Agent) != nil || h.renewACPAuthLock(watchCtx, t.Tenant, t.Space, t.Profile, t.Nonce, acpLoginSessionLimit) != nil {
					_ = bridge.conn.Close()
					return
				}
				current, e := h.resolveACPTerminalAuth(watchCtx, t.Tenant, t.Agent, t.Session, t.Method)
				if e != nil || current.runtime != rt || current.ticket.ConfigHash != t.ConfigHash {
					_ = bridge.conn.Close()
					return
				}
			}
		}
	}()
	if bridge.write(0x1, []byte(`{"type":"ready","command":"ACP authentication","autoBoot":false}`)) != nil {
		return
	}
	for {
		opcode, payload, e := readWSFrameSized(bridge.rw.Reader, 64<<10)
		if e != nil || opcode == 0x8 {
			break
		}
		if opcode == 0x9 {
			_ = bridge.write(0xA, payload)
			continue
		}
		if opcode != 0x1 {
			continue
		}
		var message struct {
			Type string `json:"type"`
			Data string `json:"data"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
		}
		if json.Unmarshal(payload, &message) != nil {
			continue
		}
		if message.Type == "input" {
			e = attempt.target.runner.call(ctx, "docker.exec.write", map[string]any{"id": started.ID, "base64": base64.StdEncoding.EncodeToString([]byte(message.Data))}, nil)
		}
		if message.Type == "resize" && message.Cols > 0 && message.Cols <= 1000 && message.Rows > 0 && message.Rows <= 1000 {
			e = attempt.target.runner.call(ctx, "docker.exec.resize", map[string]any{"id": started.ID, "cols": message.Cols, "rows": message.Rows}, nil)
		}
		if e != nil {
			break
		}
	}
	select {
	case observedExit = <-exited:
		receivedExit = true
	default:
	}
}
