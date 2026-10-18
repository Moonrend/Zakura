// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

type acpLoginRecordedCall struct {
	method string
	params map[string]any
}
type acpLoginTestState struct {
	mu         sync.Mutex
	calls      []acpLoginRecordedCall
	containers []acpSidecarContainer
}

func acpLoginRig(t *testing.T) (*handler, *appdeps.Dependencies, Space, *acpLoginTestState) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	// The parent owns migration0013. Keep this component test runnable against
	// the copied baseline as well as the integrated migration.
	_, err := d.DB.Exec(`CREATE TABLE IF NOT EXISTS runtime_connection_tickets(token_hash TEXT PRIMARY KEY,principal_id TEXT NOT NULL,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,profile_id TEXT NOT NULL,node_id TEXT NOT NULL,computer_id TEXT NOT NULL,config_hash TEXT NOT NULL,expires_at BIGINT NOT NULL,used_at BIGINT)`)
	if err != nil {
		t.Fatal(err)
	}
	state := &acpLoginTestState{}
	h := codemodeToolHarness(t, d, "rnr_acp_login", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
		state.mu.Lock()
		defer state.mu.Unlock()
		state.calls = append(state.calls, acpLoginRecordedCall{method: method, params: params})
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true, "privateAtomicFS": true, "filesystemNoFollowStat": true}, "hostInfo": map[string]any{}}, nil
		case "host.fs.list":
			return map[string]any{"entries": []any{}}, nil
		case "host.fs.mkdir":
			return map[string]any{"abs": "/srv/zakura/spaces/space/workspace"}, nil
		case "docker.create":
			labels := map[string]string{}
			for k, v := range params["labels"].(map[string]any) {
				labels[k] = v.(string)
			}
			state.containers = []acpSidecarContainer{{DockerID: "login-container", Labels: labels, Status: "running"}}
			return state.containers[0], nil
		case "docker.list":
			// A lying broad list must never cause unrelated-container cleanup.
			all := append([]acpSidecarContainer{}, state.containers...)
			all = append(all, acpSidecarContainer{DockerID: "foreign-container", Labels: map[string]string{"zakura.purpose": "acp-adapter"}})
			return all, nil
		case "docker.exec.start":
			return map[string]any{"id": "login-process", "mode": "pty"}, nil
		case "docker.exec.write":
			return map[string]any{"ok": true}, func() { emit("login-process", "stdout", map[string]string{"echo": "output"}) }
		default:
			return map[string]any{"ok": true}, nil
		}
	})
	node := "node"
	s, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "No agents or desktop", RuntimeNodeID: &node, WorkspaceKind: "host", EnableComputer: false})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.saveSpaceACP(context.Background(), "tenant", s.ID, map[string]any{"agents": map[string]any{"codex": map[string]any{"enabled": true, "setupMode": "self", "managed": map[string]any{}, "env": map[string]any{"PRIVATE_TOKEN": "do-not-expose"}}}}); err != nil {
		t.Fatal(err)
	}
	return h, d, s, state
}

func acpLoginPrincipal() httpx.Principal {
	return httpx.Principal{TenantID: "tenant", UserID: "api-key", APIKey: true, APIKeyID: "key-tenant"}
}

func TestACPLoginTicketSingleUseAndPayload(t *testing.T) {
	h, d, s, _ := acpLoginRig(t)
	target, err := h.resolveACPLogin(context.Background(), "tenant", s.ID, "codex")
	if err != nil {
		t.Fatal(err)
	}
	token, err := h.issueACPLoginTicket(context.Background(), target, acpLoginPrincipal())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(token, "do-not-expose") {
		t.Fatal("secret in token")
	}
	body, _, _ := strings.Cut(token, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(body)
	var payload map[string]any
	_ = json.Unmarshal(raw, &payload)
	if len(payload) != 9 || payload["principal"] != "key:key-tenant" || payload["space"] != s.ID || payload["profile"] != "codex" || payload["node"] != "node" || payload["computer"] == "" || payload["configHash"] == "" || strings.Contains(string(raw), "do-not-expose") {
		t.Fatalf("unexpected payload %s", raw)
	}
	if _, err = h.consumeACPLoginTicket(context.Background(), token, s.ID, "codex"); err != nil {
		t.Fatal(err)
	}
	if _, err = h.consumeACPLoginTicket(context.Background(), token, s.ID, "codex"); err == nil {
		t.Fatal("replayed terminal ticket")
	}
	var agents int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM agents`).Scan(&agents)
	if agents != 0 {
		t.Fatal("login depended on an Agent")
	}
	var stored string
	_ = d.DB.QueryRow(`SELECT token_hash FROM runtime_connection_tickets`).Scan(&stored)
	if stored == token || stored != acpLoginDigest([]byte(token)) {
		t.Fatal("nonce not hashed")
	}
}

func TestACPLoginTicketRevalidation(t *testing.T) {
	for _, scenario := range []string{"cross-space", "cross-profile", "tampered", "expired", "revoked-key", "changed-key-space", "changed-profile", "changed-target", "removed-member"} {
		t.Run(scenario, func(t *testing.T) {
			h, d, s, _ := acpLoginRig(t)
			target, err := h.resolveACPLogin(context.Background(), "tenant", s.ID, "codex")
			if err != nil {
				t.Fatal(err)
			}
			p := acpLoginPrincipal()
			if scenario == "removed-member" {
				p = connectionTicketUser(t, h)
			}
			token, err := h.issueACPLoginTicket(context.Background(), target, p)
			if err != nil {
				t.Fatal(err)
			}
			space, profile := s.ID, "codex"
			switch scenario {
			case "cross-space":
				space = "another"
			case "cross-profile":
				profile = "pi"
			case "tampered":
				token = token[:len(token)-3] + "bad"
			case "expired":
				clock := d.Clock
				d.Clock = func() time.Time { return clock().Add(2 * time.Minute) }
			case "revoked-key":
				_, err = d.DB.Exec(`UPDATE api_keys SET revoked_at=? WHERE id='key-tenant'`, d.Clock().Format(time.RFC3339Nano))
			case "changed-key-space":
				_, err = d.DB.Exec(`UPDATE api_keys SET space_id='another' WHERE id='key-tenant'`)
			case "changed-profile":
				err = h.saveSpaceACP(context.Background(), "tenant", s.ID, map[string]any{"agents": map[string]any{"codex": map[string]any{"enabled": true, "setupMode": "self", "pinnedVersion": "changed", "managed": map[string]any{}}}})
			case "changed-target":
				_, err = d.DB.Exec(`UPDATE spaces SET runtime_node_id=NULL WHERE id=?`, s.ID)
			case "removed-member":
				_, err = d.DB.Exec(`UPDATE tenant_memberships SET status='removed' WHERE user_id=?`, p.UserID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = h.consumeACPLoginTicket(context.Background(), token, space, profile); err == nil {
				t.Fatalf("accepted %s", scenario)
			}
		})
	}
}

func TestACPLoginTicketSessionRevocation(t *testing.T) {
	for _, scenario := range []string{"valid", "revoked", "expired", "oauth-valid", "oauth-expired", "oauth-agent"} {
		t.Run(scenario, func(t *testing.T) {
			h, d, space, state := acpLoginRig(t)
			actor := connectionTicketUser(t, h)
			if strings.HasPrefix(scenario, "oauth-") {
				actor.OAuth, actor.OAuthScope, actor.OAuthExpiresAt = true, "api", h.store.now().Add(time.Second)
				actor.SpaceID = space.ID
			}
			if scenario == "oauth-agent" {
				actor.AgentID = "restricted-agent"
			}
			target, err := h.resolveACPLogin(context.Background(), "tenant", space.ID, "codex")
			if err != nil {
				t.Fatal(err)
			}
			token, err := h.issueACPLoginTicket(context.Background(), target, actor)
			if scenario == "oauth-agent" {
				if err == nil {
					t.Fatal("Agent-scoped identity received a shared HOME login ticket")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "revoked":
				_, err = d.DB.Exec(`UPDATE user_sessions SET revoked_at=? WHERE id=?`, runtimeTimeString(h.store.now()), actor.SessionID)
			case "expired":
				_, err = d.DB.Exec(`UPDATE user_sessions SET expires_at=? WHERE id=?`, runtimeTimeString(h.store.now().Add(-time.Hour)), actor.SessionID)
			case "oauth-expired":
				clock := d.Clock
				d.Clock = func() time.Time { return clock().Add(2 * time.Second) }
			}
			if err != nil {
				t.Fatal(err)
			}
			_, err = h.consumeACPLoginTicket(context.Background(), token, space.ID, "codex")
			if scenario == "valid" || scenario == "oauth-valid" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("revoked or expired identity redeemed an ACP login ticket")
			}
			state.mu.Lock()
			defer state.mu.Unlock()
			for _, call := range state.calls {
				if call.method == "docker.create" || call.method == "docker.exec.start" {
					t.Fatal("ticket validation allocated a login process")
				}
			}
		})
	}
}

func TestACPLoginBridgeTTYMountsInputResizeClose(t *testing.T) {
	h, _, s, state := acpLoginRig(t)
	target, err := h.resolveACPLogin(context.Background(), "tenant", s.ID, "codex")
	if err != nil {
		t.Fatal(err)
	}
	target.ticket.Nonce = "unique-test"
	target.ticket.Principal = "key:key-tenant"
	server, client := net.Pipe()
	defer client.Close()
	defer server.Close()
	_ = client.SetDeadline(time.Now().Add(8 * time.Second))
	bridge := &workspaceBridge{conn: server, rw: bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server))}
	done := make(chan struct{})
	go func() { defer close(done); h.bridgeACPLogin(context.Background(), bridge, target) }()
	reader := bufio.NewReader(client)
	readyText, err := readRunnerServerText(reader)
	ready := []byte(readyText)
	if err != nil || !strings.Contains(string(ready), `"type":"ready"`) {
		t.Fatalf("ready=%s err=%v", ready, err)
	}
	writeMaskedText(t, client, `{"type":"resize","cols":133,"rows":41}`)
	writeMaskedText(t, client, `{"type":"input","data":"hello\n"}`)
	outputText, err := readRunnerServerText(reader)
	output := []byte(outputText)
	if err != nil || !strings.Contains(string(output), `"type":"output"`) {
		t.Fatalf("output=%s err=%v", output, err)
	}
	_ = client.Close()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("terminal did not close")
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	seenCreate, seenExec, seenWrite, seenResize, seenClose, seenCleanup := false, false, false, false, false, false
	for _, call := range state.calls {
		p := call.params
		switch call.method {
		case "docker.create":
			seenCreate = true
			labels := p["labels"].(map[string]any)
			if p["restart"] != "no" || len(labels) != 6 || labels["zakura.purpose"] != "acp-login" || labels["zakura.adapter"] != "codex" || labels["zakura.space"] != s.ID {
				t.Fatalf("container payload=%#v", p)
			}
			volumes := p["volumes"].([]any)
			if len(volumes) != 1 || volumes[0].(map[string]any)["containerPath"] != "/workspace" {
				t.Fatalf("mounts=%#v", volumes)
			}
			env := p["env"].(map[string]any)
			if env["HOME"] != "/workspace/.zakura/acp/codex/home" || env["XDG_CONFIG_HOME"] != "/workspace/.zakura/acp/codex/home/.config" {
				t.Fatalf("wrong HOME=%#v", env)
			}
			if _, exists := p["privileged"]; exists {
				t.Fatal("privileged field")
			}
		case "docker.exec.start":
			seenExec = true
			if p["tty"] != true || p["id"] != "login-container" {
				t.Fatalf("not TTY: %#v", p)
			}
		case "docker.exec.write":
			seenWrite = true
			data, _ := base64.StdEncoding.DecodeString(p["base64"].(string))
			if string(data) != "hello\n" {
				t.Fatalf("input=%q", data)
			}
		case "docker.exec.resize":
			seenResize = true
			if p["cols"] != float64(133) || p["rows"] != float64(41) {
				t.Fatalf("resize=%#v", p)
			}
		case "docker.exec.close":
			seenClose = true
		case "docker.stop":
			seenCleanup = true
			if p["id"] != "login-container" || p["remove"] != true {
				t.Fatalf("unsafe cleanup=%#v", p)
			}
		}
	}
	if !seenCreate || !seenExec || !seenWrite || !seenResize || !seenClose || !seenCleanup {
		t.Fatalf("missing lifecycle create=%v exec=%v write=%v resize=%v close=%v cleanup=%v", seenCreate, seenExec, seenWrite, seenResize, seenClose, seenCleanup)
	}
}

func TestACPLoginTicketHTTPProfileScope(t *testing.T) {
	h, _, s, _ := acpLoginRig(t)
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), acpLoginPrincipal())))
		})
	})
	router.Post("/spaces/{spaceId}/acp/agents/{profileId}/terminal-ticket", h.acpTerminalTicket)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/spaces/"+s.ID+"/acp/agents/codex/terminal-ticket", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "/acp/agents/codex/terminal-proxy?token=") || strings.Contains(w.Body.String(), "do-not-expose") {
		t.Fatalf("response=%d %s", w.Code, w.Body.String())
	}
}
