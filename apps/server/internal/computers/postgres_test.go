package computers

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/pgtest"
)

func testPostgresStore(t *testing.T) Store {
	t.Helper()
	url := pgtest.FreshURL(t, pgtest.URL(t), "computers")
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.DB.Close() })
	if conn.Dialect != "postgres" {
		t.Fatalf("expected postgres dialect, got %q", conn.Dialect)
	}
	if err := migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatal(err)
	}
	s := Store{DB: conn.DB, Rebind: conn.Rebind}
	seedComputerFixtures(t, s)
	return s
}

func TestPostgresDefaultsAndSnapshots(t *testing.T) {
	checkDefaultsAndSnapshots(t, testPostgresStore(t))
}

func TestPostgresServerComputerInvariants(t *testing.T) {
	checkServerComputerInvariants(t, testPostgresStore(t))
}

func TestPostgresRuntimeLifecycle(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	execTest(t, s, `UPDATE computers SET provider='e2b' WHERE id='computer-space'`)
	r, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if err != nil || r.State != PendingApproval {
		t.Fatalf("reserve: %+v %v", r, err)
	}
	again, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if err != nil || again.ID != r.ID || again.CreateOperationID != r.CreateOperationID {
		t.Fatalf("reserve retry changed identity: %+v %v", again, err)
	}
	target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	if err = s.ApproveCreation(ctx, target, r.CreateOperationID, "admin", now); err != nil {
		t.Fatal(err)
	}
	if err = s.CompleteCreation(ctx, target, r.CreateOperationID, CreationResult{ExternalID: "vm1", RootPath: ""}, now); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetRuntime(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != Ready || got.ExternalID != "vm1" || got.RootPath != "" {
		t.Fatalf("completion: %+v", got)
	}
	active, err := s.ActiveRuntime(ctx, "tenant", "space", "computer-space", "chat-space")
	if err != nil || active.ID != r.ID {
		t.Fatalf("active runtime: %+v %v", active, err)
	}
	c := Computer{ID: "computer-space", TenantID: "tenant", SpaceID: "space", Provider: E2B, Capabilities: []Capability{Commands}}
	if err = CheckTarget(target, c, got, "chat-space", Commands, false, now); err != nil {
		t.Fatalf("check target: %v", err)
	}
	if err = s.RecordActivity(ctx, target, "chat-space", now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	renewed, err := s.GetRuntime(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	if !renewed.IdleDeadline.After(got.IdleDeadline) {
		t.Fatalf("activity did not renew idle deadline: %+v", renewed)
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	for i := 0; i < 2; i++ {
		if err = s.PinExecution(ctx, "job1", "run1", "call1", target, stamp); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.PinExecution(ctx, "job1", "run1", "call2", target, stamp); err == nil {
		t.Fatal("reused execution binding for another tool call")
	}
	if pinned, err := s.ExecutionTarget(ctx, "tenant", "space", "run1", "job1"); err != nil || pinned != target {
		t.Fatalf("execution target: %+v %v", pinned, err)
	}
	for _, scope := range [][3]string{{"other", "space", "run1"}, {"tenant", "space2", "run1"}, {"tenant", "space", "run2"}} {
		if _, err := s.ExecutionTarget(ctx, scope[0], scope[1], scope[2], "job1"); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("execution binding leak: %v", err)
		}
	}
	if err = s.Transition(ctx, target, Ready, Expired, stamp); err != nil {
		t.Fatal(err)
	}
	if err = s.Transition(ctx, target, Expired, Ready, stamp); err == nil {
		t.Fatal("expired runtime restarted")
	}
	revived, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if !errors.Is(err, ErrRuntimeEnded) || revived.ID != r.ID {
		t.Fatalf("expired runtime silently replaced: %+v %v", revived, err)
	}
}

func TestPostgresCleanup(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	past := now.Add(-time.Minute).Format(time.RFC3339Nano)
	execTest(t, s, runtimeInsert, "rt-e2b", "tenant", "space", "computer-space", "chat-space", "inc-e", "op-e", "ready", "ctr-e", past, past)
	got, err := s.CollectExpiredRuntimes(ctx, now, 10)
	if err != nil || len(got) != 1 || got[0].ID != "rt-e2b" {
		t.Fatalf("collected: %+v %v", got, err)
	}
	deps := CleanupDeps{Store: s, Now: func() time.Time { return now }}
	destroyed, expired, err := deps.ExpireOverdue(ctx, 10)
	if err != nil || destroyed != 0 || expired != 1 {
		t.Fatalf("destroyed=%d expired=%d err=%v", destroyed, expired, err)
	}
	var state string
	if err := s.DB.QueryRow(s.query(`SELECT state FROM computer_runtimes WHERE id=?`), "rt-e2b").Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(Expired) {
		t.Fatalf("expired runtime state: %s", state)
	}
}
