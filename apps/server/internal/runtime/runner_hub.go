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
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/executor"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
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

// Stream delivery is serialized per stream, but never runs on the runner read
// loop: consumers may issue runner RPCs while handling an event. Keep startup
// output until onStream subscribes (start replies and output can race).
const runnerStreamMaxBytes = 1 << 20
const runnerStreamMaxPendingBytes = 8 << 20
const runnerStreamMaxPending = 128

type runnerStreamEvent struct {
	channel string
	data    []byte
}

type runnerStream struct {
	callback func(string, []byte)
	events   []runnerStreamEvent
	bytes    int
	draining bool
}

type runnerSession struct {
	hub          *runnerHub
	nodeID       string
	conn         net.Conn
	local        *executor.Executor
	rw           *bufio.ReadWriter
	writeGate    chan struct{}
	mu           sync.Mutex
	pending      map[string]chan runnerReply
	streamQueues map[string]*runnerStream
	streamBytes  int
	done         chan struct{}
	closeOne     sync.Once
	ready        atomic.Bool
	lastSeen     atomic.Int64
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
	err := h.deps.Gorm.WithContext(r.Context()).Table("runtime_nodes").Select("id").Where("token_hash=? AND kind<>'local'", hex.EncodeToString(sum[:])).Take(&node).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err != nil {
		statusErr(w, err)
		return
	}
	nodeID = node.ID
	installationIncarnation, err := h.cacheRuntimeNodeToken(r.Context(), nodeID, token)
	if err != nil {
		httpx.Error(w, http.StatusForbidden, "node enrollment is unavailable")
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
	sumAccept := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sumAccept[:])
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return
	}
	s := &runnerSession{writeGate: make(chan struct{}, 1), hub: h.hub, nodeID: nodeID, conn: conn, rw: rw, pending: map[string]chan runnerReply{}, streamQueues: map[string]*runnerStream{}, done: make(chan struct{})}
	s.lastSeen.Store(time.Now().UnixMilli())
	h.hub.install(s)
	stopShutdown := context.AfterFunc(h.deps.RunContext(), func() { s.close(errors.New("server stopped")) })
	defer stopShutdown()
	defer func() {
		s.close(errors.New("runner disconnected"))
		h.hub.remove(s)
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
	if err == nil && installationIncarnation != "" {
		var identity struct {
			Version     int    `json:"version"`
			Incarnation string `json:"incarnation"`
		}
		err = s.call(ctx, "workspace.identity", map[string]any{}, &identity)
		if err == nil && (identity.Version != 1 || identity.Incarnation != installationIncarnation || info.Kind != "server") {
			err = errInstallationRevoked
		}
	}
	if err == nil {
		err = h.syncWorkspaceRevocations(ctx, s)
	}
	cancel()
	if err != nil {
		return
	}
	now := h.store.now()
	h.hub.mu.Lock()
	if h.hub.sessions[nodeID] != s {
		h.hub.mu.Unlock()
		return
	}
	result := h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE runtime_nodes SET status=CASE WHEN status='draining' THEN status ELSE 'online' END,kind=CASE WHEN kind='runner' AND ? IN ('computer','server') THEN ? ELSE kind END,endpoint=NULL,host_info_json=?,capabilities_json=?,agent_version=?,storage_root=?,last_seen_at=?,updated_at=? WHERE id=? AND kind<>'local' AND token_hash=?`, info.Kind, info.Kind, validJSON(info.HostInfo, "{}"), validJSON(info.Capabilities, `{"host":true}`), nullString(info.Version), nullString(info.StorageRoot), runtimeTimeString(now), runtimeTimeString(now), nodeID, hex.EncodeToString(sum[:]))
	err = result.Error
	if err == nil && result.RowsAffected != 1 {
		err = errInstallationRevoked
	}
	if err == nil {
		s.ready.Store(true)
	}
	h.hub.mu.Unlock()
	if err != nil {
		return
	}
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			if err := h.hub.persistHeartbeat(s); err != nil {
				return
			}
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
	defer h.mu.Unlock()
	if h.sessions[session.nodeID] != session {
		return
	}
	delete(h.sessions, session.nodeID)
	// Serialize ownership changes and their persistent writes. An older socket
	// must never mark its replacement offline, including during handshake.
	if h.deps != nil && h.deps.Gorm != nil {
		_ = h.deps.Gorm.WithContext(h.deps.RunContext()).Exec(`UPDATE runtime_nodes SET status=CASE WHEN status='draining' THEN status ELSE 'offline' END,updated_at=? WHERE id=?`, runtimeTimeString(time.Now().UTC()), session.nodeID).Error
	}
}

func (h *runnerHub) persistHeartbeat(s *runnerSession) error {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.sessions[s.nodeID] != s {
		return errors.New("runner connection replaced")
	}
	if h.deps == nil || h.deps.Gorm == nil {
		return nil
	}
	seen := runtimeTimeString(time.UnixMilli(s.lastSeen.Load()).UTC())
	result := h.deps.Gorm.WithContext(h.deps.RunContext()).Exec(`UPDATE runtime_nodes SET last_seen_at=?,updated_at=? WHERE id=?`, seen, seen, s.nodeID)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errInstallationRevoked
	}
	return nil
}

func (h *runnerHub) get(nodeID string) (*runnerSession, error) {
	h.mu.RLock()
	s := h.sessions[nodeID]
	h.mu.RUnlock()
	if s == nil {
		var err error
		s, err = h.mountLocal(nodeID)
		if err != nil {
			return nil, err
		}
	}
	if !s.ready.Load() || (s.local == nil && time.Since(time.UnixMilli(s.lastSeen.Load())) > 60*time.Second) {
		return nil, errors.New("runtime node agent is offline")
	}
	return s, nil
}

// Only legacy, tokenless embedded rows are trusted host executors. No remote
// offline row, operator-entered path or new arbitrary kind becomes local.
func (h *runnerHub) mountLocal(nodeID string) (*runnerSession, error) {
	if h.deps == nil || h.deps.Gorm == nil {
		return nil, errors.New("runtime node agent is offline")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if s := h.sessions[nodeID]; s != nil {
		return s, nil
	}
	var node struct {
		StorageRoot string `gorm:"column:storage_root"`
	}
	err := h.deps.Gorm.WithContext(h.deps.RunContext()).Table("runtime_nodes").Select("storage_root").Where("id=? AND kind='local' AND agent_version='embedded' AND (token_hash IS NULL OR token_hash='')", nodeID).Take(&node).Error
	if err != nil {
		return nil, errors.New("runtime node agent is offline")
	}
	root := strings.TrimSpace(node.StorageRoot)
	if root == "" {
		return nil, errors.New("local runtime node storage root is unavailable: no storage root configured")
	}
	// Resolve legacy relative paths on this host, never foreign absolute paths
	// or drive-relative paths which would silently select a different directory.
	if !filepath.IsAbs(root) && (!filepath.IsLocal(root) || strings.Contains(root, ":") || (filepath.Separator == '/' && strings.Contains(root, `\`))) {
		return nil, fmt.Errorf("local runtime node storage root is unavailable: invalid local path %q", root)
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("local runtime node storage root is unavailable: %w", err)
	}
	if err = os.MkdirAll(root, 0750); err != nil {
		return nil, fmt.Errorf("local runtime node storage root is unavailable: %q: %w", root, err)
	}
	if root != node.StorageRoot {
		result := h.deps.Gorm.WithContext(h.deps.RunContext()).Table("runtime_nodes").Where("id=? AND kind='local' AND agent_version='embedded' AND (token_hash IS NULL OR token_hash='') AND storage_root=?", nodeID, node.StorageRoot).Update("storage_root", root)
		if result.Error != nil {
			return nil, result.Error
		}
		if result.RowsAffected != 1 {
			return nil, errors.New("local runtime node storage root changed; retry shortly")
		}
	}
	s := &runnerSession{hub: h, nodeID: nodeID, local: executor.New("local", root), pending: map[string]chan runnerReply{}, streamQueues: map[string]*runnerStream{}, done: make(chan struct{})}
	s.lastSeen.Store(time.Now().UnixMilli())
	s.ready.Store(true)
	h.sessions[nodeID] = s
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		defer func() { s.close(errors.New("local runtime stopped")); h.remove(s) }()
		for {
			select {
			case <-h.deps.RunContext().Done():
				return
			case <-s.done:
				return
			case <-ticker.C:
				s.lastSeen.Store(time.Now().UnixMilli())
				_ = h.persistHeartbeat(s)
			}
		}
	}()
	return s, nil
}

func (s *runnerSession) close(reason error) {
	s.closeOne.Do(func() {
		s.ready.Store(false)
		close(s.done)
		if s.conn != nil {
			_ = s.conn.Close()
		}
		if s.local != nil {
			go s.local.Close()
		}
		s.mu.Lock()
		for id, pending := range s.pending {
			delete(s.pending, id)
			select {
			case pending <- runnerReply{err: reason}:
			default:
			}
		}
		listeners := []func(string, []byte){}
		for _, stream := range s.streamQueues {
			if stream.callback != nil {
				listeners = append(listeners, stream.callback)
			}
		}
		s.streamQueues = map[string]*runnerStream{}
		s.streamBytes = 0
		s.mu.Unlock()
		for _, listener := range listeners {
			go listener("error", []byte(reason.Error()))
		}
	})
}

func (s *runnerSession) writeJSON(frame runnerFrame) error {
	return s.writeJSONContext(context.Background(), frame)
}

func (s *runnerSession) writeJSONContext(ctx context.Context, frame runnerFrame) error {
	raw, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return s.writeFrameContext(ctx, 0x1, raw)
}

// Bound both waiting for the writer and the socket write itself. An RPC budget
// cannot be enforced by selecting ctx.Done only after an unbounded write.
func (s *runnerSession) writeFrameContext(ctx context.Context, opcode byte, raw []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	select {
	case s.writeGate <- struct{}{}:
		defer func() { <-s.writeGate }()
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return errors.New("runtime node agent is offline")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	deadline, _ := ctx.Deadline()
	if err := s.conn.SetWriteDeadline(deadline); err != nil {
		return err
	}
	interrupted := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { _ = s.conn.SetWriteDeadline(time.Now()); close(interrupted) })
	defer func() {
		if !stop() {
			<-interrupted
		}
		_ = s.conn.SetWriteDeadline(time.Time{})
	}()
	err := writeWSFrame(s.rw.Writer, opcode, raw)
	if err != nil {
		// A partially written frame cannot safely be reused by another RPC.
		s.close(err)
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	return err
}

func (s *runnerSession) readLoop() {
	defer s.close(errors.New("runner connection closed"))
	var fragmented []byte
	var fragmentOpcode byte
	for {
		final, opcode, payload, err := readWSFrameParts(s.rw.Reader, 16<<20)
		if err != nil {
			return
		}
		if opcode == 0x8 {
			return
		}
		if opcode == 0x9 {
			if err := s.writeFrameContext(context.Background(), 0xA, payload); err != nil {
				return
			}
			continue
		}
		if opcode == 0xA {
			continue
		}
		switch opcode {
		case 0x1, 0x2:
			if fragmentOpcode != 0 {
				return
			}
			if !final {
				fragmentOpcode = opcode
				fragmented = payload
				continue
			}
		case 0x0:
			if fragmentOpcode == 0 || len(fragmented)+len(payload) > 16<<20 {
				return
			}
			fragmented = append(fragmented, payload...)
			if !final {
				continue
			}
			payload = fragmented
			fragmented = nil
			fragmentOpcode = 0
		default:
			return
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
			s.queueStream(frame.Stream, frame.Chan, data)
		}
	}
}

func (s *runnerSession) call(ctx context.Context, method string, params any, out any) error {
	if s.local != nil && method == "sys.update" {
		return errors.New("embedded local Agent is updated with the server")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
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
	if s.local != nil {
		go s.local.Dispatch(ctx, executor.Message{Type: "req", ID: id, Method: method, Params: raw}, func(msg executor.Message) {
			if msg.Type == "stream" {
				if data, err := base64.StdEncoding.DecodeString(msg.Data); err == nil {
					s.queueStream(msg.Stream, msg.Chan, data)
				}
				return
			}
			if msg.Type == "res" {
				s.mu.Lock()
				ch := s.pending[msg.ID]
				delete(s.pending, msg.ID)
				s.mu.Unlock()
				if ch != nil {
					if msg.OK != nil && !*msg.OK {
						ch <- runnerReply{err: errors.New(msg.Error)}
					} else {
						ch <- runnerReply{result: msg.Result}
					}
				}
			}
		})
	} else if err := s.writeJSONContext(ctx, runnerFrame{Type: "req", ID: id, Method: method, Params: raw}); err != nil {
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
		if s.local != nil {
			s.local.Cancel(id)
		} else {
			go func() {
				budget, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				_ = s.writeJSONContext(budget, runnerFrame{Type: "cancel", ID: id})
			}()
		}
		return ctx.Err()
	case <-s.done:
		return errors.New("runtime node agent is offline")
	}
}

func (s *runnerSession) queueStream(id, channel string, data []byte) {
	s.mu.Lock()
	select {
	case <-s.done:
		s.mu.Unlock()
		return
	default:
	}
	if s.streamQueues == nil {
		s.streamQueues = map[string]*runnerStream{}
	}
	q := s.streamQueues[id]
	if q == nil {
		if len(s.streamQueues) >= runnerStreamMaxPending {
			s.mu.Unlock()
			s.close(errors.New("runner stream backlog exhausted"))
			return
		}
		q = &runnerStream{}
		s.streamQueues[id] = q
	}
	// Overflow is a transport failure, never silent truncation of ACP JSON or
	// loss of a short-lived process's exit. Include event overhead in the bound.
	size := len(data) + 32
	if q.bytes+size > runnerStreamMaxBytes || s.streamBytes+size > runnerStreamMaxPendingBytes {
		s.mu.Unlock()
		s.close(errors.New("runner stream backlog exhausted"))
		return
	}
	q.events = append(q.events, runnerStreamEvent{channel, append([]byte(nil), data...)})
	q.bytes += size
	s.streamBytes += size
	s.startStreamLocked(id, q)
	s.mu.Unlock()
}

func (s *runnerSession) startStreamLocked(id string, q *runnerStream) {
	if q.callback != nil && !q.draining && len(q.events) > 0 {
		q.draining = true
		go s.drainStream(id, q)
	}
}

func (s *runnerSession) drainStream(id string, q *runnerStream) {
	for {
		s.mu.Lock()
		if s.streamQueues[id] != q || q.callback == nil || len(q.events) == 0 {
			q.draining = false
			s.mu.Unlock()
			return
		}
		event, callback := q.events[0], q.callback
		q.events[0] = runnerStreamEvent{}
		q.events = q.events[1:]
		size := len(event.data) + 32
		q.bytes -= size
		s.streamBytes -= size
		s.mu.Unlock()
		callback(event.channel, event.data)
	}
}

func (s *runnerSession) onStream(id string, callback func(string, []byte)) func() {
	s.mu.Lock()
	select {
	case <-s.done:
		s.mu.Unlock()
		go callback("error", []byte("runtime node agent is offline"))
		return func() {}
	default:
	}
	if s.streamQueues == nil {
		s.streamQueues = map[string]*runnerStream{}
	}
	q := s.streamQueues[id]
	if q == nil {
		q = &runnerStream{}
		s.streamQueues[id] = q
	}
	q.callback = callback
	s.startStreamLocked(id, q)
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		if s.streamQueues[id] == q {
			s.streamBytes -= q.bytes
			delete(s.streamQueues, id)
		}
		s.mu.Unlock()
	}
}

func readWSFrameSized(r *bufio.Reader, limit uint64) (byte, []byte, error) {
	_, opcode, payload, err := readWSFrameParts(r, limit)
	return opcode, payload, err
}

func readWSFrameParts(r *bufio.Reader, limit uint64) (bool, byte, []byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return false, 0, nil, err
	}
	opcode := head[0] & 0x0f
	if head[0]&0x70 != 0 {
		return false, 0, nil, errors.New("unsupported websocket extensions")
	}
	if opcode >= 0x8 && (head[0]&0x80 == 0 || head[1]&0x7f > 125) {
		return false, 0, nil, errors.New("invalid websocket control frame")
	}
	masked := head[1]&0x80 != 0
	if !masked {
		return false, 0, nil, errors.New("client websocket frames must be masked")
	}
	n := uint64(head[1] & 0x7f)
	if n == 126 {
		var value [2]byte
		if _, err := io.ReadFull(r, value[:]); err != nil {
			return false, 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(value[:]))
	} else if n == 127 {
		var value [8]byte
		if _, err := io.ReadFull(r, value[:]); err != nil {
			return false, 0, nil, err
		}
		n = binary.BigEndian.Uint64(value[:])
	}
	if n > limit {
		return false, 0, nil, errors.New("websocket frame too large")
	}
	var mask [4]byte
	if _, err := io.ReadFull(r, mask[:]); err != nil {
		return false, 0, nil, err
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return false, 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return head[0]&0x80 != 0, opcode, payload, nil
}
