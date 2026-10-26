// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func terminalAuthHarness(t *testing.T) (*handler, *acpLiveRuntime, Agent, Session, *fakeACPAdapter) {
	t.Helper()
	fake := &fakeACPAdapter{requireAuth: true}
	manager, agent, sess := acpAuthHarness(t, fake)
	manager.h.acp = manager
	d := manager.h.deps
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS runtime_connection_tickets(token_hash TEXT PRIMARY KEY,principal_id TEXT NOT NULL,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,profile_id TEXT NOT NULL,node_id TEXT NOT NULL,computer_id TEXT NOT NULL,config_hash TEXT NOT NULL,expires_at BIGINT NOT NULL,used_at BIGINT)`,
		`CREATE TABLE IF NOT EXISTS acp_profile_auth_locks(tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,profile_id TEXT NOT NULL,token TEXT NOT NULL,kind TEXT NOT NULL,expires_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,PRIMARY KEY(tenant_id,space_id,profile_id))`,
		`CREATE TABLE IF NOT EXISTS acp_device_auth_attempts(tenant_id TEXT,space_id TEXT,profile_id TEXT,status TEXT)`,
	} {
		if _, err := d.DB.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	rt, err := manager.ensure(context.Background(), "tenant", agent.ID, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	rt.state["authMethods"] = []any{map[string]any{"id": "tty", "type": "terminal", "args": []any{"login", "--interactive"}, "env": map[string]any{"AUTH_TOKEN": "descriptor-secret", "HOME": "/workspace/.zakura/acp/codex/home"}}, map[string]any{"id": "agent", "type": "agent"}}
	rt.mu.Unlock()
	return manager.h, rt, agent, sess, fake
}

func TestACPTerminalAuthExactDescriptorInvocation(t *testing.T) {
	h, _, agent, sess, _ := terminalAuthHarness(t)
	attempt, err := h.resolveACPTerminalAuth(context.Background(), "tenant", agent.ID, sess.ID, "tty")
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(attempt.command, "|")
	if got != "fake-adapter|login|--interactive" || attempt.descriptor.Env["AUTH_TOKEN"] != "descriptor-secret" {
		t.Fatalf("invocation=%q", got)
	}
	for _, id := range []string{"agent", "missing"} {
		if _, err = h.resolveACPTerminalAuth(context.Background(), "tenant", agent.ID, sess.ID, id); err == nil {
			t.Fatalf("accepted nonterminal %s", id)
		}
	}
	for _, method := range []map[string]any{{"type": "terminal", "args": []any{123}}, {"type": "terminal", "env": []any{}}, {"type": "terminal", "env": map[string]any{"BAD=KEY": "x"}}} {
		if _, err = acpReadTerminalAuthDescriptor(method); err == nil {
			t.Fatalf("accepted malformed descriptor %#v", method)
		}
	}
}

func TestACPTerminalAuthTicketReplaySessionBindingAndSecrets(t *testing.T) {
	h, _, agent, sess, _ := terminalAuthHarness(t)
	attempt, err := h.resolveACPTerminalAuth(context.Background(), "tenant", agent.ID, sess.ID, "tty")
	if err != nil {
		t.Fatal(err)
	}
	token, err := h.issueACPTerminalAuth(context.Background(), attempt, acpLoginPrincipal())
	if err != nil {
		t.Fatal(err)
	}
	body, _, _ := strings.Cut(token, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(body)
	var payload map[string]any
	_ = json.Unmarshal(raw, &payload)
	if strings.Contains(string(raw), "descriptor-secret") || strings.Contains(string(raw), "AUTH_TOKEN") || payload["session"] != sess.ID || payload["method"] != "tty" || payload["process"] == "" {
		t.Fatalf("unsafe payload %s", raw)
	}
	if _, err = h.consumeACPTerminalAuth(context.Background(), token, agent.ID, "different-session"); err == nil {
		t.Fatal("cross-session accepted")
	}
	if _, err = h.consumeACPTerminalAuth(context.Background(), token, "different-agent", sess.ID); err == nil {
		t.Fatal("cross-agent accepted")
	}
	if _, err = h.consumeACPTerminalAuth(context.Background(), token, agent.ID, sess.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = h.consumeACPTerminalAuth(context.Background(), token, agent.ID, sess.ID); err == nil {
		t.Fatal("replay accepted")
	}
	_ = h.releaseACPAuthLock(context.Background(), attempt.ticket.Tenant, attempt.ticket.Space, attempt.ticket.Profile, attempt.ticket.Nonce)
}

func TestACPTerminalAuthRejectsAgentBoundCredentialMutation(t *testing.T) {
	h, _, agent, sess, _ := terminalAuthHarness(t)
	_, err := h.deps.DB.Exec(`UPDATE api_keys SET agent_id=? WHERE id='key-tenant'`, agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := h.resolveACPTerminalAuth(context.Background(), "tenant", agent.ID, sess.ID, "tty")
	if err != nil {
		t.Fatal(err)
	}
	p := httpx.Principal{TenantID: "tenant", APIKey: true, APIKeyID: "key-tenant", AgentID: agent.ID}
	if _, err = h.issueACPTerminalAuth(context.Background(), attempt, p); err == nil {
		t.Fatal("Agent key elevated into shared Space credentials")
	}
}

func TestACPTerminalAuthReconnectRequiresOriginalActor(t *testing.T) {
	h, rt, agent, sess, _ := terminalAuthHarness(t)
	attempt, err := h.resolveACPTerminalAuth(context.Background(), "tenant", agent.ID, sess.ID, "tty")
	if err != nil {
		t.Fatal(err)
	}
	attempt.ticket.Principal = "key:key-tenant"
	zero := 0
	if err = h.completeACPTerminalAuth(context.Background(), attempt, &zero); err == nil {
		t.Fatal("terminal reconnect borrowed the session creator without original actor")
	}
	select {
	case <-rt.done:
		t.Fatal("invalid actor closed the existing runtime")
	default:
	}
}

func TestACPTerminalAuthExitZeroReconnectsWithoutAuthenticateRPC(t *testing.T) {
	for _, code := range []int{1, 0} {
		t.Run(string(rune('0'+code)), func(t *testing.T) {
			h, rt, agent, sess, fake := terminalAuthHarness(t)
			attempt, err := h.resolveACPTerminalAuth(context.Background(), "tenant", agent.ID, sess.ID, "tty")
			if err != nil {
				t.Fatal(err)
			}
			attempt.ticket.Principal = "key:key-tenant"
			attempt.actor = acpLoginPrincipal()
			if err = h.completeACPTerminalAuth(context.Background(), attempt, &code); err != nil {
				t.Fatal(err)
			}
			h.acp.mu.Lock()
			current := h.acp.runtimes["tenant\x00"+sess.ID]
			h.acp.mu.Unlock()
			if code == 0 && current == rt {
				t.Fatal("success did not reconnect")
			}
			if code != 0 && current != rt {
				t.Fatal("failure reconnected")
			}
			if fake.has("authenticate") {
				t.Fatal("terminal method issued authenticate RPC")
			}
		})
	}
}

func TestACPTerminalAuthCleanupConfirmsAbsence(t *testing.T) {
	for _, scenario := range []string{"removed", "still-present", "list-failed", "stop-failed"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			ticket := acpLoginTicket{Tenant: "tenant", Space: "space", Profile: "codex", Computer: "computer"}
			name := "unique-login"
			var mu sync.Mutex
			present := true
			h := codemodeToolHarness(t, d, "rnr_cleanup", func(method string, params map[string]any, emit func(string, string, any)) (any, func()) {
				mu.Lock()
				defer mu.Unlock()
				if method == "sys.info" {
					return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}}, nil
				}
				if method == "docker.list" {
					if scenario == "list-failed" {
						return nil, nil
					}
					containers := []acpSidecarContainer{{DockerID: "foreign", Labels: map[string]string{"zakura.login": name}}}
					if present {
						containers = append(containers, acpSidecarContainer{DockerID: "owned", Labels: acpLoginLabels(ticket, name)})
					}
					return containers, nil
				}
				if method == "docker.stop" {
					if params["id"] != "owned" {
						t.Errorf("stopped foreign container: %#v", params)
					}
					if scenario == "removed" {
						present = false
					}
				}
				return map[string]any{"ok": true}, nil
			})
			runner, _ := h.hub.get("node")
			target := &acpLoginTarget{ticket: ticket, runner: runner}
			if scenario == "list-failed" {
				runner.close(errors.New("offline"))
			}
			// stop-failed is represented by an acknowledged stop that is not observed
			// absent, exercising the stronger postcondition over transport success.
			err := h.finalizeACPLoginContainer(target, name)
			if scenario == "removed" && err != nil {
				t.Fatal(err)
			}
			if scenario != "removed" && err == nil {
				t.Fatal("unknown cleanup reported complete")
			}
		})
	}
}

func TestACPTerminalAuthActivatedLeaseCannotExpireIntoTakeover(t *testing.T) {
	h, _, agent, sess, _ := terminalAuthHarness(t)
	attempt, err := h.resolveACPTerminalAuth(context.Background(), "tenant", agent.ID, sess.ID, "tty")
	if err != nil {
		t.Fatal(err)
	}
	token, err := h.issueACPTerminalAuth(context.Background(), attempt, acpLoginPrincipal())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.consumeACPTerminalAuth(context.Background(), token, agent.ID, sess.ID); err != nil {
		t.Fatal(err)
	}
	clock := h.deps.Clock
	h.deps.Clock = func() time.Time { return clock().Add(time.Hour) }
	if err = h.acquireACPAuthLock(context.Background(), "tenant", agent.SpaceID, "codex", "terminal-pending", "replacement", time.Minute); err == nil {
		t.Fatal("expired active terminal lease was stolen")
	}
}

func TestACPTerminalAuthDescriptorChangedAfterTicket(t *testing.T) {
	h, rt, agent, sess, _ := terminalAuthHarness(t)
	attempt, err := h.resolveACPTerminalAuth(context.Background(), "tenant", agent.ID, sess.ID, "tty")
	if err != nil {
		t.Fatal(err)
	}
	token, err := h.issueACPTerminalAuth(context.Background(), attempt, acpLoginPrincipal())
	if err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	rt.state["authMethods"] = []any{map[string]any{"id": "tty", "type": "terminal", "args": []any{"changed"}}}
	rt.mu.Unlock()
	if _, err = h.consumeACPTerminalAuth(context.Background(), token, agent.ID, sess.ID); err == nil {
		t.Fatal("changed descriptor accepted")
	}
	_ = h.releaseACPAuthLock(context.Background(), attempt.ticket.Tenant, attempt.ticket.Space, attempt.ticket.Profile, attempt.ticket.Nonce)
}
