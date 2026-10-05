package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SQLiteFilePath returns the durable file backing a SQLite DATABASE_URL.
func SQLiteFilePath(databaseURL string) (string, error) {
	if strings.HasPrefix(databaseURL, "postgres://") || strings.HasPrefix(databaseURL, "postgresql://") {
		return "", errors.New("PostgreSQL backup and restore use pg_dump and pg_restore")
	}
	path := databaseURL
	if strings.HasPrefix(databaseURL, "file:") {
		u, err := url.Parse(databaseURL)
		if err != nil {
			return "", err
		}
		if u.Opaque != "" {
			path = u.Opaque
		} else {
			path = u.Path
		}
	}
	path = strings.Split(path, "?")[0]
	if path == "" || path == ":memory:" {
		return "", errors.New("backup requires a file-backed SQLite database")
	}
	return filepath.Abs(path)
}

// BackupSQLite uses SQLite's online VACUUM INTO operation, producing a
// transactionally consistent standalone database even when WAL mode is used.
func BackupSQLite(ctx context.Context, source *sql.DB, destination string) error {
	if source == nil {
		return errors.New("source database is nil")
	}
	destination, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if _, err = os.Stat(destination); err == nil {
		return fmt.Errorf("backup destination already exists: %s", destination)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
		return err
	}
	if _, err = source.ExecContext(ctx, `VACUUM INTO ?`, destination); err != nil {
		return fmt.Errorf("sqlite backup: %w", err)
	}
	if err = VerifySQLite(ctx, destination); err != nil {
		_ = os.Remove(destination)
		return fmt.Errorf("verify sqlite backup: %w", err)
	}
	return nil
}

func VerifySQLite(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite3", "file:"+path+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	var result string
	if err = db.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return fmt.Errorf("integrity_check returned %q", result)
	}
	return nil
}

// RestoreSQLite atomically installs a verified backup. The caller must stop
// every process using the target first. The previous database is retained and
// its path returned so operators can roll back the restore.
func RestoreSQLite(ctx context.Context, backup, target string) (string, error) {
	backup, err := filepath.Abs(backup)
	if err != nil {
		return "", err
	}
	target, err = filepath.Abs(target)
	if err != nil {
		return "", err
	}
	if backup == target {
		return "", errors.New("backup and target paths must differ")
	}
	if err = VerifySQLite(ctx, backup); err != nil {
		return "", fmt.Errorf("invalid backup: %w", err)
	}
	if err = os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		return "", err
	}
	tmp := target + ".restore-tmp"
	_ = os.Remove(tmp)
	if err = copyFile(backup, tmp); err != nil {
		return "", err
	}
	defer os.Remove(tmp)
	if err = VerifySQLite(ctx, tmp); err != nil {
		return "", fmt.Errorf("copied backup is invalid: %w", err)
	}
	previous := ""
	if _, statErr := os.Stat(target); statErr == nil {
		previous = fmt.Sprintf("%s.pre-restore-%s", target, time.Now().UTC().Format("20060102T150405Z"))
		if err = os.Rename(target, previous); err != nil {
			return "", err
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return "", statErr
	}
	if err = os.Rename(tmp, target); err != nil {
		if previous != "" {
			_ = os.Rename(previous, target)
		}
		return "", err
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Remove(target + suffix)
	}
	if dir, openErr := os.Open(filepath.Dir(target)); openErr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return previous, nil
}

func copyFile(source, destination string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err == nil {
		err = out.Sync()
	}
	closeErr := out.Close()
	if err != nil {
		return err
	}
	return closeErr
}
