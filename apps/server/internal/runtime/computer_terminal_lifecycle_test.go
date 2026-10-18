// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func attachedTerminalFixture(t *testing.T, temporary bool) (*workspaceProxyRig, workspaceConnectionTicket, string, *atomic.Int64, time.Time) {
	t.Helper()
	return attachedTerminalFixtureWithDeps(t, testDeps(t), temporary)
}

func attachedTerminalFixtureWithDeps(t *testing.T, d *appdeps.Dependencies, temporary bool) (*workspaceProxyRig, workspaceConnectionTicket, string, *atomic.Int64, time.Time) {
	t.Helper()
	base := time.Now().UTC().Truncate(time.Second)
	clock := &atomic.Int64{}
	d.Clock = func() time.Time { return base.Add(time.Duration(clock.Load())) }
	rig := workspaceProxyRigWithDeps(t, d)
	seedTerminalComputer(t, d, rig.space.ID, "attached", `["commands","files","docker","pty"]`)
	if err := d.Gorm.Table("computers").Where("id=?", "attached").Update("runtime_node_id", "node").Error; err != nil {
		t.Fatal(err)
	}
	session := ""
	if temporary {
		a, err := rig.h.store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: rig.space.ID})
		if err != nil {
			t.Fatal(err)
		}
		s, err := rig.h.store.CreateSession(context.Background(), "tenant", "", a.ID, Session{})
		if err != nil {
			t.Fatal(err)
		}
		session = s.ID
		if err := d.Gorm.Table("computers").Where("id=?", "attached").Updates(map[string]any{"provider": computers.Temporary, "idle_seconds": 30, "max_lifetime_seconds": 120}).Error; err != nil {
			t.Fatal(err)
		}
		if err := d.Gorm.Table("computer_runtimes").Where("computer_id=?", "attached").Updates(map[string]any{"session_scope": session, "idle_deadline": runtimeTimeString(base.Add(30 * time.Second)), "expires_at": runtimeTimeString(base.Add(120 * time.Second))}).Error; err != nil {
			t.Fatal(err)
		}
	}
	router := chi.NewRouter()
	rig.h.registerComputers(router)
	req := httptest.NewRequest(http.MethodPost, "/spaces/"+rig.space.ID+"/computers/attached/terminal-ticket", strings.NewReader(fmt.Sprintf(`{"sessionId":%q}`, session)))
	req = req.WithContext(httpx.WithPrincipal(req.Context(), acpLoginPrincipal()))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("ticket=%d %s", w.Code, w.Body)
	}
	var response struct{ Ticket string }
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	ticket, err := rig.h.verifyComputerTicket(context.Background(), response.Ticket, rig.space.ID, "attached")
	if err != nil {
		t.Fatal(err)
	}
	return rig, ticket, response.Ticket, clock, base
}

func TestComputerTerminalConnectionJournalLifecycle(t *testing.T) {
	for _, scenario := range []string{"computer", "space", "cleanup-failure", "executor-replaced"} {
		t.Run(scenario, func(t *testing.T) {
			rig, ticket, token, _, _ := attachedTerminalFixture(t, false)
			router := chi.NewRouter()
			router.Get("/api/spaces/{id}/computers/{cid}/terminal-proxy", rig.h.computerTerminalProxy)
			server := httptest.NewServer(router)
			defer server.Close()
			u, _ := url.Parse(server.URL)
			conn, err := net.Dial("tcp", u.Host)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
			_, _ = fmt.Fprintf(conn, "GET /api/spaces/%s/computers/attached/terminal-proxy?token=%s HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", rig.space.ID, url.QueryEscape(token), u.Host)
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, &http.Request{Method: "GET"})
			if err != nil || response.StatusCode != 101 {
				t.Fatalf("upgrade=%v err=%v", response, err)
			}
			ready, err := readRunnerServerText(reader)
			if err != nil || !strings.Contains(ready, `"type":"ready"`) {
				t.Fatalf("ready=%s err=%v", ready, err)
			}
			var row workspaceConnection
			if err := rig.h.deps.Gorm.Table("workspace_connections").Where("space_id=?", rig.space.ID).Take(&row).Error; err != nil {
				t.Fatal(err)
			}
			if row.Kind != "computer_terminal" || row.State != "active" || row.ComputerID == nil || *row.ComputerID != ticket.ComputerID || row.RuntimeID == nil || *row.RuntimeID != ticket.RuntimeID || row.Incarnation == nil || *row.Incarnation != ticket.Incarnation || row.StreamID == nil || *row.StreamID != "workspace-stream" || row.StreamOwner != "fixture-executor" {
				t.Fatalf("unbound journal=%+v", row)
			}
			rig.mu.Lock()
			rig.failClose = scenario == "cleanup-failure" || scenario == "executor-replaced"
			rig.mu.Unlock()
			computer := "attached"
			if scenario == "space" {
				computer = ""
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := rig.h.closeOwnerWorkspaceBridges(ctx, "tenant", rig.space.ID, computer); err != nil {
				t.Fatal(err)
			}
			var count int64
			if err := rig.h.deps.Gorm.Table("workspace_connections").Where("id=?", row.ID).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			failed := scenario == "cleanup-failure" || scenario == "executor-replaced"
			if (count == 1) != failed {
				t.Fatalf("remaining journal=%d failed=%v", count, failed)
			}
			if failed {
				claim, err := rig.h.acquireSpaceWorkspace(ctx, "tenant", rig.space.ID, "deleting", false, nil)
				if err != nil {
					t.Fatal(err)
				}
				defer claim.release()
				if scenario == "executor-replaced" {
					rig.mu.Lock()
					rig.owner, rig.failClose = "replacement-executor", false
					rig.mu.Unlock()
				}
				if err := rig.h.recoverOwnerWorkspaceConnections(ctx, claim, "attached"); err == nil {
					t.Fatal("unconfirmed cleanup permitted deletion")
				}
				if err := rig.h.deps.Gorm.Table("workspace_connections").Where("id=?", row.ID).Count(&count).Error; err != nil || count != 1 {
					t.Fatalf("uncertain journal lost: count=%d err=%v", count, err)
				}
			}
		})
	}
}

func TestComputerTerminalAllocationCannotRaceAttachedDeletion(t *testing.T) {
	rig, ticket, _, _, _ := attachedTerminalFixture(t, true)
	ctx := context.Background()
	exec, _, err := rig.h.computerTicketTarget(ctx, ticket)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := rig.h.acquireSpaceInfrastructure(ctx, "tenant", rig.space.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.release()
	if err = rig.h.deps.Gorm.Table("computers").Where("id=?", "attached").Update("deletion_pending", true).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = rig.h.beginComputerTerminalConnection(ctx, lease, exec); err == nil {
		t.Fatal("terminal allocation bypassed attached deletion fence")
	}
	var count int64
	if err = rig.h.deps.Gorm.Table("workspace_connections").Where("computer_id=?", "attached").Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("late terminal journal: %d %v", count, err)
	}
}

func TestComputerTerminalDeletionRequiresConfirmedCleanup(t *testing.T) {
	for _, scenario := range []string{"confirmed", "lost-allocation-reply", "cleanup-failure", "executor-replaced"} {
		t.Run(scenario, func(t *testing.T) {
			rig, ticket, _, _, _ := attachedTerminalFixture(t, true)
			ctx := context.Background()
			exec, _, err := rig.h.computerTicketTarget(ctx, ticket)
			if err != nil {
				t.Fatal(err)
			}
			lease, err := rig.h.acquireSpaceInfrastructure(ctx, "tenant", rig.space.ID)
			if err != nil {
				t.Fatal(err)
			}
			row, err := rig.h.beginComputerTerminalConnection(ctx, lease, exec)
			if err != nil {
				t.Fatal(err)
			}
			if scenario != "lost-allocation-reply" {
				if err := rig.h.activateWorkspaceConnection(ctx, lease, row, "attached-stream", "docker.exec.close"); err != nil {
					t.Fatal(err)
				}
			}
			lease.release()
			// An unrelated uncertain workspace connection cannot be cleared by
			// deletion of just this attached computer.
			unrelated := *row
			unrelated.ID, unrelated.Kind = "unrelated-workspace", "terminal"
			unrelated.ComputerID, unrelated.RuntimeID, unrelated.Incarnation = nil, nil, nil
			if err := rig.h.deps.Gorm.Table("workspace_connections").Create(&unrelated).Error; err != nil {
				t.Fatal(err)
			}
			rig.mu.Lock()
			rig.failClose = scenario == "cleanup-failure"
			if scenario == "executor-replaced" {
				rig.owner = "replacement"
			}
			rig.mu.Unlock()
			err = rig.h.prepareComputerDeletion(ctx, "tenant", rig.space.ID, "attached")
			confirmed := scenario == "confirmed"
			if (err == nil) != confirmed {
				t.Fatalf("deletion=%v confirmed=%v", err, confirmed)
			}
			var count int64
			if err := rig.h.deps.Gorm.Table("workspace_connections").Where("id=?", row.ID).Count(&count).Error; err != nil || (count == 0) != confirmed {
				t.Fatalf("journal count=%d err=%v", count, err)
			}
			if err := rig.h.deps.Gorm.Table("workspace_connections").Where("id=?", unrelated.ID).Count(&count).Error; err != nil || count != 1 {
				t.Fatal("attached deletion touched the workspace connection")
			}
			if !confirmed {
				if err := rig.h.deps.Gorm.Table("computer_cleanup_intents").Count(&count).Error; err != nil || count != 0 {
					t.Fatalf("uncertain stream queued destruction: %d %v", count, err)
				}
			}
		})
	}
}

func TestComputerTerminalActivityAndRevocation(t *testing.T) {
	for _, scenario := range []string{"renew", "maximum", "expired-idle", "expired-maximum", "revoked-key", "changed-incarnation", "capability-removed", "computer-deleting", "space-deleting", "migrating"} {
		t.Run(scenario, func(t *testing.T) {
			rig, ticket, token, clock, base := attachedTerminalFixture(t, true)
			ctx := context.Background()
			if err := rig.h.consumeComputerTicket(ctx, ticket, token); err != nil {
				t.Fatal(err)
			}
			clock.Store(int64(20 * time.Second))
			var err error
			switch scenario {
			case "expired-idle":
				clock.Store(int64(31 * time.Second))
			case "maximum", "expired-maximum":
				err = rig.h.deps.Gorm.Table("computer_runtimes").Where("computer_id=?", "attached").Update("idle_deadline", runtimeTimeString(base.Add(119*time.Second))).Error
				clock.Store(int64(110 * time.Second))
				if scenario == "expired-maximum" {
					clock.Store(int64(121 * time.Second))
				}
			case "revoked-key":
				err = rig.h.deps.Gorm.Table("api_keys").Where("id=?", "key-tenant").Update("revoked_at", runtimeTimeString(base)).Error
			case "changed-incarnation":
				err = rig.h.deps.Gorm.Table("computer_runtimes").Where("computer_id=?", "attached").Update("incarnation", "replacement").Error
			case "capability-removed":
				err = rig.h.deps.Gorm.Table("computers").Where("id=?", "attached").Update("capabilities_json", `["commands"]`).Error
			case "computer-deleting":
				err = rig.h.deps.Gorm.Table("computers").Where("id=?", "attached").Update("deletion_pending", true).Error
			case "space-deleting":
				err = rig.h.deps.Gorm.Table("spaces").Where("id=?", rig.space.ID).Update("deletion_pending", true).Error
			case "migrating":
				claim, e := rig.h.acquireSpaceWorkspace(ctx, "tenant", rig.space.ID, "migrating", false, nil)
				err = e
				if claim != nil {
					defer claim.release()
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			err = rig.h.renewComputerTerminal(ctx, ticket)
			valid := scenario == "renew" || scenario == "maximum"
			if (err == nil) != valid {
				t.Fatalf("renew=%v valid=%v", err, valid)
			}
			var runtime computers.Runtime
			target := computers.Target{TenantID: "tenant", SpaceID: rig.space.ID, ComputerID: "attached", RuntimeID: ticket.RuntimeID, Incarnation: ticket.Incarnation}
			if scenario != "changed-incarnation" {
				runtime, err = rig.h.computerStore().GetRuntime(ctx, target)
				if err != nil {
					t.Fatal(err)
				}
				want := base.Add(30 * time.Second)
				if scenario == "renew" {
					want = base.Add(50 * time.Second)
				} else if scenario == "maximum" {
					want = base.Add(120 * time.Second)
				} else if scenario == "expired-maximum" {
					want = base.Add(119 * time.Second)
				}
				if !runtime.IdleDeadline.Equal(want) || !runtime.ExpiresAt.Equal(base.Add(120*time.Second)) {
					t.Fatalf("lifetime=%s/%s want idle=%s", runtime.IdleDeadline, runtime.ExpiresAt, want)
				}
			}
			if !valid {
				server, client := net.Pipe()
				defer server.Close()
				defer client.Close()
				bridge := &workspaceBridge{conn: server, done: make(chan struct{})}
				ticks := make(chan time.Time, 1)
				ticks <- time.Now()
				finished := make(chan struct{})
				go func() {
					defer close(finished)
					rig.h.watchComputerTerminal(ctx, bridge, ticket, ticks)
				}()
				select {
				case <-finished:
				case <-time.After(time.Second):
					t.Fatal("revoked terminal stayed open")
				}
				if _, err := client.Read(make([]byte, 1)); err != io.EOF {
					t.Fatalf("revoked connection read=%v", err)
				}
			}
		})
	}
}
