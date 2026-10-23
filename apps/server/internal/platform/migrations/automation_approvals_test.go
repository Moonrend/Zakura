package migrations_test

import (
	"context"
	"path/filepath"
	"testing"

	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/pgtest"
)

func TestAutomationApprovalMigration(t *testing.T) {
	for _, dialect := range []string{"sqlite", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			url := "file:" + filepath.Join(t.TempDir(), "approvals.db")
			if dialect == "postgres" {
				url = pgtest.FreshURL(t, pgtest.URL(t), "automation_approvals")
			}
			ctx := context.Background()
			conn, err := platformdb.Open(ctx, url)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.DB.Close()
			for i := 0; i < 2; i++ {
				if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
					t.Fatal(err)
				}
			}
			rows, err := conn.DB.QueryContext(ctx, "SELECT bypass_tool_approval FROM agent_schedules LIMIT 0")
			if err != nil {
				t.Fatal(err)
			}
			rows.Close()
			if dialect == "postgres" {
				var dataType string
				if err = conn.DB.QueryRowContext(ctx, "SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agent_schedules' AND column_name='bypass_tool_approval'").Scan(&dataType); err != nil {
					t.Fatal(err)
				}
				if dataType != "boolean" {
					t.Fatalf("bypass column type=%s", dataType)
				}
			}
		})
	}
}
