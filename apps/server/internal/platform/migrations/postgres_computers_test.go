package migrations_test

import (
	"context"
	"os"
	"strings"
	"testing"

	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
)

func TestPostgresComputersSchema(t *testing.T) {
	url := os.Getenv("ZAKURA_TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("set ZAKURA_TEST_POSTGRES_URL to run")
	}
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	if conn.Dialect != "postgres" {
		t.Fatalf("expected postgres dialect, got %q", conn.Dialect)
	}
	if _, err := conn.DB.ExecContext(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatalf("reset disposable PostgreSQL database: %v", err)
	}
	if err := migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	for _, table := range []string{
		"computers",
		"computer_runtimes",
		"computer_creation_approvals",
		"session_computer_defaults",
		"run_computer_targets",
		"computer_execution_targets",
		"computer_project_workspaces",
		"space_computer_defaults",
	} {
		var n int
		if err := conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=?`), table).Scan(&n); err != nil {
			t.Fatalf("table %s: %v", table, err)
		}
		if n != 1 {
			t.Errorf("table %s missing", table)
		}
	}
	var dataType string
	if err := conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='spaces' AND column_name='enable_computer'`)).Scan(&dataType); err != nil {
		t.Fatalf("spaces.enable_computer: %v", err)
	}
	if dataType != "boolean" {
		t.Errorf("spaces.enable_computer is %q, want boolean", dataType)
	}
	if err := migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("second apply: %v", err)
	}
	var indexDef string
	if err := conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='idx_computer_runtime_active'`)).Scan(&indexDef); err != nil {
		t.Fatalf("idx_computer_runtime_active: %v", err)
	}
	if !strings.Contains(indexDef, "WHERE") {
		t.Errorf("idx_computer_runtime_active is not partial: %s", indexDef)
	}
}
