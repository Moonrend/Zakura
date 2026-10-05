package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "github.com/lib/pq"
	_ "github.com/mattn/go-sqlite3"
	"gorm.io/gorm"

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
)

type Connection struct {
	DB      *sql.DB
	Dialect string
	Rebind  func(string) string

	gormOnce sync.Once
	gormDB   *gorm.DB
	gormErr  error
}

func Open(ctx context.Context, databaseURL string) (*Connection, error) {
	driver, dsn, dialect, rebind, err := parseURL(databaseURL)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	if dialect == "sqlite" {
		db.SetMaxOpenConns(1)
	} else {
		db.SetMaxOpenConns(10)
		db.SetMaxIdleConns(5)
		db.SetConnMaxLifetime(30 * time.Minute)
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("connect database: %w", err)
	}
	if dialect == "sqlite" {
		for _, pragma := range []string{"PRAGMA foreign_keys=ON", "PRAGMA journal_mode=WAL", "PRAGMA busy_timeout=5000"} {
			if _, err := db.ExecContext(ctx, pragma); err != nil {
				_ = db.Close()
				return nil, fmt.Errorf("configure sqlite: %w", err)
			}
		}
	}
	return &Connection{DB: db, Dialect: dialect, Rebind: rebind}, nil
}

func parseURL(raw string) (driver, dsn, dialect string, rebind func(string) string, err error) {
	if strings.HasPrefix(raw, "postgres://") || strings.HasPrefix(raw, "postgresql://") {
		return "postgres", raw, "postgres", appdeps.PostgresRebind, nil
	}
	if strings.HasPrefix(raw, "pglite:") {
		return "", "", "", nil, errors.New("pglite: URLs belong to the TypeScript server; use file: or postgresql: for the Go backend")
	}
	path := raw
	if strings.HasPrefix(raw, "file:") {
		u, parseErr := url.Parse(raw)
		if parseErr != nil {
			return "", "", "", nil, parseErr
		}
		if u.Opaque != "" {
			path = u.Opaque
		} else {
			path = u.Path
		}
	}
	if path == "" {
		return "", "", "", nil, errors.New("empty sqlite path")
	}
	if path != ":memory:" && !strings.Contains(path, "mode=memory") {
		base := strings.Split(path, "?")[0]
		if dir := filepath.Dir(base); dir != "." && dir != "" {
			if mkErr := os.MkdirAll(dir, 0o750); mkErr != nil {
				return "", "", "", nil, mkErr
			}
		}
	}
	if path == ":memory:" {
		path = "file:zakura-memory?mode=memory&cache=shared"
	}
	return "sqlite3", path, "sqlite", appdeps.IdentityRebind, nil
}
