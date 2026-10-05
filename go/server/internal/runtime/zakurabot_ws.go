// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type zakuraBotSocket struct {
	h       *handler
	conn    net.Conn
	rw      *bufio.ReadWriter
	writeMu sync.Mutex
	actor   httpx.Principal
}

var liveZakuraBotSockets = struct {
	sync.Mutex
	items map[*zakuraBotSocket]httpx.Principal
}{items: map[*zakuraBotSocket]httpx.Principal{}}

func (s *zakuraBotSocket) send(value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw) > 1_000_000 {
		return errors.New("channel output frame too large")
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return writeWSFrame(s.rw.Writer, 0x1, raw)
}

func (s *zakuraBotSocket) fail(message string, code uint16, fatal bool, correlation map[string]any) {
	frame := map[string]any{"type": "error", "message": message, "fatal": fatal}
	for key, value := range correlation {
		frame[key] = value
	}
	_ = s.send(frame)
	reason := []byte(message)
	if len(reason) > 100 {
		reason = reason[:100]
	}
	payload := append([]byte{byte(code >> 8), byte(code)}, reason...)
	s.writeMu.Lock()
	_ = writeWSFrame(s.rw.Writer, 0x8, payload)
	s.writeMu.Unlock()
}

func (h *handler) zakuraBotWS(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		httpx.Error(w, http.StatusUpgradeRequired, "websocket upgrade required; authenticate with a hello frame")
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
	sum := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
	if rw.Flush() != nil {
		return
	}
	socket := &zakuraBotSocket{h: h, conn: conn, rw: rw}
	if r.URL.RawQuery != "" {
		socket.fail("Credentials must be sent in hello, never the URL", 1008, true, nil)
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	opcode, payload, err := readWSFrameSized(rw.Reader, 1_000_000)
	if err != nil {
		socket.fail("Timed out waiting for hello; reconnect and authenticate", 4408, false, nil)
		return
	}
	if opcode != 0x1 {
		socket.fail("Expected a JSON text frame", 1008, true, nil)
		return
	}
	var hello struct {
		Type     string `json:"type"`
		Protocol int    `json:"protocol"`
		Token    string `json:"token"`
		Client   struct {
			Name, Version string
		} `json:"client"`
	}
	if json.Unmarshal(payload, &hello) != nil || hello.Type != "hello" {
		socket.fail("Authenticate with hello first", 4401, true, nil)
		return
	}
	if hello.Protocol != 1 || hello.Token == "" || len(hello.Token) > 4096 || hello.Client.Name == "" || hello.Client.Version == "" {
		socket.fail("Invalid channel frame or unsupported protocol", 1008, true, nil)
		return
	}
	actor, err := h.authenticateZakuraBot(r.Context(), hello.Token)
	if err != nil {
		socket.fail("Sign in with Zakura to use the channel", 4401, true, nil)
		return
	}
	socket.actor = actor
	liveZakuraBotSockets.Lock()
	liveZakuraBotSockets.items[socket] = actor
	liveZakuraBotSockets.Unlock()
	defer func() {
		liveZakuraBotSockets.Lock()
		delete(liveZakuraBotSockets.items, socket)
		liveZakuraBotSockets.Unlock()
	}()
	_ = conn.SetReadDeadline(time.Time{})
	agents, bindings, err := h.zakuraBotRoster(r.Context(), actor)
	if err != nil {
		socket.fail("Zakura Bot is temporarily unavailable", 1011, false, nil)
		return
	}
	if err := socket.send(map[string]any{"type": "ready", "protocol": 1, "agents": agents, "capabilities": []string{"agents", "history", "files", "desktop_frames", "interactions"}}); err != nil {
		return
	}
	for agentID, bindingID := range bindings {
		if err := h.replayZakuraBot(r.Context(), socket, actor, agentID, bindingID); err != nil {
			return
		}
	}
	for {
		opcode, payload, err = readWSFrameSized(rw.Reader, 1_000_000)
		if err != nil {
			return
		}
		switch opcode {
		case 0x8:
			socket.writeMu.Lock()
			_ = writeWSFrame(rw.Writer, 0x8, nil)
			socket.writeMu.Unlock()
			return
		case 0x9:
			socket.writeMu.Lock()
			_ = writeWSFrame(rw.Writer, 0xA, payload)
			socket.writeMu.Unlock()
			continue
		case 0x1:
		default:
			socket.fail("Expected a JSON text frame", 1008, true, nil)
			return
		}
		var frame struct {
			Type            string `json:"type"`
			AgentID         string `json:"agentId"`
			ClientMessageID string `json:"clientMessageId"`
			Text            string `json:"text"`
		}
		if json.Unmarshal(payload, &frame) != nil {
			socket.fail("Malformed channel JSON", 1008, true, nil)
			return
		}
		switch frame.Type {
		case "ping":
			if nextAgents, nextBindings, err := h.zakuraBotRoster(r.Context(), actor); err == nil {
				bindings = nextBindings
				_ = socket.send(map[string]any{"type": "agents", "agents": nextAgents})
			}
			_ = socket.send(map[string]any{"type": "pong"})
		case "send":
			if frame.AgentID == "" || frame.ClientMessageID == "" || len(frame.AgentID) > 256 || len(frame.ClientMessageID) > 256 || strings.TrimSpace(frame.Text) == "" || len([]rune(frame.Text)) > 4000 {
				_ = socket.send(map[string]any{"type": "error", "message": "Use 1–4000 characters per message", "agentId": frame.AgentID, "clientMessageId": frame.ClientMessageID})
				continue
			}
			bindingID := bindings[frame.AgentID]
			if bindingID == "" {
				_ = socket.send(map[string]any{"type": "error", "message": "This device cannot access the requested agent", "agentId": frame.AgentID, "clientMessageId": frame.ClientMessageID})
				continue
			}
			if err := h.zakuraBotSend(r.Context(), socket, actor, frame.AgentID, bindingID, frame.ClientMessageID, strings.TrimSpace(frame.Text)); err != nil {
				_ = socket.send(map[string]any{"type": "error", "message": err.Error(), "agentId": frame.AgentID, "clientMessageId": frame.ClientMessageID})
			}
		case "interrupt":
			bindingID := bindings[frame.AgentID]
			if bindingID == "" {
				_ = socket.send(map[string]any{"type": "error", "message": "This conversation is no longer available", "agentId": frame.AgentID})
				continue
			}
			_ = h.interruptZakuraBot(r.Context(), actor, frame.AgentID, bindingID)
			_ = socket.send(map[string]any{"type": "typing", "agentId": frame.AgentID, "active": false})
		case "hello":
			socket.fail("Wait for ready before sending channel data", 1008, true, nil)
			return
		default:
			socket.fail("Invalid channel frame or unsupported protocol", 1008, true, nil)
			return
		}
	}
}

func (h *handler) authenticateZakuraBot(ctx context.Context, raw string) (httpx.Principal, error) {
	seed := sha256.Sum256(append(append([]byte{}, h.deps.Secret...), []byte("zakura-oauth-eddsa-v1")...))
	private := ed25519.NewKeyFromSeed(seed[:])
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodEdDSA {
			return nil, errors.New("invalid signing method")
		}
		return private.Public().(ed25519.PublicKey), nil
	}, jwt.WithIssuer(h.deps.PublicURL), jwt.WithExpirationRequired(), jwt.WithValidMethods([]string{"EdDSA"}))
	if err != nil || !token.Valid {
		return httpx.Principal{}, errors.New("invalid OAuth access token")
	}
	claim := func(key string) string { value, _ := claims[key].(string); return value }
	p := httpx.Principal{UserID: claim("sub"), TenantID: claim("tenantId"), OAuthScope: claim("scope"), OAuth: true}
	allowed := false
	for _, scope := range strings.Fields(p.OAuthScope) {
		allowed = allowed || scope == "api"
	}
	if p.UserID == "" || p.TenantID == "" || !allowed {
		return httpx.Principal{}, errors.New("insufficient scope")
	}
	var userStatus, membershipStatus string
	err = h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT u.email,u.is_platform_admin,u.status,m.role,m.status FROM users u JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=? WHERE u.id=?`), p.TenantID, p.UserID).Scan(&p.Email, &p.IsPlatformAdmin, &userStatus, &p.Role, &membershipStatus)
	if err != nil || userStatus != "active" || membershipStatus != "active" {
		return httpx.Principal{}, errors.New("inactive OAuth principal")
	}
	return p, nil
}

func (h *handler) zakuraBotRoster(ctx context.Context, actor httpx.Principal) ([]map[string]any, map[string]string, error) {
	rows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT a.id,a.name,a.description,a.space_id,s.name,a.avatar_color,a.avatar_shape,a.avatar_url,s.enable_computer FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? ORDER BY a.created_at,a.id`), actor.TenantID)
	if err != nil {
		return nil, nil, err
	}
	type rosterAgent struct {
		id, name, description, spaceID, spaceName string
		color, shape, avatarURL                   sql.NullString
		enableComputer                            bool
	}
	loaded := []rosterAgent{}
	for rows.Next() {
		var item rosterAgent
		if err := rows.Scan(&item.id, &item.name, &item.description, &item.spaceID, &item.spaceName, &item.color, &item.shape, &item.avatarURL, &item.enableComputer); err != nil {
			rows.Close()
			return nil, nil, err
		}
		loaded = append(loaded, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()
	agents := []map[string]any{}
	bindings := map[string]string{}
	for _, item := range loaded {
		var bindingID string
		var enabled bool
		err := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT id,enabled FROM agent_channel_bindings WHERE tenant_id=? AND agent_id=? AND platform='zakurabot' ORDER BY created_at LIMIT 1`), actor.TenantID, item.id).Scan(&bindingID, &enabled)
		if errors.Is(err, sql.ErrNoRows) {
			bindingID = h.store.id()
			now := h.store.now()
			_, err = h.deps.DB.ExecContext(ctx, h.store.q(`INSERT INTO agent_channel_bindings(id,tenant_id,space_id,agent_id,platform,profile_key,label,enabled,settings_json,config_enc,created_at,updated_at) VALUES(?,?,?,?,?,'remote-zakurabot','Zakura Bot',TRUE,'{"allowAll":true}','',?,?)`), bindingID, actor.TenantID, item.spaceID, item.id, "zakurabot", now, now)
			enabled = err == nil
		}
		if err != nil || !enabled {
			continue
		}
		bindings[item.id] = bindingID
		agents = append(agents, map[string]any{
			"id": item.id, "name": item.name, "status": "idle", "color": "#1084fe", "unread": false,
			"title": "Zakura Bot", "bindingId": bindingID, "description": item.description, "spaceId": item.spaceID, "spaceName": item.spaceName,
			"avatarColor": nullableString(item.color), "avatarShape": nullableString(item.shape), "avatarUrl": nullableString(item.avatarURL),
			"capabilities": map[string]any{"files": item.enableComputer, "desktop": item.enableComputer, "interactions": true},
		})
	}
	return agents, bindings, nil
}

func (h *handler) replayZakuraBot(ctx context.Context, socket *zakuraBotSocket, actor httpx.Principal, agentID, bindingID string) error {
	rows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT frame_json FROM zakurabot_messages WHERE tenant_id=? AND device_id=? AND binding_id=? AND agent_id=? ORDER BY seq DESC LIMIT 100`), actor.TenantID, actor.UserID, bindingID, agentID)
	if err != nil {
		return err
	}
	defer rows.Close()
	frames := []json.RawMessage{}
	for rows.Next() {
		var raw json.RawMessage
		if err := rows.Scan(&raw); err != nil {
			return err
		}
		frames = append(frames, raw)
	}
	for i := len(frames) - 1; i >= 0; i-- {
		var value any
		if json.Unmarshal(frames[i], &value) == nil {
			if err := socket.send(value); err != nil {
				return err
			}
		}
	}
	return rows.Err()
}

func (h *handler) zakuraBotSend(ctx context.Context, socket *zakuraBotSocket, actor httpx.Principal, agentID, bindingID, clientMessageID, text string) error {
	message := map[string]any{"type": "message", "message": map[string]any{
		"id": clientMessageID, "agentId": agentID, "role": "user", "kind": "text", "text": text,
		"clientMessageId": clientMessageID, "createdAt": h.store.now().UnixMilli(),
	}}
	raw, _ := json.Marshal(message)
	var existing string
	err := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT frame_json FROM zakurabot_messages WHERE tenant_id=? AND device_id=? AND binding_id=? AND agent_id=? AND client_message_id=?`), actor.TenantID, actor.UserID, bindingID, agentID, clientMessageID).Scan(&existing)
	if err == nil {
		if existing != string(raw) {
			return errors.New("clientMessageId was already used with different content")
		}
		var replay any
		_ = json.Unmarshal([]byte(existing), &replay)
		return socket.send(replay)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var seq int64
	err = appdeps.InTx(ctx, h.deps.DB, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, h.store.q(`SELECT COALESCE(MAX(seq),0)+1 FROM zakurabot_messages WHERE tenant_id=? AND device_id=? AND binding_id=? AND agent_id=?`), actor.TenantID, actor.UserID, bindingID, agentID).Scan(&seq); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, h.store.q(`INSERT INTO zakurabot_messages(id,seq,tenant_id,device_id,binding_id,agent_id,client_message_id,frame_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`), h.store.id(), seq, actor.TenantID, actor.UserID, bindingID, agentID, clientMessageID, string(raw), h.store.now())
		return err
	})
	if err != nil {
		return err
	}
	if err := socket.send(message); err != nil {
		return err
	}
	sessionID, err := h.zakuraBotSession(ctx, actor, agentID, bindingID)
	if err != nil {
		return err
	}
	run, queued, err := h.service.StartTurn(ctx, actor.TenantID, agentID, sessionID, text, nil, nil, true)
	if err != nil {
		return err
	}
	_ = socket.send(map[string]any{"type": "typing", "agentId": agentID, "active": true})
	if queued == nil {
		go h.watchZakuraBotRun(socket, actor, agentID, bindingID, sessionID, run.ID)
	}
	return nil
}

func (h *handler) zakuraBotSession(ctx context.Context, actor httpx.Principal, agentID, bindingID string) (string, error) {
	key := "zakurabot:" + actor.TenantID + ":" + actor.UserID + ":" + bindingID + ":" + agentID
	var sessionID string
	err := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT session_id FROM agent_channel_threads WHERE tenant_id=? AND binding_id=? AND external_thread_key=?`), actor.TenantID, bindingID, key).Scan(&sessionID)
	if err == nil {
		return sessionID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	origin, _ := json.Marshal(map[string]any{"platform": "zakurabot", "bindingId": bindingID, "userId": actor.UserID})
	createdBy := actor.UserID
	if actor.APIKey {
		createdBy = ""
	}
	session, err := h.store.CreateSession(ctx, actor.TenantID, createdBy, agentID, Session{Title: "Zakura Bot", Origin: origin})
	if err != nil {
		return "", err
	}
	now := h.store.now()
	_, err = h.deps.DB.ExecContext(ctx, h.store.q(`INSERT INTO agent_channel_threads(id,tenant_id,binding_id,session_id,external_thread_key,external_user_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`), h.store.id(), actor.TenantID, bindingID, session.ID, key, actor.UserID, now, now)
	return session.ID, err
}

func (h *handler) interruptZakuraBot(ctx context.Context, actor httpx.Principal, agentID, bindingID string) error {
	sessionID, err := h.zakuraBotSession(ctx, actor, agentID, bindingID)
	if err != nil {
		return err
	}
	_, err = h.service.Cancel(ctx, actor.TenantID, agentID, sessionID)
	return err
}

func (h *handler) watchZakuraBotRun(socket *zakuraBotSocket, actor httpx.Principal, agentID, bindingID, sessionID, runID string) {
	ctx, cancel := context.WithTimeout(h.deps.RunContext(), 10*time.Minute)
	defer cancel()
	cursor := int64(0)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			events, err := h.store.ListEvents(ctx, actor.TenantID, agentID, sessionID, cursor, 200)
			if err != nil {
				return
			}
			for _, event := range events {
				if event.Seq > cursor {
					cursor = event.Seq
				}
				if event.RunID == nil || *event.RunID != runID {
					continue
				}
				if event.Type == "assistant_message" || event.Type == "message.created" {
					var payload struct{ Role, Content string }
					_ = json.Unmarshal(event.Payload, &payload)
					if payload.Role == "assistant" && payload.Content != "" {
						frame := map[string]any{"type": "chat_reply", "agentId": agentID, "messageId": event.ID, "createdAt": event.CreatedAt.UnixMilli(), "payload": map[string]any{"text": payload.Content, "format": "markdown"}}
						raw, _ := json.Marshal(frame)
						var seq int64
						_ = appdeps.InTx(ctx, h.deps.DB, func(tx *sql.Tx) error {
							if err := tx.QueryRowContext(ctx, h.store.q(`SELECT COALESCE(MAX(seq),0)+1 FROM zakurabot_messages WHERE tenant_id=? AND device_id=? AND binding_id=? AND agent_id=?`), actor.TenantID, actor.UserID, bindingID, agentID).Scan(&seq); err != nil {
								return err
							}
							_, err := tx.ExecContext(ctx, h.store.q(`INSERT INTO zakurabot_messages(id,seq,tenant_id,device_id,binding_id,agent_id,client_message_id,frame_json,created_at) VALUES(?,?,?,?,?,?,NULL,?,?)`), h.store.id(), seq, actor.TenantID, actor.UserID, bindingID, agentID, string(raw), h.store.now())
							return err
						})
						_ = socket.send(frame)
					}
				}
				if event.Type == "run_end" || event.Type == "run_error" || event.Type == "run.completed" || event.Type == "run.failed" || event.Type == "run.cancelled" {
					_ = socket.send(map[string]any{"type": "typing", "agentId": agentID, "active": false})
					return
				}
			}
		}
	}
}

func readWSFrame(r *bufio.Reader) (byte, []byte, error) {
	head := make([]byte, 2)
	if _, e := io.ReadFull(r, head); e != nil {
		return 0, nil, e
	}
	opcode := head[0] & 0x0f
	masked := head[1]&0x80 != 0
	if !masked {
		return 0, nil, errors.New("client websocket frames must be masked")
	}
	n := uint64(head[1] & 0x7f)
	if n == 126 {
		var b [2]byte
		if _, e := io.ReadFull(r, b[:]); e != nil {
			return 0, nil, e
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	} else if n == 127 {
		var b [8]byte
		if _, e := io.ReadFull(r, b[:]); e != nil {
			return 0, nil, e
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if n > 2<<20 {
		return 0, nil, errors.New("websocket frame too large")
	}
	var mask [4]byte
	if _, e := io.ReadFull(r, mask[:]); e != nil {
		return 0, nil, e
	}
	payload := make([]byte, n)
	if _, e := io.ReadFull(r, payload); e != nil {
		return 0, nil, e
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return opcode, payload, nil
}
func writeWSFrame(w *bufio.Writer, opcode byte, payload []byte) error {
	head := []byte{0x80 | opcode}
	n := len(payload)
	if n < 126 {
		head = append(head, byte(n))
	} else if n <= 65535 {
		head = append(head, 126, byte(n>>8), byte(n))
	} else {
		head = append(head, 127, 0, 0, 0, 0, byte(uint64(n)>>24), byte(uint64(n)>>16), byte(uint64(n)>>8), byte(n))
	}
	if _, e := w.Write(head); e != nil {
		return e
	}
	if _, e := w.Write(payload); e != nil {
		return e
	}
	return w.Flush()
}
func (h *handler) handleZakuraFrame(ctx context.Context, p httpx.Principal, raw []byte) (map[string]any, error) {
	var frame struct {
		DeviceID        string          `json:"deviceId"`
		BindingID       string          `json:"bindingId"`
		AgentID         string          `json:"agentId"`
		ClientMessageID string          `json:"clientMessageId"`
		Type            string          `json:"type"`
		Payload         json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(raw, &frame) != nil || frame.DeviceID == "" || frame.BindingID == "" || frame.AgentID == "" {
		return nil, errors.New("deviceId, bindingId and agentId required")
	}
	var count int
	if e := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT COUNT(*) FROM agent_channel_bindings WHERE tenant_id=? AND id=? AND agent_id=? AND enabled=true`), p.TenantID, frame.BindingID, frame.AgentID).Scan(&count); e != nil || count == 0 {
		return nil, errors.New("binding not found")
	}
	var seq int64
	e := appdeps.InTx(ctx, h.deps.DB, func(tx *sql.Tx) error {
		if e := tx.QueryRowContext(ctx, h.store.q(`SELECT COALESCE(MAX(seq),0)+1 FROM zakurabot_messages WHERE tenant_id=? AND device_id=? AND binding_id=? AND agent_id=?`), p.TenantID, frame.DeviceID, frame.BindingID, frame.AgentID).Scan(&seq); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, h.store.q(`INSERT INTO zakurabot_messages(id,seq,tenant_id,device_id,binding_id,agent_id,client_message_id,frame_json,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,binding_id,agent_id,client_message_id) DO NOTHING`), h.store.id(), seq, p.TenantID, frame.DeviceID, frame.BindingID, frame.AgentID, nullString(frame.ClientMessageID), string(raw), h.store.now())
		return e
	})
	if e != nil {
		return nil, e
	}
	result := map[string]any{"type": "ack", "seq": seq, "clientMessageId": frame.ClientMessageID}
	if frame.Type == "message" {
		var body struct {
			Text      string `json:"text"`
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(frame.Payload, &body) != nil || strings.TrimSpace(body.Text) == "" {
			return nil, errors.New("message text required")
		}
		sessionID := body.SessionID
		if sessionID == "" {
			origin, _ := json.Marshal(map[string]any{"channel": "zakurabot", "deviceId": frame.DeviceID, "bindingId": frame.BindingID})
			userID := p.UserID
			if p.APIKey {
				userID = ""
			}
			sess, e := h.store.CreateSession(ctx, p.TenantID, userID, frame.AgentID, Session{Title: "ZakuraBot", Origin: origin})
			if e != nil {
				return nil, e
			}
			sessionID = sess.ID
		}
		run, queued, e := h.service.StartTurn(ctx, p.TenantID, frame.AgentID, sessionID, body.Text, nil, nil, true)
		if e != nil {
			return nil, e
		}
		result["sessionId"] = sessionID
		if queued != nil {
			result["queued"] = queued
		} else {
			result["run"] = run
		}
	}
	return result, nil
}
