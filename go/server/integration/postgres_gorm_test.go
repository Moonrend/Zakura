package integration_test

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	platformdb "github.com/Moonrend/Zakura/go/server/internal/platform/db"
)

func TestPostgresGormConnection(t *testing.T) {
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := platformdb.OpenGorm(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	gdb, err := conn.Gorm()
	if err != nil {
		t.Fatal(err)
	}
	if pool, ok := gdb.ConnPool.(*sql.DB); !ok || pool != conn.DB {
		t.Fatalf("gorm does not share the database/sql pool: %T", gdb.ConnPool)
	}
	var one int
	if err = gdb.Raw(`SELECT 1`).Scan(&one).Error; err != nil || one != 1 {
		t.Fatalf("gorm SELECT 1 over PostgreSQL: value=%d err=%v", one, err)
	}
}
