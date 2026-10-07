package computers

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

func TestRuntimeReservationAndApproval(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now()
	r, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if err != nil || r.State != PendingApproval {
		t.Fatalf("reserve: %+v %v", r, err)
	}
	again, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if err != nil || again.ID != r.ID || again.CreateOperationID != r.CreateOperationID {
		t.Fatalf("retry changed identity: %+v %v", again, err)
	}
	target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	if err = s.Transition(ctx, target, PendingApproval, Creating, now.Format(time.RFC3339Nano)); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("generic transition bypassed approval: %v", err)
	}
	if err = s.ApproveCreation(ctx, target, r.CreateOperationID, "", now); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("missing approval accepted: %v", err)
	}
	wrong := target
	wrong.TenantID = "other"
	if err = s.ApproveCreation(ctx, wrong, r.CreateOperationID, "admin", now); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("cross tenant: %v", err)
	}
	if err = s.ApproveCreation(ctx, target, "wrong", "admin", now); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("wrong operation: %v", err)
	}
	if err = s.ApproveCreation(ctx, target, r.CreateOperationID, "admin", now); err != nil {
		t.Fatal(err)
	}
	if err = s.ApproveCreation(ctx, target, r.CreateOperationID, "admin", now); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("duplicate provision allowed: %v", err)
	}
	var count int
	if err = s.DB.QueryRow(`SELECT COUNT(*) FROM computer_creation_approvals`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("audit: %d %v", count, err)
	}
	if err = s.Transition(ctx, target, Creating, Unknown, now.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	again, err = s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if err != nil || again.ID != r.ID || again.State != Unknown {
		t.Fatalf("ambiguous create replaced: %+v %v", again, err)
	}
	if err = s.Transition(ctx, target, Unknown, Expired, now.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	again, err = s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if !errors.Is(err, ErrRuntimeEnded) || again.ID != r.ID {
		t.Fatalf("expired silently replaced: %+v %v", again, err)
	}
}

func TestRuntimeReservationScope(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now()
	for _, v := range [][4]string{{"tenant", "space", "computer-space", ""}, {"tenant", "space", "computer-space", "chat-space2"}, {"other", "space", "computer-space", "chat-space"}, {"tenant", "space", "computer-foreign", "chat-space"}} {
		if _, err := s.ReserveRuntime(ctx, v[0], v[1], v[2], v[3], now); err == nil {
			t.Fatalf("invalid scope accepted: %v", v)
		}
	}
	execTest(t, s, `INSERT INTO cloud_agent_sessions(id,tenant_id,agent_id,created_at,updated_at) VALUES('chat-two','tenant','agent-space','now','now')`)
	a, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-two", now)
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == b.ID || a.Incarnation == b.Incarnation {
		t.Fatal("sessions share temporary instance")
	}
}
