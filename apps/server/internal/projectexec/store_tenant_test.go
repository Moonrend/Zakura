package projectexec

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func TestStoreTenantDrainRejectsInFlightBaselineAndSurvivesFailedDelete(t *testing.T) {
	s := testStore(t)
	p, r := createFixture(t, s, projectFixture())
	ctx := context.Background()
	_, ref := claimFixture(t, s)
	call := mission.ToolCall{ID: "publish", Name: "publish", Effect: "external_write", Arguments: json.RawMessage(`{}`)}
	cp := decisionFixture(t, s, ref, mission.Decision{Tools: []mission.ToolCall{call}, Tokens: 1})
	op, _, e := s.BeginOperation(ctx, ref, cp.ID, call)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.StartOperation(ctx, ref, op.ID, op.Revision); e != nil {
		t.Fatal(e)
	}
	// This request already read the project and began its runner baseline RPC.
	// Releasing the RPC after shutdown must not create a fresh execution run.
	baselineStarted, baselineFinished := make(chan struct{}), make(chan struct{})
	created := make(chan error, 1)
	go func() {
		close(baselineStarted)
		<-baselineFinished
		_, e := s.CreateRun(ctx, p.TenantID, p.ID, "late-baseline", p.Revision)
		created <- e
	}()
	<-baselineStarted
	if e = s.CancelTenant(ctx, p.TenantID); e != nil {
		t.Fatal(e)
	}
	close(baselineFinished)
	if e = <-created; !errors.Is(e, ErrTenantDraining) {
		t.Fatalf("in-flight baseline created a run after shutdown: %v", e)
	}
	if e = s.CancelTenant(ctx, p.TenantID); e != nil {
		t.Fatalf("repeated shutdown is not idempotent: %v", e)
	}
	if _, e = s.CreateProject(ctx, projectFixture()); !errors.Is(e, ErrTenantDraining) {
		t.Fatalf("new project escaped durable shutdown: %v", e)
	}
	if _, e = s.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, p); !errors.Is(e, ErrTenantDraining) {
		t.Fatalf("project configuration changed during shutdown: %v", e)
	}
	if e = s.RequireTenantActive(ctx, nil, p.TenantID); !errors.Is(e, ErrTenantDraining) {
		t.Fatalf("runtime precheck missed shutdown: %v", e)
	}
	// A new Store/process reads the committed fence, independent of local workers.
	restarted := NewStore(s.db, "sqlite", nil)
	if draining, e := restarted.TenantDraining(ctx, p.TenantID); e != nil || !draining {
		t.Fatalf("durable shutdown was lost across restart: %v %v", draining, e)
	}
	if e = s.DeleteProject(ctx, p.TenantID, p.ID, p.Revision); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("unresolved dispatched effect lost its audit: %v", e)
	}
	if draining, e := s.TenantDraining(ctx, p.TenantID); e != nil || !draining {
		t.Fatalf("failed deletion reopened execution: %v %v", draining, e)
	}
	op, e = s.GetOperation(ctx, ref.Scope, r.ID, op.ID)
	if e != nil || op.Status != "unknown" {
		t.Fatalf("shutdown did not preserve unknown outcome: %+v %v", op, e)
	}
	op, e = s.ResolveOperation(ctx, p.TenantID, p.ID, r.ID, op.ID, op.Revision, Resolution{Decision: "not_performed", AuthorID: "operator", Comment: "provider audit confirms no publication"})
	if e != nil || op.Status != "failed" {
		t.Fatalf("shutdown blocked human audit or restarted dispatch: %+v %v", op, e)
	}
	if _, e = s.ForkRun(ctx, p.TenantID, p.ID, r.ID, p.Revision); !errors.Is(e, ErrTenantDraining) {
		t.Fatalf("fork reopened a draining tenant: %v", e)
	}
	if e = s.DeleteProject(ctx, p.TenantID, p.ID, p.Revision); e != nil {
		t.Fatalf("resolved audit prevented requested cleanup: %v", e)
	}
	if _, e = s.CreateProject(ctx, projectFixture()); !errors.Is(e, ErrTenantDraining) {
		t.Fatalf("deleting final project cleared tenant fence: %v", e)
	}
	other := projectFixture()
	other.TenantID, other.SpaceID = "tenant-b", "space-b"
	createFixture(t, s, other)
	if a, e := s.ClaimTask(ctx, "unaffected-worker", time.Minute); e != nil || a == nil || a.Scope.TenantID != "tenant-b" {
		t.Fatalf("unaffected tenant cannot execute: %+v %v", a, e)
	}
}

func TestStoreTenantDrainFiltersSchedulerAndChecksWorkerMutation(t *testing.T) {
	s := testStore(t)
	p, _ := createFixture(t, s, projectFixture())
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	// Isolate the durable fence from lease revocation: a still-valid incarnation
	// cannot reserve a model call merely because its process has not stopped yet.
	if _, e := s.db.ExecContext(ctx, `INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES(?,1,?)`, p.TenantID, stamp(s.now())); e != nil {
		t.Fatal(e)
	}
	if _, e := s.ReserveDecisionBudget(ctx, ref, 10); !errors.Is(e, ErrTenantDraining) {
		t.Fatalf("valid lease bypassed tenant shutdown: %v", e)
	}
	if e := s.RenewLease(ctx, ref, time.Minute); !errors.Is(e, ErrTenantDraining) {
		t.Fatalf("worker renewed within draining tenant: %v", e)
	}
	other := projectFixture()
	other.TenantID, other.SpaceID = "tenant-b", "space-b"
	createFixture(t, s, other)
	if a, e := s.ClaimTask(ctx, "other-worker", time.Minute); e != nil || a == nil || a.Scope.TenantID != "tenant-b" {
		t.Fatalf("draining candidates stalled global scheduling: %+v %v", a, e)
	}
	if a, e := s.ClaimTask(ctx, "idle-worker", time.Minute); e != nil || a != nil {
		t.Fatalf("scheduler reclaimed draining incarnation: %+v %v", a, e)
	}
}
