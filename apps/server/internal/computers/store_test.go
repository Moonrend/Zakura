package computers

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
	seedComputerFixtures(t, s)
	return s
}

// seedComputerFixtures gives every Space its server computer ("server:<space>"),
// one attached E2B computer ("computer-<space>"), an agent and a chat, plus a
// second attached computer and two queued Runs in "space".
func seedComputerFixtures(t *testing.T, s Store) {
	t.Helper()
	for _, tenant := range []string{"tenant", "other"} {
		execTest(t, s, `INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES(?,?,?,'now','now')`, tenant, tenant, tenant)
	}
	for _, row := range [][2]string{{"space", "tenant"}, {"space2", "tenant"}, {"foreign", "other"}} {
		execTest(t, s, `INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,'now','now')`, row[0], row[1], row[0], row[0])
		if _, err := s.EnsureServerComputer(context.Background(), row[1], row[0], time.Now()); err != nil {
			t.Fatal(err)
		}
		execTest(t, s, `INSERT INTO agents(id,tenant_id,space_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,'now','now')`, "agent-"+row[0], row[1], row[0], row[0], row[0])
		execTest(t, s, `INSERT INTO cloud_agent_sessions(id,tenant_id,agent_id,created_at,updated_at) VALUES(?,?,?,'now','now')`, "chat-"+row[0], row[1], "agent-"+row[0])
		execTest(t, s, `INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES(?,?,?,?,'e2b','now','now')`, "computer-"+row[0], row[1], row[0], row[0])
	}
	execTest(t, s, `INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES('second','tenant','space','Second','e2b','now','now')`)
	for _, run := range []string{"run1", "run2"} {
		execTest(t, s, `INSERT INTO cloud_agent_runs(id,session_id,status,created_at) VALUES(?,'chat-space','queued','now')`, run)
	}
}
func execTest(t *testing.T, s Store, q string, args ...any) {
	t.Helper()
	if _, err := s.DB.Exec(s.query(q), args...); err != nil {
		t.Fatal(err)
	}
}
func TestUpdateManifestIsScoped(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	execTest(t, s, `INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at) VALUES('runtime','tenant','space','computer-space','chat-space','inc1','op1','unknown','now','now')`)
	target := Target{TenantID: "tenant", SpaceID: "space", ComputerID: "computer-space", RuntimeID: "runtime", Incarnation: "inc1"}
	if err := s.UpdateManifest(ctx, target, map[string]any{"box": "zippy"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := s.DB.QueryRow(`SELECT manifest_json FROM computer_runtimes WHERE id='runtime'`).Scan(&raw); err != nil || !strings.Contains(raw, "zippy") {
		t.Fatalf("manifest not persisted: %q %v", raw, err)
	}
	stale := target
	stale.Incarnation = "inc2"
	if err := s.UpdateManifest(ctx, stale, map[string]any{"box": "other"}, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("stale incarnation: %v", err)
	}
	foreign := target
	foreign.TenantID = "other"
	if err := s.UpdateManifest(ctx, foreign, map[string]any{"box": "other"}, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("cross tenant: %v", err)
	}
	unknown := target
	unknown.RuntimeID = "missing"
	if err := s.UpdateManifest(ctx, unknown, map[string]any{"box": "other"}, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing runtime: %v", err)
	}
	if err := s.UpdateManifest(ctx, target, map[string]any{"box": strings.Repeat("x", maxManifestBytes+1)}, time.Now()); err == nil {
		t.Fatal("oversized manifest accepted")
	}
	if err := s.DB.QueryRow(`SELECT manifest_json FROM computer_runtimes WHERE id='runtime'`).Scan(&raw); err != nil || !strings.Contains(raw, "zippy") {
		t.Fatalf("failed updates changed the row: %q %v", raw, err)
	}
}

func TestDefaultsSnapshotAndIsolation(t *testing.T) {
	checkDefaultsAndSnapshots(t, testStore(t))
}

func TestServerComputerInvariants(t *testing.T) {
	checkServerComputerInvariants(t, testStore(t))
}

// checkServerComputerInvariants is shared with the PostgreSQL suite.
func checkServerComputerInvariants(t *testing.T, s Store) {
	t.Helper()
	ctx := context.Background()
	for _, row := range [][2]string{{"tenant", "space"}, {"tenant", "space2"}, {"other", "foreign"}} {
		var n int
		if err := s.DB.QueryRow(s.query(`SELECT COUNT(*) FROM computers WHERE tenant_id=? AND space_id=? AND role='server'`), row[0], row[1]).Scan(&n); err != nil || n != 1 {
			t.Fatalf("%v server computers: %d %v", row, n, err)
		}
	}
	// Ensuring again is idempotent and keeps the identity.
	for i := 0; i < 2; i++ {
		c, err := s.EnsureServerComputer(ctx, "tenant", "space", time.Now())
		if err != nil || c.ID != "server:space" || !c.IsServer() || c.Provider != Server {
			t.Fatalf("ensure: %+v %v", c, err)
		}
	}
	// The partial unique index rejects a second server computer in one Space.
	if _, err := s.DB.Exec(s.query(`INSERT INTO computers(id,tenant_id,space_id,name,provider,role,created_at,updated_at) VALUES('dup','tenant','space','Dup','server','server','now','now')`)); err == nil {
		t.Fatal("second server computer accepted")
	}
	// The server computer is listed first and follows the Space's workspace.
	list, err := s.List(ctx, "tenant", "space")
	if err != nil || len(list) != 3 || list[0].ID != "server:space" || !list[0].IsServer() {
		t.Fatalf("list: %+v %v", list, err)
	}
	if list[0].WorkspaceKind != "local" || len(list[0].Capabilities) != 0 || list[0].SupportsACP() {
		t.Fatalf("nodeless server computer: %+v", list[0])
	}
	execTest(t, s, `UPDATE spaces SET runtime_node_id='node-1',workspace_kind='docker',enable_computer=? WHERE id='space'`, true)
	c, err := s.ServerComputer(ctx, "tenant", "space")
	if err != nil || c.RuntimeNodeID != "node-1" || c.WorkspaceKind != "container" || !c.Has(Docker) || !c.Has(Desktop) || !c.SupportsACP() {
		t.Fatalf("container server computer: %+v %v", c, err)
	}
	execTest(t, s, `UPDATE spaces SET workspace_kind='host' WHERE id='space'`)
	if c, err = s.ServerComputer(ctx, "tenant", "space"); err != nil || c.WorkspaceKind != "host" || c.Has(Docker) || !c.Has(RestrictedCommands) {
		t.Fatalf("host server computer: %+v %v", c, err)
	}
	if _, err = s.ServerComputer(ctx, "other", "space"); !errors.Is(err, ErrNoServerComputer) {
		t.Fatalf("cross-tenant server computer: %v", err)
	}
	// It is managed with its Space: it cannot be removed or given a runtime.
	if err = s.Delete(ctx, "tenant", "space", "server:space"); !errors.Is(err, ErrServerComputerManaged) {
		t.Fatalf("server computer deleted: %v", err)
	}
	if _, err = s.ReserveRuntime(ctx, "tenant", "space", "server:space", "chat-space", time.Now()); !errors.Is(err, ErrServerComputerManaged) {
		t.Fatalf("server computer runtime reserved: %v", err)
	}
	// Deleting a Space whose computers are referenced by pins and selections
	// succeeds and removes every computer row of that Space.
	if err = s.SetSessionDefault(ctx, "tenant", "space", "chat-space", "second"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil {
		t.Fatal(err)
	}
	execTest(t, s, `INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at) VALUES('rt-del','tenant','space','computer-space','chat-space','inc','op','expired','now','now')`)
	execTest(t, s, `DELETE FROM spaces WHERE id='space'`)
	var left int
	if err = s.DB.QueryRow(`SELECT COUNT(*) FROM computers WHERE space_id='space'`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("computers left after space delete: %d %v", left, err)
	}
}

// checkDefaultsAndSnapshots is shared with the PostgreSQL suite.
func checkDefaultsAndSnapshots(t *testing.T, s Store) {
	t.Helper()
	ctx := context.Background()
	execTest(t, s, `INSERT INTO cloud_agent_runs(id,session_id,status,created_at) VALUES('run-none','chat-space','queued','now')`)
	// A chat that never chose a computer pins the Space server computer.
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run-none"); err != nil || id != "server:space" {
		t.Fatalf("uninitialized chat: %s %v", id, err)
	}
	// The Space default is fixed to the server computer.
	if err := s.SetSpaceDefault(ctx, "tenant", "space", "computer-space"); !errors.Is(err, ErrSpaceDefaultFixed) {
		t.Fatalf("attached space default accepted: %v", err)
	}
	if err := s.SetSpaceDefault(ctx, "tenant", "space", "server:space"); err != nil {
		t.Fatalf("server space default: %v", err)
	}
	if id, err := s.SpaceDefault(ctx, "tenant", "space"); err != nil || id == nil || *id != "server:space" {
		t.Fatalf("space default: %v %v", id, err)
	}
	if _, err := s.InitializeSessionDefault(ctx, "tenant", "space", "chat-space"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("new chat gained an explicit choice: %v", err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil || id != "server:space" {
		t.Fatalf("snapshot: %s %v", id, err)
	}
	if err := s.SetSessionDefault(ctx, "tenant", "space", "chat-space", "second"); err != nil {
		t.Fatal(err)
	}
	if id, err := s.InitializeSessionDefault(ctx, "tenant", "space", "chat-space"); err != nil || id != "second" {
		t.Fatalf("reinitialization changed chat: %s %v", id, err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil || id != "server:space" {
		t.Fatalf("active Run changed: %s %v", id, err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run2"); err != nil || id != "second" {
		t.Fatalf("next Run: %s %v", id, err)
	}
	for _, computer := range []string{"computer-space2", "server:space2", "computer-foreign", "missing"} {
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
	if _, err := s.SpaceDefault(ctx, "other", "space"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("space default tenant leak: %v", err)
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

func TestClearSessionDefaultPreservesRunAndFollowsServer(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.SetSessionDefault(ctx, "tenant", "space", "chat-space", "computer-space"); err != nil {
		t.Fatal(err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil || id != "computer-space" {
		t.Fatalf("snapshot: %s %v", id, err)
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
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run2"); err != nil || id != "server:space" {
		t.Fatalf("cleared chat did not follow the server computer: %s %v", id, err)
	}
	if err := s.SetSessionDefault(ctx, "tenant", "space", "chat-space", "second"); err != nil {
		t.Fatal(err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run2"); err != nil || id != "server:space" {
		t.Fatalf("pinned run rebound: %s %v", id, err)
	}
}
