package migrations_test

import (
	"context"
	"path/filepath"
	"testing"

	platformdb "github.com/Moonrend/Zakura/go/server/internal/platform/db"
	"github.com/Moonrend/Zakura/go/server/internal/platform/migrations"
)

func TestApplyExtendsPinnedLegacyIdentityTables(t *testing.T) {
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, "file:"+filepath.Join(t.TempDir(), "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	legacy := []string{
		`CREATE TABLE platform_meta(id TEXT PRIMARY KEY DEFAULT 'platform',setup_completed INTEGER NOT NULL DEFAULT 0,mode TEXT NOT NULL DEFAULT 'single-tenant',version TEXT NOT NULL DEFAULT '0.1.0',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
		`INSERT INTO platform_meta(id,setup_completed,mode,version,created_at,updated_at) VALUES('platform',1,'single-tenant','0.1.0','2026-01-01','2026-01-01')`,
		`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT,password_hash TEXT,is_platform_admin INTEGER NOT NULL DEFAULT 0,can_use_local_runner INTEGER NOT NULL DEFAULT 0,email_verified_at TEXT,last_login_at TEXT,password_updated_at TEXT,totp_enabled_at TEXT,suspended_at TEXT,suspended_reason TEXT,suspended_by_user_id TEXT,avatar_updated_at TEXT,title TEXT,bio TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
		`CREATE TABLE tenants(id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,is_default INTEGER NOT NULL DEFAULT 0,onboarding_completed INTEGER NOT NULL DEFAULT 0,onboarding_steps TEXT NOT NULL DEFAULT '{}',suspended_at TEXT,suspended_reason TEXT,suspended_by_user_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
		`CREATE TABLE user_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,email TEXT NOT NULL,role TEXT NOT NULL,is_platform_admin INTEGER NOT NULL DEFAULT 0,user_agent TEXT,ip TEXT,expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL)`,
		`CREATE TABLE component_instances(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,provider_id TEXT NOT NULL,name TEXT NOT NULL,slug TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'stopped',config_enc TEXT NOT NULL,endpoint_url TEXT,health_status TEXT NOT NULL DEFAULT 'unknown',last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
		`CREATE TABLE provider_catalog(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',version TEXT NOT NULL DEFAULT '1.0.0',capabilities TEXT NOT NULL DEFAULT '[]',config_schema TEXT NOT NULL DEFAULT '{}',category TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
		`CREATE TABLE user_usage_events(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,actor_kind TEXT NOT NULL DEFAULT 'user',category TEXT NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ok',duration_ms INTEGER NOT NULL DEFAULT 0,agent_id TEXT,session_id TEXT,resource_kind TEXT,resource_id TEXT,summary TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)`,
	}
	for _, q := range legacy {
		if _, err = conn.DB.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatal(err)
	}
	for table, columns := range map[string][]string{
		"platform_meta":       {"singleton", "settings_json"},
		"users":               {"status", "avatar_data", "totp_secret"},
		"tenants":             {"status", "mfa_policy", "audit_retention_days"},
		"user_sessions":       {"token_hash", "last_seen_at"},
		"component_instances": {"agent_id", "component_type", "component_ref", "config_json", "secret_json"},
		"provider_catalog":    {"kind", "manifest_json", "enabled"},
		"user_usage_events":   {"detail_json", "occurred_at", "units", "actor_kind", "action", "status", "duration_ms", "agent_id", "session_id", "resource_kind", "resource_id", "summary", "created_at"},
	} {
		for _, column := range columns {
			var count int
			rows, e := conn.DB.QueryContext(ctx, "PRAGMA table_info("+table+")")
			if e != nil {
				t.Fatal(e)
			}
			for rows.Next() {
				var cid, notnull, pk int
				var name, typ string
				var def any
				if e = rows.Scan(&cid, &name, &typ, &notnull, &def, &pk); e != nil {
					t.Fatal(e)
				}
				if name == column {
					count++
				}
			}
			rows.Close()
			if count != 1 {
				t.Errorf("%s.%s missing after migration", table, column)
			}
		}
	}
	var singleton int
	if err = conn.DB.QueryRowContext(ctx, `SELECT singleton FROM platform_meta WHERE id='platform'`).Scan(&singleton); err != nil || singleton != 1 {
		t.Fatalf("legacy platform row not adopted: singleton=%d err=%v", singleton, err)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO tenants(id,slug,name,is_default,onboarding_completed,onboarding_steps,created_at,updated_at) VALUES('tenant','tenant','Tenant',0,0,'{}','2026-01-01','2026-01-01')`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,created_at,updated_at) VALUES('component','tenant',NULL,'mcp','example','Example','{}','{}','ready','2026-01-01','2026-01-01')`); err != nil {
		t.Fatalf("canonical component write after legacy migration: %v", err)
	}
	for _, legacyColumn := range []string{"provider_id", "slug", "config_enc"} {
		rows, err := conn.DB.QueryContext(ctx, `PRAGMA table_info(component_instances)`)
		if err != nil {
			t.Fatal(err)
		}
		notNull := -1
		for rows.Next() {
			var cid, required, pk int
			var name, typ string
			var def any
			if err = rows.Scan(&cid, &name, &typ, &required, &def, &pk); err != nil {
				t.Fatal(err)
			}
			if name == legacyColumn {
				notNull = required
			}
		}
		rows.Close()
		if notNull != 0 {
			t.Fatalf("legacy column %s remains NOT NULL (%d)", legacyColumn, notNull)
		}
	}
}
