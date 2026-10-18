package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// A real binary and temporary control plane exercise the generated CLI contract
// without installing a service, binding a real node or contacting Docker.
func TestRunnerDownloadedAgentConnects(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	token := "rnr_downloaded-fixture"
	sum := sha256.Sum256([]byte(token))
	if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,storage_root,created_at,updated_at) VALUES('fixture','tenant','fixture','fixture','computer','offline',?,'unused','before','before')`, hex.EncodeToString(sum[:])).Error; err != nil {
		t.Fatal(err)
	}
	artifacts := t.TempDir()
	t.Setenv("ZAKURA_AGENT_BINARIES_DIR", artifacts)
	ext := ""
	if goruntime.GOOS == "windows" {
		ext = ".exe"
	}
	artifact := filepath.Join(artifacts, fmt.Sprintf("zakura-agent_%s_%s%s", goruntime.GOOS, goruntime.GOARCH, ext))
	build := exec.Command("go", "build", "-buildvcs=false", "-o", artifact, "./cmd/zakura-agent")
	build.Dir = filepath.Join("..", "..", "..", "agent")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v %s", err, output)
	}
	h := &handler{deps: d, store: NewStore(d), hub: newRunnerHub(d)}
	router := chi.NewRouter()
	router.Get("/api/runtime-nodes/hub", h.runnerHubHTTP)
	router.Get("/api/runtime-nodes/agent-binaries/{os}/{arch}", h.runtimeAgentBinary)
	server := httptest.NewServer(router)
	defer server.Close()
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/runtime-nodes/agent-binaries/%s/%s", server.URL, goruntime.GOOS, goruntime.GOARCH), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("download status: %d", response.StatusCode)
	}
	dest := filepath.Join(t.TempDir(), "zakura-agent"+ext)
	file, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(file, response.Body)
	_ = file.Close()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	root := t.TempDir()
	process := exec.CommandContext(ctx, dest, "-server", server.URL, "-token", token, "-kind", "computer", "-data", root)
	process.Env = append(os.Environ(), "ZAKURA_SANDBOX_ENABLED=0", "ZAKURA_DOCKER="+filepath.Join(t.TempDir(), "no-docker"))
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- process.Wait() }()
	defer func() {
		cancel()
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			t.Error("Agent fixture did not terminate")
		}
	}()
	var session *runnerSession
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for session == nil {
		select {
		case err := <-exited:
			t.Fatalf("Agent exited before connect: %v", err)
		case <-deadline.C:
			t.Fatal("downloaded Agent did not connect")
		case <-tick.C:
			session, _ = h.hub.get("fixture")
		}
	}
	var info struct{ StorageRoot, Kind string }
	if err := session.call(context.Background(), "sys.info", map[string]any{}, &info); err != nil || info.StorageRoot != root || info.Kind != "computer" {
		t.Fatalf("sys.info: %#v %v", info, err)
	}
	before := session.lastSeen.Load()
	<-tick.C
	if err := session.writeJSON(runnerFrame{Type: "ping", ID: "fixture-beat"}); err != nil {
		t.Fatal(err)
	}
	for session.lastSeen.Load() <= before {
		select {
		case <-deadline.C:
			t.Fatal("Agent did not answer heartbeat")
		case <-tick.C:
		}
	}
	if err := h.hub.persistHeartbeat(session); err != nil {
		t.Fatal(err)
	}
	command := []string{"/bin/sh", "-c", "printf downloaded-exec"}
	if goruntime.GOOS == "windows" {
		command = []string{"cmd.exe", "/c", "echo downloaded-exec"}
	}
	var result struct{ Stdout string }
	if err := session.call(context.Background(), "host.exec", map[string]any{"command": command}, &result); err != nil || result.Stdout == "" {
		t.Fatalf("exec: %#v %v", result, err)
	}
	cancel()
}
