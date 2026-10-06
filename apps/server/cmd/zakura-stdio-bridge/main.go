// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/integrations"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	command := strings.TrimSpace(os.Getenv("MCP_COMMAND"))
	if command == "" {
		log.Error("invalid configuration", "error", "MCP_COMMAND is required")
		os.Exit(2)
	}
	args, err := parseArgs(os.Getenv("MCP_ARGS"))
	if err != nil {
		log.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	port, err := parsePort(os.Getenv("MCP_PORT"))
	if err != nil {
		log.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	path := strings.TrimSpace(os.Getenv("MCP_PATH"))
	if path == "" {
		path = "/mcp"
	}
	bridge, err := integrations.NewStdioBridge(integrations.StdioBridgeOptions{
		Command: command,
		Args:    args,
		Dir:     strings.TrimSpace(os.Getenv("MCP_CWD")),
		Path:    path,
	})
	if err != nil {
		log.Error("invalid configuration", "error", err)
		os.Exit(2)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(port),
		Handler:           bridge,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       2 * time.Minute,
		// SSE responses stay open until the client disconnects.
		WriteTimeout:   0,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}
	go func() {
		log.Info("stdio bridge listening", "address", srv.Addr, "path", path, "command", command)
		if serveErr := srv.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Error("stdio bridge failed", "error", serveErr)
			cancel()
		}
	}()
	<-ctx.Done()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("http shutdown failed", "error", err)
		_ = srv.Close()
	}
	if err := bridge.Close(shutdownCtx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("stdio child shutdown failed", "error", err)
	}
}

func parseArgs(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return []string{}, nil
	}
	var args []string
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return nil, fmt.Errorf("MCP_ARGS must be a JSON string array: %w", err)
	}
	return args, nil
}

func parsePort(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return 3100, nil
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, errors.New("MCP_PORT must be an integer between 1 and 65535")
	}
	return port, nil
}
