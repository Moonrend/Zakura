// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/insight"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	_ "github.com/lib/pq"
)

func TestProjectInsightPostgresRepeatableSnapshotDuringModelSettlement(t *testing.T) {
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_DSN is absent; real PostgreSQL insight isolation was not run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if err = admin.PingContext(ctx); err != nil {
		t.Fatal("PostgreSQL insight integration connection failed")
	}
	random := make([]byte, 12)
	if _, err = rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := "zakura_insight_" + hex.EncodeToString(random)
	if _, err = admin.ExecContext(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if _, err := admin.ExecContext(cleanup, `DROP SCHEMA "`+schema+`" CASCADE`); err != nil {
			t.Error("drop insight test schema:", err)
		}
	}()
	isolated := dsn
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		query := u.Query()
		query.Set("search_path", schema)
		u.RawQuery = query.Encode()
		isolated = u.String()
	} else {
		isolated += " search_path='" + schema + "'"
	}
	db, err := sql.Open("postgres", isolated)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(5)
	if err = migrations.Apply(ctx, db, "postgres", appdeps.PostgresRebind); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err = db.ExecContext(ctx, appdeps.PostgresRebind("INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES(?,?,?,?,?)"), "tenant-insight", "tenant-insight", "Insight", now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, appdeps.PostgresRebind("INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,?)"), "space-insight", "tenant-insight", "Insight", "insight", now, now); err != nil {
		t.Fatal(err)
	}
	store := projectexec.NewStore(db, "postgres", appdeps.PostgresRebind)
	project, err := store.CreateProject(ctx, mission.Project{TenantID: "tenant-insight", SpaceID: "space-insight", Name: "Snapshot proof", Goal: "Verify read isolation", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "task", Title: "Task", Prompt: "Write task.txt", AgentID: "agent", Writes: []string{"task.txt"}, Checks: []mission.CheckSpec{{ID: "file", Kind: "path_exists", Path: "task.txt", Required: true}}}}}, Config: mission.Config{Budget: mission.Budget{MaxConcurrent: 1, MaxTokens: 100}}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.CreateRun(ctx, project.TenantID, project.ID, "base", project.Revision)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var original string
	if err = tx.QueryRowContext(ctx, "SELECT run_json FROM execution_runs WHERE id=$1", run.ID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	var frozen mission.Run
	if err = json.Unmarshal([]byte(original), &frozen); err != nil {
		t.Fatal(err)
	}
	assignment, err := store.ClaimTask(ctx, "worker", time.Minute)
	if err != nil || assignment == nil {
		t.Fatalf("claim: %+v %v", assignment, err)
	}
	ref := projectexec.FenceRequest{Scope: assignment.Scope, RunID: run.ID, TaskID: assignment.Task.ID, Owner: assignment.Task.LeaseOwner, Fence: assignment.Task.Fence}
	if _, err = store.ReserveDecisionBudget(ctx, ref, 10); err != nil {
		t.Fatal(err)
	}
	if _, err = store.RecordModelDecision(ctx, ref, assignment.Checkpoint.Sequence, mission.Decision{Done: true, Result: "ready for acceptance", Tokens: 3, Message: mission.Message{"role": "assistant", "content": "ready"}}); err != nil {
		t.Fatal(err)
	}
	tasks, err := projectInsightRecords[mission.Task](ctx, tx, appdeps.PostgresRebind, "tasks", project.TenantID, project.ID, run.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	events, err := projectInsightRecords[mission.Event](ctx, tx, appdeps.PostgresRebind, "events", project.TenantID, project.ID, run.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if frozen.Tokens != 0 || len(tasks) != 1 || tasks[0].Status != "pending" {
		t.Fatal("read-only snapshot observed a later task state with old budget")
	}
	for _, event := range events {
		if event.Kind == "model.decision" || event.Kind == "task.claimed" {
			t.Fatal("later execution event entered earlier repeatable snapshot")
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: &appdeps.Dependencies{DB: db, Dialect: "postgres", Rebind: appdeps.PostgresRebind}, projects: store}
	fresh, err := h.loadProjectInsight(ctx, project.TenantID, project.ID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	value, err := insight.Analyze(fresh)
	if err != nil {
		t.Fatal(err)
	}
	if value.Usage.Tokens != 3 || value.AttributedUsage.Tokens != 3 || value.Usage.ModelCalls != 1 || value.Tasks[0].Status != "running" || value.Tasks[0].ObservedSeconds != nil {
		t.Fatalf("fresh snapshot did not settle usage: %+v", value)
	}
	if _, err = h.loadProjectInsight(ctx, "different-tenant", project.ID, run.ID); err == nil {
		t.Fatal("PostgreSQL insight query crossed tenant boundary")
	}
}
