package computers

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
)

func testStore(t *testing.T) Store {
	t.Helper()
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, "file:"+filepath.Join(t.TempDir(), "computers.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.DB.Close() })
	if err := migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatal(err)
	}
	s := Store{DB: conn.DB, Rebind: conn.Rebind}
	for _, tenant := range []string{"tenant", "other"} {
		execTest(t, s, `INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES(?,?,?,'now','now')`, tenant, tenant, tenant)
	}
	for _, row := range [][2]string{{"space", "tenant"}, {"space2", "tenant"}, {"foreign", "other"}} {
		execTest(t, s, `INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,'now','now')`, row[0], row[1], row[0], row[0])
		execTest(t, s, `INSERT INTO agents(id,tenant_id,space_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,'now','now')`, "agent-"+row[0], row[1], row[0], row[0], row[0])
		execTest(t, s, `INSERT INTO cloud_agent_sessions(id,tenant_id,agent_id,created_at,updated_at) VALUES(?,?,?,'now','now')`, "chat-"+row[0], row[1], "agent-"+row[0])
		execTest(t, s, `INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES(?,?,?,?,'e2b','now','now')`, "computer-"+row[0], row[1], row[0], row[0])
	}
	execTest(t, s, `INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES('second','tenant','space','Second','e2b','now','now')`)
	for _, run := range []string{"run1", "run2"} {
		execTest(t, s, `INSERT INTO cloud_agent_runs(id,session_id,status,created_at) VALUES(?,'chat-space','queued','now')`, run)
	}
	return s
}
func execTest(t *testing.T, s Store, q string, args ...any) {
	t.Helper()
	if _, err := s.DB.Exec(s.query(q), args...); err != nil {
		t.Fatal(err)
	}
}
func TestDefaultsSnapshotAndIsolation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	execTest(t, s, `INSERT INTO cloud_agent_runs(id,session_id,status,created_at) VALUES('run-none','chat-space','queued','now')`)
	if _, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run-none"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing default: %v", err)
	}
	if err := s.SetSpaceDefault(ctx, "tenant", "space", "computer-space"); err != nil {
		t.Fatal(err)
	}
	// A Space default is not a fallback for a chat that has not been initialized.
	if _, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run-none"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("unexpected fallback: %v", err)
	}
	if id, err := s.InitializeSessionDefault(ctx, "tenant", "space", "chat-space"); err != nil || id != "computer-space" {
		t.Fatalf("initialize: %s %v", id, err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil || id != "computer-space" {
		t.Fatalf("snapshot: %s %v", id, err)
	}
	if err := s.SetSpaceDefault(ctx, "tenant", "space", "second"); err != nil {
		t.Fatal(err)
	}
	if id, err := s.InitializeSessionDefault(ctx, "tenant", "space", "chat-space"); err != nil || id != "computer-space" {
		t.Fatalf("reinitialization changed chat: %s %v", id, err)
	}
	if err := s.SetSessionDefault(ctx, "tenant", "space", "chat-space", "second"); err != nil {
		t.Fatal(err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil || id != "computer-space" {
		t.Fatalf("active Run changed: %s %v", id, err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run2"); err != nil || id != "second" {
		t.Fatalf("next Run: %s %v", id, err)
	}
	for _, computer := range []string{"computer-space2", "computer-foreign", "missing"} {
		if err := s.SetSpaceDefault(ctx, "tenant", "space", computer); !errors.Is(err, sql.ErrNoRows) {
			t.Errorf("space accepted %s: %v", computer, err)
		}
		if err := s.SetSessionDefault(ctx, "tenant", "space", "chat-space", computer); !errors.Is(err, sql.ErrNoRows) {
			t.Errorf("chat accepted %s: %v", computer, err)
		}
	}
	if err := s.SetSessionDefault(ctx, "other", "space", "chat-space", "second"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("tenant spoof: %v", err)
	}
	if _, err := s.SnapshotRunTarget(ctx, "other", "space", "run1"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("snapshot tenant leak: %v", err)
	}
	if _, err := s.InitializeSessionDefault(ctx, "tenant", "space2", "chat-space"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("chat space leak: %v", err)
	}
}
func TestRuntimeActiveSlotAndIncarnation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	insert := `INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at) VALUES(?,'tenant','space','computer-space',?,?,?,'unknown','now','now')`
	execTest(t, s, insert, "runtime1", "chat-space", "inc1", "op1")
	if _, err := s.DB.Exec(insert, "runtime2", "chat-space", "inc2", "op2"); err == nil {
		t.Fatal("ambiguous runtime released active slot")
	}
	// Different chats may own separate instances of the same E2B configuration.
	execTest(t, s, insert, "runtime2", "another-chat", "inc2", "op2")
	target := Target{TenantID: "tenant", SpaceID: "space", ComputerID: "computer-space", RuntimeID: "runtime1", Incarnation: "inc1"}
	// Reconnection is legal only after an instance was previously observed.
	if err := s.Transition(ctx, target, Unknown, Ready, "later"); !errors.Is(err, ErrTransitionConflict) {
		t.Fatalf("unbound runtime marked ready: %v", err)
	}
	execTest(t, s, `UPDATE computer_runtimes SET external_id='vm1' WHERE id='runtime1'`)
	stale := target
	stale.Incarnation = "inc2"
	if err := s.Transition(ctx, stale, Unknown, Ready, "later"); !errors.Is(err, ErrTransitionConflict) {
		t.Fatalf("stale incarnation: %v", err)
	}
	if err := s.Transition(ctx, target, Unknown, Creating, "later"); err == nil {
		t.Fatal("unknown create retried")
	}
	if err := s.Transition(ctx, target, Unknown, Ready, "later"); err != nil {
		t.Fatal(err)
	}
	if err := s.Transition(ctx, target, Unknown, Ready, "later"); !errors.Is(err, ErrTransitionConflict) {
		t.Fatalf("stale state: %v", err)
	}
	q := `INSERT INTO computer_execution_targets(id,tenant_id,space_id,computer_id,runtime_id,incarnation,created_at) VALUES(?,'tenant','space','computer-space','runtime1',?,'now')`
	execTest(t, s, q, "job1", "inc1")
	if _, err := s.DB.Exec(q, "job2", "inc2"); err == nil {
		t.Fatal("job accepted another incarnation")
	}
	if err := s.Transition(ctx, target, Ready, Expired, "later"); err != nil {
		t.Fatal(err)
	}
	execTest(t, s, insert, "runtime3", "chat-space", "inc3", "op3")
	if err := s.Transition(ctx, target, Expired, Ready, "later"); err == nil {
		t.Fatal("expired instance restarted")
	}
	var incarnation string
	if err := s.DB.QueryRow(`SELECT incarnation FROM computer_execution_targets WHERE id='job1'`).Scan(&incarnation); err != nil || incarnation != "inc1" {
		t.Fatalf("job rebound: %s %v", incarnation, err)
	}
}

func TestExecutionBindingIsImmutableAndScoped(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	insert := `INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at) VALUES(?,'tenant','space','computer-space',?,?,?,'ready','now','now')`
	execTest(t, s, insert, "runtime1", "chat-space", "inc1", "op1")
	execTest(t, s, insert, "runtime2", "different-chat", "inc2", "op2")
	target := Target{TenantID: "tenant", SpaceID: "space", ComputerID: "computer-space", RuntimeID: "runtime1", Incarnation: "inc1"}
	for i := 0; i < 2; i++ {
		if err := s.PinExecution(ctx, "job", "run1", "call1", target, "now"); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.PinExecution(ctx, "job", "run1", "different-call", target, "now"); err == nil {
		t.Fatal("reused binding for another tool call")
	}
	other := target
	other.RuntimeID = "runtime2"
	other.Incarnation = "inc2"
	if err := s.PinExecution(ctx, "other-job", "run1", "call2", other, "now"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("cross-chat runtime: %v", err)
	}
	if err := s.PinExecution(ctx, "job", "run1", "call1", other, "now"); err == nil {
		t.Fatal("redirected existing job")
	}
	if got, err := s.ExecutionTarget(ctx, "tenant", "space", "run1", "job"); err != nil || got != target {
		t.Fatalf("lookup: %+v %v", got, err)
	}
	for _, row := range [][3]string{{"other", "space", "run1"}, {"tenant", "space2", "run1"}, {"tenant", "space", "run2"}} {
		if _, err := s.ExecutionTarget(ctx, row[0], row[1], row[2], "job"); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("binding leak: %v", err)
		}
	}
}

func TestClearSessionDefaultPreservesRunAndDoesNotFallback(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.SetSpaceDefault(ctx, "tenant", "space", "computer-space"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.InitializeSessionDefault(ctx, "tenant", "space", "chat-space"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil {
		t.Fatal(err)
	}
	for _, scope := range [][3]string{{"other", "space", "chat-space"}, {"tenant", "space2", "chat-space"}, {"tenant", "space", "missing"}} {
		if err := s.ClearSessionDefault(ctx, scope[0], scope[1], scope[2]); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("invalid scope accepted: %v", err)
		}
	}
	if id, err := s.InitializeSessionDefault(ctx, "tenant", "space", "chat-space"); err != nil || id != "computer-space" {
		t.Fatalf("invalid clear changed chat: %s %v", id, err)
	}
	for i := 0; i < 2; i++ {
		if err := s.ClearSessionDefault(ctx, "tenant", "space", "chat-space"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.InitializeSessionDefault(ctx, "tenant", "space", "chat-space"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("cleared choice restored: %v", err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil || id != "computer-space" {
		t.Fatalf("active run changed: %s %v", id, err)
	}
	if _, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run2"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("next run fell back: %v", err)
	}
	if err := s.SetSessionDefault(ctx, "tenant", "space", "chat-space", "second"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run2"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("empty run rebound: %v", err)
	}
}
