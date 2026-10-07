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
	for _, tt := range [][2]string{{"", "computer-space"}, {"second", "second"}, {"", "computer-space"}} {
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
		{"tenant", "space", "run1", "computer-foreign"},
		{"tenant", "space", "missing", "second"},
		{"tenant", "space", "run2", "second"}, // no snapshot: fail closed
		{"tenant", "space", "run1", "missing"},
	} {
		if _, err := s.ResolveRunComputer(ctx, tt[0], tt[1], tt[2], tt[3]); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("invalid target accepted %v: %v", tt, err)
		}
	}
	if err := s.ClearSessionDefault(ctx, "tenant", "space", "chat-space"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SnapshotRunTarget(ctx, "tenant", "space", "run2"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	if err := s.SetSpaceDefault(ctx, "tenant", "space", "second"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResolveRunComputer(ctx, "tenant", "space", "run2", ""); !errors.Is(err, ErrNoComputerSelected) {
		t.Fatalf("empty snapshot fell back: %v", err)
	}
	if c, err := s.ResolveRunComputer(ctx, "tenant", "space", "run2", "second"); err != nil || c.ID != "second" {
		t.Fatalf("explicit choice without default: %+v %v", c, err)
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM computer_runtimes`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("selection provisioned runtime: %d %v", n, err)
	}
}
