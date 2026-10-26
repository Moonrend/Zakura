package computers

import (
	"context"
	"database/sql"
	"encoding/json"
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

type snapshotDestroyer struct {
	captured, destroyed bool
	err                 error
}

func (s *snapshotDestroyer) Destroy(context.Context, Runtime) error {
	return errors.New("fallback destroy must not run")
}
func (s *snapshotDestroyer) CaptureCleanup(context.Context, Runtime) (json.RawMessage, error) {
	s.captured = true
	return json.RawMessage(`{"nodeId":"original-node"}`), s.err
}
func (s *snapshotDestroyer) DestroyCleanup(_ context.Context, r Runtime, data json.RawMessage) error {
	s.destroyed = true
	if r.ExternalID != "ctr-snapshot" || string(data) != `{"nodeId":"original-node"}` {
		return errors.New("snapshot route lost")
	}
	return nil
}
func TestCleanupCapturesSnapshotBeforeDestruction(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	past := now.Add(-time.Minute).Format(time.RFC3339Nano)
	execTest(t, s, `UPDATE computers SET provider='temporary' WHERE id='computer-space'`)
	execTest(t, s, runtimeInsert, "rt-snapshot", "tenant", "space", "computer-space", "chat-space", "inc-snapshot", "op-snapshot", "ready", "ctr-snapshot", past, past)
	destroyer := &snapshotDestroyer{err: errors.New("capture failed")}
	d := CleanupDeps{Store: s, Destroyers: map[Provider]DestructionProvider{Temporary: destroyer}, Now: func() time.Time { return now }}
	if _, _, err := d.ExpireOverdue(ctx, 10); err == nil {
		t.Fatal("capture failure ignored")
	}
	if state, _ := runtimeState(t, s, "rt-snapshot"); state != "ready" {
		t.Fatalf("capture failure released owner: %s", state)
	}
	destroyer.err = nil
	if _, _, err := d.ExpireOverdue(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if !destroyer.captured || !destroyer.destroyed {
		t.Fatal("snapshot callbacks not used")
	}
}

func TestCleanupLateAttemptCannotOverwriteSuccessor(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	past := now.Add(-time.Minute).Format(time.RFC3339Nano)
	execTest(t, s, `UPDATE computers SET provider='temporary' WHERE id='computer-space'`)
	execTest(t, s, runtimeInsert, "rt-late", "tenant", "space", "computer-space", "chat-space", "inc-late", "op-late", "ready", "ctr-late", past, past)
	destroyer := &stubDestroyer{onCall: func(r Runtime) {
		execTest(t, s, `UPDATE computer_cleanup_intents SET token='successor',last_error='successor state' WHERE runtime_id=?`, r.ID)
	}}
	d := CleanupDeps{Store: s, Destroyers: map[Provider]DestructionProvider{Temporary: destroyer}, Now: func() time.Time { return now }}
	if _, _, err := d.ExpireOverdue(ctx, 10); err == nil {
		t.Fatal("lost attempt was reported complete")
	}
	var token, last string
	var pending bool
	if err := s.DB.QueryRow(`SELECT token,last_error,pending FROM computer_cleanup_intents WHERE runtime_id='rt-late'`).Scan(&token, &last, &pending); err != nil || token != "successor" || last != "successor state" || !pending {
		t.Fatalf("successor overwritten: %s %s %v %v", token, last, pending, err)
	}
	if state, _ := runtimeState(t, s, "rt-late"); state != "stopping" {
		t.Fatalf("late completion changed runtime: %s", state)
	}
}

func TestQueueCleanupSurvivesOwnerDeletionAndIsIdempotent(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	future := now.Add(time.Hour).Format(time.RFC3339Nano)
	execTest(t, s, `UPDATE computers SET provider='temporary' WHERE id='computer-space'`)
	execTest(t, s, runtimeInsert, "rt-snapshot", "tenant", "space", "computer-space", "chat-space", "inc-snapshot", "op-snapshot", "ready", "ctr-snapshot", future, future)
	target := Target{TenantID: "tenant", SpaceID: "space", ComputerID: "computer-space", RuntimeID: "rt-snapshot", Incarnation: "inc-snapshot"}
	r, err := s.GetRuntime(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	destroyer := &snapshotDestroyer{}
	d := CleanupDeps{Store: s, Destroyers: map[Provider]DestructionProvider{Temporary: destroyer}, Now: func() time.Time { return now }}
	if err = d.QueueCleanup(ctx, r); err != nil {
		t.Fatal(err)
	}
	if destroyer.destroyed {
		t.Fatal("queue performed destruction")
	}
	if state, _ := runtimeState(t, s, r.ID); state != "ready" {
		t.Fatalf("queue changed execution state=%s", state)
	}
	destroyer.err = errors.New("must not recapture")
	if err = d.QueueCleanup(ctx, r); err != nil {
		t.Fatalf("idempotent queue: %v", err)
	}
	execTest(t, s, `DELETE FROM computers WHERE id='computer-space'`)
	if _, _, err = d.ExpireOverdue(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if !destroyer.destroyed {
		t.Fatal("queued snapshot did not survive owner deletion")
	}
	var pending bool
	if err = s.DB.QueryRow(`SELECT pending FROM computer_cleanup_intents WHERE runtime_id=?`, r.ID).Scan(&pending); err != nil || pending {
		t.Fatalf("pending=%v err=%v", pending, err)
	}
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

func TestCleanupFailureRetriesOriginalAfterReplacement(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	past := now.Add(-time.Minute).Format(time.RFC3339Nano)
	execTest(t, s, `UPDATE computers SET provider='temporary' WHERE id='computer-space'`)
	execTest(t, s, runtimeInsert, "rt-original", "tenant", "space", "computer-space", "chat-space", "inc-original", "op-original", "ready", "ctr-original", past, past)
	destroyer := &stubDestroyer{err: errors.New("stop failed")}
	d := CleanupDeps{Store: s, Destroyers: map[Provider]DestructionProvider{Temporary: destroyer}, Now: func() time.Time { return now }}
	if _, expired, err := d.ExpireOverdue(ctx, 10); err != nil || expired != 1 {
		t.Fatalf("first cleanup expired=%d err=%v", expired, err)
	}
	var pending bool
	var raw string
	if err := s.DB.QueryRow(`SELECT pending,runtime_json FROM computer_cleanup_intents WHERE runtime_id='rt-original'`).Scan(&pending, &raw); err != nil || !pending {
		t.Fatalf("cleanup not durable: %v %v", pending, err)
	}
	var snapshot cleanupSnapshot
	if err := json.Unmarshal([]byte(raw), &snapshot); err != nil || snapshot.Runtime.ExternalID != "ctr-original" {
		t.Fatalf("snapshot=%s err=%v", raw, err)
	}
	future := now.Add(time.Hour).Format(time.RFC3339Nano)
	execTest(t, s, runtimeInsert, "rt-replacement", "tenant", "space", "computer-space", "chat-space", "inc-new", "op-new", "ready", "ctr-new", future, future)
	execTest(t, s, `DELETE FROM computer_runtimes WHERE id='rt-original'`)
	destroyer.err = nil
	destroyer.onCall = func(r Runtime) {
		if r.ID != "rt-original" || r.Incarnation != "inc-original" || r.ExternalID != "ctr-original" {
			t.Fatalf("destroy redirected: %+v", r)
		}
	}
	now = now.Add(2 * time.Minute)
	if _, _, err := d.ExpireOverdue(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if state, _ := runtimeState(t, s, "rt-replacement"); state != "ready" {
		t.Fatalf("replacement state=%s", state)
	}
	if err := s.DB.QueryRow(`SELECT pending FROM computer_cleanup_intents WHERE runtime_id='rt-original'`).Scan(&pending); err != nil || pending {
		t.Fatalf("pending=%v err=%v", pending, err)
	}
}
