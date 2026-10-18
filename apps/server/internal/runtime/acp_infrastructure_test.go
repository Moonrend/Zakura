// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func acpInfrastructureRequest(p httpx.Principal, agent, sid, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/acp/authenticate", strings.NewReader(body))
	c := chi.NewRouteContext()
	c.URLParams.Add("id", agent)
	c.URLParams.Add("sid", sid)
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, c)
	return r.WithContext(httpx.WithPrincipal(ctx, p))
}

func assertACPInfrastructureClaims(t *testing.T, h *handler, space string, retained bool) {
	t.Helper()
	var infrastructure, profile int
	if err := h.deps.DB.QueryRow(`SELECT COUNT(*) FROM computer_workspace_leases WHERE tenant_id='tenant' AND space_id=?`, space).Scan(&infrastructure); err != nil {
		t.Fatal(err)
	}
	if err := h.deps.DB.QueryRow(`SELECT COUNT(*) FROM acp_profile_auth_locks WHERE tenant_id='tenant' AND space_id=? AND profile_id='codex' AND kind='protocol' AND node_id='node' AND computer_id<>''`, space).Scan(&profile); err != nil {
		t.Fatal(err)
	}
	want := 0
	if retained {
		want = 1
	}
	if infrastructure != want || profile != want {
		t.Fatalf("claims infrastructure=%d profile=%d, want %d", infrastructure, profile, want)
	}
}

func TestACPInfrastructureStartRejectsExistingProfileWriter(t *testing.T) {
	for _, kind := range []string{"terminal", "device", "protocol"} {
		t.Run(kind, func(t *testing.T) {
			fake := &fakeACPAdapter{}
			manager, agent, session := acpAuthHarness(t, fake)
			ctx := context.Background()
			if err := manager.h.acquireACPAuthLock(ctx, "tenant", agent.SpaceID, "codex", kind, "existing", time.Minute); err != nil {
				t.Fatal(err)
			}
			if kind != "device" {
				// Active/unknown protocol and terminal writers are not stealable,
				// even when their nominal lease time has elapsed.
				if _, err := manager.h.deps.DB.Exec(`UPDATE acp_profile_auth_locks SET expires_at=0`); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := manager.ensure(ctx, "tenant", agent.ID, session.ID); !errors.Is(err, errACPAuthBusy) {
				t.Fatalf("startup overwrote %s writer: %v", kind, err)
			}
			fake.mu.Lock()
			processes := fake.process
			fake.mu.Unlock()
			if processes != 0 {
				t.Fatalf("busy startup created %d processes", processes)
			}
			var token string
			if err := manager.h.deps.DB.QueryRow(`SELECT token FROM acp_profile_auth_locks`).Scan(&token); err != nil || token != "existing" {
				t.Fatalf("writer replaced: %q %v", token, err)
			}
			var claims int
			_ = manager.h.deps.DB.QueryRow(`SELECT COUNT(*) FROM computer_workspace_leases`).Scan(&claims)
			if claims != 0 {
				t.Fatal("side-effect-free rejection leaked infrastructure claim")
			}
		})
	}
}

func TestACPInfrastructureStartRetainsUnknownEffects(t *testing.T) {
	for _, phase := range []string{"prepare", "create", "attach", "host-start"} {
		t.Run(phase, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			var h *handler
			var reached atomic.Bool
			h = builtinToolHarness(t, d, "rnr_acp-infrastructure", func(method string, params map[string]any) (any, error) {
				switch method {
				case "sys.info":
					return map[string]any{"storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "privateAtomicFS": true, "filesystemNoFollowStat": true}}, nil
				case "host.fs.list":
					return map[string]any{"entries": []any{}}, nil
				case "host.fs.mkdir", "host.fs.write", "docker.pull", "docker.create", "docker.attach", "host.pty.start":
					space, _ := params["spaceId"].(string)
					if space == "" {
						_ = d.DB.QueryRow(`SELECT space_id FROM computer_workspace_leases`).Scan(&space)
					}
					assertACPInfrastructureClaims(t, h, space, true)
					if lease, err := h.acquireSpaceInfrastructure(context.Background(), "tenant", space); err == nil {
						lease.release()
						t.Error("startup allowed concurrent migration/configuration claim")
					}
					if err := h.acquireACPAuthLock(context.Background(), "tenant", space, "codex", "device", "racing", time.Minute); !errors.Is(err, errACPAuthBusy) {
						t.Errorf("startup did not fence profile writer: %v", err)
					}
					if (phase == "prepare" && method == "host.fs.mkdir") || (phase == "create" && method == "docker.create") {
						reached.Store(true)
						return nil, fmt.Errorf("unconfirmed %s", phase)
					}
					if method == "docker.attach" || method == "host.pty.start" {
						reached.Store(true)
						return map[string]any{}, nil // unknown start: no process ID
					}
					if method == "docker.create" {
						return map[string]any{"dockerId": "adapter"}, nil
					}
					return map[string]any{"abs": "/srv/zakura/space", "mode": 384, "atomic": true}, nil
				case "docker.stop":
					return nil, fmt.Errorf("cleanup unconfirmed")
				default:
					return nil, fmt.Errorf("unexpected method %s", method)
				}
			})
			node := "node"
			space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
			if err != nil {
				t.Fatal(err)
			}
			agent, err := h.store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
			if err != nil {
				t.Fatal(err)
			}
			session, err := h.store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{Kind: "acp"})
			if err != nil {
				t.Fatal(err)
			}
			profile := map[string]any{"command": "fake-adapter"}
			if phase != "host-start" {
				profile["image"] = "fixture-adapter"
			}
			manager := &acpRuntimeManager{h: h}
			if _, err = manager.start(context.Background(), "tenant", agent.ID, session.ID, "codex", "", session, profile); err == nil {
				t.Fatal("unknown effect reported success")
			}
			if !reached.Load() {
				t.Fatal("fixture never reached target failure")
			}
			assertACPInfrastructureClaims(t, h, space.ID, true)
			if _, err = d.DB.Exec(`UPDATE acp_profile_auth_locks SET expires_at=0`); err != nil {
				t.Fatal(err)
			}
			if err = h.acquireACPAuthLock(context.Background(), "tenant", space.ID, "codex", "device", "replacement", time.Minute); !errors.Is(err, errACPAuthBusy) {
				t.Fatalf("expired unknown writer stolen: %v", err)
			}
		})
	}
}

func TestACPInfrastructureProtocolRejectsAgentKeysBeforeEnsure(t *testing.T) {
	h := &handler{} // denial must not access DB, runtime cache, or remote target
	for _, call := range []func(http.ResponseWriter, *http.Request){h.acpAuthenticate, h.acpLogout} {
		w := httptest.NewRecorder()
		call(w, acpInfrastructureRequest(httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: "agent"}, "agent", "session", `{"methodId":"login"}`))
		if w.Code != http.StatusNotFound {
			t.Fatalf("Agent-bound shared HOME mutation returned %d", w.Code)
		}
	}
}

func TestACPInfrastructureProtocolClaimsAndUnknown(t *testing.T) {
	for _, operation := range []string{"authenticate", "logout"} {
		for _, outcome := range []string{"success", "busy", "unknown"} {
			t.Run(operation+"/"+outcome, func(t *testing.T) {
				fake := &fakeACPAdapter{}
				manager, agent, session := acpAuthHarness(t, fake)
				h := manager.h
				h.acp = manager
				if _, err := manager.ensure(context.Background(), "tenant", agent.ID, session.ID); err != nil {
					t.Fatal(err)
				}
				assertACPInfrastructureClaims(t, h, agent.SpaceID, false)
				if outcome == "busy" {
					if err := h.acquireACPAuthLock(context.Background(), "tenant", agent.SpaceID, "codex", "terminal", "existing", time.Minute); err != nil {
						t.Fatal(err)
					}
				}
				var reached atomic.Bool
				fake.onRPC = func(process string, rpc map[string]any, send func(any)) bool {
					if rpc["method"] != operation {
						return false
					}
					reached.Store(true)
					assertACPInfrastructureClaims(t, h, agent.SpaceID, true)
					if outcome == "unknown" {
						send(map[string]any{"jsonrpc": "2.0", "id": rpc["id"], "error": map[string]any{"code": -32603, "message": "credential write outcome unknown"}})
						return true
					}
					return false
				}
				w := httptest.NewRecorder()
				r := acpInfrastructureRequest(httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: agent.SpaceID}, agent.ID, session.ID, `{"methodId":"login"}`)
				if operation == "authenticate" {
					h.acpAuthenticate(w, r)
				} else {
					h.acpLogout(w, r)
				}
				if outcome == "busy" {
					if w.Code != http.StatusConflict || reached.Load() {
						t.Fatalf("busy writer reached RPC or faked success: %d", w.Code)
					}
					return
				}
				if !reached.Load() {
					t.Fatalf("protocol RPC not reached: %d %s", w.Code, w.Body.String())
				}
				if outcome == "unknown" {
					if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "outcome unknown") {
						t.Fatalf("unknown RPC faked success: %d %s", w.Code, w.Body.String())
					}
					assertACPInfrastructureClaims(t, h, agent.SpaceID, true)
				} else {
					if w.Code != http.StatusOK {
						t.Fatalf("confirmed RPC failed: %d %s", w.Code, w.Body.String())
					}
					assertACPInfrastructureClaims(t, h, agent.SpaceID, false)
				}
			})
		}
	}
}
