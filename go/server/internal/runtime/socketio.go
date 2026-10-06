// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/golang-jwt/jwt/v5"
	"github.com/reearth/ygo/crdt"
)

type realtimeClient struct {
	id        string
	h         *handler
	mu        sync.Mutex
	principal httpx.Principal
	authed    bool
	subs      map[string]context.CancelFunc
	syncSubs  map[string]bool
	send      func(string) error
	done      chan struct{}
	queue     []string
	wake      chan struct{}
}

var realtimeHub = struct {
	sync.Mutex
	clients  map[string]*realtimeClient
	presence map[string]map[string]map[string]any
	yjs      map[string]*yjsDocument
}{clients: map[string]*realtimeClient{}, presence: map[string]map[string]map[string]any{}, yjs: map[string]*yjsDocument{}}

// yjsDocument is a compacted, in-memory Yjs document.  Updates are applied to
// the CRDT before they are acknowledged and each commit persists a complete
// checkpoint.  That makes compaction lossless: old operations may disappear,
// but their resulting state and tombstones remain in the Yjs update.
type yjsDocument struct {
	mu       sync.Mutex
	doc      *crdt.Doc
	revision int64
}

func yjsDocumentKey(tenantID, sessionID string) string { return tenantID + ":" + sessionID }

func (h *handler) loadYjsDocument(ctx context.Context, tenantID, sessionID string) (*yjsDocument, error) {
	key := yjsDocumentKey(tenantID, sessionID)
	realtimeHub.Lock()
	state := realtimeHub.yjs[key]
	if state == nil {
		state = &yjsDocument{doc: crdt.New()}
		realtimeHub.yjs[key] = state
	}
	realtimeHub.Unlock()

	state.mu.Lock()
	defer state.mu.Unlock()
	if state.revision != 0 {
		return state, nil
	}
	if saved, err := h.getSetting(ctx, "tenant:"+tenantID, "yjs:"+sessionID); err == nil {
		checkpoint, _ := saved["checkpoint"].(string)
		if checkpoint != "" {
			update, decodeErr := base64.StdEncoding.DecodeString(checkpoint)
			if decodeErr != nil {
				return nil, fmt.Errorf("invalid persisted Yjs checkpoint: %w", decodeErr)
			}
			if applyErr := crdt.ApplyUpdateV1(state.doc, update, "restore"); applyErr != nil {
				return nil, fmt.Errorf("invalid persisted Yjs checkpoint: %w", applyErr)
			}
		} else if legacy, ok := saved["updates"].([]any); ok {
			// Early Go builds stored a bounded update array. Integrate every
			// retained operation before switching to lossless checkpoints.
			for _, value := range legacy {
				encoded, _ := value.(string)
				update, decodeErr := base64.StdEncoding.DecodeString(encoded)
				if decodeErr != nil || crdt.ApplyUpdateV1(state.doc, update, "legacy-restore") != nil {
					return nil, errors.New("invalid persisted legacy Yjs update")
				}
			}
		}
		switch value := saved["revision"].(type) {
		case float64:
			state.revision = int64(value)
		case int64:
			state.revision = value
		}
	}
	// Revision zero is also a valid persisted empty document.  Reserve one as
	// the loaded sentinel so concurrent subscribers don't reload it.
	if state.revision == 0 {
		state.revision = 1
	}
	return state, nil
}

func (h *handler) socketIO(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("EIO") != "4" {
		httpx.Error(w, 400, "Engine.IO 4 required")
		return
	}
	transport := r.URL.Query().Get("transport")
	if transport == "websocket" {
		h.socketWebsocket(w, r)
		return
	}
	if transport != "polling" {
		httpx.Error(w, 400, "unsupported transport")
		return
	}
	sid := r.URL.Query().Get("sid")
	if sid == "" {
		if r.Method != http.MethodGet {
			httpx.Error(w, 400, "polling handshake requires GET")
			return
		}
		c := h.newRealtimeClient()
		realtimeHub.Lock()
		realtimeHub.clients[c.id] = c
		realtimeHub.Unlock()
		w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
		fmt.Fprintf(w, "0{\"sid\":%q,\"upgrades\":[\"websocket\"],\"pingInterval\":25000,\"pingTimeout\":20000,\"maxPayload\":2000000}", c.id)
		return
	}
	realtimeHub.Lock()
	c := realtimeHub.clients[sid]
	realtimeHub.Unlock()
	if c == nil {
		httpx.Error(w, 400, "unknown sid")
		return
	}
	switch r.Method {
	case http.MethodPost:
		raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
		if e != nil {
			httpx.Error(w, 413, "payload too large")
			return
		}
		for _, packet := range strings.Split(string(raw), "\x1e") {
			if packet != "" {
				_ = c.handlePacket(r.Context(), packet)
			}
		}
		io.WriteString(w, "ok")
	case http.MethodGet:
		timer := time.NewTimer(20 * time.Second)
		defer timer.Stop()
		for {
			c.mu.Lock()
			if len(c.queue) > 0 {
				packets := append([]string(nil), c.queue...)
				c.queue = nil
				c.mu.Unlock()
				io.WriteString(w, strings.Join(packets, "\x1e"))
				return
			}
			c.mu.Unlock()
			select {
			case <-c.wake:
				continue
			case <-timer.C:
				io.WriteString(w, "2")
				return
			case <-r.Context().Done():
				return
			}
		}
	case http.MethodDelete:
		c.close()
		w.WriteHeader(200)
	default:
		w.WriteHeader(405)
	}
}
func (h *handler) newRealtimeClient() *realtimeClient {
	c := &realtimeClient{id: h.store.id(), h: h, subs: map[string]context.CancelFunc{}, syncSubs: map[string]bool{}, done: make(chan struct{}), wake: make(chan struct{}, 1)}
	c.send = func(packet string) error {
		c.mu.Lock()
		c.queue = append(c.queue, packet)
		c.mu.Unlock()
		select {
		case c.wake <- struct{}{}:
		default:
		}
		return nil
	}
	return c
}
func (h *handler) socketWebsocket(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		httpx.Error(w, 426, "websocket upgrade required")
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	hijacker, ok := w.(http.Hijacker)
	if !ok || key == "" {
		httpx.Error(w, 400, "invalid websocket handshake")
		return
	}
	conn, rw, e := hijacker.Hijack()
	if e != nil {
		return
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
	_ = rw.Flush()
	c := h.newRealtimeClient()
	var writeMu sync.Mutex
	c.send = func(packet string) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return writeWSFrame(rw.Writer, 0x1, []byte(packet))
	}
	realtimeHub.Lock()
	realtimeHub.clients[c.id] = c
	realtimeHub.Unlock()
	_ = c.send(fmt.Sprintf("0{\"sid\":%q,\"upgrades\":[],\"pingInterval\":25000,\"pingTimeout\":20000,\"maxPayload\":2000000}", c.id))
	defer func() { c.close(); conn.Close() }()
	for {
		opcode, payload, e := readWSFrame(rw.Reader)
		if e != nil {
			return
		}
		if opcode == 0x8 {
			return
		}
		if opcode == 0x9 {
			writeMu.Lock()
			_ = writeWSFrame(rw.Writer, 0xA, payload)
			writeMu.Unlock()
			continue
		}
		if opcode == 0x1 {
			_ = c.handlePacket(r.Context(), string(payload))
		}
	}
}
func (c *realtimeClient) close() {
	c.mu.Lock()
	select {
	case <-c.done:
		c.mu.Unlock()
		return
	default:
		close(c.done)
	}
	for _, cancel := range c.subs {
		cancel()
	}
	p := c.principal
	c.mu.Unlock()
	realtimeHub.Lock()
	delete(realtimeHub.clients, c.id)
	if users := realtimeHub.presence[p.TenantID]; users != nil {
		delete(users, p.UserID)
	}
	realtimeHub.Unlock()
	if p.TenantID != "" {
		broadcastTenant(p.TenantID, "presence:leave", map[string]any{"userId": p.UserID}, c.id)
	}
}
func (c *realtimeClient) handlePacket(ctx context.Context, packet string) error {
	if packet == "2" {
		return c.send("3")
	}
	if strings.HasPrefix(packet, "40") {
		var auth struct {
			Token string `json:"token"`
		}
		_ = json.Unmarshal([]byte(strings.TrimPrefix(packet, "40")), &auth)
		if auth.Token == "" {
			return c.send(`44{"message":"unauthorized"}`)
		}
		p, e := c.h.authenticateRealtime(ctx, auth.Token)
		if e != nil {
			return c.send(`44{"message":"unauthorized"}`)
		}
		c.mu.Lock()
		c.principal = p
		c.authed = true
		c.mu.Unlock()
		realtimeHub.Lock()
		if realtimeHub.presence[p.TenantID] == nil {
			realtimeHub.presence[p.TenantID] = map[string]map[string]any{}
		}
		realtimeHub.Unlock()
		_ = c.send(`40{"sid":"` + c.id + `"}`)
		return c.emitPresenceState()
	}
	if packet == "41" {
		c.close()
		return nil
	}
	if !strings.HasPrefix(packet, "42") {
		return nil
	}
	c.mu.Lock()
	authed := c.authed
	c.mu.Unlock()
	if !authed {
		return errors.New("unauthorized")
	}
	rest := strings.TrimPrefix(packet, "42")
	i := 0
	for i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
		i++
	}
	ackID := rest[:i]
	var event []json.RawMessage
	if json.Unmarshal([]byte(rest[i:]), &event) != nil || len(event) == 0 {
		return errors.New("invalid Socket.IO event")
	}
	var name string
	_ = json.Unmarshal(event[0], &name)
	payload := map[string]any{}
	if len(event) > 1 {
		_ = json.Unmarshal(event[1], &payload)
	}
	ack := func(v any) {
		if ackID != "" {
			raw, _ := json.Marshal([]any{v})
			_ = c.send("43" + ackID + string(raw))
		}
	}
	switch name {
	case "subscribe:session":
		return c.subscribeSession(payload, ack)
	case "unsubscribe:session":
		if sid, _ := payload["sessionId"].(string); sid != "" {
			c.mu.Lock()
			if cancel := c.subs[sid]; cancel != nil {
				cancel()
				delete(c.subs, sid)
			}
			c.mu.Unlock()
		}
	case "presence:update":
		c.updatePresence(payload)
	case "sync:sub":
		return c.syncSubscribe(payload, ack)
	case "sync:update":
		return c.syncUpdate(payload)
	case "sync:unsub":
		if sid, _ := payload["sessionId"].(string); sid != "" {
			c.mu.Lock()
			delete(c.syncSubs, sid)
			c.mu.Unlock()
		}
		ack(map[string]any{"ok": true})
	}
	return nil
}
func (h *handler) authenticateRealtime(ctx context.Context, raw string) (httpx.Principal, error) {
	if strings.HasPrefix(raw, "zak_") || strings.HasPrefix(raw, "zk_") {
		sum := sha256.Sum256([]byte(raw))
		p := httpx.Principal{UserID: "api-key", Role: "api_key", APIKey: true}
		var rec struct {
			APIKeyID     string `gorm:"column:api_key_id"`
			TenantID     string `gorm:"column:tenant_id"`
			Name         string `gorm:"column:name"`
			AgentID      string `gorm:"column:agent_id"`
			APIKeyScopes string `gorm:"column:scopes"`
		}
		e := h.deps.Gorm.WithContext(ctx).Table("api_keys AS k").Select("k.id AS api_key_id, k.tenant_id AS tenant_id, k.name AS name, COALESCE(k.agent_id,'') AS agent_id, k.scopes AS scopes").Joins("JOIN tenants t ON t.id=k.tenant_id").Where("k.key_hash=? AND k.revoked_at IS NULL AND t.status='active' AND (k.expires_at IS NULL OR k.expires_at>?)", hex.EncodeToString(sum[:]), runtimeTimeString(h.store.now())).Take(&rec).Error
		if e != nil {
			return httpx.Principal{}, e
		}
		p.APIKeyID, p.TenantID, p.Email, p.AgentID, p.APIKeyScopes = rec.APIKeyID, rec.TenantID, rec.Name, rec.AgentID, rec.APIKeyScopes
		_ = h.deps.Gorm.WithContext(ctx).Model(&models.APIKey{}).Where("id = ?", p.APIKeyID).Update("last_used_at", runtimeTimeString(h.store.now())).Error
		return p, nil
	}
	if p, e := h.authenticateZakuraBot(ctx, raw); e == nil {
		return p, nil
	}
	claims := jwt.MapClaims{}
	token, e := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("invalid signing method")
		}
		return h.deps.Secret, nil
	}, jwt.WithExpirationRequired(), jwt.WithValidMethods([]string{"HS256"}))
	if e != nil || !token.Valid {
		return httpx.Principal{}, errors.New("invalid token")
	}
	str := func(k string) string { v, _ := claims[k].(string); return v }
	p := httpx.Principal{UserID: str("sub"), TenantID: str("tenantId"), Email: str("email"), Role: str("role"), SessionID: str("sid")}
	var count int64
	e = h.deps.Gorm.WithContext(ctx).Model(&models.UserSession{}).Where("id=? AND user_id=? AND tenant_id=? AND revoked_at IS NULL AND expires_at>?", p.SessionID, p.UserID, p.TenantID, runtimeTimeString(h.store.now())).Count(&count).Error
	if e != nil || count == 0 {
		return httpx.Principal{}, errors.New("revoked session")
	}
	return p, nil
}
func (c *realtimeClient) subscribeSession(payload map[string]any, ack func(any)) error {
	agent, _ := payload["agentId"].(string)
	sid, _ := payload["sessionId"].(string)
	after := int64(0)
	if n, ok := payload["afterSeq"].(float64); ok {
		after = int64(n)
	}
	if agent == "" || sid == "" {
		ack(map[string]any{"ok": false, "error": "agentId and sessionId required"})
		return nil
	}
	if _, e := c.h.store.GetSession(c.h.deps.RunContext(), c.principal.TenantID, agent, sid); e != nil {
		ack(map[string]any{"ok": false, "error": "Not found"})
		return nil
	}
	c.mu.Lock()
	if old := c.subs[sid]; old != nil {
		old()
	}
	subctx, cancel := context.WithCancel(c.h.deps.RunContext())
	c.subs[sid] = cancel
	c.mu.Unlock()
	events, e := c.h.store.ListEvents(c.h.deps.RunContext(), c.principal.TenantID, agent, sid, after, 1000)
	if e != nil {
		cancel()
		ack(map[string]any{"ok": false, "error": e.Error()})
		return nil
	}
	cursor := after
	for _, ev := range events {
		if ev.Seq > cursor {
			cursor = ev.Seq
			_ = c.emit("cloud", ev)
		}
	}
	ack(map[string]any{"ok": true, "afterSeq": cursor})
	go func() {
		ticker := time.NewTicker(150 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-subctx.Done():
				return
			case <-c.done:
				return
			case <-ticker.C:
				events, e := c.h.store.ListEvents(subctx, c.principal.TenantID, agent, sid, cursor, 500)
				if e != nil {
					continue
				}
				for _, ev := range events {
					if ev.Seq > cursor {
						cursor = ev.Seq
						_ = c.emit("cloud", ev)
					}
				}
			}
		}
	}()
	return nil
}
func (c *realtimeClient) emit(name string, payload any) error {
	raw, _ := json.Marshal([]any{name, payload})
	return c.send("42" + string(raw))
}
func (c *realtimeClient) emitPresenceState() error {
	realtimeHub.Lock()
	users := realtimeHub.presence[c.principal.TenantID]
	out := []map[string]any{}
	for _, loc := range users {
		out = append(out, loc)
	}
	realtimeHub.Unlock()
	return c.emit("presence:state", out)
}
func (c *realtimeClient) updatePresence(patch map[string]any) {
	loc := map[string]any{"userId": c.principal.UserID, "name": c.principal.Email, "email": c.principal.Email, "ts": time.Now().UnixMilli()}
	for k, v := range patch {
		loc[k] = v
	}
	realtimeHub.Lock()
	if realtimeHub.presence[c.principal.TenantID] == nil {
		realtimeHub.presence[c.principal.TenantID] = map[string]map[string]any{}
	}
	realtimeHub.presence[c.principal.TenantID][c.principal.UserID] = loc
	realtimeHub.Unlock()
	broadcastTenant(c.principal.TenantID, "presence:update", loc, "")
}
func broadcastTenant(tenant, event string, payload any, except string) {
	realtimeHub.Lock()
	clients := []*realtimeClient{}
	for _, c := range realtimeHub.clients {
		if c.id != except && c.authed && c.principal.TenantID == tenant {
			clients = append(clients, c)
		}
	}
	realtimeHub.Unlock()
	for _, c := range clients {
		_ = c.emit(event, payload)
	}
}
func (c *realtimeClient) syncSubscribe(payload map[string]any, ack func(any)) error {
	agent, _ := payload["agentId"].(string)
	sid, _ := payload["sessionId"].(string)
	if _, e := c.h.store.GetSession(c.h.deps.RunContext(), c.principal.TenantID, agent, sid); e != nil {
		ack(map[string]any{"ok": false, "error": "Not found"})
		return nil
	}
	c.mu.Lock()
	c.syncSubs[sid] = true
	c.mu.Unlock()
	state, err := c.h.loadYjsDocument(c.h.deps.RunContext(), c.principal.TenantID, sid)
	if err != nil {
		ack(map[string]any{"ok": false, "error": err.Error()})
		return nil
	}
	state.mu.Lock()
	var vector crdt.StateVector
	if encoded, _ := payload["sv"].(string); encoded != "" {
		if raw, decodeErr := base64.StdEncoding.DecodeString(encoded); decodeErr == nil {
			vector, _ = crdt.DecodeStateVectorV1(raw)
		}
	}
	diff := crdt.EncodeStateAsUpdateV1(state.doc, vector)
	sv := crdt.EncodeStateVectorV1(state.doc)
	revision := state.revision
	state.mu.Unlock()
	ack(map[string]any{"ok": true, "update": base64.StdEncoding.EncodeToString(diff), "sv": base64.StdEncoding.EncodeToString(sv), "revision": revision})
	return nil
}
func (c *realtimeClient) syncUpdate(payload map[string]any) error {
	sid, _ := payload["sessionId"].(string)
	update, _ := payload["update"].(string)
	if sid == "" || update == "" {
		return errors.New("sessionId and update required")
	}
	c.mu.Lock()
	subscribed := c.syncSubs[sid]
	c.mu.Unlock()
	if !subscribed {
		return errors.New("sync subscription required")
	}
	rawUpdate, err := base64.StdEncoding.DecodeString(update)
	if err != nil {
		return errors.New("invalid Yjs update encoding")
	}
	state, err := c.h.loadYjsDocument(c.h.deps.RunContext(), c.principal.TenantID, sid)
	if err != nil {
		return err
	}
	state.mu.Lock()
	if err = crdt.ApplyUpdateV1(state.doc, rawUpdate, c.id); err != nil {
		state.mu.Unlock()
		return errors.New("invalid Yjs update")
	}
	state.revision++
	checkpoint := crdt.EncodeStateAsUpdateV1(state.doc, nil)
	sv := crdt.EncodeStateVectorV1(state.doc)
	revision := state.revision
	// Persist while holding the per-document lock so two simultaneous updates
	// cannot commit an older checkpoint after a newer one.
	err = c.h.putSetting(c.h.deps.RunContext(), "tenant:"+c.principal.TenantID, "yjs:"+sid, map[string]any{
		"encoding": "yjs-v1", "checkpoint": base64.StdEncoding.EncodeToString(checkpoint),
		"stateVector": base64.StdEncoding.EncodeToString(sv), "revision": revision, "updatedAt": time.Now().UTC(),
	})
	state.mu.Unlock()
	if err != nil {
		return err
	}
	realtimeHub.Lock()
	clients := []*realtimeClient{}
	for _, other := range realtimeHub.clients {
		if other.id != c.id && other.authed && other.principal.TenantID == c.principal.TenantID {
			clients = append(clients, other)
		}
	}
	realtimeHub.Unlock()
	for _, other := range clients {
		other.mu.Lock()
		subscribed := other.syncSubs[sid]
		other.mu.Unlock()
		if subscribed {
			_ = other.emit("sync:update", map[string]any{"sessionId": sid, "update": update, "sv": base64.StdEncoding.EncodeToString(sv), "revision": revision, "from": c.id})
		}
	}
	return nil
}
