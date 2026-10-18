// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestACPClosePreservesSessionQueueAndDoesNotRestart(t *testing.T) {
	fake := &fakeACPAdapter{}
	manager, agent, session := acpAuthHarness(t, fake)
	h := manager.h
	h.acp = manager
	actor := acpMCPUser(t, h)
	ctx := httpx.WithPrincipal(context.Background(), actor)
	rt, err := manager.ensure(ctx, "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.store.Enqueue(ctx, "tenant", agent.ID, session.ID, QueueMessage{ID: "retained", Content: "do not replay"}); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Post("/agents/{id}/sessions/{sid}/acp-runtime/close", h.closeACPRuntime)
	invoke := func(p httpx.Principal) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/agents/"+agent.ID+"/sessions/"+session.ID+"/acp-runtime/close", nil)
		router.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), p)))
		return w
	}
	wrong := actor
	wrong.APIKey, wrong.SpaceID, wrong.APIKeyScopes = true, "other", `["api"]`
	if w := invoke(wrong); w.Code != http.StatusNotFound {
		t.Fatalf("cross-Space close: %d %s", w.Code, w.Body.String())
	}
	if _, err = h.deps.DB.Exec(`UPDATE cloud_agent_sessions SET active_run_id='busy' WHERE id=?`, session.ID); err != nil {
		t.Fatal(err)
	}
	if w := invoke(actor); w.Code != http.StatusConflict {
		t.Fatalf("active close: %d %s", w.Code, w.Body.String())
	}
	select {
	case <-rt.done:
		t.Fatal("rejected close terminated the runtime")
	default:
	}
	if _, err = h.deps.DB.Exec(`UPDATE cloud_agent_sessions SET active_run_id=NULL WHERE id=?`, session.ID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if w := invoke(actor); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"state":"closed"`) {
			t.Fatalf("close %d: %d %s", i, w.Code, w.Body.String())
		}
	}
	if _, err = h.store.GetSession(ctx, "tenant", agent.ID, session.ID); err != nil {
		t.Fatal("close deleted durable session", err)
	}
	queue, err := h.store.PendingQueue(ctx, "tenant", agent.ID, session.ID)
	if err != nil || len(queue) != 1 || queue[0].Content != "do not replay" {
		t.Fatalf("close changed queue: %+v %v", queue, err)
	}
	fake.mu.Lock()
	processes := fake.process
	fake.mu.Unlock()
	if processes != 1 {
		t.Fatal("close spawned another adapter")
	}
}

func TestACPCloseRetainsUnconfirmedCleanupFences(t *testing.T) {
	fake := &fakeACPAdapter{}
	manager, agent, session := acpAuthHarness(t, fake)
	h := manager.h
	h.acp = manager
	actor := acpMCPUser(t, h)
	if _, err := manager.ensure(httpx.WithPrincipal(context.Background(), actor), "tenant", agent.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	fake.failClose = true
	fake.mu.Unlock()
	if _, err := h.closeACP(context.Background(), actor, agent.ID, session.ID); !errors.Is(err, errACPCleanupUnconfirmed) {
		t.Fatalf("cleanup uncertainty hidden: %v", err)
	}
	state, err := manager.snapshot(context.Background(), "tenant", agent.ID, session.ID)
	if err != nil || state["state"] != "error" || state["error"] != errACPCleanupUnconfirmed.Error() {
		t.Fatalf("cleanup uncertainty was reported as closed: %+v %v", state, err)
	}
	for _, table := range []string{"computer_workspace_leases", "acp_profile_auth_locks"} {
		var count int
		if err := h.deps.DB.QueryRow(`SELECT COUNT(*) FROM `+table+` WHERE tenant_id='tenant' AND space_id=?`, agent.SpaceID).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s fence missing: %d %v", table, count, err)
		}
	}
}

func TestACPCloseDuringQuarantineRetainsRecoveryOwnership(t *testing.T) {
	for _, scenario := range []string{"matching-expired", "auth-only-expired", "unrelated-profile", "active-auth"} {
		t.Run(scenario, func(t *testing.T) {
			fake := &fakeACPAdapter{}
			manager, agent, session := acpAuthHarness(t, fake)
			h := manager.h
			h.acp = manager
			actor := acpMCPUser(t, h)
			actor.Role = "owner"
			rt, err := manager.ensure(httpx.WithPrincipal(context.Background(), actor), "tenant", agent.ID, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			_, target, err := h.acpSpaceRunner(context.Background(), "tenant", agent.SpaceID)
			if err != nil {
				t.Fatal(err)
			}
			profile := rt.profileID
			if scenario == "unrelated-profile" {
				profile = "other"
			}
			lease, err := h.acquireSpaceInfrastructure(context.Background(), "tenant", agent.SpaceID)
			if err != nil {
				t.Fatal(err)
			}
			if err = lease.bindSharedProfile(context.Background(), profile); err != nil {
				t.Fatal(err)
			}
			if err = h.acquireACPAuthLock(context.Background(), "tenant", agent.SpaceID, profile, "terminal", "original-owner", time.Minute, target); err != nil {
				t.Fatal(err)
			}
			_ = lease.uncertain(errors.New("unconfirmed authentication"))
			lease.release()
			if scenario != "active-auth" {
				if _, err = h.deps.DB.Exec(`UPDATE acp_profile_auth_locks SET expires_at=0 WHERE space_id=?`, agent.SpaceID); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "auth-only-expired" {
				if _, err = h.deps.DB.Exec(`DELETE FROM computer_workspace_leases WHERE space_id=?`, agent.SpaceID); err != nil {
					t.Fatal(err)
				}
				if _, err = h.deps.DB.Exec(`UPDATE spaces SET workspace_status=? WHERE id=?`, lease.Intent.PreviousStatus, agent.SpaceID); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "matching-expired" {
				member := actor
				member.Role = "member"
				if _, err = h.closeACP(context.Background(), member, agent.ID, session.ID); err == nil {
					t.Fatal("member took over quarantined profile ownership")
				}
			}
			_, err = h.closeACP(context.Background(), actor, agent.ID, session.ID)
			if scenario == "matching-expired" || scenario == "auth-only-expired" {
				if err != nil {
					t.Fatal(err)
				}
				select {
				case <-rt.done:
				default:
					t.Fatal("matching quarantined runtime remains live")
				}
			} else {
				if err == nil {
					t.Fatal("closed runtime across unrelated or active authentication")
				}
				select {
				case <-rt.done:
					t.Fatal("rejected close changed runtime")
				default:
				}
			}
			state, err := h.loadACPAuthRecovery(context.Background(), "tenant", agent.SpaceID, profile)
			if err != nil || state.WorkspaceToken == "" {
				t.Fatalf("close lost recovery ownership: %+v %v", state, err)
			}
			rotated := state.Token != "original-owner" && state.WorkspaceToken != lease.Token
			unchanged := state.Token == "original-owner" && state.WorkspaceToken == lease.Token
			if (scenario == "matching-expired" || scenario == "auth-only-expired") && !rotated || (scenario == "unrelated-profile" || scenario == "active-auth") && !unchanged {
				t.Fatalf("close incorrectly consumed recovery ownership: %+v", state)
			}
		})
	}
}
