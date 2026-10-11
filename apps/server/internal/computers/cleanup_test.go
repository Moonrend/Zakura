package computers

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"
)

type stubDestroyer struct {
	calls  int
	err    error
	onCall func(Runtime)
}

func (d *stubDestroyer) Destroy(_ context.Context, r Runtime) error {
	d.calls++
	if d.onCall != nil {
		d.onCall(r)
	}
	return d.err
}

const runtimeInsert = `INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,external_id,expires_at,idle_deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'now','now')`

func runtimeState(t *testing.T, s Store, id string) (string, sql.NullString) {
	t.Helper()
	var state string
	var lastError sql.NullString
	if err := s.DB.QueryRow(`SELECT state,last_error FROM computer_runtimes WHERE id=?`, id).Scan(&state, &lastError); err != nil {
		t.Fatal(err)
	}
	return state, lastError
}

func TestCollectExpiredRuntimesOrdersAndSkipsLive(t *testing.T) {
	s := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	older := now.Add(-10 * time.Minute).Format(time.RFC3339Nano)
	recent := now.Add(-1 * time.Minute).Format(time.RFC3339Nano)
	future := now.Add(time.Hour).Format(time.RFC3339Nano)
	execTest(t, s, runtimeInsert, "rt-older", "tenant", "space", "computer-space", "scope-older", "inc-older", "op-older", "ready", "ctr-older", future, older)
	execTest(t, s, runtimeInsert, "rt-recent", "tenant", "space2", "computer-space2", "scope-recent", "inc-recent", "op-recent", "ready", "ctr-recent", recent, recent)
	execTest(t, s, runtimeInsert, "rt-live", "tenant", "space", "second", "scope-live", "inc-live", "op-live", "ready", "ctr-live", future, future)
	got, err := s.CollectExpiredRuntimes(context.Background(), now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "rt-older" || got[1].ID != "rt-recent" {
		t.Fatalf("collected: %+v", got)
	}
	limited, err := s.CollectExpiredRuntimes(context.Background(), now, 1)
	if err != nil || len(limited) != 1 || limited[0].ID != "rt-older" {
		t.Fatalf("limited: %+v %v", limited, err)
	}
}

func TestCollectExpiredRuntimesIsolatesBySession(t *testing.T) {
	s := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	past := now.Add(-time.Minute).Format(time.RFC3339Nano)
	future := now.Add(time.Hour).Format(time.RFC3339Nano)
	execTest(t, s, runtimeInsert, "rt-a", "tenant", "space", "computer-space", "scope-a", "inc-a", "op-a", "ready", "ctr-a", future, past)
	execTest(t, s, runtimeInsert, "rt-b", "tenant", "space", "computer-space", "scope-b", "inc-b", "op-b", "ready", "ctr-b", future, future)
	got, err := s.CollectExpiredRuntimes(context.Background(), now, 10)
	if err != nil || len(got) != 1 || got[0].ID != "rt-a" {
		t.Fatalf("collected: %+v %v", got, err)
	}
}

func TestExpireOverdueDestroysAndExpires(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	past := now.Add(-time.Minute).Format(time.RFC3339Nano)
	execTest(t, s, `UPDATE computers SET provider='temporary' WHERE id='computer-space'`)
	execTest(t, s, runtimeInsert, "rt-destroy", "tenant", "space", "computer-space", "chat-space", "inc-d", "op-d", "ready", "ctr-d", past, past)
	execTest(t, s, runtimeInsert, "rt-e2b", "tenant", "space", "second", "chat-second", "inc-e", "op-e", "ready", "ctr-e", past, past)
	execTest(t, s, runtimeInsert, "rt-done", "tenant", "space2", "computer-space2", "chat-done", "inc-done", "op-done", "destroyed", "ctr-done", past, past)
	destroyer := &stubDestroyer{}
	deps := CleanupDeps{Store: s, Destroyers: map[Provider]DestructionProvider{Temporary: destroyer}, Now: func() time.Time { return now }}
	destroyed, expired, err := deps.ExpireOverdue(ctx, 10)
	if err != nil || destroyed != 1 || expired != 1 {
		t.Fatalf("destroyed=%d expired=%d err=%v", destroyed, expired, err)
	}
	if destroyer.calls != 1 {
		t.Fatalf("destroyer calls=%d", destroyer.calls)
	}
	if state, _ := runtimeState(t, s, "rt-destroy"); state != string(Destroyed) {
		t.Fatalf("destroyed runtime state: %s", state)
	}
	if state, _ := runtimeState(t, s, "rt-e2b"); state != string(Expired) {
		t.Fatalf("expired runtime state: %s", state)
	}
	if state, _ := runtimeState(t, s, "rt-done"); state != string(Destroyed) {
		t.Fatalf("terminal runtime reprocessed: %s", state)
	}
}

func TestExpireOverdueMarksFailedDestruction(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	past := now.Add(-time.Minute).Format(time.RFC3339Nano)
	execTest(t, s, `UPDATE computers SET provider='temporary' WHERE id='computer-space'`)
	execTest(t, s, runtimeInsert, "rt-fail", "tenant", "space", "computer-space", "chat-space", "inc-f", "op-f", "ready", "ctr-f", past, past)
	destroyer := &stubDestroyer{err: errors.New("docker stop failed")}
	deps := CleanupDeps{Store: s, Destroyers: map[Provider]DestructionProvider{Temporary: destroyer}, Now: func() time.Time { return now }}
	destroyed, expired, err := deps.ExpireOverdue(ctx, 10)
	if err != nil || destroyed != 0 || expired != 1 {
		t.Fatalf("destroyed=%d expired=%d err=%v", destroyed, expired, err)
	}
	state, lastError := runtimeState(t, s, "rt-fail")
	if state != string(Expired) || !lastError.Valid || !strings.Contains(lastError.String, "docker stop failed") {
		t.Fatalf("state=%s lastError=%v", state, lastError)
	}
}

func TestExpireOverdueSkipsConcurrentStateChange(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	past := now.Add(-time.Minute).Format(time.RFC3339Nano)
	execTest(t, s, `UPDATE computers SET provider='temporary' WHERE id='computer-space'`)
	execTest(t, s, runtimeInsert, "rt-race", "tenant", "space", "computer-space", "chat-space", "inc-r", "op-r", "ready", "ctr-r", past, past)
	destroyer := &stubDestroyer{onCall: func(r Runtime) {
		_, _ = s.DB.Exec(`UPDATE computer_runtimes SET state='expired' WHERE id=?`, r.ID)
	}}
	deps := CleanupDeps{Store: s, Destroyers: map[Provider]DestructionProvider{Temporary: destroyer}, Now: func() time.Time { return now }}
	destroyed, expired, err := deps.ExpireOverdue(ctx, 10)
	if err != nil || destroyed != 0 || expired != 0 {
		t.Fatalf("destroyed=%d expired=%d err=%v", destroyed, expired, err)
	}
}
