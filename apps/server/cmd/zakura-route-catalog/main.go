// SPDX-License-Identifier: AGPL-3.0-only
// zakura-route-catalog discovers the actual registered HTTP routes without
// listening on a port or starting external providers. It is a build-time tool.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/config"
	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	platformserver "github.com/Moonrend/Zakura/apps/server/internal/platform/server"
	"github.com/go-chi/chi/v5"
)

type route struct {
	Method     string   `json:"method"`
	Path       string   `json:"path"`
	Parameters []string `json:"parameters"`
}

func discover(ctx context.Context) ([]route, error) {
	conn, err := platformdb.Open(ctx, "file::memory:")
	if err != nil {
		return nil, err
	}
	defer conn.DB.Close()
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		return nil, err
	}
	gormDB, err := conn.Gorm()
	if err != nil {
		return nil, err
	}
	cfg := config.Config{Secret: "sdk-generation-only-secret-32-characters", PublicURL: "http://sdk.invalid", WebURL: "http://sdk.invalid", Edition: "oss"}
	deps := platformserver.NewDependencies(cfg, conn.DB, conn.Dialect, conn.Rebind, gormDB)
	run, cancel := context.WithCancel(ctx)
	deps.Context = run
	// Register on a canceled runtime context: the catalog has no business
	// reason to run scheduler, refresh, or recovery background tasks.
	cancel()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := platformserver.Router(cfg, deps, log)
	tree, ok := handler.(chi.Routes)
	if !ok {
		return nil, fmt.Errorf("server router does not implement chi.Routes")
	}
	routes := []route{}
	err = chi.Walk(tree, func(method, path string, h http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		if strings.Contains(path, "*") || !(strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/v1/") || strings.HasPrefix(path, "/oauth/")) {
			return nil
		}
		switch method {
		case "GET", "POST", "PUT", "PATCH", "DELETE":
		default:
			return nil
		}
		// WebSocket, desktop and terminal proxy transports have separate binary
		// protocols. Do not advertise generic JSON helpers for those paths.
		if strings.Contains(path, "/socket.io") || strings.HasSuffix(path, "/hub") || strings.HasSuffix(path, "/ws") || strings.HasSuffix(path, "-proxy") {
			return nil
		}
		params := []string{}
		for _, part := range strings.Split(path, "/") {
			if strings.HasPrefix(part, "{") && strings.HasSuffix(part, "}") {
				params = append(params, strings.TrimSuffix(strings.TrimPrefix(part, "{"), "}"))
			}
		}
		routes = append(routes, route{Method: method, Path: path, Parameters: params})
		return nil
	})
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].Path == routes[j].Path {
			return routes[i].Method < routes[j].Method
		}
		return routes[i].Path < routes[j].Path
	})
	return routes, err
}

func main() {
	routes, err := discover(context.Background())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err = enc.Encode(routes); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
