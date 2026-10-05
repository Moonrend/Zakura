package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
)

const gormSlowQuery = 200 * time.Millisecond

// Gorm wraps the shared *sql.DB in a *gorm.DB. The handle is created once per
// Connection and reuses the same connection pool as raw database/sql queries.
func (c *Connection) Gorm() (*gorm.DB, error) {
	c.gormOnce.Do(func() {
		c.gormDB, c.gormErr = openGorm(c.DB, c.Dialect)
	})
	return c.gormDB, c.gormErr
}

// OpenGorm opens a Connection and eagerly builds its *gorm.DB so callers can
// fail fast when the dialect is unsupported.
func OpenGorm(ctx context.Context, databaseURL string) (*Connection, error) {
	conn, err := Open(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Gorm(); err != nil {
		_ = conn.DB.Close()
		return nil, err
	}
	return conn, nil
}

func openGorm(pool *sql.DB, dialect string) (*gorm.DB, error) {
	var dialector gorm.Dialector
	switch dialect {
	case "postgres":
		dialector = postgres.New(postgres.Config{Conn: pool, PreferSimpleProtocol: true})
	case "sqlite":
		dialector = sqlite.New(sqlite.Config{Conn: pool})
	default:
		return nil, fmt.Errorf("gorm: unsupported dialect %q", dialect)
	}
	return gorm.Open(dialector, &gorm.Config{
		Logger:         &slogLogger{Log: slog.Default(), Level: logger.Warn},
		PrepareStmt:    false,
		NamingStrategy: schema.NamingStrategy{NoLowerCase: true},
	})
}

type slogLogger struct {
	Log   *slog.Logger
	Level logger.LogLevel
}

func (l *slogLogger) LogMode(level logger.LogLevel) logger.Interface {
	return &slogLogger{Log: l.Log, Level: level}
}

func (l *slogLogger) Info(ctx context.Context, msg string, args ...interface{}) {
	if l.Level >= logger.Info {
		l.Log.InfoContext(ctx, msg, args...)
	}
}

func (l *slogLogger) Warn(ctx context.Context, msg string, args ...interface{}) {
	if l.Level >= logger.Warn {
		l.Log.WarnContext(ctx, msg, args...)
	}
}

func (l *slogLogger) Error(ctx context.Context, msg string, args ...interface{}) {
	if l.Level >= logger.Error {
		l.Log.ErrorContext(ctx, msg, args...)
	}
}

func (l *slogLogger) Trace(ctx context.Context, begin time.Time, fc func() (string, int64), err error) {
	if l.Level <= logger.Silent {
		return
	}
	elapsed := time.Since(begin)
	query, rows := fc()
	switch {
	case err != nil && !errors.Is(err, gorm.ErrRecordNotFound) && l.Level >= logger.Error:
		l.Log.ErrorContext(ctx, "gorm query failed", "error", err, "elapsed", elapsed, "rows", rows, "sql", query)
	case elapsed >= gormSlowQuery && l.Level >= logger.Warn:
		l.Log.WarnContext(ctx, "gorm slow query", "elapsed", elapsed, "rows", rows, "sql", query)
	case l.Level >= logger.Info:
		l.Log.InfoContext(ctx, "gorm query", "elapsed", elapsed, "rows", rows, "sql", query)
	}
}
