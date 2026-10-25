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
	"syscall"

	"github.com/Moonrend/Zakura/apps/agent/bootstrap"
	"github.com/Moonrend/Zakura/apps/agent/internal/dial"
	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
	"github.com/Moonrend/Zakura/apps/agent/internal/host"
	"github.com/Moonrend/Zakura/apps/agent/internal/rpc"
	"github.com/Moonrend/Zakura/apps/agent/internal/sys"
	"github.com/Moonrend/Zakura/apps/agent/internal/workspacestate"
)

func main() {
	server := flag.String("server", env("ZAKURA_AGENT_SERVER", ""), "控制面 URL，如 https://zakura.example")
	token := flag.String("token", env("ZAKURA_AGENT_TOKEN", ""), "rnr_ 节点令牌")
	kind := flag.String("kind", env("ZAKURA_AGENT_KIND", "computer"), "computer 或 server")
	data := flag.String("data", env("ZAKURA_AGENT_DATA_DIR", sys.DefaultDataDir()), "数据目录")
	bootstrapDir := flag.String("bootstrap", env("ZAKURA_NODE_BOOTSTRAP_DIR", ""), "Compose 安装凭证目录")
	healthcheck := flag.Bool("healthcheck", false, "检查控制面连接、Docker 与数据卷")
	flag.Parse()
	state := env("ZAKURA_AGENT_STATE_DIR", *data)
	volume := env("ZAKURA_WORKSPACE_VOLUME", "")
	if *healthcheck {
		if err := checkHealth(state, *data, volume); err != nil {
			log.Fatal(err)
		}
		return
	}

	if *server == "" || *token == "" && *bootstrapDir == "" {
		fmt.Fprintf(os.Stderr, "用法: zakura-agent -server URL (-token rnr_... | -bootstrap DIR) [-kind computer|server]\n")
		os.Exit(2)
	}
	if *kind != "computer" && *kind != "server" {
		*kind = "computer"
	}
	if err := host.EnsureDir(*data); err != nil {
		log.Fatal(err)
	}

	if *bootstrapDir != "" {
		if *kind != "server" || *token != "" || state == *data {
			log.Fatal("Compose bootstrap requires kind=server, a separate state directory, and no explicit token")
		}
		if err := host.EnsureDir(state); err != nil {
			log.Fatal(err)
		}
	}
	log.Printf("zakura-agent %s 启动 kind=%s goos=%s/%s data=%s", sys.Version, *kind, runtime.GOOS, runtime.GOARCH, *data)
	h := rpc.New(*kind, *data)
	run := func(ctx context.Context) {
		nodeToken := *token
		var heartbeat func()
		if *bootstrapDir != "" {
			if volume != "" {
				if err := docker.VerifyWorkspaceVolume(ctx, volume, *data); err != nil {
					log.Printf("node storage preflight: %v", err)
					return
				}
			}
			store := workspacestate.Store{StateRoot: state, DataRoot: *data, VolumeName: volume}
			identity, err := store.Identity(ctx)
			if err != nil {
				log.Printf("node storage identity: %v", err)
				return
			}
			beat, closeHealth, err := startHealth(state)
			if err != nil {
				log.Printf("node health state: %v", err)
				return
			}
			defer closeHealth()
			heartbeat = beat
			log.Print("node enrollment: waiting for administrator setup")
			credential, err := bootstrap.Wait(ctx, *server, *bootstrapDir, state, identity.Incarnation)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("node enrollment: %v", err)
				}
				return
			}
			nodeToken = credential.Token
		}
		dial.Loop(ctx, dial.Config{
			ServerURL: *server,
			Token:     nodeToken,
			Kind:      *kind,
			Handler:   h,
			Heartbeat: heartbeat,
		})
	}
	if managed, err := runService(run); err != nil {
		log.Fatal(err)
	} else if managed {
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	run(ctx)
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
