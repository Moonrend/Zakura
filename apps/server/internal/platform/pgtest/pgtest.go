// Package pgtest isolates opt-in PostgreSQL tests. Fixtures must use the returned
// URL without resetting public: restricted roles use a private schema instead.
package pgtest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/lib/pq"
)

const connectTimeout = 15 * time.Second

var unsafeIdent = regexp.MustCompile(`[^a-zA-Z0-9_]+`)

// URL accepts the canonical URL and legacy DSN environment variable names. Both
// take PostgreSQL URLs (as required by platform/db), not SQLite paths. Required
// suites fail, rather than silently skipping, when their fixture is missing.
func URL(t testing.TB) string {
	t.Helper()
	raw, err := environmentURL(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	if raw == "" {
		Unavailable(t, "set ZAKURA_TEST_POSTGRES_URL (or ZAKURA_TEST_POSTGRES_DSN) to a disposable PostgreSQL fixture")
	}
	return raw
}

func environmentURL(getenv func(string) string) (string, error) {
	canonical := strings.TrimSpace(getenv("ZAKURA_TEST_POSTGRES_URL"))
	legacy := strings.TrimSpace(getenv("ZAKURA_TEST_POSTGRES_DSN"))
	if canonical != "" && legacy != "" && canonical != legacy {
		return "", errors.New("ZAKURA_TEST_POSTGRES_URL and ZAKURA_TEST_POSTGRES_DSN disagree; set only one or use identical URLs")
	}
	if canonical == "" {
		canonical = legacy
	}
	if canonical != "" {
		if _, err := parseURL(canonical); err != nil {
			return "", err
		}
	}
	return canonical, nil
}

// Unavailable marks an optional prerequisite missing, or fails a required suite.
func Unavailable(t testing.TB, reason string) {
	t.Helper()
	if os.Getenv("ZAKURA_REQUIRE_POSTGRES") == "1" {
		t.Fatal(reason)
	}
	t.Skip(reason)
}

// FreshURL creates a fresh database using template0. Only permission denial may
// fall back to a private schema; connection/configuration failures fail closed.
// ZAKURA_TEST_POSTGRES_ISOLATION=schema exercises that fallback explicitly.
// Inherited dbname/search_path/options cannot redirect the isolated connection.
func FreshURL(t testing.TB, rawURL, label string) string {
	t.Helper()
	if strings.TrimSpace(rawURL) == "" {
		rawURL = URL(t)
	}
	parsed, err := parseURL(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	mode := os.Getenv("ZAKURA_TEST_POSTGRES_ISOLATION")
	if mode != "" && mode != "database" && mode != "schema" {
		t.Fatal("ZAKURA_TEST_POSTGRES_ISOLATION must be database or schema")
	}
	return freshURL(t, parsed, label, mode, withPool)
}

type poolAction func(context.Context, *sql.DB) error
type poolRunner func(string, poolAction) error

func freshURL(t testing.TB, base *url.URL, label, mode string, run poolRunner) string {
	t.Helper()
	name := uniqueName("pgtest", label, randomSuffix(t))
	if mode != "schema" {
		err := run(base.String(), func(ctx context.Context, pool *sql.DB) error {
			_, err := pool.ExecContext(ctx, "CREATE DATABASE "+quoteIdent(name)+" TEMPLATE template0")
			return err
		})
		if err == nil {
			t.Cleanup(func() {
				if err := run(base.String(), func(ctx context.Context, pool *sql.DB) error {
					_, err := pool.ExecContext(ctx, "DROP DATABASE "+quoteIdent(name)+" WITH (FORCE)")
					return err
				}); err != nil {
					t.Errorf("clean up isolated PostgreSQL database %s: %v", name, err)
				}
			})
			return isolatedURL(base, name, "public")
		}
		var pgerr *pq.Error
		if mode == "database" || !errors.As(err, &pgerr) || pgerr.Code != "42501" {
			t.Fatalf("create isolated PostgreSQL database: %v", err)
		}
	}
	if err := run(base.String(), func(ctx context.Context, pool *sql.DB) error {
		// Apply() may attempt extension creation. Require a preinstalled pg_trgm
		// before schema fallback, so cleanup cannot drop an extension newly
		// installed in this private schema and break concurrent fixtures.
		var installed bool
		if err := pool.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm')`).Scan(&installed); err != nil {
			return err
		}
		if !installed {
			return errors.New("schema isolation requires pg_trgm preinstalled in the disposable fixture database")
		}
		_, err := pool.ExecContext(ctx, "CREATE SCHEMA "+quoteIdent(name))
		return err
	}); err != nil {
		t.Fatalf("create isolated PostgreSQL schema: %v", err)
	}
	t.Cleanup(func() {
		if err := run(base.String(), func(ctx context.Context, pool *sql.DB) error {
			_, err := pool.ExecContext(ctx, "DROP SCHEMA "+quoteIdent(name)+" CASCADE")
			return err
		}); err != nil {
			t.Errorf("clean up isolated PostgreSQL schema %s: %v", name, err)
		}
	})
	// Do not include public: CREATE TABLE IF NOT EXISTS would otherwise adopt
	// existing public tables instead of creating isolated fixture tables.
	return isolatedURL(base, "", name)
}

func parseURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Opaque != "" || parsed.Fragment != "" {
		// Never include the supplied URL in diagnostics: it may contain secrets.
		return nil, errors.New("PostgreSQL fixture must be a valid postgres:// or postgresql:// URL")
	}
	if _, err := url.ParseQuery(parsed.RawQuery); err != nil {
		return nil, errors.New("invalid PostgreSQL fixture URL query")
	}
	return parsed, nil
}

func isolatedURL(base *url.URL, database, schema string) string {
	isolated := *base
	query := isolated.Query()
	if database != "" {
		isolated.Path = "/" + database
		isolated.RawPath = ""
		query.Del("dbname")
	}
	query.Del("options")
	query.Set("search_path", schema)
	isolated.RawQuery = query.Encode()
	return isolated.String()
}

func withPool(dsn string, fn poolAction) error {
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
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatalf("generate PostgreSQL test suffix: %v", err)
	}
	return hex.EncodeToString(raw[:])
}

func uniqueName(base, label, suffix string) string {
	prefix := safeIdent(base) + "_" + safeIdent(label)
	if keep := 63 - len(suffix) - 1; len(prefix) > keep {
		prefix = prefix[:keep]
	}
	return prefix + "_" + suffix
}

func safeIdent(label string) string {
	name := strings.Trim(unsafeIdent.ReplaceAllString(label, "_"), "_")
	if name == "" {
		return "pkg"
	}
	return strings.ToLower(name)
}

func quoteIdent(name string) string {
	return pq.QuoteIdentifier(name)
}

// AssertMigrationLedger compares every version and name, not a stale hardcoded
// count. The expectation can come from applying the same production migration
// registry to an isolated in-memory SQLite database; no production API needed.
func AssertMigrationLedger(t testing.TB, ctx context.Context, actual, expected *sql.DB) {
	t.Helper()
	read := func(db *sql.DB) []string {
		rows, err := db.QueryContext(ctx, `SELECT version,name FROM schema_migrations ORDER BY version`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var entries []string
		for rows.Next() {
			var version int
			var name string
			if err := rows.Scan(&version, &name); err != nil {
				t.Fatal(err)
			}
			entries = append(entries, fmt.Sprintf("%d:%s", version, name))
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return entries
	}
	want, got := read(expected), read(actual)
	if len(want) == 0 || strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("migration ledger mismatch: got %v, want nonempty %v", got, want)
	}
}
