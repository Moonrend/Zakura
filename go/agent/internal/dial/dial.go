package dial

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"zakura.dev/agent/internal/rpc"
	"zakura.dev/agent/internal/sys"
)

type Config struct {
	ServerURL string
	Token     string
	Kind      string
	Handler   *rpc.Handler
}

func Loop(ctx context.Context, cfg Config) {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		err := connectOnce(ctx, cfg)
		if err != nil {
			log.Printf("zakura-agent: 连接断开: %v，%s 后重试", err, backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func connectOnce(ctx context.Context, cfg Config) error {
	u, err := hubURL(cfg.ServerURL)
	if err != nil {
		return err
	}
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+cfg.Token)
	c, _, err := websocket.DefaultDialer.DialContext(ctx, u, hdr)
	if err != nil {
		return err
	}
	defer c.Close()

	hello := rpc.Hello(cfg.Token, sys.Version, cfg.Kind)
	if err := c.WriteJSON(hello); err != nil {
		return err
	}

	send := func(m rpc.Msg) {
		_ = c.WriteJSON(m)
	}

	c.SetReadLimit(16 << 20)
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return err
		}
		var msg rpc.Msg
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg.Type == "welcome" || msg.Type == "ping" {
			if msg.Type == "ping" {
				send(rpc.Msg{Type: "pong", ID: msg.ID})
			}
			continue
		}
		if msg.Type != "req" {
			continue
		}
		go cfg.Handler.Dispatch(ctx, msg, send)
	}
}

func hubURL(server string) (string, error) {
	s := strings.TrimRight(strings.TrimSpace(server), "/")
	if s == "" {
		return "", os.ErrInvalid
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		u.Scheme = "wss"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/runtime-nodes/hub"
	u.RawQuery = ""
	return u.String(), nil
}
