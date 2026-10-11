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
			root := ""
			if provider == Server {
				root = "computer-root"
			}
			execTest(t, s, `UPDATE computers SET provider=? WHERE id='computer-space'`, provider)
			r, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
			if err != nil {
				t.Fatal(err)
			}
			target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
			if err = s.CompleteCreation(ctx, target, r.CreateOperationID, CreationResult{ExternalID: "vm1", RootPath: root}, now); !errors.Is(err, ErrTransitionConflict) {
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
				if err = s.CompleteCreation(ctx, invalid, r.CreateOperationID, CreationResult{ExternalID: "vm1", RootPath: root}, now); !errors.Is(err, ErrTransitionConflict) {
					t.Fatalf("invalid target: %v", err)
				}
				if _, err = s.GetRuntime(ctx, invalid); !errors.Is(err, sql.ErrNoRows) {
					t.Fatalf("runtime identity leak: %v", err)
				}
			}
			if err = s.CompleteCreation(ctx, target, "wrong", CreationResult{ExternalID: "vm1", RootPath: root}, now); !errors.Is(err, ErrTransitionConflict) {
				t.Fatalf("wrong operation: %v", err)
			}
			if err = s.CompleteCreation(ctx, target, r.CreateOperationID, CreationResult{ExternalID: " ", RootPath: root}, now); err == nil {
				t.Fatal("empty provider ID accepted")
			}
			if err = s.Transition(ctx, target, Creating, Unknown, now.Format(time.RFC3339Nano)); err != nil {
				t.Fatal(err)
			}
			completed := now.Add(50 * time.Minute)
			if err = s.CompleteCreation(ctx, target, r.CreateOperationID, CreationResult{ExternalID: "vm1", RootPath: root}, completed); err != nil {
				t.Fatal(err)
			}
			got, err := s.GetRuntime(ctx, target)
			if err != nil {
				t.Fatal(err)
			}
			if got.State != Ready || got.ExternalID != "vm1" {
				t.Fatalf("bad completion: %+v", got)
			}
			if got.RootPath != root {
				t.Fatalf("bad root path: %q", got.RootPath)
			}
			var capabilities string
			if err = s.DB.QueryRow(s.query(`SELECT capabilities_json FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), r.TenantID, r.SpaceID, r.ComputerID).Scan(&capabilities); err != nil {
				t.Fatal(err)
			}
			want := map[Provider]string{
				Server:      `["commands","files","docker"]`,
				Temporary:   `["commands","files"]`,
				E2B:         `["commands"]`,
				Railway:     `["commands"]`,
				SSH:         `["commands"]`,
				RemoteAgent: `[]`,
			}[provider]
			if capabilities != want {
				t.Fatalf("capabilities %q, want %q", capabilities, want)
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
			if err = s.CompleteCreation(ctx, target, r.CreateOperationID, CreationResult{ExternalID: "vm2", RootPath: root}, completed.Add(time.Minute)); !errors.Is(err, ErrTransitionConflict) {
				t.Fatalf("replayed completion: %v", err)
			}
			again, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", completed)
			if err != nil {
				t.Fatal(err)
			}
			if again.ExternalID != "vm1" || again.RootPath != got.RootPath || !again.ExpiresAt.Equal(got.ExpiresAt) {
				t.Fatalf("identity/lifetime changed: %+v", again)
			}
		})
	}
}

func TestCompleteCreationPersistsSealedAccessToken(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	execTest(t, s, `UPDATE computers SET provider='e2b' WHERE id='computer-space'`)
	r, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if err != nil {
		t.Fatal(err)
	}
	target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	if err = s.ApproveCreation(ctx, target, r.CreateOperationID, "admin", now); err != nil {
		t.Fatal(err)
	}
	sealed, err := SealCredentials([]byte("test-secret"), r.TenantID, r.SpaceID, r.ComputerID, []byte(`{"envdAccessToken":"tok"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.CompleteCreation(ctx, target, r.CreateOperationID, CreationResult{ExternalID: "vm1", AccessTokenEnc: sealed}, now); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetRuntime(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	if got.AccessTokenEnc != sealed {
		t.Fatalf("access token not persisted: %q", got.AccessTokenEnc)
	}
}

func TestCompleteCreationRejectsPlaintextAccessToken(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	execTest(t, s, `UPDATE computers SET provider='e2b' WHERE id='computer-space'`)
	r, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
	if err != nil {
		t.Fatal(err)
	}
	target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	if err = s.ApproveCreation(ctx, target, r.CreateOperationID, "admin", now); err != nil {
		t.Fatal(err)
	}
	if err = s.CompleteCreation(ctx, target, r.CreateOperationID, CreationResult{ExternalID: "vm1", AccessTokenEnc: "plaintext-token"}, now); err == nil {
		t.Fatal("plaintext access token accepted")
	}
}
