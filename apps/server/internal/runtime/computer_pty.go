// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/hmac"
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
// It mirrors resolveACPHost's dual path: an explicit computer id (or an
// immutable run) pins the exact target, while an empty id falls back to the
// session's selected computer. A legacy workspace, a computer without the PTY
// capability, or a computer with no active ready runtime is refused rather than
// silently downgraded to the legacy host bridge. Authorized resolution records
// activity so an idle temporary runtime is renewed.
func (h *handler) resolveComputerTerminal(ctx context.Context, tenantID, spaceID, computerID, sessionID string) (*resolvedExecution, error) {
	run, _ := ctx.Value(computerRunKey{}).(string)
	var c computers.Computer
	var err error
	switch {
	case run != "":
		c, err = h.computerStore().ResolveRunComputer(ctx, tenantID, spaceID, run, computerID)
	case computerID != "":
		c, err = h.sessionSelectedComputer(ctx, tenantID, spaceID, computerID)
	default:
		if sessionID == "" {
			return nil, errors.New(computerTerminalUnavailable)
		}
		selected, selErr := h.computerStore().SessionDefault(ctx, tenantID, spaceID, sessionID)
		if selErr != nil {
			return nil, selErr
		}
		if selected == nil || *selected == "" {
			return nil, errors.New(computerTerminalUnavailable)
		}
		c, err = h.sessionSelectedComputer(ctx, tenantID, spaceID, *selected)
	}
	if err != nil {
		return nil, err
	}
	return h.resolveReadyComputerTerminal(ctx, tenantID, spaceID, c, sessionID)
}

// resolveReadyComputerTerminal rejects a legacy workspace, an ungranted
// capability, or a missing runtime and otherwise pins the active ready
// incarnation.
func (h *handler) resolveReadyComputerTerminal(ctx context.Context, tenantID, spaceID string, c computers.Computer, sessionID string) (*resolvedExecution, error) {
	var legacyScope sql.NullString
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT legacy_workspace_scope FROM computers WHERE id=? AND tenant_id=? AND space_id=?`), c.ID, tenantID, spaceID).Scan(&legacyScope)
	if err != nil {
		return nil, err
	}
	if legacyScope.Valid && legacyScope.String == spaceID {
		return nil, errors.New(computerTerminalUnavailable)
	}
	if !c.Has(computers.PTY) {
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
	ID     string
	write  func(data []byte) error
	resize func(cols, rows int) error
	close  func()
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

// startRunnerComputerPTY starts a login shell inside the computer's own
// container through the runner. docker exec runs without a TTY, so resize is
// forwarded to the same host.pty.resize RPC the legacy bridge uses and is a
// no-op there.
func (h *handler) startRunnerComputerPTY(ctx context.Context, exec *resolvedExecution, cols, rows int, sink func(string, []byte)) (*computerPTYStream, error) {
	if strings.TrimSpace(exec.containerID) == "" || strings.TrimSpace(exec.nodeID) == "" {
		return nil, errors.New(computerTerminalUnavailable)
	}
	session, err := h.hub.get(exec.nodeID)
	if err != nil {
		return nil, err
	}
	var started struct {
		ID string `json:"id"`
	}
	if err := session.call(ctx, "docker.exec.start", map[string]any{"id": exec.containerID, "command": []string{"bash", "-l"}, "workingDir": "/workspace"}, &started); err != nil || started.ID == "" {
		return nil, errors.New(computerTerminalUnavailable)
	}
	unsubscribe := session.onStream(started.ID, func(channel string, data []byte) {
		switch channel {
		case "stdout", "stderr":
			sink(channel, data)
		case "exit":
			sink("exit", nil)
		}
	})
	var once sync.Once
	return &computerPTYStream{
		ID: started.ID,
		write: func(data []byte) error {
			return session.call(ctx, "docker.exec.write", map[string]any{"id": started.ID, "base64": base64.StdEncoding.EncodeToString(data)}, nil)
		},
		resize: func(cols, rows int) error {
			return session.call(ctx, "host.pty.resize", map[string]any{"id": started.ID, "cols": cols, "rows": rows}, nil)
		},
		close: func() {
			once.Do(func() {
				unsubscribe()
				_ = session.call(context.WithoutCancel(ctx), "docker.exec.close", map[string]any{"id": started.ID}, nil)
			})
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
		close: func() {
			once.Do(func() {
				_ = stdin.Close()
				_ = session.Close()
				_ = client.Close()
			})
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
		}
	}
	stream, err := h.startComputerPTY(ctx, exec, cols, rows, sink)
	if err != nil {
		writeJSON(map[string]any{"type": "error", "message": err.Error()})
		return
	}
	defer stream.close()
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
			_ = stream.resize(message.Cols, message.Rows)
		case "input":
			_ = stream.write([]byte(message.Data))
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
	var in struct {
		SessionID string `json:"sessionId"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in)
	}
	sessionID := strings.TrimSpace(in.SessionID)
	exec, err := h.resolveComputerTerminal(r.Context(), p.TenantID, spaceID, computerID, sessionID)
	if err != nil {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	expires := h.store.now().Add(45 * time.Second)
	payloadMap := map[string]any{
		"tenantId": p.TenantID, "userId": p.UserID, "kind": "terminal",
		"spaceId": spaceID, "computerId": computerID, "sessionId": sessionID,
		"runtimeId": exec.runtime.ID, "incarnation": exec.runtime.Incarnation,
		"exp": expires.Unix(),
	}
	payload, _ := json.Marshal(payloadMap)
	body := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, h.deps.Secret)
	mac.Write([]byte("workspace:" + body))
	token := body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"ticket": token,
		"url":    strings.TrimRight(h.deps.PublicURL, "/") + "/api/spaces/" + url.PathEscape(spaceID) + "/computers/" + url.PathEscape(computerID) + "/terminal-proxy?token=" + url.QueryEscape(token),
	})
}

// verifyComputerTicket validates a computer terminal ticket against the exact
// space and computer in the proxy path. A legacy agent ticket never satisfies it
// because its computer identity is empty.
func (h *handler) verifyComputerTicket(raw, spaceID, computerID string) (workspaceConnectionTicket, error) {
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
	_, _ = mac.Write([]byte("workspace:" + body))
	expected := mac.Sum(nil)
	if len(given) != len(expected) || subtle.ConstantTimeCompare(given, expected) != 1 {
		return ticket, errors.New("invalid ticket")
	}
	payload, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil || json.Unmarshal(payload, &ticket) != nil || ticket.Kind != "terminal" || ticket.TenantID == "" || ticket.SpaceID != spaceID || ticket.ComputerID != computerID || ticket.RuntimeID == "" || ticket.Incarnation == "" || ticket.Expires <= h.store.now().Unix() {
		return workspaceConnectionTicket{}, errors.New("invalid or expired ticket")
	}
	if err := h.ticketMembershipActive(context.Background(), ticket); err != nil {
		return workspaceConnectionTicket{}, err
	}
	return ticket, nil
}

// ticketMembershipActive re-checks that a ticket's user is still an active
// member of its tenant.
func (h *handler) ticketMembershipActive(ctx context.Context, ticket workspaceConnectionTicket) error {
	if ticket.UserID == "" || ticket.UserID == "api-key" {
		return nil
	}
	var active int64
	if err := h.deps.Gorm.WithContext(ctx).Table("tenant_memberships AS m").Joins("JOIN users u ON u.id=m.user_id").Where("m.tenant_id=? AND m.user_id=? AND m.status='active' AND u.status='active'", ticket.TenantID, ticket.UserID).Count(&active).Error; err != nil || active == 0 {
		return errors.New("membership is no longer active")
	}
	return nil
}

// computerTerminalProxy upgrades a verified computer ticket to a websocket and
// bridges it to the computer's PTY. The pinned runtime is re-checked for a
// ready state and an intact PTY capability before any shell is started.
func (h *handler) computerTerminalProxy(w http.ResponseWriter, r *http.Request) {
	spaceID := chi.URLParam(r, "id")
	computerID := chi.URLParam(r, "cid")
	ticket, err := h.verifyComputerTicket(r.URL.Query().Get("token"), spaceID, computerID)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid ticket")
		return
	}
	c, err := h.sessionSelectedComputer(r.Context(), ticket.TenantID, spaceID, computerID)
	if err != nil || !c.Has(computers.PTY) {
		httpx.Error(w, http.StatusConflict, computerTerminalUnavailable)
		return
	}
	target := computers.Target{TenantID: ticket.TenantID, SpaceID: spaceID, ComputerID: computerID, RuntimeID: ticket.RuntimeID, Incarnation: ticket.Incarnation}
	runtime, err := h.computerStore().GetRuntime(r.Context(), target)
	if err != nil {
		httpx.Error(w, http.StatusConflict, computerTerminalUnavailable)
		return
	}
	now := h.store.now()
	if err = computers.CheckTarget(target, c, runtime, ticket.SessionID, computers.PTY, false, now); err != nil {
		httpx.Error(w, http.StatusConflict, computerTerminalUnavailable)
		return
	}
	if err = h.computerStore().RecordActivity(r.Context(), target, ticket.SessionID, now); err != nil {
		httpx.Error(w, http.StatusConflict, computerTerminalUnavailable)
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		httpx.Error(w, http.StatusUpgradeRequired, "websocket upgrade required")
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	hijacker, ok := w.(http.Hijacker)
	if !ok || key == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid websocket handshake")
		return
	}
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
	bridge := &workspaceBridge{conn: conn, rw: rw}
	ctx, cancel := context.WithCancel(h.deps.RunContext())
	defer cancel()
	exec := &resolvedExecution{spaceID: spaceID, nodeID: c.RuntimeNodeID, containerID: runtime.ExternalID, hostRoot: runtime.RootPath, computer: c, runtime: runtime}
	h.bridgeComputerTerminal(ctx, bridge, exec, 0, 0)
}
