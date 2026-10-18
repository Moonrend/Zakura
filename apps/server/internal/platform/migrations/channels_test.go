package migrations

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
)

func TestChannelMigrationPreservesChildrenAndUnassignsDeletedAgent(t *testing.T) {
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, "file:"+filepath.Join(t.TempDir(), "channels.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := conn.DB.ExecContext(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)`)
	for _, m := range ordered {
		if m.version >= 14 {
			break
		}
		for _, q := range strings.Split(m.sql, "-- statement-breakpoint") {
			if strings.TrimSpace(q) != "" {
				exec(q)
			}
		}
		exec(`INSERT INTO schema_migrations VALUES(?,?,'before')`, m.version, m.name)
	}
	exec(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES('t','t','Tenant','before','before')`)
	exec(`INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES('s','t','Space','s','before','before')`)
	exec(`INSERT INTO agents(id,tenant_id,space_id,name,slug,created_at,updated_at) VALUES('a','t','s','Agent','a','before','before')`)
	exec(`INSERT INTO cloud_agent_sessions(id,tenant_id,agent_id,created_at,updated_at) VALUES('chat','t','a','before','before')`)
	exec(`INSERT INTO agent_channel_bindings(id,tenant_id,space_id,agent_id,platform,profile_key,enabled,config_enc,created_at,updated_at) VALUES('binding','t','s','a','slack','profile',1,'sealed-channel','before','before')`)
	exec(`INSERT INTO agent_channel_events(id,tenant_id,binding_id,external_event_id,received_at) VALUES('event','t','binding','external','before')`)
	exec(`INSERT INTO agent_channel_threads(id,tenant_id,binding_id,session_id,external_thread_key,created_at,updated_at) VALUES('thread','t','binding','chat','external','before','before')`)
	exec(`CREATE INDEX channel_fixture_label ON agent_channel_bindings(label)`)
	exec(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,config_enc,created_at,updated_at) VALUES('install','t','a','email-smtp','sealed-install','before','before')`)
	exec(`INSERT INTO connector_settings(id,scope_key,connector_ref,config_enc,created_at,updated_at) VALUES('setting','t','email','sealed-setting','before','before')`)
	for i := 0; i < 2; i++ {
		if err := Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		`SELECT COUNT(*) FROM agent_channel_events WHERE id='event' AND binding_id='binding'`,
		`SELECT COUNT(*) FROM agent_channel_threads WHERE id='thread' AND binding_id='binding'`,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='channel_fixture_label'`,
		`SELECT COUNT(*) FROM space_connector_legacy_installations WHERE id='install' AND space_id='s' AND config_enc='sealed-install' AND encryption_scope='t:a:email-smtp' AND settings_enc='sealed-setting' AND settings_scope='t:email' AND resolved=FALSE`,
	} {
		var n int
		if err := conn.DB.QueryRowContext(ctx, q).Scan(&n); err != nil || n != 1 {
			t.Fatalf("preservation query: %s count=%d err=%v", q, n, err)
		}
	}
	exec(`DELETE FROM agents WHERE id='a'`)
	var agent sql.NullString
	var enabled bool
	var ciphertext string
	if err := conn.DB.QueryRowContext(ctx, `SELECT agent_id,enabled,config_enc FROM agent_channel_bindings WHERE id='binding'`).Scan(&agent, &enabled, &ciphertext); err != nil || agent.Valid || enabled || ciphertext != "sealed-channel" {
		t.Fatalf("channel after Agent deletion: agent=%v enabled=%v ciphertext=%q err=%v", agent, enabled, ciphertext, err)
	}
	exec(`INSERT INTO agent_channel_bindings(id,tenant_id,space_id,platform,profile_key,created_at,updated_at) VALUES('unassigned','t','s','slack','profile','after','after')`)
	var foreignKeys int
	if err := conn.DB.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil || foreignKeys != 1 {
		t.Fatalf("foreign keys not restored: %d %v", foreignKeys, err)
	}
	if _, err := conn.DB.ExecContext(ctx, `UPDATE agent_channel_bindings SET agent_id='missing' WHERE id='unassigned'`); err == nil {
		t.Fatal("invalid reply Agent accepted")
	}
	var archives int
	if err := conn.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM space_connector_legacy_installations WHERE id='install'`).Scan(&archives); err != nil || archives != 1 {
		t.Fatalf("archival credentials lost on Agent deletion: %d %v", archives, err)
	}
}
