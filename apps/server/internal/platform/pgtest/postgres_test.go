package pgtest

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

// These wire tests are selected only by the disposable PostgreSQL suite. The
// recording-driver unit tests in pgtest_test.go require no database at all.
func TestPostgresFreshURLSeparatesFixtures(t *testing.T) {
	raw := URL(t)
	first, second := FreshURL(t, raw, "same label"), FreshURL(t, raw, "same label")
	if first == second {
		t.Fatal("fixtures reused a URL")
	}
	for i, dsn := range []string{first, second} {
		pool := openFixture(t, dsn)
		if _, err := pool.Exec(`CREATE TABLE isolation_sentinel(value integer NOT NULL)`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(`INSERT INTO isolation_sentinel VALUES ($1)`, i); err != nil {
			t.Fatal(err)
		}
		// A second pool proves isolation is encoded in the URL, not SET on one
		// lucky connection from the fixture setup pool.
		other := openFixture(t, dsn)
		var value int
		if err := other.QueryRow(`SELECT value FROM isolation_sentinel`).Scan(&value); err != nil || value != i {
			t.Fatalf("fixture %d value=%d err=%v", i, value, err)
		}
	}
}

func TestPostgresSchemaFallbackPreservesSource(t *testing.T) {
	sourceURL := FreshURL(t, URL(t), "schema_source")
	source := openFixture(t, sourceURL)
	if _, err := source.Exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE TABLE isolation_sentinel(value integer NOT NULL); INSERT INTO isolation_sentinel VALUES (7)`); err != nil {
		t.Fatal(err)
	}
	parsed, err := parseURL(sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	var schema string
	t.Run("private schema", func(t *testing.T) {
		privateURL := freshURL(t, parsed, "schema_child", "schema", withPool)
		private := openFixture(t, privateURL)
		if err := private.QueryRow(`SELECT current_schema()`).Scan(&schema); err != nil || !strings.HasPrefix(schema, "pgtest_") {
			t.Fatalf("private schema=%q err=%v", schema, err)
		}
		if _, err := private.Exec(`CREATE TABLE isolation_sentinel(value integer NOT NULL); INSERT INTO isolation_sentinel VALUES (99)`); err != nil {
			t.Fatal(err)
		}
	})
	var value int
	if err := source.QueryRow(`SELECT value FROM isolation_sentinel`).Scan(&value); err != nil || value != 7 {
		t.Fatalf("schema cleanup changed source sentinel: value=%d err=%v", value, err)
	}
	var exists bool
	if err := source.QueryRow(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1)`, schema).Scan(&exists); err != nil || exists {
		t.Fatalf("private schema was not cleaned: exists=%v err=%v", exists, err)
	}
}

func openFixture(t *testing.T, dsn string) *sql.DB {
	t.Helper()
	pool, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	if err := pool.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	return pool
}
