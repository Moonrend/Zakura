package computers

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestActivityCannotReviveOrReplaceRuntime(t *testing.T) {
	for _, provider := range []Provider{Temporary, E2B, Server} {
		t.Run(string(provider), func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
			execTest(t, s, `UPDATE computers SET provider=? WHERE id='computer-space'`, provider)
			r, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
			if err != nil {
				t.Fatal(err)
			}
			target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
			if err = s.RecordActivity(ctx, target, "chat-space", now); !errors.Is(err, ErrTransitionConflict) {
				t.Fatalf("pending activity: %v", err)
			}
			if err = s.ApproveCreation(ctx, target, r.CreateOperationID, "admin", now); err != nil {
				t.Fatal(err)
			}
			if err = s.CompleteCreation(ctx, target, r.CreateOperationID, "vm1", now); err != nil {
				t.Fatal(err)
			}
			if provider == Server {
				if err = s.RecordActivity(ctx, target, "chat-space", now.Add(2*time.Hour)); err != nil {
					t.Fatal(err)
				}
				got, _ := s.GetRuntime(ctx, target)
				if !got.IdleDeadline.IsZero() || !got.ExpiresAt.IsZero() {
					t.Fatal("persistent runtime received deadline")
				}
				return
			}
			if err = s.RecordActivity(ctx, target, "wrong-chat", now); err == nil {
				t.Fatal("cross-chat renewal")
			}
			stale := target
			stale.Incarnation = "stale"
			if err = s.RecordActivity(ctx, stale, "chat-space", now); err == nil {
				t.Fatal("stale incarnation renewal")
			}
			other := target
			other.TenantID = "other"
			if err = s.RecordActivity(ctx, other, "chat-space", now); err == nil {
				t.Fatal("cross-tenant renewal")
			}
			if err = s.RecordActivity(ctx, target, "chat-space", now.Add(10*time.Minute)); err != nil {
				t.Fatal(err)
			}
			before, err := s.GetRuntime(ctx, target)
			if err != nil {
				t.Fatal(err)
			}
			if err = s.RecordActivity(ctx, target, "chat-space", now.Add(time.Minute)); err != nil {
				t.Fatal(err)
			}
			after, err := s.GetRuntime(ctx, target)
			if err != nil {
				t.Fatal(err)
			}
			if !before.IdleDeadline.Equal(after.IdleDeadline) {
				t.Fatal("out-of-order activity shortened lease")
			}
			for _, minute := range []int{10, 20, 30, 40, 50} {
				if err = s.RecordActivity(ctx, target, "chat-space", now.Add(time.Duration(minute)*time.Minute)); err != nil {
					t.Fatal(err)
				}
			}
			got, err := s.GetRuntime(ctx, target)
			if err != nil {
				t.Fatal(err)
			}
			if !got.ExpiresAt.Equal(now.Add(time.Hour)) || !got.IdleDeadline.Equal(got.ExpiresAt) {
				t.Fatalf("uncapped deadline: %+v", got)
			}
			if err = s.RecordActivity(ctx, target, "chat-space", now.Add(time.Hour)); !errors.Is(err, ErrRuntimeEnded) {
				t.Fatalf("revived: %v", err)
			}
			again, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now.Add(2*time.Hour))
			if err != nil {
				t.Fatal(err)
			}
			if again.ID != r.ID || again.Incarnation != r.Incarnation {
				t.Fatal("silent replacement")
			}
		})
	}
}

func TestActivityIdleExpiryBoundary(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	execTest(t, s, `UPDATE computers SET provider='e2b' WHERE id='computer-space'`)
	r, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if err != nil {
		t.Fatal(err)
	}
	target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	if err = s.ApproveCreation(ctx, target, r.CreateOperationID, "admin", now); err != nil {
		t.Fatal(err)
	}
	if err = s.CompleteCreation(ctx, target, r.CreateOperationID, "vm1", now); err != nil {
		t.Fatal(err)
	}
	r, err = s.GetRuntime(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.RecordActivity(ctx, target, "chat-space", r.IdleDeadline); !errors.Is(err, ErrRuntimeEnded) {
		t.Fatalf("idle revived: %v", err)
	}
}
