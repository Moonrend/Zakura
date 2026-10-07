package runtime

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

func TestComputerSelectionCreationTransactions(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	db, err := d.Gorm.DB()
	if err != nil {
		t.Fatal(err)
	}
	selections := computers.Store{DB: db}
	for _, id := range []string{"one", "two"} {
		if err := d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES(?,'tenant',?,?,'server','now','now')`, id, space.ID, id).Error; err != nil {
			t.Fatal(err)
		}
	}
	// Creation persists none. Adding a Space default later must not change it.
	empty, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	if err := selections.SetSpaceDefault(ctx, "tenant", space.ID, "one"); err != nil {
		t.Fatal(err)
	}
	if _, err := selections.InitializeSessionDefault(ctx, "tenant", space.ID, empty.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("none chat gained default: %v", err)
	}
	noneRun, err := store.StartRun(ctx, "tenant", agent.ID, empty.ID, "hello", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := selections.SetSessionDefault(ctx, "tenant", space.ID, empty.ID, "two"); err != nil {
		t.Fatal(err)
	}
	if _, err := selections.SnapshotRunTarget(ctx, "tenant", space.ID, noneRun.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("none Run gained default: %v", err)
	}
	chat, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	if err := selections.SetSpaceDefault(ctx, "tenant", space.ID, "two"); err != nil {
		t.Fatal(err)
	}
	run, err := store.StartRun(ctx, "tenant", agent.ID, chat.ID, "hello", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := selections.SetSessionDefault(ctx, "tenant", space.ID, chat.ID, "two"); err != nil {
		t.Fatal(err)
	}
	if id, err := selections.SnapshotRunTarget(ctx, "tenant", space.ID, run.ID); err != nil || id != "one" {
		t.Fatalf("Run not snapshotted at creation: %s %v", id, err)
	}
	if err := store.FinishRun(ctx, "tenant", agent.ID, chat.ID, run.ID, "completed", nil, nil); err != nil {
		t.Fatal(err)
	}
	next, err := store.StartRun(ctx, "tenant", agent.ID, chat.ID, "next", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if id, err := selections.SnapshotRunTarget(ctx, "tenant", space.ID, next.ID); err != nil || id != "two" {
		t.Fatalf("next Run did not inherit new choice: %s %v", id, err)
	}
	// A failed snapshot must roll back the entire Run, including active_run_id.
	if err := store.FinishRun(ctx, "tenant", agent.ID, chat.ID, next.ID, "completed", nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.Gorm.Exec(`CREATE TRIGGER reject_computer_snapshot BEFORE INSERT ON run_computer_targets BEGIN SELECT RAISE(ABORT,'snapshot failed'); END`).Error; err != nil {
		t.Fatal(err)
	}
	var before int64
	d.Gorm.Table("cloud_agent_runs").Count(&before)
	if _, err := store.StartRun(ctx, "tenant", agent.ID, chat.ID, "rollback", nil, nil); err == nil {
		t.Fatal("snapshot failure ignored")
	}
	var after int64
	d.Gorm.Table("cloud_agent_runs").Count(&after)
	if before != after {
		t.Fatal("failed snapshot left a Run")
	}
	current, err := store.GetSession(ctx, "tenant", agent.ID, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.ActiveRunID != nil {
		t.Fatal("failed snapshot locked chat")
	}
}
