// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/ssh"
)

type computerPTYRunnerState struct {
	mu         sync.Mutex
	process    string
	started    int
	execID     string
	startCmd   []string
	resizes    int
	resizeCols int
	resizeRows int
	closes     int
	writes     []string
}

func (s *computerPTYRunnerState) snapshot() (started int, execID string, resizes, resizeCols, resizeRows, closes int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started, s.execID, s.resizes, s.resizeCols, s.resizeRows, s.closes
}

// startComputerPTYRunner speaks the runner wire protocol for the docker exec
// stream the computer PTY uses, echoing each written payload back as stdout.
func startComputerPTYRunner(t *testing.T, serverURL, token string, state *computerPTYRunnerState) {
	t.Helper()
	go func() {
		u, _ := url.Parse(serverURL)
		conn, err := net.Dial("tcp", u.Host)
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = fmt.Fprintf(conn, "GET /api/runtime-nodes/hub HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", u.Host, token)
		reader := bufio.NewReader(conn)
		_, _ = reader.ReadString('\n')
		for {
			line, _ := reader.ReadString('\n')
			if line == "\r\n" {
				break
			}
		}
		for {
			raw, err := readRunnerServerText(reader)
			if err != nil {
				return
			}
			var frame struct {
				Type   string         `json:"type"`
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.Unmarshal([]byte(raw), &frame) != nil || frame.Type != "req" {
				continue
			}
			var result any = map[string]any{"ok": true}
			var after func()
			switch frame.Method {
			case "sys.info":
				result = map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{}}
			case "docker.exec.start":
				state.mu.Lock()
				state.started++
				state.execID = fmt.Sprint(frame.Params["id"])
				if cmd, ok := frame.Params["command"].([]any); ok {
					state.startCmd = nil
					for _, part := range cmd {
						state.startCmd = append(state.startCmd, fmt.Sprint(part))
					}
				}
				process := state.process
				state.mu.Unlock()
				result = map[string]any{"id": process, "mode": "pipe"}
			case "docker.exec.write":
				payload, _ := base64.StdEncoding.DecodeString(fmt.Sprint(frame.Params["base64"]))
				state.mu.Lock()
				state.writes = append(state.writes, string(payload))
				process := state.process
				state.mu.Unlock()
				after = func() {
					frameBytes, _ := json.Marshal(map[string]any{"type": "stream", "stream": process, "chan": "stdout", "data": base64.StdEncoding.EncodeToString(payload)})
					writeMaskedText(t, conn, string(frameBytes))
				}
			case "host.pty.resize":
				state.mu.Lock()
				state.resizes++
				state.resizeCols = int(frame.Params["cols"].(float64))
				state.resizeRows = int(frame.Params["rows"].(float64))
				state.mu.Unlock()
			case "docker.exec.close":
				state.mu.Lock()
				state.closes++
				state.mu.Unlock()
			}
			response, _ := json.Marshal(map[string]any{"type": "res", "id": frame.ID, "ok": true, "result": result})
			writeMaskedText(t, conn, string(response))
			if after != nil {
				after()
			}
		}
	}()
}

func newComputerPTYRunnerHarness(t *testing.T, d *appdeps.Dependencies, runnerToken string, state *computerPTYRunnerState) *handler {
	t.Helper()
	now := d.Clock()
	hash := sha256.Sum256([]byte(runnerToken))
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now); err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: NewStore(d), mcpSessions: map[string]spaceMCPSession{}}
	h.hub = newRunnerHub(d)
	h.service = NewService(h.store)
	router := chi.NewRouter()
	router.Handle("/api/runtime-nodes/hub", http.HandlerFunc(h.runnerHubHTTP))
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	startComputerPTYRunner(t, server.URL, runnerToken, state)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := h.hub.get("node"); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := h.hub.get("node"); err != nil {
		t.Fatalf("runner did not come online: %v", err)
	}
	return h
}

func TestComputerPTYServerRunnerEcho(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	state := &computerPTYRunnerState{process: "pty-1"}
	h := newComputerPTYRunnerHarness(t, d, "rnr_pty_server", state)
	exec := &resolvedExecution{
		spaceID:     "space",
		nodeID:      "node",
		containerID: "computer-ctr",
		computer:    computers.Computer{ID: "c", TenantID: "tenant", SpaceID: "space", Provider: computers.Server, Capabilities: []computers.Capability{computers.PTY}},
		runtime:     computers.Runtime{ID: "rt", ComputerID: "c", TenantID: "tenant", SpaceID: "space", ExternalID: "computer-ctr", State: computers.Ready},
	}
	echoed := make(chan string, 4)
	stream, err := h.startComputerPTY(context.Background(), exec, 100, 40, func(channel string, data []byte) {
		if channel == "stdout" {
			echoed <- string(data)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-echoed:
		if got != "hello" {
			t.Fatalf("echo = %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no stdout echo")
	}
	if err := stream.resize(90, 25); err != nil {
		t.Fatal(err)
	}
	stream.close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, _, _, _, _, closes := state.snapshot()
		if closes == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	started, execID, resizes, cols, rows, closes := state.snapshot()
	if started != 1 || execID != "computer-ctr" {
		t.Fatalf("docker.exec.start: started=%d execID=%q", started, execID)
	}
	if strings.Join(state.startCmd, " ") != "bash -l" {
		t.Fatalf("start command = %v", state.startCmd)
	}
	if resizes != 1 || cols != 90 || rows != 25 {
		t.Fatalf("resize: n=%d cols=%d rows=%d", resizes, cols, rows)
	}
	if closes != 1 {
		t.Fatalf("close not routed: %d", closes)
	}
}

type sshPTYRecord struct {
	mu      sync.Mutex
	ptyCols int
	ptyRows int
	winCols int
	winRows int
	shells  int
}

func (r *sshPTYRecord) snapshot() (ptyCols, ptyRows, winCols, winRows, shells int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ptyCols, r.ptyRows, r.winCols, r.winRows, r.shells
}

// serveFakeSSHPTY accepts a session, records the requested PTY size, answers the
// shell request and echoes channel data back to the client.
func serveFakeSSHPTY(conn net.Conn, cfg *ssh.ServerConfig, record *sshPTYRecord) {
	server, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer server.Close()
	go ssh.DiscardRequests(reqs)
	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			_ = newCh.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			continue
		}
		go func() {
			defer ch.Close()
			for req := range chReqs {
				switch req.Type {
				case "pty-req":
					var p struct {
						Term          string
						Columns, Rows uint32
						Width, Height uint32
						Modes         string
					}
					_ = ssh.Unmarshal(req.Payload, &p)
					record.mu.Lock()
					record.ptyCols, record.ptyRows = int(p.Columns), int(p.Rows)
					record.mu.Unlock()
					_ = req.Reply(true, nil)
				case "shell":
					record.mu.Lock()
					record.shells++
					record.mu.Unlock()
					_ = req.Reply(true, nil)
					go func() { _, _ = io.Copy(ch, ch) }()
				case "window-change":
					var p struct{ Columns, Rows, Width, Height uint32 }
					_ = ssh.Unmarshal(req.Payload, &p)
					record.mu.Lock()
					record.winCols, record.winRows = int(p.Columns), int(p.Rows)
					record.mu.Unlock()
				default:
					_ = req.Reply(false, nil)
				}
			}
		}()
	}
}

func startFakeSSHPTY(t *testing.T, signer ssh.Signer) (host, port string, record *sshPTYRecord) {
	t.Helper()
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
			return &ssh.Permissions{}, nil
		},
	}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	record = &sshPTYRecord{}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveFakeSSHPTY(conn, cfg, record)
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", fmt.Sprint(addr.Port), record
}

func TestComputerPTYSSHEcho(t *testing.T) {
	signer, key, fingerprint := sshTestHostIdentity(t)
	host, port, record := startFakeSSHPTY(t, signer)
	env := sshExecHarness(t, computers.SSH, sshCredsJSON(t, key, fingerprint, host, port), "ssh:"+host+":"+port)
	echoed := make(chan string, 4)
	exited := make(chan struct{}, 1)
	stream, err := env.h.startComputerPTY(context.Background(), env.exec, 100, 40, func(channel string, data []byte) {
		switch channel {
		case "stdout":
			echoed <- string(data)
		case "exit":
			select {
			case exited <- struct{}{}:
			default:
			}
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cols, rows, _, _, shells := record.snapshot(); cols != 100 || rows != 40 || shells != 1 {
		t.Fatalf("pty request: cols=%d rows=%d shells=%d", cols, rows, shells)
	}
	if err := stream.write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-echoed:
		if got != "hi" {
			t.Fatalf("ssh echo = %q", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no ssh stdout echo")
	}
	if err := stream.resize(80, 24); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, cols, rows, _ := record.snapshot(); cols == 80 && rows == 24 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, _, cols, rows, _ := record.snapshot(); cols != 80 || rows != 24 {
		t.Fatalf("window-change: cols=%d rows=%d", cols, rows)
	}
	stream.close()
}

func TestComputerTerminalRefusesWithoutPTY(t *testing.T) {
	env := sshExecHarness(t, computers.E2B, "", "sandbox-1")
	_, err := env.h.resolveComputerTerminal(context.Background(), "tenant", env.exec.computer.SpaceID, "computer", "")
	if err == nil || !strings.Contains(err.Error(), "terminal is not available on this computer") {
		t.Fatalf("e2b terminal accepted: %v", err)
	}
	if _, err := env.h.startComputerPTY(context.Background(), env.exec, 0, 0, func(string, []byte) {}); err == nil || !strings.Contains(err.Error(), "terminal is not available on this computer") {
		t.Fatalf("e2b transport accepted: %v", err)
	}
}

func seedTerminalComputer(t *testing.T, d *appdeps.Dependencies, spaceID, computerID string, caps string) {
	t.Helper()
	now := d.Clock().UTC().Format(time.RFC3339Nano)
	if _, err := d.DB.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,capabilities_json,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,900,3600,?,?)`, computerID, "tenant", spaceID, computerID, string(computers.Server), caps, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,external_id,created_at,updated_at) VALUES(?,?,?,?,'',?,?,'ready','ctr-1',?,?)`, "rt-"+computerID, "tenant", spaceID, computerID, "inc-"+computerID, "op-"+computerID, now, now); err != nil {
		t.Fatal(err)
	}
}

func TestComputerTerminalTicketScoping(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := newACPResolveHandler(d)
	ctx := context.Background()
	s1, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "S1"})
	if err != nil {
		t.Fatal(err)
	}
	s2, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "S2"})
	if err != nil {
		t.Fatal(err)
	}
	seedTerminalComputer(t, d, s1.ID, "c1", `["commands","files","docker","pty"]`)
	seedTerminalComputer(t, d, s2.ID, "c2", `["commands","files","docker","pty"]`)
	router := chi.NewRouter()
	h.registerComputers(router)
	call := func(path string, p httpx.Principal) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	p := httpx.Principal{TenantID: "tenant"}
	w := call("/spaces/"+s1.ID+"/computers/c1/terminal-ticket", p)
	if w.Code != 200 {
		t.Fatalf("ticket: %d %s", w.Code, w.Body)
	}
	var out struct {
		Ticket string `json:"ticket"`
		URL    string `json:"url"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out.Ticket == "" || !strings.Contains(out.URL, "/terminal-proxy?token=") {
		t.Fatalf("ticket shape: %s", w.Body)
	}
	if _, err := h.verifyComputerTicket(out.Ticket, s1.ID, "c1"); err != nil {
		t.Fatalf("valid ticket rejected: %v", err)
	}
	if _, err := h.verifyComputerTicket(out.Ticket, s2.ID, "c1"); err == nil {
		t.Fatal("cross-space ticket accepted")
	}
	if _, err := h.verifyComputerTicket(out.Ticket, s1.ID, "c2"); err == nil {
		t.Fatal("cross-computer ticket accepted")
	}
	if w := call("/spaces/"+s2.ID+"/computers/c2/terminal-ticket", httpx.Principal{TenantID: "tenant", SpaceID: s1.ID}); w.Code != 403 {
		t.Fatalf("space scope bypass: %d %s", w.Code, w.Body)
	}
	if w := call("/spaces/"+s1.ID+"/computers/c2/terminal-ticket", p); w.Code != 409 {
		t.Fatalf("foreign computer accepted: %d %s", w.Code, w.Body)
	}
}

func TestComputerTerminalTicketKeepsLegacyTickets(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := newACPResolveHandler(d)
	ctx := context.Background()
	node := "node"
	space, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Post("/agents/{id}/terminal-ticket", h.terminalTicket)
	req := httptest.NewRequest(http.MethodPost, "/agents/"+agent.ID+"/terminal-ticket", nil)
	req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant"}))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("legacy ticket: %d %s", w.Code, w.Body)
	}
	var out struct {
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	ticket, err := h.verifyWorkspaceTicket(out.Ticket, agent.ID, "terminal")
	if err != nil || ticket.AgentID != agent.ID || ticket.Kind != "terminal" {
		t.Fatalf("legacy ticket broken: %+v %v", ticket, err)
	}
	if _, err := h.verifyComputerTicket(out.Ticket, space.ID, "c1"); err == nil {
		t.Fatal("legacy ticket accepted by the computer proxy")
	}
}
