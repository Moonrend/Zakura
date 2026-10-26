package computers

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestConfigurationIsolation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	c := Computer{ID: "new", TenantID: "tenant", SpaceID: "space", Name: "E2B", Provider: E2B, IdleSeconds: 900, MaxLifetimeSeconds: 3600, Capabilities: []Capability{}}
	if err := s.Create(ctx, c, "encrypted-envelope"); err != nil {
		t.Fatal(err)
	}
	c.ID = "second-card"
	if err := s.Create(ctx, c, "another-encrypted-envelope"); err != nil {
		t.Fatal(err)
	}
	c.ID = "foreign-card"
	c.SpaceID = "foreign"
	if err := s.Create(ctx, c, "encrypted"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("cross tenant create: %v", err)
	}
	if err := s.Rename(ctx, "other", "space", "new", "hijack"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("cross tenant rename: %v", err)
	}
	if err := s.Rename(ctx, "tenant", "space", "new", "Renamed"); err != nil {
		t.Fatal(err)
	}
	var role string
	if err := s.DB.QueryRow(`SELECT role FROM computers WHERE id='new'`).Scan(&role); err != nil || role != string(RoleAttached) {
		t.Fatalf("created computer role: %q %v", role, err)
	}
	server := Computer{ID: "rogue", TenantID: "tenant", SpaceID: "space", Name: "Rogue", Provider: Server, Role: RoleServer, IdleSeconds: 900, MaxLifetimeSeconds: 3600}
	if err := s.Create(ctx, server, "encrypted"); !errors.Is(err, ErrServerComputerManaged) {
		t.Fatalf("second server computer created: %v", err)
	}
}

func TestDeleteAttachedComputer(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.Delete(ctx, "tenant", "space", "server:space"); !errors.Is(err, ErrServerComputerManaged) {
		t.Fatalf("server computer deleted: %v", err)
	}
	for _, scope := range [][2]string{{"other", "space"}, {"tenant", "space2"}} {
		if err := s.Delete(ctx, scope[0], scope[1], "second"); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("cross-scope delete %v: %v", scope, err)
		}
	}
	// A queued Run pinned to the computer keeps it alive.
	if err := s.SetSessionDefault(ctx, "tenant", "space", "chat-space", "second"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "tenant", "space", "second"); !errors.Is(err, ErrComputerInUse) {
		t.Fatalf("pinned computer deleted: %v", err)
	}
	execTest(t, s, `UPDATE cloud_agent_runs SET status='completed' WHERE id='run1'`)
	// A runtime that may own a provider instance keeps it alive too.
	execTest(t, s, `INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,external_id,state,created_at,updated_at) VALUES('rt','tenant','space','second','chat-space','inc','op','sandbox','ready','now','now')`)
	if err := s.Delete(ctx, "tenant", "space", "second"); !errors.Is(err, ErrComputerInUse) {
		t.Fatalf("computer with a live instance deleted: %v", err)
	}
	execTest(t, s, `UPDATE computer_runtimes SET state='expired' WHERE id='rt'`)
	if err := s.Delete(ctx, "tenant", "space", "second"); err != nil {
		t.Fatal(err)
	}
	// The chat that chose it now follows the server computer.
	if selected, err := s.SessionDefault(ctx, "tenant", "space", "chat-space"); err != nil || selected != nil {
		t.Fatalf("chat selection survived: %v %v", selected, err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run2"); err != nil || id != "server:space" {
		t.Fatalf("chat did not fall back: %s %v", id, err)
	}
	for _, q := range []string{`SELECT COUNT(*) FROM computers WHERE id='second'`, `SELECT COUNT(*) FROM computer_runtimes WHERE computer_id='second'`, `SELECT COUNT(*) FROM run_computer_targets WHERE computer_id='second'`} {
		var n int
		if err := s.DB.QueryRow(q).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s: %d %v", q, n, err)
		}
	}
}

func TestUpdateConfigurationRejectsStaleMergeAndPreservesIdentity(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	c, err := s.Get(ctx, "tenant", "space", "computer-space")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateCredentials(ctx, c.TenantID, c.SpaceID, c.ID, "original"); err != nil {
		t.Fatal(err)
	}
	c.Name = "Edited"
	c.IdleSeconds, c.MaxLifetimeSeconds = 300, 1800
	if err = s.UpdateConfiguration(ctx, c, "original", "updated", false); err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateConfiguration(ctx, c, "original", "stale", false); !errors.Is(err, ErrTransitionConflict) {
		t.Fatalf("stale credential merge: %v", err)
	}
	got, err := s.Get(ctx, c.TenantID, c.SpaceID, c.ID)
	if err != nil || got.Name != c.Name || got.Provider != c.Provider || got.RuntimeNodeID != c.RuntimeNodeID || got.IdleSeconds != 300 || got.MaxLifetimeSeconds != 1800 {
		t.Fatalf("configuration update changed identity: %+v %v", got, err)
	}
	var sealed string
	if err = s.DB.QueryRow(`SELECT secret_ref FROM computers WHERE id=?`, c.ID).Scan(&sealed); err != nil || sealed != "updated" {
		t.Fatalf("stale edit replaced configuration: %q %v", sealed, err)
	}
	c.SpaceID = "space2"
	if err = s.UpdateConfiguration(ctx, c, "updated", "foreign", false); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("cross-Space edit: %v", err)
	}
}

func TestUpdateCredentialsIsScoped(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.UpdateCredentials(ctx, "tenant", "space", "computer-space", "sealed-one"); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := s.DB.QueryRow(`SELECT secret_ref FROM computers WHERE id='computer-space'`).Scan(&got); err != nil || got != "sealed-one" {
		t.Fatalf("update: %q %v", got, err)
	}
	for _, scope := range [][2]string{{"other", "space"}, {"tenant", "foreign"}, {"other", "foreign"}} {
		if err := s.UpdateCredentials(ctx, scope[0], scope[1], "computer-space", "sealed-two"); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("cross-tenant update %v: %v", scope, err)
		}
	}
	if err := s.UpdateCredentials(ctx, "tenant", "space", "missing", "sealed-three"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing computer: %v", err)
	}
	if err := s.DB.QueryRow(`SELECT secret_ref FROM computers WHERE id='computer-space'`).Scan(&got); err != nil || got != "sealed-one" {
		t.Fatalf("scoped update changed row: %q %v", got, err)
	}
}
