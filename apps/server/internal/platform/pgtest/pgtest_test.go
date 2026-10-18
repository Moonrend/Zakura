package pgtest

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"net/url"
	"strings"
	"testing"

	"github.com/lib/pq"
)

func TestEnvironmentURL(t *testing.T) {
	const raw = "postgres://fixture:fixture@localhost/disposable?sslmode=disable"
	for _, tc := range []struct {
		name, canonical, legacy, want string
		invalid                       bool
	}{
		{name: "missing"},
		{name: "canonical", canonical: raw, want: raw},
		{name: "legacy", legacy: raw, want: raw},
		{name: "same", canonical: raw, legacy: raw, want: raw},
		{name: "trim", canonical: " " + raw + " ", want: raw},
		{name: "conflict", canonical: raw, legacy: raw + "2", invalid: true},
		{name: "sqlite", canonical: "file:fixture.db", invalid: true},
		{name: "keyword DSN not URL", legacy: "host=localhost dbname=fixture", invalid: true},
		{name: "malformed", canonical: "postgres://%zz:fixture@localhost/db", invalid: true},
		{name: "bad query", canonical: raw + "&invalid=%zz", invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := environmentURL(func(key string) string {
				if key == "ZAKURA_TEST_POSTGRES_URL" {
					return tc.canonical
				}
				return tc.legacy
			})
			if (err != nil) != tc.invalid || got != tc.want {
				t.Fatalf("got %q, %v; want %q invalid=%v", got, err, tc.want, tc.invalid)
			}
			if err != nil && strings.Contains(err.Error(), "localhost") {
				t.Fatal("validation leaked credentials")
			}
		})
	}
}

func TestIsolatedURLOverridesInheritedRouting(t *testing.T) {
	base, err := parseURL("postgresql://fixture@localhost/base?dbname=elsewhere&search_path=public&options=-csearch_path%3Dpublic&sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"database", "schema"} {
		t.Run(mode, func(t *testing.T) {
			database := ""
			if mode == "database" {
				database = "pgtest_new"
			}
			got, _ := url.Parse(isolatedURL(base, database, "pgtest_private"))
			if got.Query().Get("search_path") != "pgtest_private" || got.Query().Has("options") || got.Query().Get("sslmode") != "disable" {
				t.Fatalf("unsafe isolation routing: %s", got.Redacted())
			}
			if mode == "database" && (got.Path != "/pgtest_new" || got.Query().Has("dbname")) {
				t.Fatal("database URL still routes to the source database")
			}
			if mode == "schema" && (got.Path != base.Path || got.Query().Get("dbname") != "elsewhere") {
				t.Fatal("schema fallback changed source database")
			}
		})
	}
}

func TestUniqueNameBoundsAndEntropy(t *testing.T) {
	for _, label := range []string{"", "../../Bad \" Name", strings.Repeat("long_", 100)} {
		a := uniqueName("pgtest", label, randomSuffix(t))
		b := uniqueName("pgtest", label, randomSuffix(t))
		if a == b || len(a) > 63 || unsafeIdent.MatchString(a) || !strings.HasPrefix(a, "pgtest_") {
			t.Fatalf("unsafe or reused identifier: %q / %q", a, b)
		}
	}
}

// A recording SQL driver exercises fixture DDL and cleanup without opening a
// socket or executing anything against PostgreSQL (even if env vars are set).
func init() { sql.Register("pgtest-recording", recordingDriver{}) }

type recordingDriver struct{}

func (recordingDriver) Open(dsn string) (driver.Conn, error) { return recordingConn{dsn: dsn}, nil }

type recordingConn struct{ dsn string }

func (recordingConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not implemented") }
func (recordingConn) Close() error                        { return nil }
func (recordingConn) Begin() (driver.Tx, error)           { return nil, errors.New("not implemented") }
func (recordingConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(1), nil
}
func (c recordingConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if strings.Contains(query, "pg_extension") {
		return &recordingRows{columns: []string{"exists"}, values: [][]driver.Value{{c.dsn != "missing_extension"}}}, nil
	}
	if strings.Contains(c.dsn, "extra_ledger") {
		return &recordingRows{columns: []string{"version", "name"}, values: [][]driver.Value{{int64(1), "platform"}, {int64(2), "runtime"}, {int64(3), "added"}}}, nil
	}
	if strings.Contains(c.dsn, "empty_ledger") {
		return &recordingRows{columns: []string{"version", "name"}}, nil
	}
	return &recordingRows{columns: []string{"version", "name"}, values: [][]driver.Value{{int64(1), "platform"}, {int64(2), "runtime"}}}, nil
}

type recordingRows struct {
	columns []string
	values  [][]driver.Value
}

func (r *recordingRows) Columns() []string { return r.columns }
func (r *recordingRows) Close() error      { return nil }
func (r *recordingRows) Next(dst []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(dst, r.values[0])
	r.values = r.values[1:]
	return nil
}

type fixtureTB struct {
	testing.TB
	cleanups []func()
	fatal    bool
	skipped  bool
}

func (*fixtureTB) Helper()                 {}
func (f *fixtureTB) Cleanup(fn func())     { f.cleanups = append(f.cleanups, fn) }
func (f *fixtureTB) Fatal(...any)          { f.fatal = true; panic("fixture stopped") }
func (f *fixtureTB) Fatalf(string, ...any) { f.Fatal() }
func (f *fixtureTB) Skip(...any)           { f.skipped = true; panic("fixture stopped") }

func stopped(fn func()) { defer func() { _ = recover() }(); fn() }

func TestRequiredMissingFixtureFailsWithoutSkip(t *testing.T) {
	t.Setenv("ZAKURA_TEST_POSTGRES_URL", "")
	t.Setenv("ZAKURA_TEST_POSTGRES_DSN", "")
	for _, required := range []string{"", "1"} {
		t.Setenv("ZAKURA_REQUIRE_POSTGRES", required)
		fixture := &fixtureTB{TB: t}
		stopped(func() { URL(fixture) })
		if fixture.fatal != (required == "1") || fixture.skipped != (required != "1") {
			t.Fatalf("required=%q fatal=%v skipped=%v", required, fixture.fatal, fixture.skipped)
		}
	}
}

func TestFreshURLIsolationBranchesAndCleanup(t *testing.T) {
	for _, tc := range []struct {
		name, mode  string
		createError error
		poolDSN     string
		wantCalls   int
		fatal       bool
	}{
		{name: "database", wantCalls: 2},
		{name: "permission fallback", createError: &pq.Error{Code: "42501"}, wantCalls: 3},
		{name: "forced schema", mode: "schema", wantCalls: 2},
		{name: "missing extension fails schema setup", mode: "schema", poolDSN: "missing_extension", wantCalls: 1, fatal: true},
		{name: "forced database refuses fallback", mode: "database", createError: &pq.Error{Code: "42501"}, wantCalls: 1, fatal: true},
		{name: "unreachable is not fallback", createError: errors.New("unreachable"), wantCalls: 1, fatal: true},
		{name: "duplicate is not fallback", createError: &pq.Error{Code: "42P04"}, wantCalls: 1, fatal: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool, err := sql.Open("pgtest-recording", tc.poolDSN)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			base, _ := parseURL("postgres://fixture@localhost/source?search_path=public")
			fixture := &fixtureTB{TB: t}
			calls := 0
			run := func(dsn string, fn poolAction) error {
				calls++
				if dsn != base.String() {
					t.Fatal("cleanup/admin connection was redirected")
				}
				if calls == 1 && tc.createError != nil {
					return tc.createError
				}
				return fn(context.Background(), pool)
			}
			var isolated string
			stopped(func() { isolated = freshURL(fixture, base, "unit", tc.mode, run) })
			if fixture.fatal != tc.fatal || fixture.skipped {
				t.Fatalf("fatal=%v skipped=%v", fixture.fatal, fixture.skipped)
			}
			if !tc.fatal {
				parsed, _ := url.Parse(isolated)
				schema := parsed.Query().Get("search_path")
				if tc.mode == "schema" || tc.createError != nil {
					if parsed.Path != "/source" || !strings.HasPrefix(schema, "pgtest_") || strings.Contains(schema, "public") {
						t.Fatal("schema fallback escaped isolation")
					}
				} else if parsed.Path == "/source" || schema != "public" {
					t.Fatal("database isolation did not select fresh database")
				}
				if len(fixture.cleanups) != 1 {
					t.Fatal("missing fixture cleanup")
				}
				fixture.cleanups[0]()
			}
			if calls != tc.wantCalls {
				t.Fatalf("pool calls=%d want=%d", calls, tc.wantCalls)
			}
		})
	}
}

func TestMigrationLedgerAssertionHasNoFixedCount(t *testing.T) {
	pool, err := sql.Open("pgtest-recording", "")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	AssertMigrationLedger(t, context.Background(), pool, pool)
	for _, dsn := range []string{"extra_ledger", "empty_ledger"} {
		changed, err := sql.Open("pgtest-recording", dsn)
		if err != nil {
			t.Fatal(err)
		}
		fixture := &fixtureTB{TB: t}
		stopped(func() { AssertMigrationLedger(fixture, context.Background(), changed, pool) })
		_ = changed.Close()
		if !fixture.fatal {
			t.Fatalf("accepted mismatched ledger %s", dsn)
		}
	}
}
