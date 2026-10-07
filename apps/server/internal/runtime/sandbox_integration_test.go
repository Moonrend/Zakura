package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// Exercises real server tool dispatch -> WebSocket hub -> runner binary -> Docker.
// Only benign fixture commands are used; this is not an escape assessment.
func TestSandboxServerRunnerDockerIntegration(t *testing.T) {
	if os.Getenv("ZAKURA_SERVER_SANDBOX_INTEGRATION") != "1" {
		t.Skip("real server/runner Docker integration not requested")
	}
	binary := os.Getenv("ZAKURA_SANDBOX_AGENT_BINARY")
	if !filepath.IsAbs(binary) {
		t.Fatal("absolute ZAKURA_SANDBOX_AGENT_BINARY required")
	}
	if _, e := os.Stat(binary); e != nil {
		t.Fatal(e)
	}
	if os.Getenv("ZAKURA_SANDBOX_IMAGE") == "" {
		t.Fatal("pre-provisioned image with bash required")
	}
	if _, e := exec.LookPath("docker"); e != nil {
		t.Fatal(e)
	}
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	node := "node"
	space, e := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if e != nil {
		t.Fatal(e)
	}
	agent, e := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, Config: json.RawMessage(`{"executionMode":"sandbox"}`)})
	if e != nil {
		t.Fatal(e)
	}
	storage := t.TempDir()
	workspace := filepath.Join(storage, "spaces", space.ID, "workspace")
	if e := os.MkdirAll(workspace, 0755); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(workspace, "fixture.txt"), []byte("read-only fixture"), 0644); e != nil {
		t.Fatal(e)
	}
	token := "rnr_real_sandbox_fixture"
	hash := sha256.Sum256([]byte(token))
	now := d.Clock()
	if _, e := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}',?,'{}',false,?,?)`, hex.EncodeToString(hash[:]), storage, now, now); e != nil {
		t.Fatal(e)
	}
	h := &handler{deps: d, store: store, mcpSessions: map[string]spaceMCPSession{}}
	h.hub = newRunnerHub(d)
	h.service = NewService(store)
	router := chi.NewRouter()
	router.Handle("/api/runtime-nodes/hub", http.HandlerFunc(h.runnerHubHTTP))
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	runctx, stop := context.WithCancel(context.Background())
	cmd := exec.CommandContext(runctx, binary, "-server", server.URL, "-token", token, "-data", storage)
	cmd.Env = append(os.Environ(), "ZAKURA_SANDBOX_ENABLED=true")
	logFile, e := os.CreateTemp(t.TempDir(), "runner-log-")
	if e != nil {
		t.Fatal(e)
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if e := cmd.Start(); e != nil {
		stop()
		t.Fatal(e)
	}
	t.Cleanup(func() { stop(); _ = cmd.Wait(); _ = logFile.Close() })
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if _, e := h.hub.get("node"); e == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, e := h.hub.get("node"); e != nil {
		t.Fatal("real runner failed to connect", e)
	}
	call := func(ctx context.Context, script string, timeout int) map[string]any {
		t.Helper()
		args, _ := json.Marshal(map[string]any{"command": script, "timeout_ms": timeout})
		raw, e := h.dispatchAgentTool(ctx, "tenant", agent.ID, "", "fixture-call", "shell_exec", args)
		return decodeBuiltinResult(t, raw, e)
	}
	assertNoOutputWrites := func() {
		t.Helper()
		files, e := os.ReadDir(workspace)
		if e != nil {
			t.Fatal(e)
		}
		if len(files) != 1 || files[0].Name() != "fixture.txt" {
			t.Fatalf("server wrote outside sandbox: %v", files)
		}
	}
	t.Run("long stdout and stderr never persist", func(t *testing.T) {
		out := call(context.Background(), `head -c 30000 /dev/zero | tr '\000' x; head -c 30000 /dev/zero | tr '\000' e >&2`, 10000)
		if out["truncated"] != true || out["executionMode"] != "sandbox" {
			t.Fatalf("incorrect result flags: %v", out["truncated"])
		}
		for _, key := range []string{"stdout", "stderr"} {
			if s := out[key].(string); len(s) > toolOutputMaxBytes || !strings.Contains(s, "not persisted") {
				t.Fatalf("invalid %s preview", key)
			}
		}
		assertNoOutputWrites()
	})
	t.Run("deadline preserves final output", func(t *testing.T) {
		out := call(context.Background(), `printf 'before timeout'; printf diagnostic >&2; sleep 30`, 3000)
		if out["timedOut"] != true || out["stdout"] != "before timeout" || out["stderr"] != "diagnostic" {
			t.Fatalf("lost timeout result: %+v", out)
		}
		assertNoOutputWrites()
	})
	t.Run("caller cancellation acknowledges cleanup", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		timer := time.AfterFunc(3*time.Second, cancel)
		defer timer.Stop()
		out := call(ctx, `printf 'before cancellation'; sleep 30`, 10000)
		if out["cancelled"] != true || out["stdout"] != "before cancellation" {
			t.Fatalf("lost cancellation result: %+v", out)
		}
		assertNoOutputWrites()
	})
	t.Run("operator enforced result never persists", func(t *testing.T) {
		if _, e := store.UpdateAgent(context.Background(), "tenant", agent.ID, map[string]any{"config": map[string]any{}}); e != nil {
			t.Fatal(e)
		}
		out := call(context.Background(), `head -c 30000 /dev/zero | tr '\000' x`, 10000)
		if out["executionMode"] != "sandbox" || out["truncated"] != true {
			t.Fatal("operator enforcement lost")
		}
		assertNoOutputWrites()
	})
	t.Run("operator enforced cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		timer := time.AfterFunc(3*time.Second, cancel)
		defer timer.Stop()
		out := call(ctx, `printf 'operator cancellation'; sleep 30`, 10000)
		if out["cancelled"] != true || out["stdout"] != "operator cancellation" {
			t.Fatalf("lost enforced cancellation: %+v", out)
		}
		assertNoOutputWrites()
	})
	checkctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	remaining, e := exec.CommandContext(checkctx, "docker", "container", "ls", "--all", "--filter", "name=zakura-sandbox-", "--format", "{{.ID}}").Output()
	if e != nil || strings.TrimSpace(string(remaining)) != "" {
		t.Fatalf("container cleanup unconfirmed: %s %v", remaining, e)
	}
}
