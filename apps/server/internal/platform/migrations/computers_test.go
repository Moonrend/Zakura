package migrations

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
)

func TestComputersAdoptLegacyWorkspaceWithoutProvisioning(t *testing.T) {
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, "file:"+filepath.Join(t.TempDir(), "adoption.db"))
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
	// Build the real pre-computers schema, rather than rerunning an already applied migration.
	for _, m := range ordered {
		if m.version >= 5 {
			break
		}
		for _, q := range strings.Split(m.sql, "-- statement-breakpoint") {
			if strings.TrimSpace(q) != "" {
				exec(q)
			}
		}
		exec(`INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,'now')`, m.version, m.name)
	}
	exec(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES('t','t','Tenant','before','before')`)
	exec(`INSERT INTO spaces(id,tenant_id,name,slug,enable_computer,runtime_node_id,workspace_kind,workspace_image,created_at,updated_at) VALUES('s','t','Existing','existing',1,'existing-node','docker','custom:image','before','before')`)
	exec(`INSERT INTO spaces(id,tenant_id,name,slug,enable_computer,created_at,updated_at) VALUES('disabled','t','Disabled','disabled',0,'before','before')`)
	for _, space := range []string{"s", "disabled"} {
		exec(`INSERT INTO agents(id,tenant_id,space_id,name,slug,created_at,updated_at) VALUES(?,'t',?, ?,?,'before','before')`, "agent-"+space, space, space, space)
		exec(`INSERT INTO cloud_agent_sessions(id,tenant_id,agent_id,created_at,updated_at) VALUES(?,'t',?,'before','before')`, "chat-"+space, "agent-"+space)
	}
	for i := 0; i < 2; i++ {
		if err := Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
			t.Fatal(err)
		}
	}
	var id, node, scope, kind, image, created string
	err = conn.DB.QueryRow(`SELECT id,runtime_node_id,legacy_workspace_scope,legacy_workspace_kind,workspace_image,created_at FROM computers WHERE tenant_id='t' AND space_id='s'`).Scan(&id, &node, &scope, &kind, &image, &created)
	if err != nil {
		t.Fatal(err)
	}
	if id != "legacy:s" || node != "existing-node" || scope != "s" || kind != "docker" || image != "custom:image" || created != "before" {
		t.Fatalf("legacy workspace changed: %s %s %s %s %s %s", id, node, scope, kind, image, created)
	}
	for _, check := range []struct {
		query string
		want  int
	}{
		{`SELECT COUNT(*) FROM computers`, 1},
		{`SELECT COUNT(*) FROM computer_runtimes`, 0},
		{`SELECT COUNT(*) FROM session_computer_defaults`, 2},
		{`SELECT COUNT(*) FROM session_computer_defaults WHERE session_id='chat-s' AND computer_id='legacy:s' AND tenant_id='t' AND space_id='s'`, 1},
		{`SELECT COUNT(*) FROM session_computer_defaults WHERE session_id='chat-disabled' AND computer_id IS NULL AND tenant_id='t' AND space_id='disabled'`, 1},
		{`SELECT COUNT(*) FROM space_computer_defaults WHERE computer_id='legacy:s' AND tenant_id='t' AND space_id='s'`, 1},
		{`SELECT COUNT(*) FROM schema_migrations WHERE version=5`, 1},
	} {
		var n int
		if err := conn.DB.QueryRow(check.query).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != check.want {
			t.Errorf("%s: got %d want %d", check.query, n, check.want)
		}
	}
}
