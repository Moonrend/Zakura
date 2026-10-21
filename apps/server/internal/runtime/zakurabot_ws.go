// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/sha1"
	"crypto/sha256"
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

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
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
	streamCtx, stopStream := context.WithCancel(r.Context())
	defer stopStream()
	go h.watchZakuraBotMessages(streamCtx, socket, actor)
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
			Type            string       `json:"type"`
			AgentID         string       `json:"agentId"`
			ClientMessageID string       `json:"clientMessageId"`
			Text            string       `json:"text"`
			Attachments     []botFileRef `json:"attachments"`
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
			if frame.AgentID == "" || frame.ClientMessageID == "" || len(frame.AgentID) > 256 || len(frame.ClientMessageID) > 200 || (strings.TrimSpace(frame.Text) == "" && len(frame.Attachments) == 0) || len(frame.Attachments) > 10 || len([]rune(frame.Text)) > 4000 {
				_ = socket.send(map[string]any{"type": "error", "message": "Use 1–4000 characters per message", "agentId": frame.AgentID, "clientMessageId": frame.ClientMessageID})
				continue
			}
			bindingID := bindings[frame.AgentID]
			if bindingID == "" {
				_ = socket.send(map[string]any{"type": "error", "message": "This device cannot access the requested agent", "agentId": frame.AgentID, "clientMessageId": frame.ClientMessageID})
				continue
			}
			if err := h.zakuraBotSend(r.Context(), socket, actor, frame.AgentID, bindingID, frame.ClientMessageID, strings.TrimSpace(frame.Text), frame.Attachments...); err != nil {
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
	var rec struct {
		Email            string `gorm:"column:email"`
		IsPlatformAdmin  bool   `gorm:"column:is_platform_admin"`
		UserStatus       string `gorm:"column:user_status"`
		Role             string `gorm:"column:role"`
		MembershipStatus string `gorm:"column:membership_status"`
	}
	err = h.deps.Gorm.WithContext(ctx).Table("users AS u").Select("u.email AS email, u.is_platform_admin AS is_platform_admin, u.status AS user_status, m.role AS role, m.status AS membership_status").Joins("JOIN tenant_memberships m ON m.user_id = u.id AND m.tenant_id = ?", p.TenantID).Where("u.id = ?", p.UserID).Take(&rec).Error
	if err != nil || rec.UserStatus != "active" || rec.MembershipStatus != "active" {
		return httpx.Principal{}, errors.New("inactive OAuth principal")
	}
	p.Email, p.IsPlatformAdmin, p.Role = rec.Email, rec.IsPlatformAdmin, rec.Role
	return p, nil
}

func (h *handler) zakuraBotRoster(ctx context.Context, actor httpx.Principal) ([]map[string]any, map[string]string, error) {
	type rosterAgent struct {
		ID             string  `gorm:"column:id"`
		Name           string  `gorm:"column:name"`
		Description    string  `gorm:"column:description"`
		SpaceID        string  `gorm:"column:space_id"`
		SpaceName      string  `gorm:"column:space_name"`
		AvatarColor    *string `gorm:"column:avatar_color"`
		AvatarShape    *string `gorm:"column:avatar_shape"`
		AvatarURL      *string `gorm:"column:avatar_url"`
		EnableComputer bool    `gorm:"column:enable_computer"`
	}
	var loaded []rosterAgent
	err := h.deps.Gorm.WithContext(ctx).Table("agents AS a").Select("a.id AS id, a.name AS name, a.description AS description, a.space_id AS space_id, s.name AS space_name, a.avatar_color AS avatar_color, a.avatar_shape AS avatar_shape, a.avatar_url AS avatar_url, s.enable_computer AS enable_computer").Joins("JOIN spaces s ON s.id = a.space_id").Where("a.tenant_id = ?", actor.TenantID).Order("a.created_at, a.id").Find(&loaded).Error
	if err != nil {
		return nil, nil, err
	}
	deref := func(v *string) any {
		if v == nil {
			return nil
		}
		return *v
	}
	agents := []map[string]any{}
	bindings := map[string]string{}
	for _, item := range loaded {
		var bindingID string
		var enabled bool
		var bindingRow struct {
			ID      string `gorm:"column:id"`
			Enabled bool   `gorm:"column:enabled"`
		}
		err := h.deps.Gorm.WithContext(ctx).Table("agent_channel_bindings").Select("id, enabled").Where("tenant_id = ? AND agent_id = ? AND platform = 'zakurabot'", actor.TenantID, item.ID).Order("created_at").Take(&bindingRow).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			bindingID = h.store.id()
			now := runtimeTimeString(h.store.now())
			err = h.deps.Gorm.WithContext(ctx).Exec(`INSERT INTO agent_channel_bindings(id,tenant_id,space_id,agent_id,platform,profile_key,label,enabled,settings_json,config_enc,created_at,updated_at) VALUES(?,?,?,?,?,'remote-zakurabot','Zakura Bot',TRUE,'{"allowAll":true}','',?,?)`, bindingID, actor.TenantID, item.SpaceID, item.ID, "zakurabot", now, now).Error
			enabled = err == nil
		} else if err == nil {
			bindingID, enabled = bindingRow.ID, bindingRow.Enabled
		}
		if err != nil || !enabled {
			continue
		}
		bindings[item.ID] = bindingID
		agents = append(agents, map[string]any{
			"id": item.ID, "name": item.Name, "status": "idle", "color": "#1084fe", "unread": false,
			"title": "Zakura Bot", "bindingId": bindingID, "description": item.Description, "spaceId": item.SpaceID, "spaceName": item.SpaceName,
			"avatarColor": deref(item.AvatarColor), "avatarShape": deref(item.AvatarShape), "avatarUrl": deref(item.AvatarURL),
			"capabilities": map[string]any{"files": item.EnableComputer, "desktop": item.EnableComputer, "interactions": true},
		})
	}
	return agents, bindings, nil
}

func (h *handler) zakuraBotSend(ctx context.Context, socket *zakuraBotSocket, actor httpx.Principal, agentID, bindingID, clientMessageID, text string, refs ...botFileRef) error {
	attachments, err := h.botAttachments(ctx, actor, agentID, bindingID, refs)
	if err != nil {
		return err
	}
	sessionID, err := h.zakuraBotSession(ctx, actor, agentID, bindingID)
	if err != nil {
		return err
	}
	// Serialize admission and acknowledgement separately from the run lock.
	mu := h.service.sessionLock("bot-send:" + sessionID)
	mu.Lock()
	defer mu.Unlock()
	var existing struct {
		FrameJSON string `gorm:"column:frame_json"`
	}
	err = h.deps.Gorm.WithContext(ctx).Table("zakurabot_messages").Select("frame_json").Where("tenant_id=? AND device_id=? AND binding_id=? AND agent_id=? AND client_message_id=?", actor.TenantID, actor.UserID, bindingID, agentID, clientMessageID).Take(&existing).Error
	if err == nil {
		var saved struct {
			Message struct {
				Text        string `json:"text"`
				Attachments []struct {
					ID string `json:"id"`
				} `json:"attachments"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(existing.FrameJSON), &saved) != nil || saved.Message.Text != text {
			return ErrConflict
		}
		if len(saved.Message.Attachments) != len(refs) {
			return ErrConflict
		}
		for i, attachment := range saved.Message.Attachments {
			if attachment.ID != refs[i].FileID {
				return ErrConflict
			}
		}
		return socket.send(json.RawMessage(existing.FrameJSON))
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	var user struct {
		Name string `gorm:"column:name"`
	}
	_ = h.deps.Gorm.WithContext(ctx).Table("users").Select("name").Where("id=?", actor.UserID).Take(&user).Error
	sender, _ := json.Marshal(map[string]string{"id": actor.UserID, "name": user.Name})
	wrapper := &MessageContext{
		Prefix: "[Zakura Bot message]\nSender: " + string(sender),
		Suffix: "[Reply delivery]\nYour final answer is delivered to this bot conversation automatically. Use chat_reply when you need to send a separate message. Do not repeat messages already sent with chat_reply.",
	}
	_, _, err = h.service.Start(ctx, TurnRequest{Tenant: actor.TenantID, Agent: agentID, Session: sessionID, Content: text, Context: wrapper, Attachments: attachments, MessageID: clientMessageID, UserID: actor.UserID, UserName: user.Name, QueueOnConflict: true, FollowUpMode: queueModeQueue})
	if err != nil {
		return err
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("zakurabot_messages").Select("frame_json").Where("tenant_id=? AND device_id=? AND binding_id=? AND agent_id=? AND client_message_id=?", actor.TenantID, actor.UserID, bindingID, agentID, clientMessageID).Take(&existing).Error; err != nil {
		return err
	}
	return socket.send(json.RawMessage(existing.FrameJSON))
}

func (h *handler) zakuraBotSession(ctx context.Context, actor httpx.Principal, agentID, bindingID string) (string, error) {
	key := "zakurabot:" + actor.TenantID + ":" + actor.UserID + ":" + bindingID + ":" + agentID
	mu := h.service.sessionLock("bot-thread:" + key)
	mu.Lock()
	defer mu.Unlock()
	var thread models.AgentChannelThread
	err := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND binding_id = ? AND external_thread_key = ?", actor.TenantID, bindingID, key).Take(&thread).Error
	if err == nil {
		return thread.SessionID, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
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
	now := runtimeTimeString(h.store.now())
	tid := h.store.id()
	thread = models.AgentChannelThread{ID: &tid, TenantID: actor.TenantID, BindingID: bindingID, SessionID: session.ID, ExternalThreadKey: key, ExternalUserKey: &actor.UserID, CreatedAt: now, UpdatedAt: now}
	err = h.deps.Gorm.WithContext(ctx).Create(&thread).Error
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

func (h *handler) watchZakuraBotMessages(ctx context.Context, socket *zakuraBotSocket, actor httpx.Principal) {
	cursors := map[string]int64{}
	busy := map[string]bool{}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var bindings map[string]string
	var rosterAt time.Time
	for {
		if time.Since(rosterAt) >= 5*time.Second {
			var err error
			_, bindings, err = h.zakuraBotRoster(ctx, actor)
			if err != nil {
				return
			}
			rosterAt = time.Now()
		}
		for agent, binding := range bindings {
			key := agent + ":" + binding
			cursor, initialized := cursors[key]
			var rows []models.ZakurabotMessage
			query := h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND device_id=? AND binding_id=? AND agent_id=?", actor.TenantID, actor.UserID, binding, agent)
			if initialized {
				query = query.Where("seq > ?", cursor).Order("seq ASC").Limit(200)
			} else {
				query = query.Order("seq DESC").Limit(100)
			}
			if query.Find(&rows).Error != nil {
				return
			}
			if !initialized {
				for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
					rows[i], rows[j] = rows[j], rows[i]
				}
			}
			for _, row := range rows {
				if err := socket.send(json.RawMessage(row.FrameJSON)); err != nil {
					return
				}
				cursor = int64(row.Seq)
			}
			cursors[key] = cursor
			state, err := h.zakuraSessionStatus(ctx, actor, agent, binding)
			if err != nil {
				continue
			}
			active := state["status"] == "running"
			if len(rows) > 0 || busy[key] != active {
				if err := socket.send(map[string]any{"type": "typing", "agentId": agent, "active": active}); err != nil {
					return
				}
				busy[key] = active
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
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
