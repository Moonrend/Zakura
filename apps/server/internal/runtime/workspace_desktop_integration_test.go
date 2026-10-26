// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/executor"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

// Opt-in, no pulls, no host ports/mounts/network, and only uniquely owned Docker
// resources. The browser uses the installed noVNC package and a fresh profile.
func TestWorkspaceDesktopBrowserIntegration(t *testing.T) {
	if os.Getenv("ZAKURA_DESKTOP_INTEGRATION") != "1" {
		t.Skip("real Docker/noVNC desktop integration not requested")
	}
	image, chrome := os.Getenv("ZAKURA_DESKTOP_IMAGE"), os.Getenv("ZAKURA_DESKTOP_CHROME")
	if image == "" || !filepath.IsAbs(chrome) {
		t.Fatal("cached ZAKURA_DESKTOP_IMAGE and absolute ZAKURA_DESKTOP_CHROME required")
	}
	if _, err := os.Stat(chrome); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	docker := func(args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "docker", args...)
		out, err := cmd.CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}
	imageID, err := docker("image", "inspect", image, "--format", "{{.Id}}")
	if err != nil || !strings.HasPrefix(imageID, "sha256:") {
		t.Fatalf("cached image required: %s %v", imageID, err)
	}
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	node := "desktop-fixture"
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "Desktop fixture", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	owner := rand.Text()
	name := "zakura-desktop-test-" + strings.ToLower(owner)
	// Install cleanup before creation: a lost CLI reply does not prove absence.
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		out, err := exec.CommandContext(cleanup, "docker", "inspect", name).Output()
		if err != nil {
			// List by the exact ownership label as a second observation; no broad rm.
			out, listErr := exec.CommandContext(cleanup, "docker", "ps", "-aq", "--filter", "label=zakura.desktop-test="+owner).Output()
			t.Errorf("desktop fixture cleanup unconfirmed: inspect=%v list=%s %v", err, out, listErr)
			return
		}
		var rows []struct {
			ID     string
			Config struct{ Labels map[string]string }
		}
		if json.Unmarshal(out, &rows) != nil || len(rows) != 1 || rows[0].Config.Labels["zakura.desktop-test"] != owner {
			t.Error("refusing cleanup of a container without exact fixture ownership")
			return
		}
		out, err = exec.CommandContext(cleanup, "docker", "rm", "-f", rows[0].ID).CombinedOutput()
		if err != nil {
			t.Errorf("desktop fixture cleanup: %s %v", out, err)
		}
	})
	id, err := docker("create", "--pull=never", "--name", name, "--network", "none", "--shm-size", "256m", "--label", "zakura.desktop-test="+owner, "--label", "zakura.tenant=tenant", "--label", "zakura.space="+space.ID, "--label", "zakura.purpose=workspace", "-e", "ZAKURA_ENABLE_BROWSER=1", "-e", "ZAKURA_ENABLE_COMPUTER=1", imageID)
	if err != nil {
		t.Fatalf("create owned desktop: %s %v", id, err)
	}
	if out, err := docker("start", id); err != nil {
		t.Fatalf("start owned desktop: %s %v", out, err)
	}
	ready := false
	for until := time.Now().Add(55 * time.Second); time.Now().Before(until); {
		if _, err := docker("exec", id, "test", "-f", "/var/lib/zakura-features/.display-ready"); err == nil {
			ready = true
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	if !ready {
		out, _ := docker("exec", id, "sh", "-c", "cat /var/log/zakura/workspace.log /var/log/zakura/chrome.log /var/log/zakura/x11vnc.log")
		t.Fatalf("desktop did not become ready: %s", out)
	}
	// A local page records real X11 keyboard input delivered through VNC.
	fixtureJS := `const http=require('http');let value='';http.createServer((q,s)=>{const u=new URL(q.url,'http://fixture');if(u.pathname==='/value'){s.end(value);return}if(u.pathname==='/input'){value=u.searchParams.get('value')||'';s.end('ok');return}s.setHeader('Content-Type','text/html');s.end('<!doctype html><body style="background:#f8f8f8"><h1>Desktop input fixture</h1><input autofocus style="font-size:32px" oninput="fetch(\'/input?value=\'+encodeURIComponent(this.value))"></body>')}).listen(8789,'127.0.0.1')`
	if out, err := docker("exec", "-d", id, "node", "-e", fixtureJS); err != nil {
		t.Fatalf("fixture page: %s %v", out, err)
	}
	for until := time.Now().Add(5 * time.Second); ; {
		if _, err := docker("exec", id, "curl", "-fsS", "http://127.0.0.1:8789/value"); err == nil {
			break
		}
		if time.Now().After(until) {
			t.Fatal("fixture page did not start")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if out, err := docker("exec", id, "curl", "-fsS", "-X", "PUT", "http://127.0.0.1:9222/json/new?http://127.0.0.1:8789/"); err != nil {
		t.Fatalf("open fixture page: %s %v", out, err)
	}
	if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,created_at,updated_at) VALUES(?,'tenant','Desktop fixture','desktop-fixture','computer','online',?,'before','before')`, node, t.TempDir()).Error; err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store, hub: newRunnerHub(d)}
	local := executor.New("computer", t.TempDir())
	runner := &runnerSession{hub: h.hub, nodeID: node, local: local, pending: map[string]chan runnerReply{}, done: make(chan struct{})}
	runner.ready.Store(true)
	runner.lastSeen.Store(time.Now().UnixMilli())
	h.hub.install(runner)
	t.Cleanup(func() { runner.close(context.Canceled); local.Close() })
	t.Run("interactive-terminal", func(t *testing.T) {
		output := make(chan string, 128)
		stream, err := h.startRunnerComputerPTY(ctx, &resolvedExecution{nodeID: node, containerID: id}, 100, 40, func(channel string, data []byte) {
			if channel == "stdout" || channel == "stderr" {
				select {
				case output <- string(data):
				case <-ctx.Done():
				}
			}
		})
		if err != nil {
			t.Fatal(err)
		}
		defer stream.close()
		await := func(fragment string) {
			t.Helper()
			var text strings.Builder
			deadline := time.NewTimer(10 * time.Second)
			defer deadline.Stop()
			for {
				select {
				case part := <-output:
					text.WriteString(part)
					if strings.Contains(text.String(), fragment) {
						return
					}
				case <-deadline.C:
					t.Fatalf("terminal awaiting %q: %q", fragment, text.String())
				}
			}
		}
		if err := stream.write([]byte("stty -echo; test -t 0 && printf 'TTY_READY\\n'; stty size\n")); err != nil {
			t.Fatal(err)
		}
		await("40 100")
		if err := stream.resize(132, 43); err != nil {
			t.Fatal(err)
		}
		// Docker's CLI propagates the local console resize asynchronously.
		time.Sleep(300 * time.Millisecond)
		if err := stream.write([]byte("stty size; printf 'TERMINAL_INPUT_OK\\n'\n")); err != nil {
			t.Fatal(err)
		}
		await("43 132")
		if err := stream.write([]byte("printf 'SECOND_INPUT_OK\\n'\n")); err != nil {
			t.Fatal(err)
		}
		await("SECOND_INPUT_OK")
	})
	router := chi.NewRouter()
	router.Post("/api/spaces/{id}/desktop-ticket", func(w http.ResponseWriter, r *http.Request) {
		h.issueSpaceWorkspaceTicket(w, r.WithContext(httpx.WithPrincipal(r.Context(), acpLoginPrincipal())), "desktop")
	})
	router.Get("/api/spaces/{id}/desktop-proxy", h.spaceDesktopProxy)
	assets := filepath.Join("..", "..", "..", "web", "node_modules", "@novnc", "novnc")
	if _, err := os.Stat(filepath.Join(assets, "core", "rfb.js")); err != nil {
		t.Fatal(err)
	}
	router.Handle("/novnc/*", http.StripPrefix("/novnc/", http.FileServer(http.Dir(assets))))
	router.Get("/fixture", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprintf(w, desktopBrowserFixture, space.ID)
	})
	server := httptest.NewServer(router)
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if err := h.closeSpaceWorkspaceBridges(cleanup, "tenant", space.ID); err != nil {
			t.Errorf("desktop bridge cleanup: %v", err)
		}
		server.Close()
	})
	cmd := exec.CommandContext(ctx, "node", filepath.Join("..", "..", "scripts", "desktop-browser.mjs"), "--url", server.URL+"/fixture", "--chrome", chrome)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("noVNC browser: %s %v", out, err)
	}
	t.Logf("noVNC browser: %s", out)
	value, err := docker("exec", id, "curl", "-fsS", "http://127.0.0.1:8789/value")
	if err != nil || value != "zakura" {
		t.Fatalf("VNC keyboard input=%q err=%v", value, err)
	}
	if err := h.closeSpaceWorkspaceBridges(ctx, "tenant", space.ID); err != nil {
		t.Fatal(err)
	}
	var pending int64
	if err := d.Gorm.Table("workspace_connections").Count(&pending).Error; err != nil || pending != 0 {
		t.Fatalf("desktop connection cleanup: rows=%d err=%v", pending, err)
	}
}

const desktopBrowserFixture = `<!doctype html><meta charset="utf-8"><title>Desktop fixture</title><div id="desktop" style="width:1280px;height:720px"></div><script type="module">
import RFB from '/novnc/core/rfb.js';
const space = %q;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect() {
 const response = await fetch('/api/spaces/' + space + '/desktop-ticket', {method:'POST'});
 if (!response.ok) throw new Error('ticket ' + response.status);
 const {ticket} = await response.json();
 const rfb = new RFB(document.querySelector('#desktop'), location.origin.replace('http','ws') + '/api/spaces/' + space + '/desktop-proxy?token=' + encodeURIComponent(ticket));
 rfb.scaleViewport = true;
 await new Promise((resolve,reject) => { rfb.addEventListener('connect', resolve, {once:true}); rfb.addEventListener('disconnect', () => reject(new Error('early disconnect')), {once:true}); });
 for (let i=0;i<100;i++) {
  const canvas = document.querySelector('canvas');
  if (canvas && canvas.width > 100 && canvas.height > 100) {
   const data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
   const colors = new Set();
   for(let j=0;j<data.length;j+=400) colors.add(data[j]+','+data[j+1]+','+data[j+2]);
   if(colors.size>3) return {rfb, width:canvas.width, height:canvas.height, colors:colors.size};
  }
  await sleep(100);
 }
 throw new Error('no rendered framebuffer');
}
window.verifyDesktop = async () => {
 const first = await connect();
 await sleep(800);
 for (const key of 'zakura') first.rfb.sendKey(key.charCodeAt(0));
 await sleep(500);
 const closed = new Promise(resolve => first.rfb.addEventListener('disconnect',resolve,{once:true}));
 first.rfb.disconnect(); await closed;
 const second = await connect();
 const result = {first:{width:first.width,height:first.height,colors:first.colors},reconnect:{width:second.width,height:second.height,colors:second.colors}};
 const closedAgain = new Promise(resolve => second.rfb.addEventListener('disconnect',resolve,{once:true}));
 second.rfb.disconnect(); await closedAgain;
 return result;
};
</script>`
