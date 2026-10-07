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
	if err := s.SetSpaceDefault(ctx, "tenant", "space", "new"); err != nil {
		t.Fatal(err)
	}
	id, err := s.SpaceDefault(ctx, "tenant", "space")
	if err != nil || id == nil || *id != "new" {
		t.Fatalf("default %v %v", id, err)
	}
	if _, err := s.SpaceDefault(ctx, "other", "space"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("cross tenant read %v", err)
	}
	if err := s.ClearSpaceDefault(ctx, "other", "space"); err != nil {
		t.Fatal(err)
	}
	id, err = s.SpaceDefault(ctx, "tenant", "space")
	if err != nil || id == nil {
		t.Fatal("foreign clear changed default")
	}
	if err := s.ClearSpaceDefault(ctx, "tenant", "space"); err != nil {
		t.Fatal(err)
	}
	id, err = s.SpaceDefault(ctx, "tenant", "space")
	if err != nil || id != nil {
		t.Fatalf("clear %v %v", id, err)
	}
}
