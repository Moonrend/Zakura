// Package pgtest isolates PostgreSQL-gated Go tests from one another.
//
// Parallel test packages all consume the same ZAKURA_TEST_POSTGRES_URL, so the
// default `go test ./...` lets their migrations, extension creation, and schema
// resets race on one shared database. FreshURL hands every caller a private
// database (derived from the shared URL) that is dropped when the test ends.
package pgtest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

const connectTimeout = 15 * time.Second

var unsafeIdent = regexp.MustCompile(`[^a-zA-Z0-9_]+`)

// FreshURL returns a PostgreSQL DSN pointing at a private database derived from
// rawURL and registers its cleanup. An empty rawURL skips the test; a
// non-PostgreSQL URL is returned unchanged. When the connecting role cannot
// CREATE DATABASE the helper falls back to a private schema in the original
// database and points the DSN at it via search_path.
func FreshURL(t testing.TB, rawURL, label string) string {
	t.Helper()
	if rawURL == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_URL is not set")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse ZAKURA_TEST_POSTGRES_URL: %v", err)
	}
	if parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		return rawURL
	}
	base := strings.Trim(parsed.Path, "/")
	if base == "" {
		base = "postgres"
	}

	name := uniqueName(base, label, randomSuffix(t))
	if err := withAdminPool(rawURL, func(ctx context.Context, pool *sql.DB) error {
		_, execErr := pool.ExecContext(ctx, "CREATE DATABASE "+quoteIdent(name))
		return execErr
	}); err == nil {
		t.Cleanup(func() { dropDatabase(rawURL, name) })
		unique := *parsed
		unique.Path = "/" + name
		return unique.String()
	}

	schema := "pgtest_" + safeIdent(label) + "_" + randomSuffix(t)
	if err := withPool(rawURL, func(ctx context.Context, pool *sql.DB) error {
		_, execErr := pool.ExecContext(ctx, "CREATE SCHEMA "+quoteIdent(schema))
		return execErr
	}); err != nil {
		t.Fatalf("isolate PostgreSQL test (no CREATE DATABASE and no schema fallback): %v", err)
	}
	t.Cleanup(func() { dropSchema(rawURL, schema) })
	unique := *parsed
	query := unique.Query()
	query.Set("search_path", schema)
	unique.RawQuery = query.Encode()
	return unique.String()
}

func dropDatabase(rawURL, name string) {
	_ = withAdminPool(rawURL, func(ctx context.Context, pool *sql.DB) error {
		_, _ = pool.ExecContext(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, name)
		_, err := pool.ExecContext(ctx, "DROP DATABASE IF EXISTS "+quoteIdent(name))
		return err
	})
}

func dropSchema(rawURL, schema string) {
	_ = withPool(rawURL, func(ctx context.Context, pool *sql.DB) error {
		_, err := pool.ExecContext(ctx, "DROP SCHEMA IF EXISTS "+quoteIdent(schema)+" CASCADE")
		return err
	})
}

// withAdminPool runs fn against the URL's own database, falling back to the
// "postgres" maintenance database when the original one is unreachable.
func withAdminPool(rawURL string, fn func(context.Context, *sql.DB) error) error {
	candidates := []string{}
	if parsed, err := url.Parse(rawURL); err == nil {
		if name := strings.Trim(parsed.Path, "/"); name != "" {
			candidates = append(candidates, name)
		}
	}
	candidates = append(candidates, "postgres")
	var lastErr error
	for _, dbname := range candidates {
		if err := withDB(rawURL, dbname, fn); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

// withPool runs fn against the database named in rawURL.
func withPool(rawURL string, fn func(context.Context, *sql.DB) error) error {
	name := ""
	if parsed, err := url.Parse(rawURL); err == nil {
		name = strings.Trim(parsed.Path, "/")
	}
	return withDB(rawURL, name, fn)
}

func withDB(rawURL, dbname string, fn func(context.Context, *sql.DB) error) error {
	dsn := rawURL
	if parsed, err := url.Parse(rawURL); err == nil {
		if dbname == "" {
			parsed.Path = ""
		} else {
			parsed.Path = "/" + dbname
		}
		dsn = parsed.String()
	}
	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	pool, err := sql.Open("postgres", dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pool.PingContext(ctx); err != nil {
		return err
	}
	return fn(ctx, pool)
}

func randomSuffix(t testing.TB) string {
	t.Helper()
	var raw [4]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatalf("generate PostgreSQL test suffix: %v", err)
	}
	return hex.EncodeToString(raw[:])
}

func uniqueName(base, label, suffix string) string {
	tail := "_" + safeIdent(label) + "_" + suffix
	base = strings.ToLower(base)
	if len(base)+len(tail) > 63 {
		keep := 63 - len(tail)
		if keep < 1 {
			return safeIdent(label) + "_" + suffix
		}
		base = base[:keep]
	}
	return base + tail
}

func safeIdent(label string) string {
	name := strings.Trim(unsafeIdent.ReplaceAllString(label, "_"), "_")
	if name == "" {
		return "pkg"
	}
	return strings.ToLower(name)
}

func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
