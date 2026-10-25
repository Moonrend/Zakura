package migrations

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
)

func TestWorkspaceStorageUpgradePreservesCreationEvidence(t *testing.T) {
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, "file:"+filepath.Join(t.TempDir(), "workspace-upgrade.db"))
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
		if m.version >= 26 {
			break
		}
		for _, q := range strings.Split(m.sql, "-- statement-breakpoint") {
			if strings.TrimSpace(q) != "" {
				exec(q)
			}
		}
		exec(`INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,'before')`, m.version, m.name)
	}
	exec(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES('t','t','Tenant','before','before')`)
	exec(`INSERT INTO spaces(id,tenant_id,name,slug,runtime_node_id,workspace_status,created_at,updated_at) VALUES('s','t','Space','space','node','running','before','before')`)
	exec(`INSERT INTO workspace_create_operations(space_id,tenant_id,node_id,computer_id,operation_id,name,config_digest,created_at) VALUES('s','t','node','legacy:s','original-op','original-name','original-digest','before')`)
	exec(`INSERT INTO acp_profile_auth_locks(tenant_id,space_id,profile_id,token,kind,expires_at,updated_at,node_id,computer_id) VALUES('t','s','codex','original-owner','terminal',123,1,'node','legacy:s')`)
	exec(`INSERT INTO acp_device_auth_attempts(id,tenant_id,space_id,profile_id,principal_id,node_id,computer_id,config_hash,status,encrypted_payload,expires_at,next_poll_at,created_at,updated_at) VALUES('attempt','t','s','codex','user','node','legacy:s','hash','unknown','retained-envelope','later','later','before','before')`)
	for i := 0; i < 2; i++ {
		if err := Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
			t.Fatal(err)
		}
	}
	var op, name, digest, created string
	var instance sql.NullString
	if err := conn.DB.QueryRow(`SELECT operation_id,name,config_digest,created_at,workspace_instance_id FROM workspace_create_operations`).Scan(&op, &name, &digest, &created, &instance); err != nil {
		t.Fatal(err)
	}
	if op != "original-op" || name != "original-name" || digest != "original-digest" || created != "before" || instance.Valid {
		t.Fatalf("creation evidence changed: %q %q %q %q %+v", op, name, digest, created, instance)
	}
	var node, status string
	var generation int64
	if err := conn.DB.QueryRow(`SELECT runtime_node_id,workspace_status,workspace_generation,current_workspace_instance_id FROM spaces WHERE id='s'`).Scan(&node, &status, &generation, &instance); err != nil {
		t.Fatal(err)
	}
	if node != "node" || status != "running" || generation != 0 || instance.Valid {
		t.Fatal("schema migration changed the live workspace binding")
	}
	for _, table := range []string{"acp_profile_auth_locks", "acp_device_auth_attempts"} {
		var binding string
		if err := conn.DB.QueryRow(`SELECT workspace_instance_id,workspace_generation FROM `+table).Scan(&binding, &generation); err != nil || binding != "" || generation != 0 {
			t.Fatalf("migration inferred a legacy authentication target in %s: %v", table, err)
		}
	}
	var token, payload, attemptStatus string
	if err := conn.DB.QueryRow(`SELECT token FROM acp_profile_auth_locks`).Scan(&token); err != nil || token != "original-owner" {
		t.Fatalf("migration changed existing authentication ownership: %v", err)
	}
	if err := conn.DB.QueryRow(`SELECT encrypted_payload,status FROM acp_device_auth_attempts`).Scan(&payload, &attemptStatus); err != nil || payload != "retained-envelope" || attemptStatus != "unknown" {
		t.Fatalf("migration lost pending authentication evidence: %v", err)
	}
	// Legacy callers still have one slot; adopting the operation frees the slot
	// for another instance without deleting the original intent or its digest.
	if _, err := conn.DB.Exec(`INSERT INTO workspace_create_operations(operation_id,space_id,tenant_id,node_id,computer_id,name,created_at) VALUES('duplicate','s','t','node','legacy:s','duplicate','now')`); err == nil {
		t.Fatal("duplicate unadopted legacy create accepted")
	}
	exec(`UPDATE workspace_create_operations SET workspace_instance_id='old-instance' WHERE operation_id='original-op'`)
	exec(`INSERT INTO workspace_create_operations(operation_id,space_id,tenant_id,node_id,computer_id,workspace_instance_id,identity_version,name,created_at) VALUES('new-op','s','t','node','legacy:s','new-instance',2,'new-name','now')`)
	exec(`DELETE FROM spaces WHERE id='s'`)
	exec(`DELETE FROM tenants WHERE id='t'`)
	var count int
	if err := conn.DB.QueryRow(`SELECT COUNT(*) FROM workspace_create_operations`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("owner deletion lost creation evidence: %d %v", count, err)
	}
}

func TestWorkspaceStorageMigrationIsAdditiveAndIdempotent(t *testing.T) {
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, "file:"+filepath.Join(t.TempDir(), "workspace-storage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	for i := 0; i < 2; i++ {
		if err := Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"workspace_disks", "workspace_instances", "workspace_cleanup_tombstones", "workspace_disk_projects"} {
		var count int
		if err := conn.DB.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("migration provisioned %s: %d %v", table, count, err)
		}
	}
}
