package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/config"
	platformdb "github.com/Moonrend/Zakura/go/server/internal/platform/db"
	"github.com/Moonrend/Zakura/go/server/internal/platform/migrations"
	platformserver "github.com/Moonrend/Zakura/go/server/internal/platform/server"
)

// TestPostgresCoreWorkflow is deliberately opt-in locally and mandatory in CI.
// Its database must be disposable: the test resets the public schema so every
// run exercises the complete PostgreSQL migration path through lib/pq.
func TestPostgresCoreWorkflow(t *testing.T) {
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	conn, err := platformdb.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	if conn.Dialect != "postgres" {
		t.Fatalf("expected postgres dialect, got %q", conn.Dialect)
	}
	if _, err = conn.DB.ExecContext(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatalf("reset disposable PostgreSQL database: %v", err)
	}
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("apply PostgreSQL migrations: %v", err)
	}
	gormDB, err := conn.Gorm()
	if err != nil {
		t.Fatalf("open gorm: %v", err)
	}

	var seq int
	cfg := config.Config{WebURL: "http://web.test", PublicURL: "http://api.test", Edition: "saas", MultiTenant: true}
	deps := &appdeps.Dependencies{
		DB: conn.DB, Gorm: gormDB, Dialect: conn.Dialect, Rebind: conn.Rebind,
		Clock:  func() time.Time { return time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC) },
		NewID:  func() string { seq++; return fmt.Sprintf("pg-%023d", seq) },
		Secret: bytes.Repeat([]byte("p"), 32), PublicURL: cfg.PublicURL,
		WebURL: cfg.WebURL, Edition: cfg.Edition, MultiTenant: cfg.MultiTenant,
		VerifyDomain: func(context.Context, string, string) error { return nil },
	}
	srv := httptest.NewServer(platformserver.Router(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer srv.Close()

	status, setup := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/setup", "", map[string]any{
		"adminEmail": "postgres@example.test", "adminPassword": "postgres-integration-password",
		"adminName": "Postgres Admin", "tenantName": "Postgres Tenant",
	})
	if status != http.StatusOK {
		t.Fatalf("setup: %d %#v", status, setup)
	}
	session, _ := setup["session"].(string)
	if session == "" {
		t.Fatalf("setup did not return a session: %#v", setup)
	}
	status, bootstrap := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/tenant/onboarding/bootstrap", session, map[string]any{})
	if status != http.StatusOK || bootstrap["agent"] == nil {
		t.Fatalf("bootstrap: %d %#v", status, bootstrap)
	}
	status, login := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/auth/login", "", map[string]any{
		"email": "postgres@example.test", "password": "postgres-integration-password",
	})
	if status != http.StatusOK || login["session"] == nil {
		t.Fatalf("login: %d %#v", status, login)
	}
	status, agents := arrayCall(t, srv.Client(), http.MethodGet, srv.URL+"/api/agents", login["session"].(string))
	if status != http.StatusOK || len(agents) != 1 {
		t.Fatalf("agents: %d %#v", status, agents)
	}

	var migrationsApplied, users, tenants, agentCount int
	for query, target := range map[string]*int{
		`SELECT COUNT(*) FROM schema_migrations`: &migrationsApplied,
		`SELECT COUNT(*) FROM users`:             &users,
		`SELECT COUNT(*) FROM tenants`:           &tenants,
		`SELECT COUNT(*) FROM agents`:            &agentCount,
	} {
		if err = conn.DB.QueryRowContext(ctx, query).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	if migrationsApplied != 3 || users != 1 || tenants != 1 || agentCount != 1 {
		t.Fatalf("unexpected durable rows: migrations=%d users=%d tenants=%d agents=%d", migrationsApplied, users, tenants, agentCount)
	}
}

func TestPostgresLegacyCompatibility(t *testing.T) {
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	conn, err := platformdb.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	if _, err = conn.DB.ExecContext(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	legacy := []string{
		`CREATE TABLE platform_meta(id TEXT PRIMARY KEY DEFAULT 'platform',setup_completed BOOLEAN NOT NULL DEFAULT FALSE,mode TEXT NOT NULL DEFAULT 'single-tenant',version TEXT NOT NULL DEFAULT '0.1.0',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
		`INSERT INTO platform_meta(id,setup_completed) VALUES('platform',TRUE)`,
		`CREATE TABLE component_instances(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,provider_id TEXT NOT NULL,name TEXT NOT NULL,slug TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'stopped',config_enc TEXT NOT NULL,endpoint_url TEXT,health_status TEXT NOT NULL DEFAULT 'unknown',last_error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
		`CREATE TABLE provider_catalog(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',version TEXT NOT NULL DEFAULT '1.0.0',capabilities TEXT NOT NULL DEFAULT '[]',config_schema TEXT NOT NULL DEFAULT '{}',category TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
	}
	for _, statement := range legacy {
		if _, err = conn.DB.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("upgrade pinned PostgreSQL schema: %v", err)
	}
	var setup bool
	if err = conn.DB.QueryRowContext(ctx, `SELECT setup_completed FROM platform_meta WHERE singleton=1`).Scan(&setup); err != nil || !setup {
		t.Fatalf("legacy platform row was not adopted: setup=%v err=%v", setup, err)
	}
	for table, columns := range map[string][]string{
		"component_instances": {"component_type", "component_ref", "config_json", "secret_json"},
		"provider_catalog":    {"kind", "manifest_json", "enabled"},
	} {
		for _, column := range columns {
			var count int
			if err = conn.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=$2`, table, column).Scan(&count); err != nil || count != 1 {
				t.Fatalf("legacy compatibility column %s.%s: count=%d err=%v", table, column, count, err)
			}
		}
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO tenants(id,slug,name,is_default,onboarding_completed,onboarding_steps,created_at,updated_at) VALUES('legacy-tenant','legacy-tenant','Legacy Tenant',FALSE,FALSE,'{}',NOW(),NOW())`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,created_at,updated_at) VALUES('canonical-component','legacy-tenant',NULL,'mcp','example','Example','{}','{}','ready',NOW(),NOW())`); err != nil {
		t.Fatalf("canonical component write after PostgreSQL legacy upgrade: %v", err)
	}
}

// TestPostgresPinnedDrizzleUpgrade executes every pinned TypeScript migration
// through a real PostgreSQL wire connection before applying the native additive
// migration. This catches type/DDL compatibility that SQLite and PGlite cannot
// prove. CI sets ZAKURA_REFERENCE_DRIZZLE_DIR to the preserved frontend/server
// checkout; local runs skip when that immutable reference is unavailable.
func TestPostgresPinnedDrizzleUpgrade(t *testing.T) {
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_URL")
	drizzleDir := os.Getenv("ZAKURA_REFERENCE_DRIZZLE_DIR")
	if dsn == "" || drizzleDir == "" {
		t.Skip("PostgreSQL URL or pinned Drizzle directory is not set")
	}
	files, err := filepath.Glob(filepath.Join(drizzleDir, "*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("pinned Drizzle migrations unavailable at %q: %v", drizzleDir, err)
	}
	sort.Strings(files)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	conn, err := platformdb.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	if _, err = conn.DB.ExecContext(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	statements := 0
	for _, file := range files {
		raw, readErr := os.ReadFile(file)
		if readErr != nil {
			t.Fatal(readErr)
		}
		for _, statement := range strings.Split(string(raw), "--> statement-breakpoint") {
			statement = strings.TrimSpace(statement)
			if statement == "" {
				continue
			}
			if _, err = conn.DB.ExecContext(ctx, statement); err != nil {
				t.Fatalf("pinned migration %s statement %d: %v", filepath.Base(file), statements+1, err)
			}
			statements++
		}
	}
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("native migration over complete pinned schema: %v", err)
	}
	var tables, columns int
	if err = conn.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=current_schema()`).Scan(&tables); err != nil {
		t.Fatal(err)
	}
	if err = conn.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=current_schema()`).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if statements < 500 || tables < 84 || columns < 998 {
		t.Fatalf("incomplete pinned upgrade: statements=%d tables=%d columns=%d", statements, tables, columns)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO tenants(id,slug,name,is_default,onboarding_completed,onboarding_steps,created_at,updated_at) VALUES('go-write-tenant','go-write-tenant','Go Write Tenant',FALSE,FALSE,'{}',NOW(),NOW())`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,created_at,updated_at) VALUES('go-write-component','go-write-tenant',NULL,'mcp','example','Example','{}','{}','ready',NOW(),NOW())`); err != nil {
		t.Fatalf("canonical component write on pinned schema: %v", err)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO tenant_domains(id,tenant_id,domain,join_mode,verification_token,created_at,updated_at) VALUES('go-write-domain','go-write-tenant','go-write.example','invite_only','token',NOW(),NOW())`); err != nil {
		t.Fatalf("canonical tenant-domain write on pinned schema: %v", err)
	}
	// The legacy schema uses TIMESTAMPTZ while a few additive compatibility
	// columns are TEXT. Prepare the portable casts used by the live handler.
	if _, err = conn.DB.ExecContext(ctx, `PREPARE session_inventory(text) AS SELECT id,COALESCE(ip,''),COALESCE(user_agent,''),COALESCE(CAST(last_seen_at AS TEXT),CAST(created_at AS TEXT)),CAST(created_at AS TEXT),CAST(expires_at AS TEXT) FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`); err != nil {
		t.Fatalf("legacy session inventory SQL: %v", err)
	}
}

// Keep imports used even if this test is compiled in isolation by tooling that
// prunes sibling test files containing jsonCall.
var _ = json.NewDecoder
