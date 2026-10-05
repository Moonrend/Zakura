// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

type workspaceConnectionTicket struct {
	TenantID string `json:"tenantId"`
	UserID   string `json:"userId,omitempty"`
	AgentID  string `json:"agentId"`
	Kind     string `json:"kind"`
	Adapter  string `json:"adapterId,omitempty"`
	Expires  int64  `json:"exp"`
}

type workspaceBridge struct {
	conn    net.Conn
	rw      *bufio.ReadWriter
	writeMu sync.Mutex
}

var liveWorkspaceBridges = struct {
	sync.Mutex
	items map[*workspaceBridge]workspaceConnectionTicket
}{items: map[*workspaceBridge]workspaceConnectionTicket{}}

func (b *workspaceBridge) write(opcode byte, payload []byte) error {
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	return writeWSFrame(b.rw.Writer, opcode, payload)
}

func (h *handler) verifyWorkspaceTicket(raw, agentID, kind string) (workspaceConnectionTicket, error) {
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
	if err != nil || json.Unmarshal(payload, &ticket) != nil || ticket.AgentID != agentID || ticket.Kind != kind || ticket.TenantID == "" || ticket.Expires <= h.store.now().Unix() {
		return workspaceConnectionTicket{}, errors.New("invalid or expired ticket")
	}
	if ticket.Adapter != "" && kind != "terminal" {
		return workspaceConnectionTicket{}, errors.New("invalid ticket")
	}
	if ticket.UserID != "" && ticket.UserID != "api-key" {
		var active int
		if err := h.deps.DB.QueryRowContext(context.Background(), h.store.q(`SELECT COUNT(*) FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND u.status='active'`), ticket.TenantID, ticket.UserID).Scan(&active); err != nil || active == 0 {
			return workspaceConnectionTicket{}, errors.New("membership is no longer active")
		}
	}
	return ticket, nil
}

func (h *handler) desktopProxy(w http.ResponseWriter, r *http.Request) {
	h.workspaceProxy(w, r, "desktop")
}
func (h *handler) terminalProxy(w http.ResponseWriter, r *http.Request) {
	h.workspaceProxy(w, r, "terminal")
}

func (h *handler) workspaceProxy(w http.ResponseWriter, r *http.Request, kind string) {
	ticket, err := h.verifyWorkspaceTicket(r.URL.Query().Get("token"), chi.URLParam(r, "id"), kind)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid ticket")
		return
	}
	var nodeID, spaceID, workspaceKind string
	var enabled bool
	err = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT n.id,s.id,s.workspace_kind,s.enable_computer FROM agents a JOIN spaces s ON s.id=a.space_id JOIN runtime_nodes n ON n.id=s.runtime_node_id WHERE a.tenant_id=? AND a.id=?`), ticket.TenantID, ticket.AgentID).Scan(&nodeID, &spaceID, &workspaceKind, &enabled)
	if err != nil || !enabled {
		httpx.Error(w, http.StatusForbidden, "desktop unavailable")
		return
	}
	session, err := h.hub.get(nodeID)
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, err.Error())
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
	liveWorkspaceBridges.Lock()
	liveWorkspaceBridges.items[bridge] = ticket
	liveWorkspaceBridges.Unlock()
	defer func() {
		liveWorkspaceBridges.Lock()
		delete(liveWorkspaceBridges.items, bridge)
		liveWorkspaceBridges.Unlock()
	}()
	ctx, cancel := context.WithCancel(h.deps.RunContext())
	defer cancel()
	if kind == "desktop" {
		h.bridgeDesktop(ctx, bridge, session, spaceID, workspaceKind)
	} else {
		h.bridgeTerminal(ctx, bridge, session, spaceID, workspaceKind, ticket.Adapter)
	}
}

type runnerContainer struct {
	DockerID string            `json:"dockerId"`
	Labels   map[string]string `json:"labels"`
}

func workspaceDockerID(ctx context.Context, session *runnerSession, spaceID, adapterID string) (string, error) {
	var containers []runnerContainer
	if err := session.call(ctx, "docker.list", map[string]any{"label": "zakura.space=" + spaceID}, &containers); err != nil {
		return "", err
	}
	for _, container := range containers {
		purpose := container.Labels["zakura.purpose"]
		if adapterID != "" && purpose == "acp-adapter" && container.Labels["zakura.adapter"] == adapterID {
			return container.DockerID, nil
		}
		if adapterID == "" && (purpose == "workspace" || purpose == "") {
			return container.DockerID, nil
		}
	}
	return "", errors.New("workspace container is not running")
}

func (h *handler) bridgeDesktop(ctx context.Context, bridge *workspaceBridge, session *runnerSession, spaceID, workspaceKind string) {
	if workspaceKind == "host" {
		_ = bridge.write(0x8, []byte{0x03, 0xf3})
		return
	}
	dockerID, err := workspaceDockerID(ctx, session, spaceID, "")
	if err != nil {
		_ = bridge.write(0x8, []byte{0x03, 0xf3})
		return
	}
	var started struct {
		ID string `json:"id"`
	}
	err = session.call(ctx, "docker.exec.start", map[string]any{"id": dockerID, "command": []string{"socat", "STDIO", "TCP:127.0.0.1:5900,connect-timeout=5"}, "workingDir": "/workspace"}, &started)
	if err != nil || started.ID == "" {
		_ = bridge.write(0x8, []byte{0x03, 0xf3})
		return
	}
	defer func() {
		_ = session.call(context.WithoutCancel(ctx), "docker.exec.close", map[string]any{"id": started.ID}, nil)
	}()
	streamDone := make(chan struct{})
	var once sync.Once
	unsubscribe := session.onStream(started.ID, func(channel string, data []byte) {
		if channel == "stdout" && len(data) > 0 {
			_ = bridge.write(0x2, data)
		} else if channel == "exit" {
			once.Do(func() { close(streamDone) })
			_ = bridge.conn.Close()
		}
	})
	defer unsubscribe()
	for {
		opcode, payload, err := readWSFrameSized(bridge.rw.Reader, 1<<20)
		if err != nil {
			return
		}
		if opcode == 0x8 {
			return
		}
		if opcode == 0x9 {
			_ = bridge.write(0xA, payload)
			continue
		}
		if opcode == 0x1 || opcode == 0x2 {
			encoded := base64.StdEncoding.EncodeToString(payload)
			if session.call(ctx, "docker.exec.write", map[string]any{"id": started.ID, "base64": encoded}, nil) != nil {
				return
			}
		}
		select {
		case <-streamDone:
			return
		default:
		}
	}
}

func (h *handler) bridgeTerminal(ctx context.Context, bridge *workspaceBridge, session *runnerSession, spaceID, workspaceKind, adapterID string) {
	method, writeMethod, closeMethod := "host.pty.start", "host.pty.write", "host.pty.close"
	params := map[string]any{"spaceId": spaceID, "command": []string{"bash", "-l"}, "workingDir": "/workspace", "cols": 120, "rows": 30}
	if workspaceKind != "host" || adapterID != "" {
		dockerID, err := workspaceDockerID(ctx, session, spaceID, adapterID)
		if err != nil {
			_ = bridge.write(0x1, []byte(`{"type":"error","message":"workspace container is not running"}`))
			return
		}
		method, writeMethod, closeMethod = "docker.exec.start", "docker.exec.write", "docker.exec.close"
		params = map[string]any{"id": dockerID, "command": []string{"bash", "-l"}, "workingDir": "/workspace"}
	}
	var started struct {
		ID string `json:"id"`
	}
	if err := session.call(ctx, method, params, &started); err != nil || started.ID == "" {
		_ = bridge.write(0x1, []byte(`{"type":"error","message":"terminal unavailable"}`))
		return
	}
	defer func() {
		_ = session.call(context.WithoutCancel(ctx), closeMethod, map[string]any{"id": started.ID}, nil)
	}()
	unsubscribe := session.onStream(started.ID, func(channel string, data []byte) {
		switch channel {
		case "stdout":
			raw, _ := json.Marshal(map[string]any{"type": "output", "data": string(data)})
			_ = bridge.write(0x1, raw)
		case "exit":
			raw, _ := json.Marshal(map[string]any{"type": "exit", "code": 0})
			_ = bridge.write(0x1, raw)
			_ = bridge.conn.Close()
		}
	})
	defer unsubscribe()
	ready, _ := json.Marshal(map[string]any{"type": "ready", "sessionId": started.ID, "command": "bash -l"})
	_ = bridge.write(0x1, ready)
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
		if message.Type == "resize" {
			_ = session.call(ctx, "host.pty.resize", map[string]any{"id": started.ID, "cols": message.Cols, "rows": message.Rows}, nil)
		} else if message.Type == "input" {
			_ = session.call(ctx, writeMethod, map[string]any{"id": started.ID, "base64": base64.StdEncoding.EncodeToString([]byte(message.Data))}, nil)
		}
	}
}
