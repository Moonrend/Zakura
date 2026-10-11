// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestCreateRunOnceConcurrentReplayAndFrozenProof(t *testing.T) {
	s := testStore(t)
	raw, err := os.ReadFile("../platform/migrations/sql/0012_project_campaigns.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range strings.Split(string(raw), "-- statement-breakpoint") {
		if _, err = s.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	p, err := s.CreateProject(ctx, projectFixture())
	if err != nil {
		t.Fatal(err)
	}
	rid := "0123456789abcdef0123456789abcdef"
	results := make(chan error, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			run, err := s.CreateRunOnce(ctx, p.TenantID, p.ID, "frozen-base", p.Revision, rid)
			if err == nil && run.ID != rid {
				t.Errorf("wrong reserved identity: %s", run.ID)
			}
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	runs, err := s.ListRuns(ctx, p.TenantID, p.ID, 100)
	if err != nil || len(runs) != 1 {
		t.Fatalf("duplicate runs: %d %v", len(runs), err)
	}
	if _, err = s.CreateRunOnce(ctx, p.TenantID, p.ID, "different-base", p.Revision, rid); !errors.Is(err, ErrConflict) {
		t.Fatalf("base proof not bound: %v", err)
	}
	if _, err = s.CreateRunOnce(ctx, p.TenantID, p.ID, "frozen-base", p.Revision+1, rid); !errors.Is(err, ErrConflict) {
		t.Fatalf("revision proof not bound: %v", err)
	}
	other, err := s.CreateProject(ctx, projectFixture())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateRunOnce(ctx, other.TenantID, other.ID, "frozen-base", other.Revision, rid); !errors.Is(err, ErrConflict) {
		t.Fatalf("identity borrowed by other project: %v", err)
	}
	if _, err = s.CreateRunOnce(ctx, p.TenantID, p.ID, "frozen-base", p.Revision, "not-opaque"); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("invalid reserved ID accepted: %v", err)
	}
}
