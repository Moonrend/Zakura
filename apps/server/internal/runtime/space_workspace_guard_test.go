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
	"gorm.io/gorm"
)

func workspaceGuardTestHandler(t *testing.T) (*handler, Agent) {
	t.Helper()
	h, id := newWebHandler(t)
	// The isolated baseline predates the coordinator's 0011/0017 migrations.
	// Production uses those migrations; test setup is also harmless on main.
	if err := h.deps.Gorm.Exec(`CREATE TABLE IF NOT EXISTS computer_workspace_leases(space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,tenant_id TEXT NOT NULL,token TEXT NOT NULL,operation TEXT NOT NULL,expires_at BIGINT NOT NULL,intent_json TEXT NOT NULL DEFAULT '{}',updated_at BIGINT NOT NULL)`).Error; err != nil {
		t.Fatal(err)
	}
	if !h.deps.Gorm.Migrator().HasColumn("spaces", "deletion_pending") {
		if err := h.deps.Gorm.Exec(`ALTER TABLE spaces ADD COLUMN deletion_pending BOOLEAN NOT NULL DEFAULT FALSE`).Error; err != nil {
			t.Fatal(err)
		}
	}
	a, err := h.store.GetAgent(context.Background(), "tenant", id)
	if err != nil {
		t.Fatal(err)
	}
	return h, a
}
func TestWorkspaceGuardRunAdmissionAndExecution(t *testing.T) {
	h, a := workspaceGuardTestHandler(t)
	ctx := context.Background()
	for _, state := range []string{"migrating", "deleting", "configuring"} {
		t.Run(state, func(t *testing.T) {
			lease, err := h.acquireSpaceWorkspace(ctx, "tenant", a.SpaceID, state, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			sess, err := h.store.CreateSession(ctx, "tenant", "", a.ID, Session{})
			if err != nil {
				t.Fatal(err)
			}
			_, err = h.store.StartRun(ctx, "tenant", a.ID, sess.ID, "hello", nil, nil)
			if !errors.Is(err, ErrConflict) {
				t.Fatalf("admitted run during %s: %v", state, err)
			}
			current, _ := h.store.GetSession(ctx, "tenant", a.ID, sess.ID)
			if current.ActiveRunID != nil {
				t.Fatal("failed admission mutated session")
			}
			lease.release()
		})
	}
	if err := h.deps.Gorm.Table("spaces").Where("id=?", a.SpaceID).Update("deletion_pending", true).Error; err != nil {
		t.Fatal(err)
	}
	sess, _ := h.store.CreateSession(ctx, "tenant", "", a.ID, Session{})
	if _, err := h.store.StartRun(ctx, "tenant", a.ID, sess.ID, "hello", nil, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("pending deletion admitted run: %v", err)
	}
	if _, err := h.acquireSpaceWorkspace(ctx, "tenant", a.SpaceID, "configuring", false, nil); err == nil {
		t.Fatal("pending deletion admitted writer")
	}
	_ = h.deps.Gorm.Table("spaces").Where("id=?", a.SpaceID).Update("deletion_pending", false).Error
	run, err := h.store.StartRun(ctx, "tenant", a.ID, sess.ID, "hello", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.guardRunWorkspace(ctx, "tenant", a.ID, sess.ID, run.ID); err != nil {
		t.Fatal(err)
	}
	lease, err := h.acquireSpaceWorkspace(ctx, "tenant", a.SpaceID, "migrating", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.release()
	if err := h.store.guardRunWorkspace(ctx, "tenant", a.ID, sess.ID, run.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("execute revalidation ignored migration: %v", err)
	}
	var active int64
	_ = h.deps.Gorm.Table("cloud_agent_runs AS r").Joins("JOIN cloud_agent_sessions AS s ON s.id=r.session_id").Joins("JOIN agents AS a ON a.id=s.agent_id AND a.tenant_id=s.tenant_id").Where("a.tenant_id=? AND a.space_id=? AND r.status='running'", "tenant", a.SpaceID).Count(&active).Error
	if active != 1 {
		t.Fatal("migration cannot observe admitted run")
	}
}
func TestWorkspaceGuardRunTransactionClosesClaimWindow(t *testing.T) {
	h, a := workspaceGuardTestHandler(t)
	ctx := context.Background()
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- h.deps.Gorm.Transaction(func(tx *gorm.DB) error {
			if err := h.store.guardSpaceWorkspaceTx(tx, "tenant", a.SpaceID); err != nil {
				return err
			}
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	claimDone := make(chan *workspaceLease, 1)
	go func() {
		lease, _ := h.acquireSpaceWorkspace(ctx, "tenant", a.SpaceID, "migrating", false, nil)
		claimDone <- lease
	}()
	select {
	case lease := <-claimDone:
		if lease != nil {
			lease.release()
		}
		close(release)
		t.Fatal("claim passed admission transaction lock")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	select {
	case lease := <-claimDone:
		if lease == nil {
			t.Fatal("claim failed after transaction release")
		}
		lease.release()
	case <-time.After(time.Second):
		t.Fatal("claim stayed blocked")
	}
}
func TestWorkspaceGuardCanonicalAndLegacyWriters(t *testing.T) {
	h, a := workspaceGuardTestHandler(t)
	for _, legacy := range []bool{false, true} {
		router := chi.NewRouter()
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx := httpx.WithPrincipal(r.Context(), httpx.Principal{TenantID: "tenant"})
				ctx = context.WithValue(ctx, computerExecKey{}, &resolvedExecution{nodeID: "selected", hostRoot: "elsewhere"})
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
		calls := 0
		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			if exec := pinnedExecution(r.Context()); exec == nil || exec.nodeID != "selected" {
				t.Fatal("selected tool computer changed")
			}
			if lease, err := h.acquireSpaceWorkspace(r.Context(), "tenant", a.SpaceID, "migrating", false, nil); err == nil {
				lease.release()
				t.Fatal("migration entered running writer")
			}
			w.WriteHeader(200)
		})
		url := "/spaces/" + a.SpaceID + "/write"
		if legacy {
			url = "/agents/" + a.ID + "/write"
			router.Post("/agents/{id}/write", h.legacyWorkspaceRoute(handler))
		} else {
			router.Post("/spaces/{id}/write", h.spaceWorkspaceRoute(handler))
		}
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, httptest.NewRequest("POST", url, nil))
		if resp.Code != 200 || calls != 1 {
			t.Fatalf("writer %d calls=%d", resp.Code, calls)
		}
		lease, err := h.acquireSpaceWorkspace(context.Background(), "tenant", a.SpaceID, "migrating", false, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp = httptest.NewRecorder()
		router.ServeHTTP(resp, httptest.NewRequest("POST", url, nil))
		if resp.Code != 409 || calls != 1 {
			t.Fatalf("migration admitted writer %d %d", resp.Code, calls)
		}
		lease.release()
	}
}
func TestWorkspaceGuardRetainsUncertainRemoteButProjectIntentRetryable(t *testing.T) {
	h, a := workspaceGuardTestHandler(t)
	_ = h.deps.Gorm.Table("spaces").Where("id=?", a.SpaceID).Update("runtime_node_id", "offline").Error
	run := func(code int) {
		req := httptest.NewRequest("POST", "/", nil)
		req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant"}))
		h.withWorkspaceWrite(httptest.NewRecorder(), req, a.SpaceID, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(code) })
	}
	run(409) // Project rename/delete persists its own projectOperations intent.
	var count int64
	_ = h.deps.Gorm.Table("computer_workspace_leases").Where("space_id=?", a.SpaceID).Count(&count).Error
	if count != 0 {
		t.Fatal("project recovery retry deadlocked")
	}
	run(502)
	var intent string
	_ = h.deps.DB.QueryRow(`SELECT intent_json FROM computer_workspace_leases WHERE space_id=?`, a.SpaceID).Scan(&intent)
	if !strings.Contains(intent, `"uncertain":true`) {
		t.Fatalf("uncertain remote claim lost %q", intent)
	}
	_ = h.deps.Gorm.Table("computer_workspace_leases").Where("space_id=?", a.SpaceID).Update("expires_at", 0).Error
	err := h.deps.Gorm.Transaction(func(tx *gorm.DB) error { return h.store.guardSpaceWorkspaceTx(tx, "tenant", a.SpaceID) })
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expired uncertain claim admitted run %v", err)
	}
}

func TestWorkspaceGuardNestedFinishMemoizesWithoutDatabaseWrite(t *testing.T) {
	h, a := workspaceGuardTestHandler(t)
	_ = h.deps.Gorm.Table("spaces").Where("id=?", a.SpaceID).Update("runtime_node_id", "offline").Error
	ctx, finish, err := h.claimSharedWorkspaceWrite(context.Background(), "tenant", a.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	err = h.deps.Gorm.Transaction(func(tx *gorm.DB) error {
		if err := tx.Table("spaces").Where("id=?", a.SpaceID).UpdateColumn("workspace_status", gorm.Expr("workspace_status")).Error; err != nil {
			return err
		}
		nested, nestedFinish, err := h.claimSharedWorkspaceWrite(ctx, "tenant", a.SpaceID)
		if err != nil || nested == nil {
			t.Fatalf("reentrant claim %v", err)
		}
		// The only connection is held by tx; nested finish must not issue SQL.
		nestedFinish(errors.New("uncertain remote stage RPC"))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	finish(nil)
	finish(nil)
	var intent string
	_ = h.deps.DB.QueryRow(`SELECT intent_json FROM computer_workspace_leases WHERE space_id=?`, a.SpaceID).Scan(&intent)
	if !strings.Contains(intent, `"uncertain":true`) {
		t.Fatalf("nested cause lost %q", intent)
	}
}

func TestWorkspaceGuardRemoteError400MarkerRetainsClaim(t *testing.T) {
	h, a := workspaceGuardTestHandler(t)
	_ = h.deps.Gorm.Table("spaces").Where("id=?", a.SpaceID).Update("runtime_node_id", "offline").Error
	req := httptest.NewRequest("POST", "/", nil)
	req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant"}))
	response := httptest.NewRecorder()
	h.withWorkspaceWrite(response, req, a.SpaceID, func(w http.ResponseWriter, r *http.Request) {
		writeRemoteError(w, errors.New("RPC response lost after write"))
	})
	if response.Code != 400 {
		t.Fatalf("response %d", response.Code)
	}
	var intent string
	_ = h.deps.DB.QueryRow(`SELECT intent_json FROM computer_workspace_leases WHERE space_id=?`, a.SpaceID).Scan(&intent)
	if !strings.Contains(intent, `"uncertain":true`) {
		t.Fatalf("remote400 cause lost %q", intent)
	}
}
