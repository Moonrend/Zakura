package computers

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestResolveRunComputerUsesSnapshotAndExplicitScopedTarget(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.SetSessionDefault(ctx, "tenant", "space", "chat-space", "computer-space"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSessionDefault(ctx, "tenant", "space", "chat-space", "second"); err != nil {
		t.Fatal(err)
	}
	for _, tt := range [][2]string{{"", "computer-space"}, {"second", "second"}, {"server:space", "server:space"}, {"", "computer-space"}} {
		c, err := s.ResolveRunComputer(ctx, "tenant", "space", "run1", tt[0])
		if err != nil || c.ID != tt[1] {
			t.Fatalf("resolve %q: %+v %v", tt[0], c, err)
		}
		if c.SecretRef != "" {
			t.Fatal("execution selection exposed secret reference")
		}
	}
	for _, tt := range [][4]string{
		{"other", "space", "run1", "second"},
		{"tenant", "space2", "run1", "computer-space2"},
		{"tenant", "space", "run1", "computer-space2"},
		{"tenant", "space", "run1", "server:space2"},
		{"tenant", "space", "run1", "computer-foreign"},
		{"tenant", "space", "missing", "second"},
		{"tenant", "space", "run2", "second"}, // no snapshot: fail closed
		{"tenant", "space", "run1", "missing"},
	} {
		if _, err := s.ResolveRunComputer(ctx, tt[0], tt[1], tt[2], tt[3]); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("invalid target accepted %v: %v", tt, err)
		}
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM computer_runtimes`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("selection provisioned runtime: %d %v", n, err)
	}
}

func TestResolveRunComputerFallsBackToServerComputer(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.ClearSessionDefault(ctx, "tenant", "space", "chat-space"); err != nil {
		t.Fatal(err)
	}
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run1"); err != nil || id != "server:space" {
		t.Fatalf("snapshot: %s %v", id, err)
	}
	c, err := s.ResolveRunComputer(ctx, "tenant", "space", "run1", "")
	if err != nil || c.ID != "server:space" || !c.IsServer() {
		t.Fatalf("fallback: %+v %v", c, err)
	}
	// An explicit target still wins for that call only.
	if c, err := s.ResolveRunComputer(ctx, "tenant", "space", "run1", "second"); err != nil || c.ID != "second" {
		t.Fatalf("explicit target: %+v %v", c, err)
	}
	// A Run pinned before the server computer existed has a NULL target; it
	// resolves to the server computer rather than failing every tool call.
	execTest(t, s, `INSERT INTO run_computer_targets(run_id,tenant_id,space_id,computer_id) VALUES('run2','tenant','space',NULL)`)
	if c, err := s.ResolveRunComputer(ctx, "tenant", "space", "run2", ""); err != nil || c.ID != "server:space" {
		t.Fatalf("legacy NULL target: %+v %v", c, err)
	}
	// Without a server computer the fallback fails closed instead of picking
	// another computer.
	execTest(t, s, `INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES('bare','tenant','Bare','bare','now','now')`)
	execTest(t, s, `INSERT INTO agents(id,tenant_id,space_id,name,slug,created_at,updated_at) VALUES('agent-bare','tenant','bare','bare','bare','now','now')`)
	execTest(t, s, `INSERT INTO cloud_agent_sessions(id,tenant_id,agent_id,created_at,updated_at) VALUES('chat-bare','tenant','agent-bare','now','now')`)
	execTest(t, s, `INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES('bare-cloud','tenant','bare','Cloud','e2b','now','now')`)
	execTest(t, s, `INSERT INTO cloud_agent_runs(id,session_id,status,created_at) VALUES('run-bare','chat-bare','queued','now')`)
	if _, err := s.SnapshotRunTarget(ctx, "tenant", "bare", "run-bare"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("snapshot without server computer: %v", err)
	}
	if _, err := s.ResolveRunComputer(ctx, "tenant", "bare", "run-bare", ""); !errors.Is(err, ErrNoServerComputer) || !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing server computer: %v", err)
	}
}
