package computers

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestEnsureServerComputerHealsUnmanagedSpaceWithoutChangingSelections(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	execTest(t, s, `INSERT INTO spaces(id,tenant_id,name,slug,runtime_node_id,workspace_kind,workspace_image,created_at,updated_at) VALUES('bare','tenant','Bare','bare','old-node','host','custom:old','before','before')`)
	execTest(t, s, `INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES('attached-bare','tenant','bare','Attached','e2b','before','before')`)
	execTest(t, s, `INSERT INTO agents(id,tenant_id,space_id,name,slug,created_at,updated_at) VALUES('agent-bare','tenant','bare','Bare','bare','before','before')`)
	execTest(t, s, `INSERT INTO cloud_agent_sessions(id,tenant_id,agent_id,created_at,updated_at) VALUES('chat-bare','tenant','agent-bare','before','before')`)
	if err := s.SetSessionDefault(ctx, "tenant", "bare", "chat-bare", "attached-bare"); err != nil {
		t.Fatal(err)
	}
	execTest(t, s, `INSERT INTO cloud_agent_runs(id,session_id,status,created_at) VALUES('run-bare','chat-bare','queued','before')`)
	if id, err := s.SnapshotRunTarget(ctx, "tenant", "bare", "run-bare"); err != nil || id != "attached-bare" {
		t.Fatalf("initial snapshot: %s %v", id, err)
	}
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 2; i++ {
		c, err := s.EnsureServerComputer(ctx, "tenant", "bare", now)
		if err != nil || c.ID != "server:bare" || !c.IsServer() || c.RuntimeNodeID != "old-node" || c.WorkspaceKind != "host" {
			t.Fatalf("healed server: %+v %v", c, err)
		}
	}
	execTest(t, s, `UPDATE spaces SET runtime_node_id='new-node',workspace_kind='container',workspace_image='custom:new',enable_computer=TRUE WHERE id='bare'`)
	if _, err := s.EnsureServerComputer(ctx, "tenant", "bare", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var node, kind, image, created string
	if err := s.DB.QueryRow(`SELECT runtime_node_id,legacy_workspace_kind,workspace_image,created_at FROM computers WHERE id='server:bare'`).Scan(&node, &kind, &image, &created); err != nil || node != "new-node" || kind != "container" || image != "custom:new" || created != now.Format(time.RFC3339Nano) {
		t.Fatalf("cached workspace columns: %s %s %s %s %v", node, kind, image, created, err)
	}
	if selected, err := s.SessionDefault(ctx, "tenant", "bare", "chat-bare"); err != nil || selected == nil || *selected != "attached-bare" {
		t.Fatalf("healing changed chat: %v %v", selected, err)
	}
	if c, err := s.ResolveRunComputer(ctx, "tenant", "bare", "run-bare", ""); err != nil || c.ID != "attached-bare" {
		t.Fatalf("healing changed run: %+v %v", c, err)
	}
	for _, scope := range [][2]string{{"other", "bare"}, {"tenant", "missing"}} {
		if _, err := s.EnsureServerComputer(ctx, scope[0], scope[1], now); !errors.Is(err, ErrNoServerComputer) {
			t.Fatalf("invalid scope %v: %v", scope, err)
		}
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM computers WHERE space_id='bare'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("healing duplicated computers: %d %v", n, err)
	}
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM computer_runtimes`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("healing provisioned runtime: %d %v", n, err)
	}
}

func TestEnsureServerComputerPreservesAdoptedIdentity(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	execTest(t, s, `INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES('adopted','tenant','Adopted','adopted','before','before')`)
	execTest(t, s, `INSERT INTO computers(id,tenant_id,space_id,name,provider,role,legacy_workspace_scope,created_at,updated_at) VALUES('legacy:adopted','tenant','adopted','Old name','server','server','adopted','before','before')`)
	for i := 0; i < 2; i++ {
		c, err := s.EnsureServerComputer(ctx, "tenant", "adopted", time.Now())
		if err != nil || c.ID != "legacy:adopted" || c.Name != "Old name" {
			t.Fatalf("adopted identity changed: %+v %v", c, err)
		}
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM computers WHERE space_id='adopted'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("adopted workspace duplicated: %d %v", n, err)
	}
	if id, err := s.SpaceDefault(ctx, "tenant", "adopted"); err != nil || id == nil || *id != "legacy:adopted" {
		t.Fatalf("adopted space default: %v %v", id, err)
	}
}
