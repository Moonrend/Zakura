package computers

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

func TestCompleteCreationPinsInstanceAndLifetime(t *testing.T) {
	for _, provider := range []Provider{E2B, Temporary, Server, RemoteAgent, SSH, Railway} {
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
			if err = s.CompleteCreation(ctx, target, r.CreateOperationID, "vm1", now); !errors.Is(err, ErrTransitionConflict) {
				t.Fatalf("unapproved completion: %v", err)
			}
			if err = s.ApproveCreation(ctx, target, r.CreateOperationID, "admin", now); err != nil {
				t.Fatal(err)
			}
			if err = s.Transition(ctx, target, Creating, Ready, now.Format(time.RFC3339Nano)); err == nil {
				t.Fatal("generic completion bypassed instance binding")
			}
			for _, invalid := range []Target{
				{TenantID: "other", SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation},
				{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: "stale"},
			} {
				if err = s.CompleteCreation(ctx, invalid, r.CreateOperationID, "vm1", now); !errors.Is(err, ErrTransitionConflict) {
					t.Fatalf("invalid target: %v", err)
				}
				if _, err = s.GetRuntime(ctx, invalid); !errors.Is(err, sql.ErrNoRows) {
					t.Fatalf("runtime identity leak: %v", err)
				}
			}
			if err = s.CompleteCreation(ctx, target, "wrong", "vm1", now); !errors.Is(err, ErrTransitionConflict) {
				t.Fatalf("wrong operation: %v", err)
			}
			if err = s.CompleteCreation(ctx, target, r.CreateOperationID, " ", now); err == nil {
				t.Fatal("empty provider ID accepted")
			}
			if err = s.Transition(ctx, target, Creating, Unknown, now.Format(time.RFC3339Nano)); err != nil {
				t.Fatal(err)
			}
			completed := now.Add(50 * time.Minute)
			if err = s.CompleteCreation(ctx, target, r.CreateOperationID, "vm1", completed); err != nil {
				t.Fatal(err)
			}
			got, err := s.GetRuntime(ctx, target)
			if err != nil {
				t.Fatal(err)
			}
			if got.State != Ready || got.ExternalID != "vm1" {
				t.Fatalf("bad completion: %+v", got)
			}
			if (Computer{Provider: provider}).SessionScoped() {
				if !got.ExpiresAt.Equal(now.Add(time.Hour)) || !got.IdleDeadline.Equal(got.ExpiresAt) {
					t.Fatalf("lifetime renewed or idle uncapped: %+v", got)
				}
				c := Computer{ID: r.ComputerID, TenantID: r.TenantID, SpaceID: r.SpaceID, Provider: provider, Capabilities: []Capability{Commands}}
				if err = CheckTarget(target, c, got, "chat-space", Commands, false, got.ExpiresAt); err == nil {
					t.Fatal("expired execution permitted")
				}
			} else if !got.ExpiresAt.IsZero() || !got.IdleDeadline.IsZero() {
				t.Fatal("persistent instance expires")
			}
			if err = s.CompleteCreation(ctx, target, r.CreateOperationID, "vm2", completed.Add(time.Minute)); !errors.Is(err, ErrTransitionConflict) {
				t.Fatalf("replayed completion: %v", err)
			}
			again, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", completed)
			if err != nil {
				t.Fatal(err)
			}
			if again.ExternalID != "vm1" || !again.ExpiresAt.Equal(got.ExpiresAt) {
				t.Fatalf("identity/lifetime changed: %+v", again)
			}
		})
	}
}
