package db_test

import (
	"context"
	"path/filepath"
	"testing"

	platformdb "github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/db"
)

func TestSQLiteBackupRestore(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	target := filepath.Join(dir, "zakura.db")
	conn, err := platformdb.Open(ctx, "file:"+target)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = conn.DB.ExecContext(ctx, `CREATE TABLE durable_state(id TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO durable_state VALUES('one','before')`); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(dir, "backups", "zakura.db")
	if err = platformdb.BackupSQLite(ctx, conn.DB, backup); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.DB.ExecContext(ctx, `UPDATE durable_state SET value='after' WHERE id='one'`); err != nil {
		t.Fatal(err)
	}
	if err = conn.DB.Close(); err != nil {
		t.Fatal(err)
	}
	previous, err := platformdb.RestoreSQLite(ctx, backup, target)
	if err != nil {
		t.Fatal(err)
	}
	if previous == "" {
		t.Fatal("restore did not retain the previous database")
	}
	restored, err := platformdb.Open(ctx, "file:"+target)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.DB.Close()
	var value string
	if err = restored.DB.QueryRowContext(ctx, `SELECT value FROM durable_state WHERE id='one'`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != "before" {
		t.Fatalf("restored value = %q", value)
	}
}
