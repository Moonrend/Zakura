// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func TestToolApprovalAccessRevocationScopesAndSettlesOnce(t *testing.T) {
	testToolApprovalAccessRevocation(t, testDeps)
}

func TestPostgresToolApprovalAccessRevocation(t *testing.T) {
	testToolApprovalAccessRevocation(t, runtimePostgresDeps)
}

func testToolApprovalAccessRevocation(t *testing.T, deps func(*testing.T) *appdeps.Dependencies) {
	t.Helper()
	for _, action := range []string{"tenant", "member"} {
		t.Run(action, func(t *testing.T) {
			d := deps(t)
			store := NewStore(d)
			h := &handler{deps: d, store: store, service: NewService(store)}
			ctx := context.Background()
			for _, tenant := range []string{"tenant", "other-tenant"} {
				seedTenant(t, d, tenant)
			}
			for _, user := range []string{"removed-user", "other-user"} {
				now := runtimeTimeString(store.now())
				if err := d.Gorm.Table("users").Create(map[string]any{"id": user, "email": user + "@example.test", "password_hash": "unused", "status": "active", "created_at": now, "updated_at": now}).Error; err != nil {
					t.Fatal(err)
				}
			}
			type pending struct {
				tenant, user, agent, session, id string
			}
			var approvals []pending
			for _, tenant := range []string{"tenant", "other-tenant"} {
				space, err := store.CreateSpace(ctx, tenant, Space{Name: "Approval"})
				if err != nil {
					t.Fatal(err)
				}
				agent, err := store.CreateAgent(ctx, tenant, Agent{Name: "A", SpaceID: space.ID})
				if err != nil {
					t.Fatal(err)
				}
				for _, user := range []string{"removed-user", "other-user"} {
					for _, active := range []bool{false, true} {
						session, err := store.CreateSession(ctx, tenant, user, agent.ID, Session{})
						if err != nil {
							t.Fatal(err)
						}
						runID := ""
						if active {
							run, err := store.StartRun(ctx, tenant, agent.ID, session.ID, "test", nil, nil)
							if err != nil {
								t.Fatal(err)
							}
							runID = run.ID
						}
						for _, run := range []string{runID, ""} {
							id, err := store.CreateApproval(ctx, tenant, agent.ID, session.ID, run, "call", ApprovalRequest{ToolName: "fs_read"})
							if err != nil {
								t.Fatal(err)
							}
							approvals = append(approvals, pending{tenant, user, agent.ID, session.ID, id})
						}
					}
				}
			}
			for attempt := 0; attempt < 2; attempt++ {
				var err error
				if action == "tenant" {
					err = h.cancelTenantRuns(ctx, "tenant")
				} else {
					err = h.afterMemberRemoved(ctx, "tenant", "removed-user")
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			for _, approval := range approvals {
				cancelled := approval.tenant == "tenant" && (action == "tenant" || approval.user == "removed-user")
				want := "pending"
				if cancelled {
					want = "cancelled"
				}
				row, err := store.getApproval(ctx, approval.tenant, approval.agent, approval.session, approval.id)
				if err != nil || row.Status != want {
					t.Fatalf("tenant=%s user=%s status=%s want=%s err=%v", approval.tenant, approval.user, row.Status, want, err)
				}
				if cancelled {
					if err = store.settleApproval(ctx, approval.tenant, approval.agent, approval.session, approval.id, "approved", "user", false); !errors.Is(err, ErrConflict) {
						t.Fatalf("late approval accepted: %v", err)
					}
				}
				events, err := store.ListEvents(ctx, approval.tenant, approval.agent, approval.session, 0, 100)
				if err != nil {
					t.Fatal(err)
				}
				resolved := 0
				for _, event := range events {
					var payload struct{ RequestID, Decision string }
					if event.Type == "tool_approval_resolved" && json.Unmarshal(event.Payload, &payload) == nil && payload.RequestID == approval.id {
						resolved++
						if payload.Decision != "cancelled" {
							t.Fatalf("decision=%s", payload.Decision)
						}
					}
				}
				wantResolved := 0
				if cancelled {
					wantResolved = 1
				}
				if resolved != wantResolved {
					t.Fatalf("resolved=%d want=%d", resolved, wantResolved)
				}
			}
		})
	}
}

func TestToolApprovalOriginalCallerRevalidated(t *testing.T) {
	for _, revoke := range []string{"membership", "api-key", "key-scope", "key-binding", "session", "oauth", "tenant"} {
		t.Run(revoke, func(t *testing.T) {
			s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
			h := &handler{deps: s.store.deps, store: s.store, service: s}
			actor := acpMCPUser(t, h)
			now := s.store.now()
			nowString := runtimeTimeString(now)
			// This caller is deliberately not the session creator.
			if revoke == "api-key" || revoke == "key-scope" || revoke == "key-binding" {
				actor = httpx.Principal{TenantID: "tenant", APIKey: true, APIKeyID: "key-tenant"}
			}
			if revoke == "session" {
				actor.SessionID = "caller-session"
				if err := h.deps.Gorm.Table("user_sessions").Create(map[string]any{"id": actor.SessionID, "user_id": actor.UserID, "tenant_id": "tenant", "email": "caller@example.test", "role": "member", "token_hash": "fixture-session-hash", "expires_at": runtimeTimeString(now.Add(time.Hour)), "last_seen_at": nowString, "created_at": nowString}).Error; err != nil {
					t.Fatal(err)
				}
			}
			var clock atomic.Int64
			clock.Store(now.UnixNano())
			if revoke == "oauth" {
				h.deps.Clock = func() time.Time { return time.Unix(0, clock.Load()).UTC() }
				actor.OAuth, actor.OAuthScope, actor.OAuthExpiresAt = true, "api", now.Add(time.Minute)
			}
			ctx, cancel := context.WithTimeout(httpx.WithPrincipal(context.Background(), actor), 10*time.Second)
			defer cancel()
			done := make(chan error, 1)
			var effects atomic.Int64
			go func() {
				_, err := s.toolExecutionGuard(ctx, "tenant", a.ID, session.ID, run.ID, "call", "fs_read", json.RawMessage(`{}`))
				if err == nil {
					effects.Add(1)
				}
				done <- err
			}()
			id := waitApproval(t, s.store, session.ID)
			var err error
			switch revoke {
			case "membership":
				err = h.deps.Gorm.Table("tenant_memberships").Where("tenant_id=? AND user_id=?", "tenant", actor.UserID).Update("status", "suspended").Error
			case "api-key":
				err = h.deps.Gorm.Table("api_keys").Where("id=?", actor.APIKeyID).Update("revoked_at", nowString).Error
			case "key-scope":
				err = h.deps.Gorm.Table("api_keys").Where("id=?", actor.APIKeyID).Update("scopes", `["gateway"]`).Error
			case "key-binding":
				err = h.deps.Gorm.Table("api_keys").Where("id=?", actor.APIKeyID).Update("space_id", a.SpaceID).Error
			case "session":
				err = h.deps.Gorm.Table("user_sessions").Where("id=?", actor.SessionID).Update("revoked_at", nowString).Error
			case "oauth":
				clock.Store(now.Add(2 * time.Minute).UnixNano())
			case "tenant":
				err = h.deps.Gorm.Table("tenants").Where("id=?", "tenant").Update("status", "suspended").Error
			}
			if err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err == nil || effects.Load() != 0 {
					t.Fatalf("revoked caller executed: %v effects=%d", err, effects.Load())
				}
			case <-ctx.Done():
				t.Fatal("revoked caller remained pending")
			}
			row, err := s.store.getApproval(context.Background(), "tenant", a.ID, session.ID, id)
			if err != nil || row.Status != "cancelled" {
				t.Fatalf("unsettled approval=%+v err=%v", row, err)
			}
			if err := s.store.settleApproval(context.Background(), "tenant", a.ID, session.ID, id, "approved", "user", false); !errors.Is(err, ErrConflict) {
				t.Fatalf("late approval=%v", err)
			}
		})
	}
}

func TestToolApprovalAccessRevocationUnblocksGateWithoutEffects(t *testing.T) {
	for _, action := range []string{"tenant", "member"} {
		for _, runless := range []bool{false, true} {
			name := action + "/run"
			if runless {
				name = action + "/runless"
			}
			t.Run(name, func(t *testing.T) {
				s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
				h := &handler{deps: s.store.deps, store: s.store, service: s}
				actor := acpMCPUser(t, h)
				if err := h.deps.Gorm.Table("cloud_agent_sessions").Where("id=?", session.ID).Update("created_by_user_id", actor.UserID).Error; err != nil {
					t.Fatal(err)
				}
				runID, source := run.ID, "standard"
				if runless {
					if err := s.store.FinishRun(context.Background(), "tenant", a.ID, session.ID, run.ID, "completed", nil, nil); err != nil {
						t.Fatal(err)
					}
					runID, source = "", "acp_callback"
				}
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				var effects atomic.Int64
				done := make(chan error, 1)
				go func() {
					err := s.approveTool(ctx, "tenant", a.ID, session.ID, runID, "call", "fs_read", json.RawMessage(`{}`), "always_ask", source, "request")
					if err == nil {
						effects.Add(1)
					}
					done <- err
				}()
				id := waitApproval(t, s.store, session.ID)
				var err error
				if action == "tenant" {
					err = h.cancelTenantRuns(ctx, "tenant")
				} else {
					err = h.afterMemberRemoved(ctx, "tenant", actor.UserID)
				}
				if err != nil {
					t.Fatal(err)
				}
				select {
				case err := <-done:
					if err == nil || effects.Load() != 0 {
						t.Fatalf("revoked gate executed: %v effects=%d", err, effects.Load())
					}
				case <-ctx.Done():
					t.Fatal("revoked gate did not stop")
				}
				if err = s.store.settleApproval(context.Background(), "tenant", a.ID, session.ID, id, "approved", "user", false); !errors.Is(err, ErrConflict) {
					t.Fatalf("late approval=%v", err)
				}
			})
		}
	}
}
