package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/config"
	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	platformserver "github.com/Moonrend/Zakura/apps/server/internal/platform/server"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load()
	if err != nil {
		log.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	conn, err := platformdb.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	defer conn.DB.Close()
	if cfg.AutoMigrate {
		if err := migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
			log.Error("database migration failed", "error", err)
			os.Exit(1)
		}
	}
	gormDB, gormErr := conn.Gorm()
	if gormErr != nil {
		log.Error("gorm init failed", "error", gormErr)
		os.Exit(1)
	}
	deps := platformserver.NewDependencies(cfg, conn.DB, conn.Dialect, conn.Rebind, gormDB)
	deps.Context = ctx
	if err := deps.Validate(); err != nil {
		log.Error("invalid dependencies", "error", err)
		os.Exit(2)
	}
	var hijacked sync.Map
	srv := &http.Server{Addr: cfg.ListenAddr, Handler: platformserver.Router(cfg, deps, log), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: cfg.ReadTimeout, WriteTimeout: cfg.WriteTimeout, IdleTimeout: 120 * time.Second, MaxHeaderBytes: 1 << 20,
		ConnState: func(conn net.Conn, state http.ConnState) {
			if state == http.StateHijacked {
				hijacked.Store(conn, struct{}{})
			} else if state == http.StateClosed {
				hijacked.Delete(conn)
			}
		},
	}
	serverResult := make(chan error, 1)
	go func() {
		log.Info("server listening", "address", cfg.ListenAddr)
		serverResult <- srv.ListenAndServe()
	}()
	serveFailed := false
	select {
	case <-ctx.Done():
	case serveErr := <-serverResult:
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Error("server failed", "error", serveErr)
			serveFailed = true
			cancel()
		}
	}
	hijacked.Range(func(key, _ any) bool {
		_ = key.(net.Conn).Close()
		hijacked.Delete(key)
		return true
	})
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "error", err)
		_ = srv.Close()
	}
	if serveFailed {
		os.Exit(1)
	}
}
