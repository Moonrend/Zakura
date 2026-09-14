package sys

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Exercise a real foreground agent, download, RPC response, exec and new WSS
// session. No installed service or Docker daemon is needed.
func TestForegroundAgentSelfUpdateReconnects(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix exec integration")
	}
	old := agentFixture(t)
	updated := append(append([]byte{}, old...), []byte("self-update integration fixture")...)
	wantSHA := digest(updated)
	dir := t.TempDir()
	bin := filepath.Join(dir, "zakura-agent")
	if err := os.WriteFile(bin, old, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "agent-link")
	if err := os.Symlink(bin, link); err != nil {
		t.Fatal(err)
	}
	var connections atomic.Int32
	var progress atomic.Int32
	ack := make(chan struct{}, 1)
	reconnected := make(chan string, 1)
	upgrader := websocket.Upgrader{}
	var baseURL string
	ready := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-ready
		if r.URL.Path == "/binary" {
			w.Header().Set("Content-Length", fmt.Sprint(len(updated)))
			_, _ = w.Write(updated)
			return
		}
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		generation := connections.Add(1)
		_ = c.WriteJSON(map[string]any{"type": "req", "id": "info", "method": "sys.info", "params": map[string]any{"light": true}})
		for {
			var frame struct {
				Type   string          `json:"type"`
				ID     string          `json:"id"`
				OK     bool            `json:"ok"`
				Result json.RawMessage `json:"result"`
			}
			if err := c.ReadJSON(&frame); err != nil {
				return
			}
			if frame.Type == "stream" {
				progress.Add(1)
			}
			if frame.Type == "res" && frame.ID == "info" {
				var info struct {
					SHA256 string `json:"sha256"`
				}
				_ = json.Unmarshal(frame.Result, &info)
				if generation > 1 {
					reconnected <- info.SHA256
					continue
				}
				_ = c.WriteJSON(map[string]any{"type": "req", "id": "update", "method": "sys.update", "params": UpdateParams{
					URL: baseURL + "/binary", SHA256: wantSHA, Restart: true, ProgressStream: "progress",
				}})
			}
			if frame.Type == "res" && frame.ID == "update" && frame.OK {
				ack <- struct{}{}
			}
		}
	}))
	defer server.Close()
	baseURL = server.URL
	close(ready)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, link, "-server", baseURL, "-token", "rnr_integration", "-kind", "computer", "-data", filepath.Join(dir, "data with spaces"))
	cmd.Env = append(os.Environ(), "ZAKURA_DOCKER=unavailable-docker-for-update-test")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() { cancel(); <-exited })
	started := time.Now()
	select {
	case got := <-reconnected:
		if got != wantSHA {
			t.Fatalf("reconnected with old/wrong executable: %s", got)
		}
	case <-ctx.Done():
		t.Fatal("updated agent never reconnected")
	}
	select {
	case <-ack:
	default:
		t.Fatal("restarted before sending update acknowledgement")
	}
	if progress.Load() == 0 {
		t.Fatal("no download progress received")
	}
	select {
	case err := <-exited:
		exited <- err
		t.Fatalf("original process exited instead of exec: %v", err)
	default:
	}
	assertFile(t, bin, updated)
	assertFile(t, bin+".bak", old)
	assertNoStaged(t, bin)
	t.Logf("download, verify, replace and reconnect completed in %s", time.Since(started))
}
