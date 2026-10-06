// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type StdioBridgeOptions struct {
	Command        string
	Args           []string
	Dir            string
	Env            []string
	Path           string
	RequestTimeout time.Duration
	MaxBodyBytes   int64
}

type bridgeReply struct {
	raw []byte
	err error
}

type StdioBridge struct {
	opts        StdioBridgeOptions
	mu          sync.Mutex
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	processDone chan error
	pending     map[string]chan bridgeReply
	sessions    map[string]chan []byte
	writeMu     sync.Mutex
	closed      atomic.Bool
	ready       atomic.Bool
	requestSeq  atomic.Uint64
	initMu      sync.Mutex
	initReply   []byte
	initialized bool
}

func NewStdioBridge(opts StdioBridgeOptions) (*StdioBridge, error) {
	if strings.TrimSpace(opts.Command) == "" {
		return nil, errors.New("stdio MCP command is required")
	}
	if opts.Path == "" {
		opts.Path = "/mcp"
	}
	if !strings.HasPrefix(opts.Path, "/") {
		return nil, errors.New("bridge path must start with /")
	}
	if opts.RequestTimeout <= 0 {
		opts.RequestTimeout = 2 * time.Minute
	}
	if opts.MaxBodyBytes <= 0 {
		opts.MaxBodyBytes = 4 << 20
	}
	return &StdioBridge{opts: opts, pending: map[string]chan bridgeReply{}, sessions: map[string]chan []byte{}}, nil
}

func (b *StdioBridge) Ready() bool { return b.ready.Load() }

func (b *StdioBridge) ensureStarted() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed.Load() {
		return errors.New("stdio bridge is closed")
	}
	if b.cmd != nil && b.cmd.Process != nil && b.ready.Load() {
		return nil
	}
	cmd := exec.Command(b.opts.Command, b.opts.Args...)
	cmd.Dir = b.opts.Dir
	if len(b.opts.Env) > 0 {
		cmd.Env = append(os.Environ(), b.opts.Env...)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		return err
	}
	b.cmd, b.stdin, b.processDone = cmd, stdin, make(chan error, 1)
	b.ready.Store(true)
	go b.readLoop(cmd, stdout)
	go b.waitLoop(cmd)
	return nil
}
func (b *StdioBridge) waitLoop(cmd *exec.Cmd) {
	err := cmd.Wait()
	b.mu.Lock()
	if b.cmd == cmd {
		b.cmd = nil
		b.stdin = nil
		b.ready.Store(false)
		b.initReply = nil
		b.initialized = false
		for id, ch := range b.pending {
			delete(b.pending, id)
			select {
			case ch <- bridgeReply{err: fmt.Errorf("stdio MCP exited: %w", err)}:
			default:
			}
		}
	}
	if b.processDone != nil {
		select {
		case b.processDone <- err:
		default:
		}
		close(b.processDone)
		b.processDone = nil
	}
	b.mu.Unlock()
}
func rpcID(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	return string(raw)
}
func (b *StdioBridge) readLoop(cmd *exec.Cmd, stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	for scanner.Scan() {
		raw := append([]byte(nil), scanner.Bytes()...)
		var frame struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.Unmarshal(raw, &frame)
		id := rpcID(frame.ID)
		if id != "" {
			b.mu.Lock()
			ch := b.pending[id]
			delete(b.pending, id)
			b.mu.Unlock()
			if ch != nil {
				ch <- bridgeReply{raw: raw}
				continue
			}
		}
		b.mu.Lock()
		for _, sub := range b.sessions {
			select {
			case sub <- raw:
			default:
			}
		}
		b.mu.Unlock()
	}
	if err := scanner.Err(); err != nil {
		b.waitLoopError(cmd, err)
	}
}
func (b *StdioBridge) waitLoopError(cmd *exec.Cmd, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cmd != cmd {
		return
	}
	for id, ch := range b.pending {
		delete(b.pending, id)
		select {
		case ch <- bridgeReply{err: err}:
		default:
		}
	}
}
func replaceRPCID(raw []byte, id any) ([]byte, error) {
	var frame map[string]any
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil, err
	}
	frame["id"] = id
	return json.Marshal(frame)
}

func (b *StdioBridge) call(ctx context.Context, sessionID string, raw []byte) ([]byte, error) {
	if err := b.ensureStarted(); err != nil {
		return nil, err
	}
	var frame struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
	}
	if json.Unmarshal(raw, &frame) != nil || frame.JSONRPC != "2.0" || frame.Method == "" {
		return nil, errors.New("invalid JSON-RPC request")
	}
	id := rpcID(frame.ID)
	originalID := append(json.RawMessage(nil), frame.ID...)
	var reply chan bridgeReply
	if id != "" {
		// The upstream stdio process is shared by all HTTP sessions. Rewrite every
		// request ID so clients are free to reuse ordinary IDs such as 1 without
		// colliding, then restore the downstream ID in the response.
		upstreamID := fmt.Sprintf("zakura:%s:%d", sessionID, b.requestSeq.Add(1))
		var doc map[string]any
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, errors.New("invalid JSON-RPC request")
		}
		doc["id"] = upstreamID
		raw, _ = json.Marshal(doc)
		idBytes, _ := json.Marshal(upstreamID)
		id = string(idBytes)
		reply = make(chan bridgeReply, 1)
		b.mu.Lock()
		if _, exists := b.pending[id]; exists {
			b.mu.Unlock()
			return nil, errors.New("duplicate JSON-RPC id")
		}
		b.pending[id] = reply
		b.mu.Unlock()
	}
	b.writeMu.Lock()
	b.mu.Lock()
	stdin := b.stdin
	b.mu.Unlock()
	if stdin == nil {
		b.writeMu.Unlock()
		return nil, errors.New("stdio MCP is unavailable")
	}
	_, err := stdin.Write(append(append([]byte(nil), raw...), '\n'))
	b.writeMu.Unlock()
	if err != nil {
		return nil, err
	}
	if id == "" {
		return nil, nil
	}
	timer := time.NewTimer(b.opts.RequestTimeout)
	defer timer.Stop()
	select {
	case result := <-reply:
		if result.err != nil {
			return nil, result.err
		}
		var original any
		_ = json.Unmarshal(originalID, &original)
		return replaceRPCID(result.raw, original)
	case <-ctx.Done():
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
		return nil, ctx.Err()
	case <-timer.C:
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
		return nil, errors.New("stdio MCP request timed out")
	}
}

func (b *StdioBridge) initialize(ctx context.Context, sessionID string, raw []byte) ([]byte, error) {
	b.initMu.Lock()
	defer b.initMu.Unlock()
	if len(b.initReply) == 0 {
		response, err := b.call(ctx, sessionID, raw)
		if err != nil {
			return nil, err
		}
		b.initReply = append([]byte(nil), response...)
		return response, nil
	}
	var request struct {
		ID any `json:"id"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, err
	}
	return replaceRPCID(b.initReply, request.ID)
}

func (b *StdioBridge) initializedNotification(ctx context.Context, sessionID string, raw []byte) error {
	b.initMu.Lock()
	defer b.initMu.Unlock()
	if b.initialized {
		return nil
	}
	if _, err := b.call(ctx, sessionID, raw); err != nil {
		return err
	}
	b.initialized = true
	return nil
}
func bridgeSessionID() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
func (b *StdioBridge) cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Last-Event-Id, Mcp-Protocol-Version, Accept")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
}
func (b *StdioBridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Path == "/" || r.URL.Path == "/health" {
		writeBridgeJSON(w, http.StatusOK, map[string]any{"ok": true, "ready": b.Ready(), "command": b.opts.Command})
		return
	}
	if r.URL.Path != b.opts.Path {
		http.NotFound(w, r)
		return
	}
	sid := strings.TrimSpace(r.Header.Get("Mcp-Session-Id"))
	switch r.Method {
	case http.MethodPost:
		b.post(w, r, sid)
	case http.MethodGet:
		b.stream(w, r, sid)
	case http.MethodDelete:
		b.delete(w, sid)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
func (b *StdioBridge) post(w http.ResponseWriter, r *http.Request, sid string) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, b.opts.MaxBodyBytes))
	if err != nil {
		writeBridgeError(w, http.StatusRequestEntityTooLarge, nil, -32600, "request body too large")
		return
	}
	var frame struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if json.Unmarshal(raw, &frame) != nil {
		writeBridgeError(w, http.StatusBadRequest, nil, -32700, "Parse error")
		return
	}
	if sid == "" && frame.Method != "initialize" {
		writeBridgeError(w, http.StatusBadRequest, frame.ID, -32000, "Invalid or missing session ID")
		return
	}
	if sid != "" {
		b.mu.Lock()
		_, ok := b.sessions[sid]
		b.mu.Unlock()
		if !ok {
			writeBridgeError(w, http.StatusBadRequest, frame.ID, -32000, "Invalid or missing session ID")
			return
		}
	} else {
		sid, err = bridgeSessionID()
		if err != nil {
			writeBridgeError(w, http.StatusInternalServerError, frame.ID, -32603, err.Error())
			return
		}
		b.mu.Lock()
		b.sessions[sid] = make(chan []byte, 64)
		b.mu.Unlock()
		w.Header().Set("Mcp-Session-Id", sid)
	}
	var response []byte
	if frame.Method == "initialize" {
		response, err = b.initialize(r.Context(), sid, raw)
	} else if frame.Method == "notifications/initialized" {
		err = b.initializedNotification(r.Context(), sid, raw)
	} else {
		response, err = b.call(r.Context(), sid, raw)
	}
	if err != nil {
		if frame.Method == "initialize" {
			b.mu.Lock()
			delete(b.sessions, sid)
			b.mu.Unlock()
		}
		writeBridgeError(w, http.StatusInternalServerError, frame.ID, -32603, err.Error())
		return
	}
	if len(response) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(response)
}
func (b *StdioBridge) stream(w http.ResponseWriter, r *http.Request, sid string) {
	b.mu.Lock()
	sub := b.sessions[sid]
	b.mu.Unlock()
	if sid == "" || sub == nil {
		http.Error(w, "Invalid or missing session ID", http.StatusBadRequest)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	for {
		select {
		case raw := <-sub:
			_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", raw)
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
func (b *StdioBridge) delete(w http.ResponseWriter, sid string) {
	b.mu.Lock()
	_, ok := b.sessions[sid]
	delete(b.sessions, sid)
	b.mu.Unlock()
	if sid == "" || !ok {
		http.Error(w, "Invalid or missing session ID", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func writeBridgeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeBridgeError(w http.ResponseWriter, status int, id json.RawMessage, code int, message string) {
	var parsed any
	if len(id) > 0 {
		_ = json.Unmarshal(id, &parsed)
	}
	writeBridgeJSON(w, status, map[string]any{"jsonrpc": "2.0", "error": map[string]any{"code": code, "message": message}, "id": parsed})
}
func (b *StdioBridge) Close(ctx context.Context) error {
	if !b.closed.CompareAndSwap(false, true) {
		return nil
	}
	b.mu.Lock()
	cmd := b.cmd
	stdin := b.stdin
	done := b.processDone
	b.cmd = nil
	b.stdin = nil
	b.ready.Store(false)
	for id, ch := range b.pending {
		delete(b.pending, id)
		ch <- bridgeReply{err: errors.New("stdio bridge closed")}
	}
	b.sessions = map[string]chan []byte{}
	b.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	_ = cmd.Process.Signal(os.Interrupt)
	if done == nil {
		_ = cmd.Process.Kill()
		return nil
	}
	select {
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		return ctx.Err()
	case err := <-done:
		return err
	}
}
