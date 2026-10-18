// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"encoding/base64"
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

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

type workspaceProxyRig struct {
	h         *handler
	space     Space
	mu        sync.Mutex
	container computerContainer
	calls     []acpLoginRecordedCall
	owner     string
	failClose bool
}

func newWorkspaceProxyRig(t *testing.T) *workspaceProxyRig {
	t.Helper()
	return workspaceProxyRigWithDeps(t, testDeps(t))
}

func workspaceProxyRigWithDeps(t *testing.T, d *appdeps.Dependencies) *workspaceProxyRig {
	t.Helper()
	seedTenant(t, d, "tenant")
	node := "node"
	space, err := NewStore(d).CreateSpace(context.Background(), "tenant", Space{Name: "Desktop", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	rig := &workspaceProxyRig{space: space, container: computerContainer{DockerID: "canonical-container", Name: "workspace", Status: "running", Image: "fixture", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}}
	rig.owner = "fixture-executor"
	rig.h = codemodeToolHarness(t, d, "rnr_workspace_proxy", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
		rig.mu.Lock()
		defer rig.mu.Unlock()
		rig.calls = append(rig.calls, acpLoginRecordedCall{method: method, params: params})
		switch method {
		case "sys.info":
			info := codemodeInfo()
			info["streamOwner"] = rig.owner
			info["capabilities"].(map[string]any)["dockerCreateReceipts"] = true
			return info, nil
		case "docker.exec.close", "host.pty.close":
			return map[string]any{"ok": !rig.failClose}, nil
		case "docker.list":
			return []computerContainer{rig.container}, nil
		case "docker.create.status":
			return workspaceReceiptStatusFixture(rig.container), nil
		case "docker.exec.start":
			return map[string]any{"id": "workspace-stream"}, nil
		case "docker.exec.write":
			return map[string]any{}, func() { emit("workspace-stream", "stdout", map[string]any{"echo": "fixture"}) }
		default:
			return map[string]any{}, nil
		}
	})
	return rig
}

func (rig *workspaceProxyRig) issue(t *testing.T, kind string) string {
	t.Helper()
	return rig.issueAs(t, kind, acpLoginPrincipal())
}

func (rig *workspaceProxyRig) issueAs(t *testing.T, kind string, actor httpx.Principal) string {
	t.Helper()
	router := chi.NewRouter()
	router.Post("/spaces/{id}/ticket", func(w http.ResponseWriter, r *http.Request) { rig.h.issueSpaceWorkspaceTicket(w, r, kind) })
	req := httptest.NewRequest(http.MethodPost, "/spaces/"+rig.space.ID+"/ticket", nil)
	req = req.WithContext(httpx.WithPrincipal(req.Context(), actor))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("ticket: %d %s", w.Code, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("ticket response is cacheable")
	}
	var response struct {
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.Ticket == "" {
		t.Fatalf("ticket: %v", err)
	}
	return response.Ticket
}

func TestSpaceWorkspaceTicketRevalidation(t *testing.T) {
	for _, scenario := range []string{"valid", "cross-space", "cross-kind", "tampered", "expired", "revoked-key", "changed-container", "changed-node", "migrating"} {
		t.Run(scenario, func(t *testing.T) {
			rig := newWorkspaceProxyRig(t)
			token := rig.issue(t, "desktop")
			space, kind := rig.space.ID, "desktop"
			var err error
			switch scenario {
			case "cross-space":
				space = "another"
			case "cross-kind":
				kind = "terminal"
			case "tampered":
				token += "bad"
			case "expired":
				clock := rig.h.deps.Clock
				rig.h.deps.Clock = func() time.Time { return clock().Add(2 * time.Minute) }
			case "revoked-key":
				err = rig.h.deps.Gorm.Table("api_keys").Where("id=?", "key-tenant").Update("revoked_at", runtimeTimeString(time.Now())).Error
			case "changed-container":
				rig.mu.Lock()
				rig.container.DockerID = "replacement"
				rig.mu.Unlock()
			case "changed-node":
				err = rig.h.deps.Gorm.Table("spaces").Where("id=?", space).Update("runtime_node_id", "different").Error
			case "migrating":
				lease, e := rig.h.acquireSpaceWorkspace(context.Background(), "tenant", space, "migrating", false, nil)
				err = e
				if e == nil {
					defer lease.release()
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			target, lease, _, err := rig.h.consumeSpaceWorkspaceTicket(context.Background(), token, space, kind)
			if scenario != "valid" {
				if err == nil {
					lease.release()
					t.Fatalf("accepted %s", scenario)
				}
				return
			}
			if err != nil || target.container != "canonical-container" {
				t.Fatalf("valid ticket: %v", err)
			}
			lease.release()
			if _, again, _, err := rig.h.consumeSpaceWorkspaceTicket(context.Background(), token, space, kind); err == nil {
				again.release()
				t.Fatal("replayed ticket accepted")
			}
			var count int64
			if err := rig.h.deps.Gorm.Table("agents").Count(&count).Error; err != nil || count != 0 {
				t.Fatal("workspace ticket needs an Agent")
			}
		})
	}
}

func connectionTicketUser(t *testing.T, h *handler) httpx.Principal {
	t.Helper()
	now := runtimeTimeString(h.store.now())
	if _, err := h.deps.DB.Exec(`INSERT INTO users(id,email,password_hash,status,created_at,updated_at) VALUES('viewer','viewer@example.test','unused','active',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := h.deps.DB.Exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES('viewer-member','tenant','viewer','member','active',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := h.deps.DB.Exec(`INSERT INTO user_sessions(id,user_id,tenant_id,email,role,token_hash,expires_at,last_seen_at,created_at) VALUES('viewer-session','viewer','tenant','viewer@example.test','member','synthetic-session-hash',?,?,?)`, runtimeTimeString(h.store.now().Add(time.Hour)), now, now); err != nil {
		t.Fatal(err)
	}
	return httpx.Principal{TenantID: "tenant", UserID: "viewer", SessionID: "viewer-session"}
}

func TestSpaceWorkspaceTicketSessionRevocation(t *testing.T) {
	for _, scenario := range []string{"valid", "revoked", "expired", "removed-member", "oauth-valid", "oauth-expired"} {
		t.Run(scenario, func(t *testing.T) {
			rig := newWorkspaceProxyRig(t)
			actor := connectionTicketUser(t, rig.h)
			if strings.HasPrefix(scenario, "oauth-") {
				actor.OAuth, actor.OAuthScope, actor.OAuthExpiresAt = true, "api", rig.h.store.now().Add(time.Second)
				actor.SpaceID = rig.space.ID
			}
			token := rig.issueAs(t, "terminal", actor)
			switch scenario {
			case "revoked":
				if err := rig.h.deps.Gorm.Table("user_sessions").Where("id=?", actor.SessionID).Update("revoked_at", runtimeTimeString(rig.h.store.now())).Error; err != nil {
					t.Fatal(err)
				}
			case "expired":
				if err := rig.h.deps.Gorm.Table("user_sessions").Where("id=?", actor.SessionID).Update("expires_at", runtimeTimeString(rig.h.store.now().Add(-time.Hour))).Error; err != nil {
					t.Fatal(err)
				}
			case "removed-member":
				if err := rig.h.deps.Gorm.Table("tenant_memberships").Where("user_id=?", actor.UserID).Update("status", "removed").Error; err != nil {
					t.Fatal(err)
				}
			case "oauth-expired":
				clock := rig.h.deps.Clock
				rig.h.deps.Clock = func() time.Time { return clock().Add(2 * time.Second) }
			}
			_, lease, ctx, err := rig.h.consumeSpaceWorkspaceTicket(context.Background(), token, rig.space.ID, "terminal")
			if scenario == "valid" || scenario == "oauth-valid" {
				if err != nil {
					t.Fatal(err)
				}
				lease.release()
				current, _ := httpx.PrincipalFrom(ctx)
				if current.OAuth != actor.OAuth || current.SpaceID != actor.SpaceID || current.SessionID != actor.SessionID && !actor.OAuth {
					t.Fatalf("actor binding changed: %#v", current)
				}
			} else if err == nil {
				lease.release()
				t.Fatal("revoked or expired identity redeemed a ticket")
			}
			rig.mu.Lock()
			defer rig.mu.Unlock()
			for _, call := range rig.calls {
				if call.method == "docker.exec.start" || call.method == "host.pty.start" {
					t.Fatal("ticket validation allocated a stream")
				}
			}
		})
	}
}

func TestSpaceWorkspaceTicketRejectsRestrictedActors(t *testing.T) {
	for _, scenario := range []string{"oauth-agent", "oauth-space", "oauth-scope", "oauth-expired", "key-agent", "key-space"} {
		t.Run(scenario, func(t *testing.T) {
			rig := newWorkspaceProxyRig(t)
			actor := connectionTicketUser(t, rig.h)
			actor.OAuth, actor.OAuthScope, actor.OAuthExpiresAt = true, "api", rig.h.store.now().Add(time.Hour)
			switch scenario {
			case "oauth-agent":
				actor.AgentID = "restricted-agent"
			case "oauth-space":
				actor.SpaceID = "restricted-space"
			case "oauth-scope":
				actor.OAuthScope = "mcp"
			case "oauth-expired":
				actor.OAuthExpiresAt = rig.h.store.now().Add(-time.Second)
			case "key-agent", "key-space":
				actor = acpLoginPrincipal()
				column, value := "space_id", "restricted-space"
				if scenario == "key-agent" {
					column, value = "agent_id", "restricted-agent"
				}
				if err := rig.h.deps.Gorm.Table("api_keys").Where("id=?", actor.APIKeyID).Update(column, value).Error; err != nil {
					t.Fatal(err)
				}
			}
			router := chi.NewRouter()
			router.Post("/spaces/{id}/ticket", func(w http.ResponseWriter, r *http.Request) { rig.h.issueSpaceWorkspaceTicket(w, r, "terminal") })
			req := httptest.NewRequest(http.MethodPost, "/spaces/"+rig.space.ID+"/ticket", nil)
			req = req.WithContext(httpx.WithPrincipal(req.Context(), actor))
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != http.StatusForbidden {
				t.Fatalf("restricted actor: %d %s", w.Code, w.Body)
			}
			rig.mu.Lock()
			defer rig.mu.Unlock()
			for _, call := range rig.calls {
				if call.method != "sys.info" {
					t.Fatalf("restricted actor reached the workspace runner: %s", call.method)
				}
			}
		})
	}
}

func TestSpaceWorkspaceSocketRunnerDisconnect(t *testing.T) {
	for _, kind := range []string{"desktop", "terminal"} {
		t.Run(kind, func(t *testing.T) {
			rig := newWorkspaceProxyRig(t)
			runner, err := rig.h.hub.get("node")
			if err != nil {
				t.Fatal(err)
			}
			server, client := net.Pipe()
			defer client.Close()
			bridge := &workspaceBridge{conn: server, rw: bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server))}
			allocated := make(chan struct{})
			bridge.ready = func(string, string) error { close(allocated); return nil }
			done := make(chan struct{})
			go func() {
				defer close(done)
				defer server.Close()
				if kind == "desktop" {
					rig.h.bridgeDesktopContainer(context.Background(), bridge, runner, "canonical-container")
				} else {
					rig.h.bridgeTerminalContainer(context.Background(), bridge, runner, rig.space.ID, "container", "", "canonical-container")
				}
			}()
			// Drain server frames, including the terminal ready/error messages.
			go func() { _, _ = io.Copy(io.Discard, client) }()
			select {
			case <-allocated:
			case <-time.After(2 * time.Second):
				t.Fatal("stream was not allocated")
			}
			runner.close(context.Canceled)
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("runner disconnect left workspace socket open")
			}
			if bridge.remoteClosed || bridge.cleanupErr == nil {
				t.Fatal("runner disconnect was treated as confirmed remote cleanup")
			}
		})
	}
}

func TestSpaceWorkspaceTerminalSocketLifecycle(t *testing.T) {
	rig := newWorkspaceProxyRig(t)
	token := rig.issue(t, "terminal")
	router := chi.NewRouter()
	router.Get("/api/spaces/{id}/workspace-terminal-proxy", rig.h.spaceTerminalProxy)
	server := httptest.NewServer(router)
	defer server.Close()
	u, _ := url.Parse(server.URL)
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
	_, err = fmt.Fprintf(conn, "GET /api/spaces/%s/workspace-terminal-proxy?token=%s HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", rig.space.ID, url.QueryEscape(token), u.Host)
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, &http.Request{Method: "GET"})
	if err != nil || response.StatusCode != 101 {
		t.Fatalf("upgrade=%v err=%v", response, err)
	}
	ready, err := readRunnerServerText(reader)
	if err != nil || !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("ready=%s %v", ready, err)
	}
	writeMaskedText(t, conn, `{"type":"resize","cols":131,"rows":43}`)
	writeMaskedText(t, conn, `{"type":"input","data":"hello\n"}`)
	output, err := readRunnerServerText(reader)
	if err != nil || !strings.Contains(output, `"type":"output"`) {
		t.Fatalf("output=%s %v", output, err)
	}
	if err := rig.h.closeSpaceWorkspaceBridges(context.Background(), "tenant", rig.space.ID); err != nil {
		t.Fatal(err)
	}
	var connections int64
	if err := rig.h.deps.Gorm.Table("workspace_connections").Count(&connections).Error; err != nil || connections != 0 {
		t.Fatalf("connection journal after cleanup=%d, err=%v", connections, err)
	}
	rig.mu.Lock()
	defer rig.mu.Unlock()
	start, resize, input, closed := false, false, false, false
	for _, call := range rig.calls {
		switch call.method {
		case "docker.exec.start":
			start = call.params["id"] == "canonical-container" && call.params["tty"] == true
		case "docker.exec.resize":
			resize = call.params["cols"] == float64(131) && call.params["rows"] == float64(43)
		case "docker.exec.write":
			raw, _ := base64.StdEncoding.DecodeString(fmt.Sprint(call.params["base64"]))
			input = string(raw) == "hello\n"
		case "docker.exec.close":
			closed = call.params["id"] == "workspace-stream"
		}
	}
	if !start || !resize || !input || !closed {
		t.Fatalf("start/resize/input/close=%v/%v/%v/%v", start, resize, input, closed)
	}
}
