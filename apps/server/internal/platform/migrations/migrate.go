package migrations

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
)

//go:embed sql/0001_platform.sql
var platformSQL string

//go:embed sql/0002_runtime.sql
var runtimeSQL string

//go:embed sql/0003_compatibility.sql
var compatibilitySQL string

//go:embed sql/0004_space_mcp.sql
var spaceMCPSQL string

type migration struct {
	version   int
	name, sql string
}

var ordered = []migration{
	{1, "platform", platformSQL},
	{2, "runtime", runtimeSQL},
	{3, "compatibility", compatibilitySQL},
	{4, "space_mcp", spaceMCPSQL},
}

func Apply(ctx context.Context, db *sql.DB, dialect string, rebind func(string) string) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`); err != nil {
		return err
	}
	// A database created by the TypeScript/Drizzle backend already contains
	// most table names, but a small number of columns have different names or
	// representations. Add the compatibility columns before CREATE TABLE IF NOT
	// EXISTS and index statements run, then repeat after the native schema has
	// been created for a brand-new database.
	if err := ensureAdditiveCompatibility(ctx, db, dialect, rebind); err != nil {
		return err
	}
	for _, m := range ordered {
		var count int
		if err := db.QueryRowContext(ctx, rebind(`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`), m.version).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			continue
		}
		if err := appdeps.InTx(ctx, db, func(tx *sql.Tx) error {
			migrationSQL := m.sql
			if dialect == "postgres" {
				migrationSQL = postgresSchema(migrationSQL)
			}
			for _, statement := range strings.Split(migrationSQL, "-- statement-breakpoint") {
				statement = strings.TrimSpace(statement)
				if statement == "" {
					continue
				}
				if _, err := tx.ExecContext(ctx, statement); err != nil {
					return fmt.Errorf("migration %04d %s: %w", m.version, m.name, err)
				}
			}
			_, err := tx.ExecContext(ctx, rebind(`INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)`), m.version, m.name, time.Now().UTC().Format(time.RFC3339Nano))
			return err
		}); err != nil {
			return err
		}
	}
	return ensureAdditiveCompatibility(ctx, db, dialect, rebind)
}

type columnSpec struct{ table, name, sqlite, postgres string }

func ensureAdditiveCompatibility(ctx context.Context, db *sql.DB, dialect string, rebind func(string) string) error {
	specs := []columnSpec{
		{"platform_meta", "singleton", "INTEGER", "INTEGER"}, {"platform_meta", "settings_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"},
		{"users", "status", "TEXT NOT NULL DEFAULT 'active'", "TEXT NOT NULL DEFAULT 'active'"}, {"users", "avatar_mime", "TEXT", "TEXT"}, {"users", "avatar_data", "BLOB", "BYTEA"}, {"users", "totp_secret", "TEXT", "TEXT"}, {"users", "totp_pending_secret", "TEXT", "TEXT"}, {"users", "recovery_codes_json", "TEXT NOT NULL DEFAULT '[]'", "TEXT NOT NULL DEFAULT '[]'"}, {"users", "suspended_reason", "TEXT", "TEXT"}, {"users", "suspended_by_user_id", "TEXT", "TEXT"},
		{"tenants", "status", "TEXT NOT NULL DEFAULT 'active'", "TEXT NOT NULL DEFAULT 'active'"}, {"tenants", "mfa_policy", "TEXT NOT NULL DEFAULT 'optional'", "TEXT NOT NULL DEFAULT 'optional'"}, {"tenants", "audit_retention_days", "INTEGER NOT NULL DEFAULT 365", "INTEGER NOT NULL DEFAULT 365"}, {"tenants", "settings_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"}, {"tenants", "suspended_reason", "TEXT", "TEXT"}, {"tenants", "suspended_by_user_id", "TEXT", "TEXT"},
		{"user_sessions", "token_hash", "TEXT", "TEXT"}, {"user_sessions", "last_seen_at", "TEXT", "TEXT"},
		{"agents", "avatar_color", "TEXT", "TEXT"}, {"agents", "avatar_shape", "TEXT", "TEXT"}, {"agents", "avatar_url", "TEXT", "TEXT"},
		{"oauth_clients", "updated_at", "TEXT", "TEXT"}, {"oauth_refresh_tokens", "family_id", "TEXT", "TEXT"}, {"oauth_refresh_tokens", "agent_id", "TEXT", "TEXT"}, {"oauth_refresh_tokens", "resource", "TEXT", "TEXT"}, {"oauth_refresh_tokens", "consumed_at", "TEXT", "TEXT"}, {"oauth_refresh_tokens", "replaced_by", "TEXT", "TEXT"},
		{"tenant_sso_configs", "config_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"}, {"tenant_sso_configs", "secret_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"},
		{"api_keys", "user_id", "TEXT", "TEXT"}, {"api_keys", "revoked_at", "TEXT", "TEXT"},
		{"memory_providers", "secret_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"}, {"memory_providers", "enabled", "INTEGER NOT NULL DEFAULT 1", "BOOLEAN NOT NULL DEFAULT TRUE"},
		{"component_instances", "agent_id", "TEXT", "TEXT"}, {"component_instances", "component_type", "TEXT NOT NULL DEFAULT 'mcp'", "TEXT NOT NULL DEFAULT 'mcp'"}, {"component_instances", "component_ref", "TEXT NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"component_instances", "config_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"}, {"component_instances", "secret_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"},
		{"integration_components", "manifest_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"},
		{"mcp_policies", "agent_id", "TEXT", "TEXT"}, {"mcp_policies", "space_id", "TEXT", "TEXT"}, {"mcp_policies", "name", "TEXT NOT NULL DEFAULT 'Default'", "TEXT NOT NULL DEFAULT 'Default'"}, {"mcp_policies", "policy_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"},
		{"provider_catalog", "kind", "TEXT NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"provider_catalog", "manifest_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"}, {"provider_catalog", "enabled", "INTEGER NOT NULL DEFAULT 1", "BOOLEAN NOT NULL DEFAULT TRUE"},
		{"tenant_domains", "verification_token", "TEXT", "TEXT"}, {"tenant_invites", "invited_by", "TEXT", "TEXT"},
		{"user_usage_events", "detail_json", "TEXT NOT NULL DEFAULT '{}'", "TEXT NOT NULL DEFAULT '{}'"}, {"user_usage_events", "occurred_at", "TEXT", "TIMESTAMPTZ"}, {"user_usage_events", "units", "INTEGER NOT NULL DEFAULT 1", "INTEGER NOT NULL DEFAULT 1"},
		{"user_usage_events", "actor_kind", "TEXT NOT NULL DEFAULT 'user'", "TEXT NOT NULL DEFAULT 'user'"}, {"user_usage_events", "action", "TEXT NOT NULL DEFAULT 'tool_called'", "TEXT NOT NULL DEFAULT 'tool_called'"}, {"user_usage_events", "status", "TEXT NOT NULL DEFAULT 'ok'", "TEXT NOT NULL DEFAULT 'ok'"}, {"user_usage_events", "duration_ms", "INTEGER NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"user_usage_events", "agent_id", "TEXT", "TEXT"}, {"user_usage_events", "session_id", "TEXT", "TEXT"}, {"user_usage_events", "resource_kind", "TEXT", "TEXT"}, {"user_usage_events", "resource_id", "TEXT", "TEXT"}, {"user_usage_events", "summary", "TEXT NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"user_usage_events", "created_at", "TEXT", "TIMESTAMPTZ"},
	}
	for _, spec := range specs {
		tablePresent, err := tableExists(ctx, db, dialect, rebind, spec.table)
		if err != nil {
			return err
		}
		if !tablePresent {
			continue
		}
		exists, err := columnExists(ctx, db, dialect, rebind, spec.table, spec.name)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		definition := spec.sqlite
		if dialect == "postgres" {
			definition = spec.postgres
		}
		if _, err = db.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s %s`, spec.table, spec.name, definition)); err != nil {
			return fmt.Errorf("add compatibility column %s.%s: %w", spec.table, spec.name, err)
		}
	}
	if legacyComponents, _ := columnExists(ctx, db, dialect, rebind, "component_instances", "provider_id"); legacyComponents {
		if dialect == "postgres" {
			for _, column := range []string{"provider_id", "slug", "config_enc"} {
				if _, err := db.ExecContext(ctx, `ALTER TABLE component_instances ALTER COLUMN `+column+` DROP NOT NULL`); err != nil {
					return fmt.Errorf("relax legacy component_instances.%s: %w", column, err)
				}
			}
		} else if err := relaxSQLiteLegacyComponents(ctx, db); err != nil {
			return err
		}
	}
	statements := []string{}
	if ok, _ := tableExists(ctx, db, dialect, rebind, "platform_meta"); ok {
		statements = append(statements, `UPDATE platform_meta SET singleton=1 WHERE singleton IS NULL`, `CREATE UNIQUE INDEX IF NOT EXISTS platform_meta_singleton_idx ON platform_meta(singleton)`)
	}
	if ok, _ := columnExists(ctx, db, dialect, rebind, "component_instances", "provider_id"); ok {
		statements = append(statements, `UPDATE component_instances SET component_ref=provider_id WHERE component_ref='' AND provider_id IS NOT NULL`)
	}
	if ok, _ := columnExists(ctx, db, dialect, rebind, "integration_components", "config_json"); ok {
		statements = append(statements, `UPDATE integration_components SET manifest_json=config_json WHERE manifest_json='{}' AND config_json IS NOT NULL`)
	}
	if ok, _ := columnExists(ctx, db, dialect, rebind, "provider_catalog", "category"); ok {
		statements = append(statements, `UPDATE provider_catalog SET kind=category WHERE kind='' AND category IS NOT NULL`)
	}
	if ok, _ := columnExists(ctx, db, dialect, rebind, "tenant_domains", "txt_token"); ok {
		statements = append(statements, `UPDATE tenant_domains SET verification_token=txt_token WHERE verification_token IS NULL`)
		if dialect == "postgres" {
			// The pinned Drizzle schema called this column txt_token and made it
			// mandatory. Native Go writes verification_token; retain the legacy
			// value for reads while allowing new rows to use the canonical column.
			statements = append(statements, `ALTER TABLE tenant_domains ALTER COLUMN txt_token DROP NOT NULL`)
		}
	}
	if ok, _ := columnExists(ctx, db, dialect, rebind, "tenant_invites", "invited_by_user_id"); ok {
		statements = append(statements, `UPDATE tenant_invites SET invited_by=invited_by_user_id WHERE invited_by IS NULL`)
	}
	if ok, _ := columnExists(ctx, db, dialect, rebind, "user_usage_events", "created_at"); ok {
		if dialect == "postgres" {
			// A fresh native schema stores occurred_at as portable TEXT, while
			// the additive compatibility column is TIMESTAMPTZ. A pinned
			// Drizzle schema can have both as TIMESTAMPTZ. Cast to the actual
			// target type because PostgreSQL does not implicitly coerce these
			// types during UPDATE assignment.
			occurredType, err := postgresColumnType(ctx, db, rebind, "user_usage_events", "occurred_at")
			if err != nil {
				return err
			}
			createdType, err := postgresColumnType(ctx, db, rebind, "user_usage_events", "created_at")
			if err != nil {
				return err
			}
			toOccurred := "created_at"
			if occurredType == "text" {
				toOccurred = "CAST(created_at AS TEXT)"
			} else if strings.Contains(occurredType, "timestamp") {
				toOccurred = "CAST(created_at AS TIMESTAMPTZ)"
			}
			toCreated := "occurred_at"
			if createdType == "text" {
				toCreated = "CAST(occurred_at AS TEXT)"
			} else if strings.Contains(createdType, "timestamp") {
				toCreated = "CAST(occurred_at AS TIMESTAMPTZ)"
			}
			statements = append(statements,
				`UPDATE user_usage_events SET occurred_at=`+toOccurred+` WHERE occurred_at IS NULL`,
				`UPDATE user_usage_events SET created_at=`+toCreated+` WHERE created_at IS NULL`,
			)
		} else {
			statements = append(statements, `UPDATE user_usage_events SET occurred_at=created_at WHERE occurred_at IS NULL`, `UPDATE user_usage_events SET created_at=occurred_at WHERE created_at IS NULL`)
		}
	}
	if ok, _ := tableExists(ctx, db, dialect, rebind, "user_sessions"); ok {
		statements = append(statements, `CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_hash_idx ON user_sessions(token_hash)`)
	}
	if ok, _ := tableExists(ctx, db, dialect, rebind, "users"); ok {
		statements = append(statements, `UPDATE users SET status='suspended' WHERE suspended_at IS NOT NULL`)
	}
	if ok, _ := tableExists(ctx, db, dialect, rebind, "tenants"); ok {
		statements = append(statements, `UPDATE tenants SET status='suspended' WHERE suspended_at IS NOT NULL`)
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func postgresColumnType(ctx context.Context, db *sql.DB, rebind func(string) string, table, column string) (string, error) {
	var dataType string
	err := db.QueryRowContext(ctx, rebind(`SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? AND column_name=?`), table, column).Scan(&dataType)
	return strings.ToLower(dataType), err
}

func relaxSQLiteLegacyComponents(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(component_instances)`)
	if err != nil {
		return err
	}
	existing := map[string]bool{}
	rebuild := false
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var def any
		if err = rows.Scan(&cid, &name, &typ, &notNull, &def, &pk); err != nil {
			rows.Close()
			return err
		}
		existing[name] = true
		if (name == "provider_id" || name == "slug" || name == "config_enc") && notNull != 0 {
			rebuild = true
		}
	}
	rows.Close()
	if !rebuild {
		return nil
	}
	targetColumns := []string{"id", "tenant_id", "provider_id", "name", "slug", "status", "config_enc", "endpoint_url", "health_status", "last_error", "last_health_check_at", "next_health_check_at", "health_failure_count", "health_claim_until", "runtime_node_id", "agent_id", "component_type", "component_ref", "config_json", "secret_json", "created_at", "updated_at"}
	copyColumns := []string{}
	for _, name := range targetColumns {
		if existing[name] {
			copyColumns = append(copyColumns, name)
		}
	}
	return appdeps.InTx(ctx, db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE component_instances RENAME TO component_instances_legacy_go`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `CREATE TABLE component_instances (
id TEXT PRIMARY KEY,
tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
provider_id TEXT,
name TEXT NOT NULL,
slug TEXT,
status TEXT NOT NULL DEFAULT 'stopped',
config_enc TEXT,
endpoint_url TEXT,
health_status TEXT NOT NULL DEFAULT 'unknown',
last_error TEXT,
last_health_check_at TEXT,
next_health_check_at TEXT,
health_failure_count INTEGER NOT NULL DEFAULT 0,
health_claim_until TEXT,
runtime_node_id TEXT,
agent_id TEXT,
component_type TEXT NOT NULL DEFAULT 'mcp',
component_ref TEXT NOT NULL DEFAULT '',
config_json TEXT NOT NULL DEFAULT '{}',
secret_json TEXT NOT NULL DEFAULT '{}',
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
)`); err != nil {
			return err
		}
		joined := strings.Join(copyColumns, ",")
		if _, err := tx.ExecContext(ctx, `INSERT INTO component_instances(`+joined+`) SELECT `+joined+` FROM component_instances_legacy_go`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DROP TABLE component_instances_legacy_go`); err != nil {
			return err
		}
		_, _ = tx.ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS component_instances_tenant_slug ON component_instances(tenant_id,slug)`)
		_, _ = tx.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS component_instances_tenant ON component_instances(tenant_id)`)
		return nil
	})
}

func tableExists(ctx context.Context, db *sql.DB, dialect string, rebind func(string) string, table string) (bool, error) {
	if dialect == "postgres" {
		var n int
		err := db.QueryRowContext(ctx, rebind(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=?`), table).Scan(&n)
		return n > 0, err
	}
	var name string
	err := db.QueryRowContext(ctx, rebind(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`), table).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func postgresSchema(sqlText string) string {
	sqlText = strings.ReplaceAll(sqlText, " BLOB", " BYTEA")
	bools := []string{"setup_completed", "is_platform_admin", "can_use_local_runner", "is_default", "onboarding_completed", "enable_computer", "enable_memory", "cancel_requested", "enabled", "allow_multiple", "secret", "always_allow", "partial", "auto_update", "is_shared", "source_retained", "is_error", "builtin", "has_workspace", "jit_enabled", "enforce_sso", "exposure_enabled", "allow_desktop_exposure", "allow_public_exposure", "allow_tcp_exposure", "agents_can_expose", "require_user_approval", "require_tailscale_for_remote_runners"}
	for _, name := range bools {
		sqlText = strings.ReplaceAll(sqlText, name+" INTEGER NOT NULL DEFAULT 0", name+" BOOLEAN NOT NULL DEFAULT FALSE")
		sqlText = strings.ReplaceAll(sqlText, name+" INTEGER NOT NULL DEFAULT 1", name+" BOOLEAN NOT NULL DEFAULT TRUE")
	}
	sqlText = strings.ReplaceAll(sqlText, "last_test_ok INTEGER", "last_test_ok BOOLEAN")
	return sqlText
}
func columnExists(ctx context.Context, db *sql.DB, dialect string, rebind func(string) string, table, column string) (bool, error) {
	if dialect == "postgres" {
		var n int
		err := db.QueryRowContext(ctx, rebind(`SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? AND column_name=?`), table, column).Scan(&n)
		return n > 0, err
	}
	rows, err := db.QueryContext(ctx, fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var def any
		if err = rows.Scan(&cid, &name, &typ, &notnull, &def, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}
