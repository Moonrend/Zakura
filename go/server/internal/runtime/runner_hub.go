// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"gorm.io/gorm"
)

// runnerHub is the native Go control plane for the existing zakura-agent. Agents
// dial this endpoint, so nodes behind NAT never need to expose an inbound port.
type runnerHub struct {
	deps     *appdeps.Dependencies
	mu       sync.RWMutex
	sessions map[string]*runnerSession
	seq      atomic.Uint64
}

type runnerFrame struct {
	Type   string          `json:"type"`
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	OK     *bool           `json:"ok,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
	Stream string          `json:"stream,omitempty"`
	Chan   string          `json:"chan,omitempty"`
	Data   string          `json:"data,omitempty"`
}

type runnerReply struct {
	result json.RawMessage
	err    error
}

type runnerSession struct {
	hub      *runnerHub
	nodeID   string
	conn     net.Conn
	rw       *bufio.ReadWriter
	writeMu  sync.Mutex
	mu       sync.Mutex
	pending  map[string]chan runnerReply
	streams  map[string]func(string, []byte)
	done     chan struct{}
	closeOne sync.Once
	ready    atomic.Bool
	lastSeen atomic.Int64
}

func newRunnerHub(deps *appdeps.Dependencies) *runnerHub {
	return &runnerHub{deps: deps, sessions: map[string]*runnerSession{}}
}

func (h *handler) runnerHubHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		httpx.Error(w, http.StatusUpgradeRequired, "websocket upgrade required")
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	if !strings.HasPrefix(token, "rnr_") || len(token) > 4096 {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	sum := sha256.Sum256([]byte(token))
	var nodeID string
	var node struct {
		ID string `gorm:"column:id"`
	}
	err := h.deps.Gorm.WithContext(r.Context()).Table("runtime_nodes").Select("id").Where("token_hash=?", hex.EncodeToString(sum[:])).Take(&node).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err != nil {
		statusErr(w, err)
		return
	}
	nodeID = node.ID
	runnerTokenCache.Store(nodeID, token)
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
	sumAccept := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sumAccept[:])
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return
	}
	s := &runnerSession{hub: h.hub, nodeID: nodeID, conn: conn, rw: rw, pending: map[string]chan runnerReply{}, streams: map[string]func(string, []byte){}, done: make(chan struct{})}
	s.lastSeen.Store(time.Now().UnixMilli())
	h.hub.install(s)
	defer func() {
		s.close(errors.New("runner disconnected"))
		h.hub.remove(s)
		_ = h.deps.Gorm.WithContext(h.deps.RunContext()).Exec(`UPDATE runtime_nodes SET status=CASE WHEN status='draining' THEN status ELSE 'offline' END,updated_at=? WHERE id=?`, h.store.now(), nodeID).Error
	}()
	go s.readLoop()
	if err := s.writeJSON(runnerFrame{Type: "welcome", ID: nodeID}); err != nil {
		return
	}
	var info struct {
		Version      string          `json:"version"`
		StorageRoot  string          `json:"storageRoot"`
		Kind         string          `json:"kind"`
		HostInfo     json.RawMessage `json:"hostInfo"`
		Capabilities json.RawMessage `json:"capabilities"`
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	err = s.call(ctx, "sys.info", map[string]any{}, &info)
	cancel()
	if err != nil {
		return
	}
	now := h.store.now()
	err = h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE runtime_nodes SET status=CASE WHEN status='draining' THEN status ELSE 'online' END,kind=CASE WHEN kind='runner' AND ? IN ('computer','server') THEN ? ELSE kind END,endpoint=NULL,host_info_json=?,capabilities_json=?,agent_version=?,storage_root=?,last_seen_at=?,updated_at=? WHERE id=?`, info.Kind, info.Kind, validJSON(info.HostInfo, "{}"), validJSON(info.Capabilities, `{"host":true}`), nullString(info.Version), nullString(info.StorageRoot), now, now, nodeID).Error
	if err != nil {
		return
	}
	s.ready.Store(true)
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			if time.Since(time.UnixMilli(s.lastSeen.Load())) > 60*time.Second {
				return
			}
			if err := s.writeJSON(runnerFrame{Type: "ping", ID: "beat"}); err != nil {
				return
			}
		}
	}
}

func (h *runnerHub) install(session *runnerSession) {
	h.mu.Lock()
	previous := h.sessions[session.nodeID]
	h.sessions[session.nodeID] = session
	h.mu.Unlock()
	if previous != nil {
		previous.close(errors.New("runner connection replaced"))
	}
}

func (h *runnerHub) remove(session *runnerSession) {
	h.mu.Lock()
	if h.sessions[session.nodeID] == session {
		delete(h.sessions, session.nodeID)
	}
	h.mu.Unlock()
}

func (h *runnerHub) get(nodeID string) (*runnerSession, error) {
	h.mu.RLock()
	s := h.sessions[nodeID]
	h.mu.RUnlock()
	if s == nil || !s.ready.Load() || time.Since(time.UnixMilli(s.lastSeen.Load())) > 60*time.Second {
		return nil, errors.New("runtime node agent is offline")
	}
	return s, nil
}

func (s *runnerSession) close(reason error) {
	s.closeOne.Do(func() {
		s.ready.Store(false)
		close(s.done)
		_ = s.conn.Close()
		s.mu.Lock()
		for id, pending := range s.pending {
			delete(s.pending, id)
			select {
			case pending <- runnerReply{err: reason}:
			default:
			}
		}
		s.streams = map[string]func(string, []byte){}
		s.mu.Unlock()
	})
}

func (s *runnerSession) writeJSON(frame runnerFrame) error {
	raw, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return writeWSFrame(s.rw.Writer, 0x1, raw)
}

func (s *runnerSession) readLoop() {
	defer s.close(errors.New("runner connection closed"))
	for {
		opcode, payload, err := readWSFrameSized(s.rw.Reader, 16<<20)
		if err != nil {
			return
		}
		if opcode == 0x8 {
			return
		}
		if opcode == 0x9 {
			s.writeMu.Lock()
			_ = writeWSFrame(s.rw.Writer, 0xA, payload)
			s.writeMu.Unlock()
			continue
		}
		if opcode != 0x1 && opcode != 0x2 {
			continue
		}
		var frame runnerFrame
		if json.Unmarshal(payload, &frame) != nil {
			continue
		}
		s.lastSeen.Store(time.Now().UnixMilli())
		switch frame.Type {
		case "pong", "hello":
			continue
		case "res":
			s.mu.Lock()
			pending := s.pending[frame.ID]
			delete(s.pending, frame.ID)
			s.mu.Unlock()
			if pending != nil {
				if frame.OK != nil && !*frame.OK {
					pending <- runnerReply{err: errors.New(frame.Error)}
				} else {
					pending <- runnerReply{result: frame.Result}
				}
			}
		case "stream":
			data, err := base64.StdEncoding.DecodeString(frame.Data)
			if err != nil {
				continue
			}
			s.mu.Lock()
			listener := s.streams[frame.Stream]
			s.mu.Unlock()
			if listener != nil {
				listener(frame.Chan, data)
			}
		}
	}
}

func (s *runnerSession) call(ctx context.Context, method string, params any, out any) error {
	id := fmt.Sprintf("%d", s.hub.seq.Add(1))
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	pending := make(chan runnerReply, 1)
	s.mu.Lock()
	select {
	case <-s.done:
		s.mu.Unlock()
		return errors.New("runtime node agent is offline")
	default:
	}
	s.pending[id] = pending
	s.mu.Unlock()
	if err := s.writeJSON(runnerFrame{Type: "req", ID: id, Method: method, Params: raw}); err != nil {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return err
	}
	select {
	case reply := <-pending:
		if reply.err != nil {
			return reply.err
		}
		if out == nil || len(reply.result) == 0 || string(reply.result) == "null" {
			return nil
		}
		return json.Unmarshal(reply.result, out)
	case <-ctx.Done():
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return ctx.Err()
	case <-s.done:
		return errors.New("runtime node agent is offline")
	}
}

func (s *runnerSession) onStream(id string, callback func(string, []byte)) func() {
	s.mu.Lock()
	s.streams[id] = callback
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.streams, id)
		s.mu.Unlock()
	}
}

func readWSFrameSized(r *bufio.Reader, limit uint64) (byte, []byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil, err
	}
	opcode := head[0] & 0x0f
	masked := head[1]&0x80 != 0
	if !masked {
		return 0, nil, errors.New("client websocket frames must be masked")
	}
	n := uint64(head[1] & 0x7f)
	if n == 126 {
		var value [2]byte
		if _, err := io.ReadFull(r, value[:]); err != nil {
			return 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(value[:]))
	} else if n == 127 {
		var value [8]byte
		if _, err := io.ReadFull(r, value[:]); err != nil {
			return 0, nil, err
		}
		n = binary.BigEndian.Uint64(value[:])
	}
	if n > limit {
		return 0, nil, errors.New("websocket frame too large")
	}
	var mask [4]byte
	if _, err := io.ReadFull(r, mask[:]); err != nil {
		return 0, nil, err
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return opcode, payload, nil
}
