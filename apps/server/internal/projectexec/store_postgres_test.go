package projectexec

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	_ "github.com/lib/pq"
)

func newPostgresStoreFixture(t *testing.T) (*Store, *atomic.Int64) {
	t.Helper()
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_DSN is absent; real PostgreSQL integration was not run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, e := sql.Open("postgres", dsn)
	if e != nil {
		t.Fatal(e)
	}
	if e = admin.PingContext(ctx); e != nil {
		admin.Close()
		t.Fatal("connect integration PostgreSQL:", e)
	}
	id, e := newID()
	if e != nil {
		admin.Close()
		t.Fatal(e)
	}
	schema := "zakura_projectexec_" + id
	if _, e = admin.ExecContext(ctx, `CREATE SCHEMA "`+schema+`"`); e != nil {
		admin.Close()
		t.Fatal(e)
	}
	// Startup parameters apply the isolated search path to every pooled
	// connection, including the competing workers, rather than only one session.
	isolatedDSN := dsn
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		u, e := url.Parse(dsn)
		if e != nil {
			t.Fatal(e)
		}
		q := u.Query()
		q.Set("search_path", schema)
		u.RawQuery = q.Encode()
		isolatedDSN = u.String()
	} else {
		isolatedDSN += " search_path='" + schema + "'"
	}
	db, e := sql.Open("postgres", isolatedDSN)
	if e != nil {
		t.Fatal(e)
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(10)
	t.Cleanup(func() {
		if e := db.Close(); e != nil {
			t.Error(e)
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if _, e := admin.ExecContext(cleanup, `DROP SCHEMA "`+schema+`" CASCADE`); e != nil {
			t.Error("drop isolated test schema:", e)
		}
		if e := admin.Close(); e != nil {
			t.Error(e)
		}
	})
	if e = migrations.Apply(ctx, db, "postgres", appdeps.PostgresRebind); e != nil {
		t.Fatal(e)
	}
	var lastVersion int
	if e = db.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&lastVersion); e != nil {
		t.Fatal(e)
	}
	if lastVersion < 7 {
		t.Fatalf("expected actual project execution and merge migrations, got version %d", lastVersion)
	}
	now := stamp(time.Now().UTC())
	for _, tenant := range []string{"tenant-a", "tenant-b"} {
		if _, e = db.ExecContext(ctx, appdeps.PostgresRebind(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES(?,?,?,?,?)`), tenant, tenant, tenant, now, now); e != nil {
			t.Fatal(e)
		}
	}
	for _, pair := range [][2]string{{"space-a", "tenant-a"}, {"space-b", "tenant-b"}} {
		if _, e = db.ExecContext(ctx, appdeps.PostgresRebind(`INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,?)`), pair[0], pair[1], pair[0], pair[0], now, now); e != nil {
			t.Fatal(e)
		}
	}
	clock := &atomic.Int64{}
	clock.Store(time.Now().UTC().UnixNano())
	s := NewStore(db, "postgres", appdeps.PostgresRebind)
	s.now = func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	return s, clock
}

func TestStorePostgresCompetingWorkersBudgetsFencesAndRevisionOrder(t *testing.T) {
	s, clock := newPostgresStoreFixture(t)
	ctx := context.Background()
	p := projectFixture()
	p.Config.Budget.MaxTokens = 15
	second := p.Plan.Tasks[0]
	second.ID = "second"
	p.Plan.Tasks = append(p.Plan.Tasks, second)
	p, r := createFixture(t, s, p)
	var wg sync.WaitGroup
	claims := make(chan *mission.Assignment, 8)
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			a, e := s.ClaimTask(ctx, fmt.Sprintf("postgres-worker-%d", i), time.Minute)
			if e != nil {
				failures <- e
			}
			if a != nil {
				claims <- a
			}
		}(i)
	}
	wg.Wait()
	close(claims)
	close(failures)
	for e := range failures {
		t.Fatal(e)
	}
	assignments := []*mission.Assignment{}
	seen := map[string]bool{}
	for a := range claims {
		if seen[a.Task.ID] {
			t.Fatal("two PostgreSQL workers acquired the same task incarnation")
		}
		seen[a.Task.ID] = true
		assignments = append(assignments, a)
	}
	if len(assignments) != 2 {
		t.Fatalf("competing PostgreSQL claims=%d", len(assignments))
	}
	refs := map[string]FenceRequest{}
	allowances := make(chan int64, 2)
	for _, a := range assignments {
		ref := FenceRequest{Scope: a.Scope, RunID: r.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}
		refs[a.Task.ID] = ref
		wg.Add(1)
		go func(ref FenceRequest) {
			defer wg.Done()
			n, e := s.ReserveDecisionBudget(ctx, ref, 10)
			if e != nil {
				t.Error(e)
			}
			allowances <- n
		}(ref)
	}
	wg.Wait()
	close(allowances)
	reserved := int64(0)
	for n := range allowances {
		reserved += n
	}
	if reserved != 15 {
		t.Fatalf("atomic token reservations=%d", reserved)
	}
	current, e := s.GetRun(ctx, p.TenantID, p.ID, r.ID)
	if e != nil || current.Tokens != 15 || current.ModelCalls != 2 {
		t.Fatalf("PostgreSQL budget %+v %v", current, e)
	}
	for _, ref := range refs {
		if _, e = s.RecordModelDecision(ctx, ref, 0, mission.Decision{Done: true, Result: "ready", Tokens: 1}); e != nil {
			t.Fatal(e)
		}
	}
	a := assignments[0]
	ref := refs[a.Task.ID]
	if e = s.InitializeTaskBranch(ctx, ref, "postgres-branch", "base-snapshot"); e != nil {
		t.Fatal(e)
	}
	var latest mission.Verification
	for _, snapshot := range []string{"snapshot-one", "snapshot-two"} {
		report, e := acceptance.Evaluate(ctx, a.Task.Spec.Checks, acceptance.Environment{SnapshotID: snapshot, Files: storeSnapshotFiles{"feature.go": "package feature"}}, acceptance.Options{})
		if e != nil {
			t.Fatal(e)
		}
		latest, e = s.RecordVerification(ctx, ref, report.Verification("", ref.TaskID, "postgres-branch", s.now()))
		if e != nil {
			t.Fatal(e)
		}
	}
	actual, e := s.verification(ctx, s.db, ref.Scope, ref.RunID, ref.TaskID)
	if e != nil || actual.ID != latest.ID || actual.SnapshotID != "snapshot-two" {
		t.Fatalf("same-clock verification ordering %+v %v", actual, e)
	}
	p.Goal = "A newer goal"
	updated, e := s.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, updated); !errors.Is(e, ErrConflict) {
		t.Fatalf("project CAS failed: %v", e)
	}
	frozen, e := s.GetRunProject(ctx, p.TenantID, p.ID, r.ID)
	if e != nil || frozen.Goal == updated.Goal {
		t.Fatalf("run plan not frozen %+v %v", frozen, e)
	}
	if _, e = s.GetRun(ctx, "tenant-b", p.ID, r.ID); !errors.Is(e, ErrNotFound) {
		t.Fatalf("PostgreSQL cross-tenant read: %v", e)
	}
	clock.Add(int64(2 * time.Minute))
	recovered, e := s.ClaimTask(ctx, "postgres-recovery", time.Minute)
	if e != nil || recovered == nil {
		t.Fatalf("recover PostgreSQL lease %+v %v", recovered, e)
	}
	stale := refs[recovered.Task.ID]
	if recovered.Task.Fence <= stale.Fence || recovered.Task.Attempt != 1 {
		t.Fatalf("invalid recovered incarnation %+v", recovered.Task)
	}
	if e = s.RenewLease(ctx, stale, time.Minute); !errors.Is(e, ErrLeaseLost) {
		t.Fatalf("PostgreSQL stale lease write: %v", e)
	}
	events, e := s.ListEvents(ctx, p.TenantID, p.ID, "", 0, 1000)
	if e != nil {
		t.Fatal(e)
	}
	for i, event := range events {
		if event.Sequence != int64(i+1) || !json.Valid(event.Payload) {
			t.Fatalf("transactional PostgreSQL event sequence %+v", events)
		}
	}
	if e = s.CancelTenant(ctx, p.TenantID); e != nil {
		t.Fatal(e)
	}
	if e = s.CancelTenant(ctx, p.TenantID); e != nil {
		t.Fatalf("PostgreSQL repeated drain: %v", e)
	}
	if draining, e := s.TenantDraining(ctx, p.TenantID); e != nil || !draining {
		t.Fatalf("PostgreSQL durable drain: %v %v", draining, e)
	}
	if _, e = s.CreateRun(ctx, p.TenantID, p.ID, "late-baseline"); !errors.Is(e, ErrTenantDraining) {
		t.Fatalf("PostgreSQL late run bypassed drain: %v", e)
	}
	other := projectFixture()
	other.TenantID, other.SpaceID = "tenant-b", "space-b"
	createFixture(t, s, other)
	if a, e := s.ClaimTask(ctx, "postgres-other-tenant", time.Minute); e != nil || a == nil || a.Scope.TenantID != "tenant-b" {
		t.Fatalf("PostgreSQL drain stalled another tenant: %+v %v", a, e)
	}
}
