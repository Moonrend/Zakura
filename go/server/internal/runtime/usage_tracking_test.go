// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"testing"

	platformusage "github.com/Moonrend/Zakura/go/server/internal/platform/usage"
	"github.com/go-chi/chi/v5"
)

func TestRuntimeUsageRecordsDurableHumanSessionRunAndToolEvents(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	now := d.Clock()
	if _, err := d.DB.Exec(`INSERT INTO users(id,email,password_hash,name,status,is_platform_admin,created_at,updated_at) VALUES('human','human@example.test','x','Human','active',false,?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES('membership','tenant','human','member','active',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	// Installing the real platform callback makes this a SQL integration test,
	// rather than merely observing an in-memory spy.
	platformusage.RegisterRoutes(chi.NewRouter(), d)
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "Usage", WorkspaceKind: "local"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Usage", SpaceID: space.ID})
	session, err := store.CreateSession(context.Background(), "tenant", "human", agent.ID, Session{Title: "Measured chat"})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := store.StartRun(context.Background(), "tenant", agent.ID, session.ID, "one", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.FinishRun(context.Background(), "tenant", agent.ID, session.ID, completed.ID, "completed", nil, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	cancelled, _ := store.StartRun(context.Background(), "tenant", agent.ID, session.ID, "two", nil, nil)
	if _, err = store.CancelRun(context.Background(), "tenant", agent.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	failed, _ := store.StartRun(context.Background(), "tenant", agent.ID, session.ID, "three", nil, nil)
	failure := "provider failed"
	if err = store.FinishRun(context.Background(), "tenant", agent.ID, session.ID, failed.ID, "failed", &failure, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	service := NewService(store)
	service.recordToolUsage(context.Background(), session, "tenant", agent.ID, session.ID, "tool-ok", "files:read", "ok", 12)
	service.recordToolUsage(context.Background(), session, "tenant", agent.ID, session.ID, "tool-error", "files:write", "error", 7)
	// API-key/anonymous sessions are intentionally excluded.
	if _, err = store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{Title: "API key chat"}); err != nil {
		t.Fatal(err)
	}

	var sessions, runsOK, runsError, tools, toolErrors int
	if err = d.DB.QueryRow(`SELECT sessions_started,runs_ok,runs_error,tool_calls,tool_errors FROM user_usage_daily WHERE tenant_id='tenant' AND user_id='human'`).Scan(&sessions, &runsOK, &runsError, &tools, &toolErrors); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 || runsOK != 1 || runsError != 2 || tools != 2 || toolErrors != 1 {
		t.Fatalf("usage daily mismatch: sessions=%d ok=%d errors=%d tools=%d toolErrors=%d", sessions, runsOK, runsError, tools, toolErrors)
	}
	var eventCount, runStarted int
	if err = d.DB.QueryRow(`SELECT COUNT(*),SUM(CASE WHEN action='run_started' THEN 1 ELSE 0 END) FROM user_usage_events WHERE tenant_id='tenant' AND user_id='human'`).Scan(&eventCount, &runStarted); err != nil {
		t.Fatal(err)
	}
	if eventCount != 9 || runStarted != 3 {
		t.Fatalf("usage events mismatch: count=%d runStarted=%d", eventCount, runStarted)
	}
	var resource string
	if err = d.DB.QueryRow(`SELECT resource_id FROM user_usage_events WHERE action='run_cancelled'`).Scan(&resource); err != nil || resource != cancelled.ID {
		t.Fatalf("cancel resource mismatch: %q %v", resource, err)
	}
}
