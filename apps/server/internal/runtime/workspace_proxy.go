// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

type workspaceConnectionTicket struct {
	TenantID            string          `json:"tenantId"`
	UserID              string          `json:"userId,omitempty"`
	AgentID             string          `json:"agentId"`
	Kind                string          `json:"kind"`
	Adapter             string          `json:"adapterId,omitempty"`
	Expires             int64           `json:"exp"`
	SpaceID             string          `json:"spaceId,omitempty"`
	ComputerID          string          `json:"computerId,omitempty"`
	SessionID           string          `json:"sessionId,omitempty"`
	RuntimeID           string          `json:"runtimeId,omitempty"`
	Incarnation         string          `json:"incarnation,omitempty"`
	NodeID              string          `json:"nodeId,omitempty"`
	WorkspaceInstanceID string          `json:"workspaceInstanceId,omitempty"`
	Authorization       *acpLoginTicket `json:"authorization,omitempty"`
}

type workspaceBridge struct {
	conn         net.Conn
	rw           *bufio.ReadWriter
	writeMu      sync.Mutex
	done         chan struct{}
	cleanupErr   error
	remoteClosed bool
	journalID    string
	streamOwner  string
	remote       *remoteWorkspace
	ready        func(string, string) error
}

func (b *workspaceBridge) allocated(id, closeMethod string) error {
	if b.ready != nil {
		return b.ready(id, closeMethod)
	}
	return nil
}

var liveWorkspaceBridges = struct {
	sync.Mutex
	items map[*workspaceBridge]workspaceConnectionTicket
}{items: map[*workspaceBridge]workspaceConnectionTicket{}}

func (b *workspaceBridge) write(opcode byte, payload []byte) error {
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	if err := b.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	defer b.conn.SetWriteDeadline(time.Time{})
	if err := writeWSFrame(b.rw.Writer, opcode, payload); err != nil {
		_ = b.conn.Close()
		return err
	}
	return nil
}

func (b *workspaceBridge) call(ctx context.Context, session *runnerSession, method string, params map[string]any, out any) error {
	if b.remote != nil {
		return b.remote.call(ctx, method, params, out)
	}
	return session.call(ctx, method, params, out)
}

func (b *workspaceBridge) closeRemote(ctx context.Context, session *runnerSession, method, id string) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	var err error
	if b.remote != nil {
		err = closePinnedWorkspaceStream(cleanup, session, method, id, b.streamOwner, b.remote.workspace)
	} else if b.streamOwner != "" {
		err = closeWorkspaceStream(cleanup, session, method, id, b.streamOwner)
	} else {
		err = session.call(cleanup, method, map[string]any{"id": id}, nil)
	}
	if err != nil {
		b.cleanupErr = errors.Join(b.cleanupErr, err)
	} else {
		b.remoteClosed = true
	}
}

// Closing a socket is not proof that its remote process has exited.
func (h *handler) closeSpaceWorkspaceBridges(ctx context.Context, tenant, space string) error {
	return h.closeOwnerWorkspaceBridges(ctx, tenant, space, "")
}

func (h *handler) closeOwnerWorkspaceBridges(ctx context.Context, tenant, space, computer string) error {
	return h.closeMatchingWorkspaceBridges(ctx, tenant, space, computer, "")
}

func (h *handler) closeInstanceWorkspaceBridges(ctx context.Context, tenant, space, instance string) error {
	if instance == "" {
		return errors.New("workspace instance required")
	}
	return h.closeMatchingWorkspaceBridges(ctx, tenant, space, "", instance)
}

// Retirement closes local access immediately without waiting for an offline
// node. The durable instance tombstone remains responsible for remote writers.
func (h *handler) disconnectInstanceWorkspaceBridges(tenant, space, instance string) {
	liveWorkspaceBridges.Lock()
	var bridges []*workspaceBridge
	for bridge, ticket := range liveWorkspaceBridges.items {
		if ticket.TenantID == tenant && ticket.SpaceID == space && ticket.WorkspaceInstanceID == instance {
			bridges = append(bridges, bridge)
		}
	}
	liveWorkspaceBridges.Unlock()
	for _, bridge := range bridges {
		_ = bridge.conn.Close()
	}
}

func (h *handler) closeMatchingWorkspaceBridges(ctx context.Context, tenant, space, computer, instance string) error {
	liveWorkspaceBridges.Lock()
	var bridges []*workspaceBridge
	for bridge, ticket := range liveWorkspaceBridges.items {
		if ticket.TenantID == tenant && ticket.SpaceID == space && (computer == "" || ticket.ComputerID == computer) && (instance == "" || ticket.WorkspaceInstanceID == instance) {
			bridges = append(bridges, bridge)
		}
	}
	liveWorkspaceBridges.Unlock()
	for _, bridge := range bridges {
		_ = bridge.conn.Close()
	}
	var failures []error
	for _, bridge := range bridges {
		if bridge.done == nil {
			failures = append(failures, errors.New("workspace connection cleanup cannot be confirmed"))
			continue
		}
		select {
		case <-bridge.done:
			if bridge.journalID == "" {
				failures = append(failures, bridge.cleanupErr)
			}
		case <-ctx.Done():
			return errors.Join(append(failures, ctx.Err())...)
		}
	}
	return errors.Join(failures...)
}

func (h *handler) desktopProxy(w http.ResponseWriter, r *http.Request) {
	h.workspaceProxy(w, r, "desktop")
}
func (h *handler) terminalProxy(w http.ResponseWriter, r *http.Request) {
	h.workspaceProxy(w, r, "terminal")
}

// Compatibility URLs use the same single-use Space ticket and allocation
// journal. Historical HMAC-only tickets cannot bypass the canonical gate.
func (h *handler) workspaceProxy(w http.ResponseWriter, r *http.Request, kind string) {
	body, _, ok := strings.Cut(r.URL.Query().Get("token"), ".")
	if !ok || len(body) > 4096 {
		httpx.Error(w, http.StatusUnauthorized, "invalid ticket")
		return
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	var ticket acpLoginTicket
	if err != nil || json.Unmarshal(raw, &ticket) != nil || ticket.Tenant == "" || ticket.Space == "" {
		httpx.Error(w, http.StatusUnauthorized, "invalid ticket")
		return
	}
	a, err := h.store.GetAgent(r.Context(), ticket.Tenant, chi.URLParam(r, "id"))
	if err != nil || a.SpaceID != ticket.Space {
		httpx.Error(w, http.StatusUnauthorized, "invalid ticket")
		return
	}
	route := chi.NewRouteContext()
	route.URLParams.Add("id", a.SpaceID)
	h.spaceWorkspaceProxy(w, r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, route)), kind)
}

func (h *handler) bridgeDesktopContainer(ctx context.Context, bridge *workspaceBridge, session *runnerSession, dockerID string) {
	var started struct {
		ID string `json:"id"`
	}
	err := bridge.call(ctx, session, "docker.exec.start", map[string]any{"id": dockerID, "command": []string{"socat", "STDIO", "TCP:127.0.0.1:5900,connect-timeout=5"}, "workingDir": "/workspace"}, &started)
	if err != nil || started.ID == "" {
		bridge.cleanupErr = errors.New("desktop stream allocation could not be confirmed")
		_ = bridge.write(0x8, []byte{0x03, 0xf3})
		return
	}
	defer func() {
		bridge.closeRemote(ctx, session, "docker.exec.close", started.ID)
	}()
	if err := bridge.allocated(started.ID, "docker.exec.close"); err != nil {
		bridge.cleanupErr = err
		return
	}
	streamDone := make(chan struct{})
	var once sync.Once
	unsubscribe := session.onStream(started.ID, func(channel string, data []byte) {
		if channel == "stdout" && len(data) > 0 {
			if bridge.write(0x2, data) != nil {
				_ = bridge.conn.Close()
			}
		} else if channel == "exit" || channel == "error" {
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
			if bridge.call(ctx, session, "docker.exec.write", map[string]any{"id": started.ID, "base64": encoded}, nil) != nil {
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

func (h *handler) bridgeTerminalContainer(ctx context.Context, bridge *workspaceBridge, session *runnerSession, spaceID, workspaceKind, adapterID, dockerID string) {
	method, writeMethod, closeMethod := "host.pty.start", "host.pty.write", "host.pty.close"
	command := []string{"bash", "-l"}
	if workspaceKind == "host" && adapterID == "" {
		var info struct {
			GOOS     string `json:"goos"`
			HostInfo struct {
				Platform string `json:"platform"`
			} `json:"hostInfo"`
		}
		if err := session.call(ctx, "sys.info", map[string]any{}, &info); err != nil {
			bridge.cleanupErr = err
			_ = bridge.write(0x1, []byte(`{"type":"error","message":"terminal unavailable"}`))
			return
		}
		if info.GOOS == "windows" || info.HostInfo.Platform == "windows" {
			command = []string{"powershell.exe", "-NoLogo", "-NoProfile"}
		}
	}
	params := map[string]any{"spaceId": spaceID, "command": command, "workingDir": "/workspace", "cols": 120, "rows": 30}
	if workspaceKind != "host" || adapterID != "" {
		if dockerID == "" {
			bridge.cleanupErr = errors.New("canonical workspace container is required")
			_ = bridge.write(0x1, []byte(`{"type":"error","message":"workspace container is not running"}`))
			return
		}
		method, writeMethod, closeMethod = "docker.exec.start", "docker.exec.write", "docker.exec.close"
		params = map[string]any{"id": dockerID, "command": []string{"bash", "-l"}, "workingDir": "/workspace", "tty": true, "cols": 120, "rows": 30}
	}
	var started struct {
		ID string `json:"id"`
	}
	if err := bridge.call(ctx, session, method, params, &started); err != nil || started.ID == "" {
		bridge.cleanupErr = errors.New("terminal stream allocation could not be confirmed")
		_ = bridge.write(0x1, []byte(`{"type":"error","message":"terminal unavailable"}`))
		return
	}
	defer func() {
		bridge.closeRemote(ctx, session, closeMethod, started.ID)
	}()
	if err := bridge.allocated(started.ID, closeMethod); err != nil {
		bridge.cleanupErr = err
		return
	}
	unsubscribe := session.onStream(started.ID, func(channel string, data []byte) {
		switch channel {
		case "stdout", "stderr":
			raw, _ := json.Marshal(map[string]any{"type": "output", "data": string(data)})
			_ = bridge.write(0x1, raw)
		case "error":
			_ = bridge.write(0x1, []byte(`{"type":"error","message":"terminal connection lost"}`))
			_ = bridge.conn.Close()
		case "exit":
			raw, _ := json.Marshal(map[string]any{"type": "exit", "code": 0})
			_ = bridge.write(0x1, raw)
			_ = bridge.conn.Close()
		}
	})
	defer unsubscribe()
	ready, _ := json.Marshal(map[string]any{"type": "ready", "sessionId": started.ID, "command": strings.Join(command, " ")})
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
			resizeMethod := "host.pty.resize"
			if method == "docker.exec.start" {
				resizeMethod = "docker.exec.resize"
			}
			if err := bridge.call(ctx, session, resizeMethod, map[string]any{"id": started.ID, "cols": message.Cols, "rows": message.Rows}, nil); err != nil {
				return
			}
		} else if message.Type == "input" {
			if err := bridge.call(ctx, session, writeMethod, map[string]any{"id": started.ID, "base64": base64.StdEncoding.EncodeToString([]byte(message.Data))}, nil); err != nil {
				return
			}
		}
	}
}
