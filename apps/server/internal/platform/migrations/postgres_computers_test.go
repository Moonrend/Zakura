package migrations_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/pgtest"
)

func TestPostgresComputersSchema(t *testing.T) {
	url := pgtest.FreshURL(t, pgtest.URL(t), "migrations")
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	if conn.Dialect != "postgres" {
		t.Fatalf("expected postgres dialect, got %q", conn.Dialect)
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
		"agent_tool_approvals",
		"workspace_create_operations",
		"workspace_connections",
		"workspace_disks",
		"workspace_instances",
		"workspace_cleanup_tombstones",
		"workspace_disk_projects",
		"node_installations",
	} {
		var n int
		if err := conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=?`), table).Scan(&n); err != nil {
			t.Fatalf("table %s: %v", table, err)
		}
		if n != 1 {
			t.Errorf("table %s missing", table)
		}
	}
	for _, table := range []string{"acp_profile_auth_locks", "acp_device_auth_attempts"} {
		for column, expected := range map[string]string{"workspace_instance_id": "text", "workspace_generation": "bigint"} {
			var dataType string
			if err := conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? AND column_name=?`), table, column).Scan(&dataType); err != nil || dataType != expected {
				t.Fatalf("%s.%s type=%q: %v", table, column, dataType, err)
			}
		}
	}
	var dataType string
	if err := conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='spaces' AND column_name='enable_computer'`)).Scan(&dataType); err != nil {
		t.Fatalf("spaces.enable_computer: %v", err)
	}
	if dataType != "boolean" {
		t.Errorf("spaces.enable_computer is %q, want boolean", dataType)
	}
	reference, err := platformdb.Open(ctx, "file:"+filepath.Join(t.TempDir(), "migration-ledger.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer reference.DB.Close()
	if err := migrations.Apply(ctx, reference.DB, reference.Dialect, reference.Rebind); err != nil {
		t.Fatal(err)
	}
	pgtest.AssertMigrationLedger(t, ctx, conn.DB, reference.DB)
	if err := migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("second apply: %v", err)
	}
	pgtest.AssertMigrationLedger(t, ctx, conn.DB, reference.DB)
	var indexDef string
	if err := conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='idx_computer_runtime_active'`)).Scan(&indexDef); err != nil {
		t.Fatalf("idx_computer_runtime_active: %v", err)
	}
	if !strings.Contains(indexDef, "WHERE") {
		t.Errorf("idx_computer_runtime_active is not partial: %s", indexDef)
	}
}
