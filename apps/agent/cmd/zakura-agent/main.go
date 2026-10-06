package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"strings"

	"zakura.dev/agent/internal/dial"
	"zakura.dev/agent/internal/host"
	"zakura.dev/agent/internal/rpc"
	"zakura.dev/agent/internal/sys"
)

func main() {
	server := flag.String("server", env("ZAKURA_AGENT_SERVER", ""), "控制面 URL，如 https://zakura.example")
	token := flag.String("token", env("ZAKURA_AGENT_TOKEN", ""), "rnr_ 节点令牌")
	kind := flag.String("kind", env("ZAKURA_AGENT_KIND", "computer"), "computer 或 server")
	data := flag.String("data", env("ZAKURA_AGENT_DATA_DIR", sys.DefaultDataDir()), "数据目录")
	flag.Parse()

	if *server == "" || *token == "" {
		fmt.Fprintf(os.Stderr, "用法: zakura-agent -server URL -token rnr_... [-kind computer|server]\n")
		os.Exit(2)
	}
	if *kind != "computer" && *kind != "server" {
		*kind = "computer"
	}
	if err := host.EnsureDir(*data); err != nil {
		log.Fatal(err)
	}

	log.Printf("zakura-agent %s 启动 kind=%s goos=%s/%s data=%s", sys.Version, *kind, runtime.GOOS, runtime.GOARCH, *data)
	h := rpc.New(*kind, *data)
	run := func(ctx context.Context) {
		dial.Loop(ctx, dial.Config{
			ServerURL: *server,
			Token:     *token,
			Kind:      *kind,
			Handler:   h,
		})
	}
	if managed, err := runService(run); err != nil {
		log.Fatal(err)
	} else if managed {
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	run(ctx)
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
