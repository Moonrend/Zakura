// SPDX-License-Identifier: AGPL-3.0-or-later
package projecttemplates

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
	_ "github.com/mattn/go-sqlite3"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	db, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "templates.db")+"?_foreign_keys=on&_busy_timeout=10000&_journal_mode=WAL")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(8)
	t.Cleanup(func() { db.Close() })
	for _, query := range []string{`CREATE TABLE tenants(id TEXT PRIMARY KEY)`, `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id))`, `INSERT INTO tenants VALUES('tenant-a'),('tenant-b')`, `INSERT INTO spaces VALUES('space-a','tenant-a'),('space-b','tenant-b')`} {
		if _, err = db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"0006_project_execution.sql", "0008_project_templates.sql"} {
		raw, err := os.ReadFile("../platform/migrations/sql/" + name)
		if err != nil {
			t.Fatal(err)
		}
		for _, query := range strings.Split(string(raw), "-- statement-breakpoint") {
			if _, err = db.Exec(query); err != nil {
				t.Fatal(err)
			}
		}
	}
	return NewStore(db, "sqlite", nil)
}

func fixture() blueprint.Definition { return blueprint.Recipes()[0].Definition }

func TestVersionHistoryTenantIsolationAndArchive(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	created, err := s.Create(ctx, "tenant-a", "", fixture())
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 1 || created.CurrentVersion != 1 || created.CreatedBy != "" {
		t.Fatalf("bad create %#v", created)
	}
	if _, err = s.Get(ctx, "tenant-b", created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tenant leak: %v", err)
	}
	definition := fixture()
	definition.Description = "Revised description"
	updated, err := s.Update(ctx, "tenant-a", created.ID, "user", 1, definition)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 2 || updated.CurrentVersion != 2 {
		t.Fatal("version did not advance")
	}
	old, err := s.Version(ctx, "tenant-a", created.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if old.Definition.Description == updated.Definition.Description {
		t.Fatal("immutable version changed")
	}
	if _, err = s.Select(ctx, "tenant-a", created.ID, 1, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("accepted stale select: %v", err)
	}
	selected, err := s.Select(ctx, "tenant-a", created.ID, 2, 1)
	if err != nil || selected.Version != 1 {
		t.Fatalf("old version selection: %#v %v", selected, err)
	}
	if _, err = s.Update(ctx, "tenant-a", created.ID, "user", 1, definition); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale update: %v", err)
	}
	versions, err := s.Versions(ctx, "tenant-a", created.ID, 10)
	if err != nil || len(versions) != 2 || versions[0].Version != 2 {
		t.Fatalf("versions: %#v %v", versions, err)
	}
	if err = s.Delete(ctx, "tenant-b", created.ID, 2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant delete: %v", err)
	}
	if err = s.Delete(ctx, "tenant-a", created.ID, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale delete: %v", err)
	}
	if err = s.Delete(ctx, "tenant-a", created.ID, 2); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Get(ctx, "tenant-a", created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("archived visible: %v", err)
	}
	items, err := s.List(ctx, "tenant-a", 10)
	if err != nil || len(items) != 0 {
		t.Fatalf("archived listed: %#v %v", items, err)
	}
	var n int
	if err = s.db.QueryRow(`SELECT count(*) FROM project_template_versions WHERE template_id=?`, created.ID).Scan(&n); err != nil || n != 2 {
		t.Fatal("archival destroyed versions", err)
	}
}

func TestConcurrentEditorsHaveOneWinner(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	item, err := s.Create(ctx, "tenant-a", "user", fixture())
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := s.Update(ctx, "tenant-a", item.ID, "user", 1, fixture())
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	winners := 0
	for err := range results {
		if err == nil {
			winners++
		} else if !errors.Is(err, ErrConflict) {
			t.Fatalf("unexpected concurrent mutation error: %v", err)
		}
	}
	if winners != 1 {
		t.Fatalf("got %d winners", winners)
	}
	versions, err := s.Versions(ctx, "tenant-a", item.ID, 100)
	if err != nil || len(versions) != 2 {
		t.Fatalf("versions: %d %v", len(versions), err)
	}
}

func TestTenantDrainFencesAllTemplateMutations(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	item, err := s.Create(ctx, "tenant-a", "user", fixture())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES('tenant-a',1,'now')`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(ctx, "tenant-a", "user", fixture()); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatalf("create ignored drain: %v", err)
	}
	if _, err = s.Update(ctx, "tenant-a", item.ID, "user", 1, fixture()); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatalf("update ignored drain: %v", err)
	}
	if err = s.Delete(ctx, "tenant-a", item.ID, 1); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatalf("delete ignored drain: %v", err)
	}
	if _, err = s.Get(ctx, "tenant-a", item.ID); err != nil {
		t.Fatalf("read blocked by drain: %v", err)
	}
	if _, err = s.Create(ctx, "missing", "user", fixture()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown tenant: %v", err)
	}
}
