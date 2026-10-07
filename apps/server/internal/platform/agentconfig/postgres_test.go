package agentconfig

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	_ "github.com/lib/pq"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestPostgresUpdateRetriesAgainstFreshConfig(t *testing.T) {
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set ZAKURA_TEST_POSTGRES_DSN to a disposable PostgreSQL test service")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	pool.SetMaxOpenConns(1)
	pool.SetMaxIdleConns(1)
	// Pin the session: all reads/writes must target its temporary table, even if
	// a connection fails. Never reconnect and fall through to a persistent table.
	conn, err := pool.Conn(ctx)
	if err != nil {
		t.Fatalf("PostgreSQL test service unavailable: %v", err)
	}
	defer conn.Close()
	if err := conn.PingContext(ctx); err != nil {
		t.Fatalf("PostgreSQL test service unavailable: %v", err)
	}
	if _, err := conn.ExecContext(ctx, `SET search_path TO pg_temp`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, `CREATE TEMPORARY TABLE agents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, config_json TEXT NOT NULL, updated_at TEXT, enable_memory BOOLEAN)`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, `INSERT INTO agents (id,tenant_id,config_json,enable_memory) VALUES ('agent','tenant',$1,true)`, `{"executionMode":"host","cloud":{"model":"before"},"large":9007199254740993}`); err != nil {
		t.Fatal(err)
	}
	db, err := gorm.Open(postgres.New(postgres.Config{Conn: conn, PreferSimpleProtocol: true}), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	checkUpdateRetriesAgainstFreshConfig(t, db)
}
