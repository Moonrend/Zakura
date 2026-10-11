// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/Moonrend/Zakura/apps/server/internal/projectcampaign"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/campaign"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	_ "github.com/lib/pq"
)

func workbenchPostgresDatabase(t *testing.T) (*sql.DB, string) {
	t.Helper()
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_DSN is absent; real PostgreSQL workbench lock integration was not run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close() })
	if err = admin.PingContext(ctx); err != nil {
		t.Fatal("PostgreSQL campaign integration connection failed:", err)
	}
	var entropy [12]byte
	if _, err = rand.Read(entropy[:]); err != nil {
		t.Fatal(err)
	}
	schema := "zakura_campaign_gate_" + hex.EncodeToString(entropy[:])
	if _, err = admin.ExecContext(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if _, err := admin.ExecContext(cleanup, `DROP SCHEMA "`+schema+`" CASCADE`); err != nil {
			t.Error("drop campaign integration schema:", err)
		}
	})
	isolated := dsn
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		u, e := url.Parse(dsn)
		if e != nil {
			t.Fatal(e)
		}
		query := u.Query()
		query.Set("search_path", schema)
		query.Set("application_name", schema)
		u.RawQuery = query.Encode()
		isolated = u.String()
	} else {
		isolated += " search_path='" + schema + "' application_name='" + schema + "'"
	}
	db, err := sql.Open("postgres", isolated)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(5)
	if err = migrations.Apply(ctx, db, "postgres", appdeps.PostgresRebind); err != nil {
		t.Fatal(err)
	}
	return db, schema
}

func TestProjectWorkbenchPostgresCampaignIntentSerializesBeforeTenantDrain(t *testing.T) {
	db, schema := workbenchPostgresDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	var err error
	const tenant = "tenant-campaign-gate"
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err = db.ExecContext(ctx, `INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES($1,$1,'Campaign gate',$2,$2)`, tenant, now); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES('space-campaign-gate',$1,'Campaign gate','campaign-gate',$2,$2)`, tenant, now); err != nil {
		t.Fatal(err)
	}
	executions := projectexec.NewStore(db, "postgres", appdeps.PostgresRebind)
	source, err := executions.CreateProject(ctx, mission.Project{TenantID: tenant, SpaceID: "space-campaign-gate", Name: "Source", Goal: "Serialize new intents", Config: mission.Config{MaxTasks: 10}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "work", Title: "Work", Prompt: "Work", AgentID: "fixture-agent", MaxAttempts: 1, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "result.txt", Required: true}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	variants := []campaign.Variant{}
	for _, name := range []string{"baseline", "candidate"} {
		child := source
		child.Name = name
		variants = append(variants, campaign.Variant{ID: name, Name: name, Project: child, DefinitionHash: campaign.ProjectHash(child)})
	}
	store := projectcampaign.NewStore(db, "postgres", appdeps.PostgresRebind)
	c, err := store.Create(ctx, tenant, source.SpaceID, "fixture-human", campaign.Definition{Name: "Drain race", SourceProjectID: source.ID, TemplateID: "fixture-template", TemplateVersion: 1, BaselineID: "baseline", Variants: variants})
	if err != nil {
		t.Fatal(err)
	}

	// Hold the exact tenant lock used by CancelTenant. The competing mutation
	// must wait here before obtaining its campaign lock or reading the fence.
	drain, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer drain.Rollback()
	if _, err = drain.ExecContext(ctx, `UPDATE tenants SET id=id WHERE id=$1`, tenant); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		_, e := store.BeginControl(ctx, tenant, c.ID, "fixture-human", "Pause explicitly", "pause", c.Revision)
		finished <- e
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	waiting := false
	for !waiting {
		select {
		case e := <-finished:
			t.Fatalf("campaign intent crossed the held tenant lock before drain: %v", e)
		case <-ctx.Done():
			t.Fatal("campaign mutation did not reach the expected tenant lock:", ctx.Err())
		case <-ticker.C:
			if err = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE tenants SET id=id%')`, schema).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err = drain.ExecContext(ctx, `INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES($1,1,$2)`, tenant, now); err != nil {
		t.Fatal(err)
	}
	if err = drain.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-finished:
		if !errors.Is(err, projectexec.ErrTenantDraining) {
			t.Fatalf("mutation did not recheck committed tenant drain: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("campaign drain wait deadlocked:", ctx.Err())
	}
	unchanged, err := store.Get(ctx, tenant, c.ID)
	if err != nil || unchanged.Revision != c.Revision || unchanged.Status != "draft" {
		t.Fatalf("rejected intent changed campaign: %+v %v", unchanged, err)
	}
	audit, err := store.Audit(ctx, tenant, c.ID, 100)
	if err != nil || len(audit) != 1 || audit[0].Action != "created" {
		t.Fatalf("rejected intent left a committed control audit: %+v %v", audit, err)
	}
	if _, err = db.ExecContext(ctx, `DELETE FROM tenants WHERE id=$1`, tenant); err != nil {
		t.Fatalf("PostgreSQL source FK prevented whole-tenant cascade: %v", err)
	}
	for _, table := range []string{"project_campaigns", "project_campaign_variants", "project_campaign_audit", "execution_projects", "execution_tenant_controls"} {
		var count int
		if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table+` WHERE tenant_id=$1`, tenant).Scan(&count); err != nil || count != 0 {
			t.Errorf("whole-tenant cascade retained %s: %d %v", table, count, err)
		}
	}
}

func TestProjectWorkbenchPostgresRuntimeTenantFirstLockPreservesDrainSettlementAndSourceRecovery(t *testing.T) {
	db, schema := workbenchPostgresDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	const tenant = "tenant-runtime-gate"
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := db.ExecContext(ctx, `INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES($1,$1,'Runtime gate',$2,$2)`, tenant, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES('space-runtime-gate',$1,'Runtime gate','runtime-gate',$2,$2)`, tenant, now); err != nil {
		t.Fatal(err)
	}
	d := &appdeps.Dependencies{DB: db, Dialect: "postgres", Rebind: appdeps.PostgresRebind}
	h := &handler{deps: d, store: NewStore(d), projects: projectexec.NewStore(db, "postgres", d.Rebind)}
	p, err := h.projects.CreateProject(ctx, mission.Project{TenantID: tenant, SpaceID: "space-runtime-gate", Name: "Runtime source", Goal: "Preserve shutdown recovery", Config: mission.Config{MaxTasks: 10}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "work", Title: "Work", Prompt: "Work", AgentID: "fixture-agent", MaxAttempts: 1, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "result.txt", Required: true}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	transfer, err := h.insertDelivery(ctx, p, projectDelivery{ID: "pending_transfer", ProjectID: p.ID, Kind: "import", Name: "Pending scoped import", Status: "unknown", CreatedBy: "fixture-operator"})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.recordSourceAttestation(ctx, p, "pending_source", "fixture-operator", `["old_writer"]`, "Previously requested source confirmation", now); err != nil {
		t.Fatal(err)
	}
	run, err := h.projects.CreateRun(ctx, tenant, p.ID, "fixture-base", p.Revision)
	if err != nil {
		t.Fatal(err)
	}
	preview := projectMergePreview{ID: "pending_merge", ProjectID: p.ID, RunID: run.ID, Status: "unknown", OperationID: "earlier_apply"}
	if err = h.saveMerge(ctx, p, preview); err != nil {
		t.Fatal(err)
	}

	// Hold shutdown's first lock. A waiting runtime writer must not acquire
	// the project lock before it: shutdown still needs that lock to commit.
	drain, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer drain.Rollback()
	if _, err = drain.ExecContext(ctx, `UPDATE tenants SET id=id WHERE id=$1`, tenant); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		_, e := h.insertDelivery(ctx, p, projectDelivery{ID: "late_transfer", ProjectID: p.ID, Kind: "import", Name: "Forbidden late import", Status: "preparing"})
		finished <- e
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	waiting := false
	for !waiting {
		select {
		case e := <-finished:
			t.Fatalf("runtime mutation did not serialize on the tenant before project lock: %v", e)
		case <-ctx.Done():
			t.Fatal("runtime mutation did not reach tenant lock:", ctx.Err())
		case <-ticker.C:
			if err = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE tenants SET id=id%')`, schema).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err = drain.ExecContext(ctx, `UPDATE execution_projects SET event_sequence=event_sequence WHERE tenant_id=$1 AND id=$2`, tenant, p.ID); err != nil {
		t.Fatal("shutdown could not acquire project after waiting runtime tenant lock:", err)
	}
	if _, err = drain.ExecContext(ctx, `INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES($1,1,$2)`, tenant, now); err != nil {
		t.Fatal(err)
	}
	if err = drain.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-finished:
		if !errors.Is(err, projectexec.ErrTenantDraining) {
			t.Fatalf("runtime new intent did not recheck committed drain: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("tenant/project runtime lock order deadlocked:", ctx.Err())
	}
	var count int
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM execution_deliveries WHERE id='late_transfer'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rejected runtime mutation committed a late transfer: %d %v", count, err)
	}
	workbenchAssertDrainReceiptRecovery(t, ctx, h, p, transfer, run, preview, now)
}

func workbenchAssertDrainReceiptRecovery(t *testing.T, ctx context.Context, h *handler, p mission.Project, transfer projectDelivery, run mission.Run, preview projectMergePreview, now string) {
	t.Helper()
	// These are control-plane receipt settlements, not new runner calls. The
	// helper must still permit their metadata to close after shutdown fences work.
	settled, err := h.mutateDelivery(ctx, p, transfer.ID, "import", transfer.Revision, false, "receipt.inspected", "fixture-operator", "Observed prior import completion", func(_ *sql.Tx, candidate *projectDelivery) error {
		candidate.Status = "completed"
		return nil
	})
	if err != nil || settled.Status != "completed" || settled.Revision != transfer.Revision+1 {
		t.Fatalf("tenant lock incorrectly blocked receipt settlement: %+v %v", settled, err)
	}
	called := false
	if _, err = h.mutateDelivery(ctx, p, transfer.ID, "import", settled.Revision, true, "new.work", "fixture-operator", "New work is fenced", func(_ *sql.Tx, _ *projectDelivery) error {
		called = true
		return nil
	}); !errors.Is(err, projectexec.ErrTenantDraining) || called {
		t.Fatalf("active mutation escaped drain: called=%t error=%v", called, err)
	}
	reconciled, err := h.mutateMerge(ctx, p, run.ID, preview.ID, 1, "fixture-operator", "apply.reconciled", "Observed prior publication completion", func(_ *sql.Tx, candidate *projectMergePreview) error {
		candidate.Status = "applied"
		return nil
	})
	if err != nil || reconciled.Status != "applied" || reconciled.Revision != 2 {
		t.Fatalf("tenant lock incorrectly blocked publication settlement: %+v %v", reconciled, err)
	}
	if err = h.recordSourceAttestation(ctx, p, "recover_source", "fixture-operator", `["old_writer"]`, "Explicit recovery of the outstanding confirmation", now); err != nil {
		t.Fatalf("tenant lock blocked scoped pending-source recovery: %v", err)
	}
	if _, err = h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE execution_source_attestations SET status='confirmed' WHERE tenant_id=? AND project_id=?`), p.TenantID, p.ID); err != nil {
		t.Fatal(err)
	}
	if err = h.recordSourceAttestation(ctx, p, "new_source", "fixture-operator", `["new_writer"]`, "No pending recovery remains", now); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatalf("source recovery exception permitted unrelated new work: %v", err)
	}
}
