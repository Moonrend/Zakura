package migrations

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// Channels outlive their reply Agent. SQLite needs a dedicated connection with
// foreign keys disabled before the transaction; renaming the old table would
// rewrite child-table references and cascade away channel history.
func migrateChannelRouting(ctx context.Context, db *sql.DB, dialect string, rebind func(string) string, m migration) (result error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if dialect == "sqlite" {
		if _, err = conn.ExecContext(ctx, `PRAGMA foreign_keys=OFF`); err != nil {
			return err
		}
		defer func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err := conn.ExecContext(cleanup, `PRAGMA foreign_keys=ON`)
			if result == nil {
				result = err
			}
		}()
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if dialect == "postgres" {
		err = migratePostgresChannelRouting(ctx, tx)
	} else {
		err = migrateSQLiteChannelRouting(ctx, tx)
	}
	if err != nil {
		return fmt.Errorf("migration %04d %s: %w", m.version, m.name, err)
	}
	if _, err = tx.ExecContext(ctx, rebind(`INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)`), m.version, m.name, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	return tx.Commit()
}

func migrateSQLiteChannelRouting(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT sql FROM sqlite_master WHERE tbl_name='agent_channel_bindings' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`)
	if err != nil {
		return err
	}
	var definitions []string
	for rows.Next() {
		var definition string
		if err = rows.Scan(&definition); err != nil {
			rows.Close()
			return err
		}
		definitions = append(definitions, definition)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	statements := []string{
		`CREATE TABLE agent_channel_bindings_next (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
 platform TEXT NOT NULL,
 profile_key TEXT NOT NULL,
 label TEXT NOT NULL DEFAULT '',
 enabled INTEGER NOT NULL DEFAULT 0,
 settings_json TEXT NOT NULL DEFAULT '{}',
 config_enc TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
)`,
		`INSERT INTO agent_channel_bindings_next (id,tenant_id,space_id,agent_id,platform,profile_key,label,enabled,settings_json,config_enc,created_at,updated_at) SELECT id,tenant_id,space_id,agent_id,platform,profile_key,label,enabled,settings_json,config_enc,created_at,updated_at FROM agent_channel_bindings`,
		`DROP TABLE agent_channel_bindings`,
		`ALTER TABLE agent_channel_bindings_next RENAME TO agent_channel_bindings`,
	}
	statements = append(statements, definitions...)
	statements = append(statements, `CREATE TRIGGER agent_channel_disable_before_agent_delete BEFORE DELETE ON agents BEGIN UPDATE agent_channel_bindings SET enabled=0 WHERE tenant_id=OLD.tenant_id AND agent_id=OLD.id; END`)
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	rows, err = tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return fmt.Errorf("foreign key violation after preserving channel routing")
	}
	return rows.Err()
}

func migratePostgresChannelRouting(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname='agent_channel_bindings' AND c.contype='f' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum=ANY(c.conkey) AND a.attname='agent_id')`)
	if err != nil {
		return err
	}
	var constraints []string
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		constraints = append(constraints, name)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, name := range constraints {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE agent_channel_bindings DROP CONSTRAINT "`+strings.ReplaceAll(name, `"`, `""`)+`"`); err != nil {
			return err
		}
	}
	for _, statement := range []string{
		`ALTER TABLE agent_channel_bindings ALTER COLUMN agent_id DROP NOT NULL`,
		`ALTER TABLE agent_channel_bindings ADD CONSTRAINT agent_channel_reply_agent_fk FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE SET NULL`,
		`CREATE FUNCTION disable_channel_reply_agent() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$ BEGIN UPDATE agent_channel_bindings SET enabled=FALSE WHERE tenant_id=OLD.tenant_id AND agent_id=OLD.id; RETURN OLD; END $$`,
		`CREATE TRIGGER agent_channel_disable_before_agent_delete BEFORE DELETE ON agents FOR EACH ROW EXECUTE FUNCTION disable_channel_reply_agent()`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}
