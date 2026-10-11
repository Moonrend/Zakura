package runtime

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

type e2bEnvdRecorder struct {
	mu          sync.Mutex
	calls       int
	token       string
	contentType string
	sandboxID   string
	sandboxPort string
	cmd         string
	args        []string
	cwd         string
}

type e2bEnvdResult struct {
	stdout   string
	stderr   string
	exitCode int
	errorMsg string
	delay    time.Duration
}

func e2bFrame(flags byte, payload string) []byte {
	frame := make([]byte, 5+len(payload))
	frame[0] = flags
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(payload)))
	copy(frame[5:], payload)
	return frame
}

// newE2BEnvdServer stands in for a sandbox's envd: it speaks the Connect
// server-streaming wire format for process.Process/Start.
func newE2BEnvdServer(t *testing.T, result e2bEnvdResult) (*httptest.Server, *e2bEnvdRecorder) {
	t.Helper()
	rec := &e2bEnvdRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.mu.Lock()
		rec.calls++
		rec.token = r.Header.Get("X-Access-Token")
		rec.contentType = r.Header.Get("Content-Type")
		rec.sandboxID = r.Header.Get("E2b-Sandbox-Id")
		rec.sandboxPort = r.Header.Get("E2b-Sandbox-Port")
		rec.mu.Unlock()
		if r.URL.Path != e2bExecPath {
			http.Error(w, "unexpected path", http.StatusNotFound)
			return
		}
		if len(body) >= 5 {
			length := int(binary.BigEndian.Uint32(body[1:5]))
			if length >= 0 && 5+length <= len(body) {
				var req struct {
					Process *struct {
						Cmd  string   `json:"cmd"`
						Args []string `json:"args"`
						Cwd  string   `json:"cwd"`
					} `json:"process"`
				}
				if err := json.Unmarshal(body[5:5+length], &req); err == nil && req.Process != nil {
					rec.mu.Lock()
					rec.cmd = req.Process.Cmd
					rec.args = req.Process.Args
					rec.cwd = req.Process.Cwd
					rec.mu.Unlock()
				}
			}
		}
		if result.delay > 0 {
			time.Sleep(result.delay)
		}
		w.Header().Set("Content-Type", "application/connect+json")
		w.WriteHeader(http.StatusOK)
		if result.errorMsg != "" {
			_, _ = w.Write(e2bFrame(0x02, `{"error":{"code":"`+result.errorMsg+`"}}`))
			return
		}
		_, _ = w.Write(e2bFrame(0x00, `{"event":{"start":{"pid":42}}}`))
		if result.stdout != "" {
			_, _ = w.Write(e2bFrame(0x00, `{"event":{"data":{"stdout":"`+base64.StdEncoding.EncodeToString([]byte(result.stdout))+`"}}}`))
		}
		if result.stderr != "" {
			_, _ = w.Write(e2bFrame(0x00, `{"event":{"data":{"stderr":"`+base64.StdEncoding.EncodeToString([]byte(result.stderr))+`"}}}`))
		}
		_, _ = w.Write(e2bFrame(0x00, fmt.Sprintf(`{"event":{"end":{"exitCode":%d,"exited":true}}}`, result.exitCode)))
		_, _ = w.Write(e2bFrame(0x02, `{}`))
	}))
	t.Cleanup(server.Close)
	return server, rec
}

func useE2BEnvdServer(t *testing.T, url string) {
	t.Helper()
	previous := e2bExecBaseURLOverride
	e2bExecBaseURLOverride = url
	t.Cleanup(func() { e2bExecBaseURLOverride = previous })
}

func e2bExecHarness(t *testing.T, credentials string) (*handler, *resolvedExecution) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if credentials != "" {
		sealed, err := computers.SealCredentials(d.Secret, "tenant", space.ID, "computer", []byte(credentials))
		if err != nil {
			t.Fatal(err)
		}
		now := d.Clock().UTC().Format(time.RFC3339Nano)
		if _, err = d.DB.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,secret_ref,capabilities_json,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES('computer','tenant',?,?,?,?,?,?,?,?,?)`, space.ID, "E2B", "e2b", sealed, "[]", 900, 3600, now, now); err != nil {
			t.Fatal(err)
		}
	}
	h := &handler{deps: d, store: store, mcpSessions: map[string]spaceMCPSession{}}
	exec := &resolvedExecution{
		spaceID:     space.ID,
		containerID: "sbx-123",
		computer:    computers.Computer{ID: "computer", TenantID: "tenant", SpaceID: space.ID, Name: "E2B", Provider: computers.E2B},
		runtime:     computers.Runtime{ID: "runtime", ComputerID: "computer", TenantID: "tenant", SpaceID: space.ID, ExternalID: "sbx-123", State: computers.Ready},
	}
	return h, exec
}

func TestE2BSandboxHost(t *testing.T) {
	if got := e2bSandboxHost("sbx-1", e2bEnvdPort, "e2b.app"); got != "49983-sbx-1.e2b.app" {
		t.Fatalf("host = %q", got)
	}
	if got := e2bSandboxHost("sbx-1", e2bEnvdPort, ""); got != "49983-sbx-1.e2b.dev" {
		t.Fatalf("default host = %q", got)
	}
	if got := e2bDomainFromAPIBase("https://api.e2b.dev"); got != "e2b.dev" {
		t.Fatalf("domain = %q", got)
	}
	if got := e2bDomainFromAPIBase("not a url"); got != e2bDefaultDomain {
		t.Fatalf("fallback domain = %q", got)
	}
}

func TestE2BExecSuccess(t *testing.T) {
	h, exec := e2bExecHarness(t, `{"apiKey":"test-key","template":"base","envdAccessToken":"envd-token"}`)
	server, rec := newE2BEnvdServer(t, e2bEnvdResult{stdout: "hello\n", exitCode: 0})
	useE2BEnvdServer(t, server.URL)
	result, err := h.e2bComputerExec(context.Background(), exec, 0, "bash", "-lc", "echo hello")
	if err != nil {
		t.Fatal(err)
	}
	if result["stdout"] != "hello\n" || result["exitCode"] != float64(0) {
		t.Fatalf("result = %v", result)
	}
	if result["executionMode"] != "workspace-container" || result["isolated"] != true || result["restrictedPolicyApplied"] != false {
		t.Fatalf("flags = %v", result)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.calls != 1 || rec.token != "envd-token" {
		t.Fatalf("calls/token = %d/%q", rec.calls, rec.token)
	}
	if rec.contentType != "application/connect+json" || rec.sandboxID != "sbx-123" || rec.sandboxPort != "49983" {
		t.Fatalf("headers = %q %q %q", rec.contentType, rec.sandboxID, rec.sandboxPort)
	}
	if rec.cmd != "bash" || !reflect.DeepEqual(rec.args, []string{"-lc", "echo hello"}) || rec.cwd != "/workspace" {
		t.Fatalf("process = %q %v %q", rec.cmd, rec.args, rec.cwd)
	}
}

func TestE2BExecNonZeroExit(t *testing.T) {
	h, exec := e2bExecHarness(t, `{"apiKey":"test-key","template":"base"}`)
	server, _ := newE2BEnvdServer(t, e2bEnvdResult{stdout: "out", stderr: "boom", exitCode: 7})
	useE2BEnvdServer(t, server.URL)
	result, err := h.e2bComputerExec(context.Background(), exec, 0, "bash", "-lc", "false")
	if err == nil || result == nil {
		t.Fatalf("expected a result and an error: %v %v", result, err)
	}
	if result["exitCode"] != float64(7) || result["stderr"] != "boom" || result["stdout"] != "out" {
		t.Fatalf("result = %v", result)
	}
}

func TestE2BExecProcessError(t *testing.T) {
	h, exec := e2bExecHarness(t, `{"apiKey":"test-key","template":"base"}`)
	server, _ := newE2BEnvdServer(t, e2bEnvdResult{errorMsg: "unavailable"})
	useE2BEnvdServer(t, server.URL)
	result, err := h.e2bComputerExec(context.Background(), exec, 0, "bash", "-lc", "true")
	if err == nil || result != nil {
		t.Fatalf("expected an error with no result: %v %v", result, err)
	}
	if !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("error = %v", err)
	}
}

func TestE2BExecNetworkError(t *testing.T) {
	h, exec := e2bExecHarness(t, `{"apiKey":"test-key","template":"base","envdAccessToken":"secret-token"}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := server.URL
	server.Close()
	useE2BEnvdServer(t, url)
	result, err := h.e2bComputerExec(context.Background(), exec, 0, "bash", "-lc", "echo hi")
	if err == nil || result != nil {
		t.Fatalf("expected an error with no result: %v %v", result, err)
	}
	if strings.Contains(err.Error(), "secret-token") || strings.Contains(err.Error(), "test-key") {
		t.Fatalf("error leaked a credential: %v", err)
	}
}

func TestE2BExecTimeout(t *testing.T) {
	h, exec := e2bExecHarness(t, `{"apiKey":"test-key","template":"base"}`)
	server, _ := newE2BEnvdServer(t, e2bEnvdResult{stdout: "late", exitCode: 0, delay: time.Second})
	useE2BEnvdServer(t, server.URL)
	start := time.Now()
	result, err := h.e2bComputerExec(context.Background(), exec, 100, "bash", "-lc", "sleep 5")
	if err == nil || result != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout: %v %v", result, err)
	}
	if elapsed := time.Since(start); elapsed > 900*time.Millisecond {
		t.Fatalf("timeout not honored: %v", elapsed)
	}
}

func TestE2BExecMissingCredentials(t *testing.T) {
	h, exec := e2bExecHarness(t, "")
	server, rec := newE2BEnvdServer(t, e2bEnvdResult{exitCode: 0})
	useE2BEnvdServer(t, server.URL)
	result, err := h.e2bComputerExec(context.Background(), exec, 0, "bash", "-lc", "echo hi")
	if err == nil || result != nil {
		t.Fatalf("expected a credential error: %v %v", result, err)
	}
	if !strings.Contains(err.Error(), "configuration") {
		t.Fatalf("error = %v", err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.calls != 0 {
		t.Fatalf("credential-less exec contacted the sandbox %d times", rec.calls)
	}
}

func TestE2BExecDispatch(t *testing.T) {
	h, exec := e2bExecHarness(t, `{"apiKey":"test-key","template":"base"}`)
	server, rec := newE2BEnvdServer(t, e2bEnvdResult{stdout: "hi", exitCode: 0})
	useE2BEnvdServer(t, server.URL)
	result, err := h.computerContainerExec(context.Background(), exec, "host", 0, "bash", "-lc", "echo hi")
	if err != nil {
		t.Fatal(err)
	}
	if result["stdout"] != "hi" || result["executionMode"] != "workspace-container" {
		t.Fatalf("result = %v", result)
	}
	rec.mu.Lock()
	calls := rec.calls
	rec.mu.Unlock()
	if calls != 1 {
		t.Fatalf("dispatch did not reach E2B: calls=%d", calls)
	}
	if _, err := h.computerContainerExec(context.Background(), exec, "sandbox", 0, "bash", "-lc", "echo hi"); err == nil || !strings.Contains(err.Error(), "refusing downgrade") {
		t.Fatalf("sandbox downgrade not refused: %v", err)
	}
}
