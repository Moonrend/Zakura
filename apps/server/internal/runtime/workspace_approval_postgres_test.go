// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func runtimePostgresDeps(t *testing.T) *appdeps.Dependencies {
	t.Helper()
	d := testPostgresDeps(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d.Context, d.Secret = ctx, bytes.Repeat([]byte("p"), 32)
	d.PublicURL = "http://example.test"
	var ids atomic.Int64
	d.NewID = func() string { return fmt.Sprintf("pg-runtime-%06d", ids.Add(1)) }
	return d
}

func TestPostgresToolApprovalConcurrentDecision(t *testing.T) {
	d := runtimePostgresDeps(t)
	seedTenant(t, d, "tenant")
	store, ctx := NewStore(d), context.Background()
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "Approval"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.StartRun(ctx, "tenant", agent.ID, session.ID, "test", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	id, err := store.CreateApproval(ctx, "tenant", agent.ID, session.ID, run.ID, "call", ApprovalRequest{ToolName: "fs_read", Args: json.RawMessage(`{"path":"/note"}`), SpaceID: space.ID, Source: "standard"})
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	start := make(chan struct{})
	for _, decision := range []string{"approved", "denied"} {
		go func() {
			<-start
			results <- store.settleApproval(ctx, "tenant", agent.ID, session.ID, id, decision, "user", false)
		}()
	}
	close(start)
	won := 0
	for range 2 {
		err := <-results
		if err == nil {
			won++
		} else if !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	if won != 1 {
		t.Fatalf("winning decisions=%d", won)
	}
	var events int64
	if err := d.Gorm.Table("cloud_agent_events").Where("session_id=? AND type='tool_approval_resolved'", session.ID).Count(&events).Error; err != nil || events != 1 {
		t.Fatalf("resolved events=%d err=%v", events, err)
	}
	second, err := store.CreateApproval(ctx, "tenant", agent.ID, session.ID, run.ID, "call2", ApprovalRequest{ToolName: "fs_read", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.cancelApprovals(ctx, "tenant", agent.ID, session.ID, run.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.settleApproval(ctx, "tenant", agent.ID, session.ID, second, "approved", "user", false); !errors.Is(err, ErrConflict) {
		t.Fatalf("late approval=%v", err)
	}
}

func TestPostgresWorkspaceConnectionRecovery(t *testing.T) {
	rig := workspaceProxyRigWithDeps(t, runtimePostgresDeps(t))
	ctx := context.Background()
	token := rig.issue(t, "terminal")
	_, claim, _, err := rig.h.consumeSpaceWorkspaceTicket(ctx, token, rig.space.ID, "terminal")
	if err != nil {
		t.Fatal(err)
	}
	claim.release()
	if _, replay, _, err := rig.h.consumeSpaceWorkspaceTicket(ctx, token, rig.space.ID, "terminal"); err == nil {
		replay.release()
		t.Fatal("replayed PostgreSQL ticket")
	}
	lease, row := prepareConnectionFixture(t, rig)
	if err := rig.h.activateWorkspaceConnection(ctx, lease, row, "workspace-stream", "docker.exec.close"); err != nil {
		t.Fatal(err)
	}
	lease.release()
	fresh := &handler{deps: rig.h.deps, store: NewStore(rig.h.deps), hub: rig.h.hub}
	recovery, err := fresh.acquireSpaceWorkspace(ctx, "tenant", rig.space.ID, "migrating", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer recovery.release()
	rig.mu.Lock()
	rig.failClose = true
	rig.mu.Unlock()
	if err := fresh.recoverWorkspaceConnections(ctx, recovery); err == nil {
		t.Fatal("unacknowledged cleanup succeeded")
	}
	var rows int64
	if err := fresh.deps.Gorm.Table("workspace_connections").Where("id=?", row.ID).Count(&rows).Error; err != nil || rows != 1 {
		t.Fatalf("failed cleanup lost intent: rows=%d err=%v", rows, err)
	}
	rig.mu.Lock()
	rig.failClose = false
	rig.mu.Unlock()
	if err := fresh.recoverWorkspaceConnections(ctx, recovery); err != nil {
		t.Fatal(err)
	}
	if err := fresh.deps.Gorm.Table("workspace_connections").Where("id=?", row.ID).Count(&rows).Error; err != nil || rows != 0 {
		t.Fatalf("confirmed cleanup retained intent: rows=%d err=%v", rows, err)
	}
}

func TestPostgresComputerTerminalTicketSingleUse(t *testing.T) {
	d := runtimePostgresDeps(t)
	seedTenant(t, d, "tenant")
	h := newACPResolveHandler(d)
	ctx := context.Background()
	space, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "Attached terminal"})
	if err != nil {
		t.Fatal(err)
	}
	seedTerminalComputer(t, d, space.ID, "attached", `["commands","files","docker","pty"]`)
	router := chi.NewRouter()
	h.registerComputers(router)
	req := httptest.NewRequest(http.MethodPost, "/spaces/"+space.ID+"/computers/attached/terminal-ticket", strings.NewReader(`{}`))
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
	ticket, err := h.verifyComputerTicket(ctx, response.Ticket, space.ID, "attached")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.computerTicketTarget(ctx, ticket); err != nil {
		t.Fatal(err)
	}
	start, results := make(chan struct{}), make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			results <- h.consumeComputerTicket(ctx, ticket, response.Ticket)
		}()
	}
	close(start)
	won := 0
	for range 2 {
		if err := <-results; err == nil {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("ticket redemptions=%d want=1", won)
	}
	if err := h.consumeComputerTicket(ctx, ticket, response.Ticket); err == nil {
		t.Fatal("used PostgreSQL ticket replayed")
	}
	if err := d.Gorm.Table("api_keys").Where("id=?", "key-tenant").Update("revoked_at", runtimeTimeString(h.store.now())).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := h.verifyComputerTicket(ctx, response.Ticket, space.ID, "attached"); err == nil {
		t.Fatal("revoked PostgreSQL actor accepted")
	}
}

func TestPostgresComputerTerminalConnectionRecovery(t *testing.T) {
	rig, ticket, _, clock, _ := attachedTerminalFixtureWithDeps(t, runtimePostgresDeps(t), true)
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
	if err := rig.h.activateWorkspaceConnection(ctx, lease, row, "attached-stream", "docker.exec.close"); err != nil {
		t.Fatal(err)
	}
	lease.release()
	clock.Store(int64(20 * time.Second))
	if err := rig.h.renewComputerTerminal(ctx, ticket); err != nil {
		t.Fatal(err)
	}
	fresh := &handler{deps: rig.h.deps, store: NewStore(rig.h.deps), hub: rig.h.hub}
	claim, err := fresh.acquireSpaceWorkspace(ctx, "tenant", rig.space.ID, "migrating", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer claim.release()
	if err := fresh.recoverWorkspaceConnections(ctx, claim); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := fresh.deps.Gorm.Table("workspace_connections").Where("id=?", row.ID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("attached journal count=%d err=%v", count, err)
	}
}

func TestPostgresWorkspaceCreateReceiptFencing(t *testing.T) {
	rig := workspaceProxyRigWithDeps(t, runtimePostgresDeps(t))
	ctx := context.Background()
	lease, err := rig.h.acquireSpaceInfrastructure(ctx, "tenant", rig.space.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.release()
	runner, err := rig.h.hub.get("node")
	if err != nil {
		t.Fatal(err)
	}
	op, err := rig.h.beginWorkspaceCreate(ctx, lease, runner)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := rig.h.workspaceCreateOperation(ctx, lease.Space)
	if err != nil || loaded == nil || loaded.OperationID != op.OperationID {
		t.Fatalf("durable creation intent=%+v err=%v", loaded, err)
	}
	digest := strings.Repeat("a", 64)
	rig.mu.Lock()
	rig.container.Name = op.Name
	rig.container.Labels["zakura.computer"] = op.ComputerID
	rig.container.Labels["zakura.create-operation"] = op.OperationID
	rig.container.Labels["zakura.create-digest"] = digest
	container := rig.container
	rig.mu.Unlock()
	obs := workspaceObservation{Container: container}
	if err := rig.h.reconcileWorkspaceCreate(ctx, lease, runner, op, obs); err != nil {
		t.Fatal(err)
	}
	loaded, err = rig.h.workspaceCreateOperation(ctx, lease.Space)
	if err != nil || loaded.ConfigDigest == nil || *loaded.ConfigDigest != digest {
		t.Fatalf("receipt digest=%+v err=%v", loaded, err)
	}
	if err := rig.h.deps.Gorm.Table("computer_workspace_leases").Where("space_id=?", rig.space.ID).Update("token", "replacement-claim").Error; err != nil {
		t.Fatal(err)
	}
	if err := rig.h.reconcileWorkspaceCreate(ctx, lease, runner, op, obs); !errors.Is(err, errWorkspaceLeaseLost) {
		t.Fatalf("replaced claim changed creation journal: %v", err)
	}
}
