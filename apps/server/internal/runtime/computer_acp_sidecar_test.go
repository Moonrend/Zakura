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
	"github.com/go-chi/chi/v5"
)

type acpSidecarState struct {
	mu           sync.Mutex
	creates      int
	lists        int
	execStarts   int
	execID       string
	createParams map[string]any
	containers   []map[string]any
	sidecarID    string
	execProcess  string
}

func (s *acpSidecarState) container(name string, labels map[string]string) map[string]any {
	return map[string]any{"dockerId": s.sidecarID, "name": "/" + name, "image": acpSidecarImage, "status": "running", "labels": labels}
}

// startACPSidecarRunner speaks the runner wire protocol for the computer-side
// Docker RPCs the ACP sidecar path uses, and drives the ACP JSON-RPC handshake
// back over docker.exec.write stdout streams.
func startACPSidecarRunner(t *testing.T, serverURL, token string, state *acpSidecarState) {
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
		sendStream := func(process string, message any) {
			raw, _ := json.Marshal(message)
			raw = append(raw, '\n')
			frame, _ := json.Marshal(map[string]any{"type": "stream", "stream": process, "chan": "stdout", "data": base64.StdEncoding.EncodeToString(raw)})
			writeMaskedText(t, conn, string(frame))
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
			case "docker.list":
				state.mu.Lock()
				state.lists++
				containers := append([]map[string]any(nil), state.containers...)
				state.mu.Unlock()
				result = containers
			case "docker.create":
				state.mu.Lock()
				state.creates++
				state.createParams = frame.Params
				rawLabels, _ := json.Marshal(frame.Params["labels"])
				var labels map[string]string
				_ = json.Unmarshal(rawLabels, &labels)
				container := state.container(fmt.Sprint(frame.Params["name"]), labels)
				state.containers = []map[string]any{container}
				state.mu.Unlock()
				result = container
			case "docker.exec.start":
				state.mu.Lock()
				state.execStarts++
				state.execID = fmt.Sprint(frame.Params["id"])
				process := state.execProcess
				state.mu.Unlock()
				result = map[string]any{"id": process, "mode": "exec"}
			case "docker.exec.write":
				payload, _ := base64.StdEncoding.DecodeString(fmt.Sprint(frame.Params["base64"]))
				var rpc map[string]any
				_ = json.Unmarshal(payload, &rpc)
				method, _ := rpc["method"].(string)
				after = func() {
					id := rpc["id"]
					switch method {
					case "initialize":
						sendStream(state.execProcess, map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"agentCapabilities": map[string]any{"loadSession": true}}})
					case "session/new", "session/load":
						sendStream(state.execProcess, map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"sessionId": "acp-sidecar-1"}})
					}
				}
			case "docker.exec.close":
			default:
				return
			}
			response, _ := json.Marshal(map[string]any{"type": "res", "id": frame.ID, "ok": true, "result": result})
			writeMaskedText(t, conn, string(response))
			if after != nil {
				after()
			}
		}
	}()
}

func newACPSidecarHarness(t *testing.T, d *appdeps.Dependencies, runnerToken string, state *acpSidecarState) *handler {
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
	startACPSidecarRunner(t, server.URL, runnerToken, state)
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

type acpHostFixture struct {
	spaceID    string
	agentID    string
	sid        string
	runID      string
	computerID string
	nodeID     string
	rootPath   string
}

// newACPHostFixture seeds a Space, agent, ACP session, and immutable Run target
// pinned to one computer. runtimeState=="" seeds no runtime at all.
func newACPHostFixture(t *testing.T, d *appdeps.Dependencies, h *handler, provider computers.Provider, caps string, runtimeState string, legacy bool) acpHostFixture {
	t.Helper()
	ctx := context.Background()
	store := NewStore(d)
	node := "node"
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	computerID := "pc"
	var legacyScope any
	if legacy {
		legacyScope = space.ID
	}
	if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,runtime_node_id,legacy_workspace_scope,capabilities_json,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,900,3600,'now','now')`, computerID, "tenant", space.ID, "PC", string(provider), node, legacyScope, caps).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.computerStore().SetSpaceDefault(ctx, "tenant", space.ID, computerID); err != nil {
		t.Fatal(err)
	}
	sess, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{Kind: "acp", Origin: json.RawMessage(`{"runtime":"acp","acpProfileId":"codex"}`)})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.StartRun(ctx, "tenant", agent.ID, sess.ID, "hi", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	rootPath := "/srv/zakura/computers/rt1/workspace"
	if runtimeState != "" {
		if err = d.Gorm.Exec(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,external_id,state,root_path,created_at,updated_at) VALUES('rt1','tenant',?,?,'','inc1','op1','computer-ctr',?,?,'now','now')`, space.ID, computerID, runtimeState, rootPath).Error; err != nil {
			t.Fatal(err)
		}
	}
	return acpHostFixture{spaceID: space.ID, agentID: agent.ID, sid: sess.ID, runID: run.ID, computerID: computerID, nodeID: node, rootPath: rootPath}
}

func acpHostContext(fx acpHostFixture) context.Context {
	return context.WithValue(context.Background(), computerRunKey{}, fx.runID)
}

func TestACPSidecarResolveHostLegacyReturnsNil(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := newACPSidecarHarness(t, d, "rnr_acp_legacy", &acpSidecarState{sidecarID: "sidecar-ctr", execProcess: "proc-1"})
	fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files","docker"]`, "ready", true)
	exec, err := resolveACPHost(acpHostContext(fx), h, "tenant", fx.agentID, fx.sid)
	if err != nil || exec != nil {
		t.Fatalf("legacy host resolution: exec=%+v err=%v", exec, err)
	}
}

func TestACPSidecarResolveHostRejectsTemporary(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := newACPSidecarHarness(t, d, "rnr_acp_temporary", &acpSidecarState{sidecarID: "sidecar-ctr", execProcess: "proc-1"})
	fx := newACPHostFixture(t, d, h, computers.Temporary, `["commands","files","docker"]`, "", false)
	if _, err := resolveACPHost(acpHostContext(fx), h, "tenant", fx.agentID, fx.sid); err == nil || !strings.Contains(err.Error(), "persistent server computers") {
		t.Fatalf("temporary host accepted: %v", err)
	}
}

func TestACPSidecarResolveHostRequiresDocker(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := newACPSidecarHarness(t, d, "rnr_acp_nodocker", &acpSidecarState{sidecarID: "sidecar-ctr", execProcess: "proc-1"})
	fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files"]`, "ready", false)
	if _, err := resolveACPHost(acpHostContext(fx), h, "tenant", fx.agentID, fx.sid); err == nil || !strings.Contains(err.Error(), "Docker capability") {
		t.Fatalf("docker-less host accepted: %v", err)
	}
}

func TestACPSidecarResolveHostRequiresActiveRuntime(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := newACPSidecarHarness(t, d, "rnr_acp_noruntime", &acpSidecarState{sidecarID: "sidecar-ctr", execProcess: "proc-1"})
	fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files","docker"]`, "", false)
	if _, err := resolveACPHost(acpHostContext(fx), h, "tenant", fx.agentID, fx.sid); err == nil || !strings.Contains(err.Error(), "no active runtime") {
		t.Fatalf("runtime-less host accepted: %v", err)
	}
}

func TestACPSidecarEnsureCreateAndReuse(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	state := &acpSidecarState{sidecarID: "sidecar-ctr", execProcess: "proc-1"}
	h := newACPSidecarHarness(t, d, "rnr_acp_sidecar_reuse", state)
	fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files","docker"]`, "ready", false)
	ctx := acpHostContext(fx)
	exec, err := resolveACPHost(ctx, h, "tenant", fx.agentID, fx.sid)
	if err != nil || exec == nil {
		t.Fatalf("host resolution: exec=%+v err=%v", exec, err)
	}
	first, err := h.ensureACPSidecar(ctx, exec)
	if err != nil {
		t.Fatalf("ensure sidecar: %v", err)
	}
	second, err := h.ensureACPSidecar(ctx, exec)
	if err != nil {
		t.Fatalf("reuse sidecar: %v", err)
	}
	if first != state.sidecarID || second != state.sidecarID {
		t.Fatalf("sidecar ids: %q %q", first, second)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.creates != 1 {
		t.Fatalf("sidecar recreated: creates=%d", state.creates)
	}
	if state.lists != 2 {
		t.Fatalf("sidecar lookups: lists=%d", state.lists)
	}
}

func TestACPSidecarStartUsesDedicatedContainer(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	state := &acpSidecarState{sidecarID: "sidecar-ctr", execProcess: "proc-1"}
	h := newACPSidecarHarness(t, d, "rnr_acp_sidecar_start", state)
	fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files","docker"]`, "ready", false)
	ctx := acpHostContext(fx)
	exec, err := resolveACPHost(ctx, h, "tenant", fx.agentID, fx.sid)
	if err != nil || exec == nil {
		t.Fatalf("host resolution: exec=%+v err=%v", exec, err)
	}
	if exec.hostRoot != fx.rootPath || exec.computer.ID != fx.computerID {
		t.Fatalf("resolved execution: %+v", exec)
	}
	m := &acpRuntimeManager{h: h}
	sess, err := h.store.GetSession(ctx, "tenant", fx.agentID, fx.sid)
	if err != nil {
		t.Fatal(err)
	}
	rt, err := m.start(ctx, "tenant", fx.agentID, fx.sid, "codex", "", sess, map[string]any{"command": "codex-acp", "args": []any{"--stdio"}})
	if err != nil {
		t.Fatalf("sidecar start: %v", err)
	}
	if rt.processID != "proc-1" || rt.writeMethod != "docker.exec.write" || rt.closeMethod != "docker.exec.close" || rt.computerID != fx.computerID {
		t.Fatalf("runtime transport: %+v", rt)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.creates != 1 || state.execStarts != 1 || state.execID != state.sidecarID {
		t.Fatalf("sidecar wiring: creates=%d execStarts=%d execID=%q", state.creates, state.execStarts, state.execID)
	}
	volume := state.createParams["volumes"].([]any)[0].(map[string]any)
	if volume["hostPath"] != fx.rootPath || volume["containerPath"] != "/workspace" {
		t.Fatalf("sidecar mount: %#v", volume)
	}
	if state.createParams["privileged"] != nil || state.createParams["ports"] != nil {
		t.Fatalf("unsafe sidecar spec: %#v", state.createParams)
	}
	labels := state.createParams["labels"].(map[string]any)
	if labels["zakura.purpose"] != "acp-sidecar" || labels["zakura.computer"] != fx.computerID || labels["zakura.runtime"] != "rt1" || labels["zakura.incarnation"] != "inc1" {
		t.Fatalf("sidecar labels: %#v", labels)
	}
	updated, err := h.store.GetSession(context.Background(), "tenant", fx.agentID, fx.sid)
	if err != nil {
		t.Fatal(err)
	}
	var origin map[string]any
	_ = json.Unmarshal(updated.Origin, &origin)
	if origin["acpComputerId"] != fx.computerID {
		t.Fatalf("session host not pinned: %#v", origin)
	}
}

func newACPResolveHandler(d *appdeps.Dependencies) *handler {
	return &handler{deps: d, store: NewStore(d), mcpSessions: map[string]spaceMCPSession{}}
}

// TestACPEnsureResolvesSessionDefaultComputer covers the fallback resolution
// used by HTTP ACP paths that carry no immutable Run: the session's selected
// computer must be picked instead of the legacy host, and a pinned host must
// never be silently replaced.
func TestACPEnsureResolvesSessionDefaultComputer(t *testing.T) {
	ctx := context.Background()

	t.Run("server default with ready runtime", func(t *testing.T) {
		d := testDeps(t)
		seedTenant(t, d, "tenant")
		h := newACPResolveHandler(d)
		fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files","docker"]`, "ready", false)
		exec, err := resolveACPHost(ctx, h, "tenant", fx.agentID, fx.sid)
		if err != nil || exec == nil {
			t.Fatalf("session default resolution: exec=%+v err=%v", exec, err)
		}
		if exec.computer.ID != fx.computerID || exec.containerID != "computer-ctr" || exec.hostRoot != fx.rootPath {
			t.Fatalf("resolved execution: %+v", exec)
		}
	})

	t.Run("no session selection keeps legacy path", func(t *testing.T) {
		d := testDeps(t)
		seedTenant(t, d, "tenant")
		h := newACPResolveHandler(d)
		fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files","docker"]`, "ready", false)
		if err := h.computerStore().ClearSessionDefault(ctx, "tenant", fx.spaceID, fx.sid); err != nil {
			t.Fatal(err)
		}
		exec, err := resolveACPHost(ctx, h, "tenant", fx.agentID, fx.sid)
		if err != nil || exec != nil {
			t.Fatalf("unselected session resolution: exec=%+v err=%v", exec, err)
		}
	})

	t.Run("temporary selection is rejected", func(t *testing.T) {
		d := testDeps(t)
		seedTenant(t, d, "tenant")
		h := newACPResolveHandler(d)
		fx := newACPHostFixture(t, d, h, computers.Temporary, `["commands","files","docker"]`, "", false)
		if _, err := resolveACPHost(ctx, h, "tenant", fx.agentID, fx.sid); err == nil || !strings.Contains(err.Error(), "persistent server computers") {
			t.Fatalf("temporary selection accepted: %v", err)
		}
	})

	t.Run("selected computer without runtime is rejected", func(t *testing.T) {
		d := testDeps(t)
		seedTenant(t, d, "tenant")
		h := newACPResolveHandler(d)
		fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files","docker"]`, "", false)
		if _, err := resolveACPHost(ctx, h, "tenant", fx.agentID, fx.sid); err == nil || !strings.Contains(err.Error(), "no active runtime") {
			t.Fatalf("runtime-less selection accepted: %v", err)
		}
	})

	t.Run("pinned host mismatch is rejected", func(t *testing.T) {
		d := testDeps(t)
		seedTenant(t, d, "tenant")
		h := newACPResolveHandler(d)
		fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files","docker"]`, "ready", false)
		origin, _ := json.Marshal(map[string]any{"runtime": "acp", "acpProfileId": "codex", "acpComputerId": "other"})
		if err := d.Gorm.Exec(`UPDATE cloud_agent_sessions SET origin_json=? WHERE tenant_id=? AND agent_id=? AND id=?`, string(origin), "tenant", fx.agentID, fx.sid).Error; err != nil {
			t.Fatal(err)
		}
		if _, err := resolveACPHost(ctx, h, "tenant", fx.agentID, fx.sid); err == nil || !strings.Contains(err.Error(), "host computer changed") {
			t.Fatalf("host switch accepted: %v", err)
		}
	})

	t.Run("legacy selection keeps legacy path", func(t *testing.T) {
		d := testDeps(t)
		seedTenant(t, d, "tenant")
		h := newACPResolveHandler(d)
		fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files","docker"]`, "ready", true)
		exec, err := resolveACPHost(ctx, h, "tenant", fx.agentID, fx.sid)
		if err != nil || exec != nil {
			t.Fatalf("legacy session resolution: exec=%+v err=%v", exec, err)
		}
	})
}

func TestACPSidecarStartRejectsHostSwitch(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := newACPSidecarHarness(t, d, "rnr_acp_sidecar_switch", &acpSidecarState{sidecarID: "sidecar-ctr", execProcess: "proc-1"})
	fx := newACPHostFixture(t, d, h, computers.Server, `["commands","files","docker"]`, "ready", false)
	ctx := acpHostContext(fx)
	sess, err := h.store.GetSession(ctx, "tenant", fx.agentID, fx.sid)
	if err != nil {
		t.Fatal(err)
	}
	sess.Origin = json.RawMessage(`{"runtime":"acp","acpProfileId":"codex","acpComputerId":"other"}`)
	m := &acpRuntimeManager{h: h}
	if _, err = m.start(ctx, "tenant", fx.agentID, fx.sid, "codex", "", sess, map[string]any{"command": "codex-acp"}); err == nil || !strings.Contains(err.Error(), "host computer changed") {
		t.Fatalf("host switch accepted: %v", err)
	}
}
