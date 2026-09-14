package sys

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

var builtAgent = sync.OnceValues(func() ([]byte, error) {
	dir, err := os.MkdirTemp("", "zakura-update-fixture-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "build", "-o", filepath.Join(dir, "agent"), "../../cmd/zakura-agent")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("build agent: %w: %s", err, out)
	}
	return os.ReadFile(filepath.Join(dir, "agent"))
})

func agentFixture(t *testing.T) []byte {
	t.Helper()
	data, err := builtAgent()
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func testUpdater(t *testing.T) (*updater, string, []byte) {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "agent")
	old := []byte("old running agent")
	if err := os.WriteFile(bin, old, 0o755); err != nil {
		t.Fatal(err)
	}
	u := &updater{binary: func() (string, error) { return bin, nil },
		runningSHA: func() string { return digest(old) }, idleTimeout: time.Second,
		restart: func(string, string) error { t.Error("unexpected restart"); return errors.New("unexpected restart") }}
	return u, bin, old
}

func assertFile(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("unexpected file %s: len=%d, error=%v", path, len(got), err)
	}
}

func assertNoStaged(t *testing.T, bin string) {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(filepath.Dir(bin), ".zakura-agent-update-*"))
	if err != nil || len(files) != 0 {
		t.Fatalf("leaked staged downloads: %v, %v", files, err)
	}
}

func TestEqualFoldHex(t *testing.T) {
	sum := strings.Repeat("ab", 32)
	if !equalFoldHex(sum, strings.ToUpper(sum)) {
		t.Fatal("valid digests should be case insensitive")
	}
	for _, pair := range [][2]string{{"abc", "ABC"}, {"zz", "xx"}, {"", ""}, {sum, strings.Repeat("cd", 32)}, {sum + "x", sum}} {
		if equalFoldHex(pair[0], pair[1]) {
			t.Fatalf("invalid/different digests matched: %q", pair)
		}
	}
}

func TestApplyAlreadyCurrentSkipsDownload(t *testing.T) {
	u, bin, old := testUpdater(t)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	defer server.Close()
	result, err := u.apply(context.Background(), UpdateParams{URL: server.URL, SHA256: strings.ToUpper(digest(old)), Restart: true}, nil)
	if err != nil || !result.AlreadyCurrent || result.Restarting {
		t.Fatalf("result=%+v, err=%v", result, err)
	}
	if requests.Load() != 0 {
		t.Fatal("same binary was downloaded again")
	}
	assertFile(t, bin, old)
	assertNoStaged(t, bin)
}

func TestApplyFailuresKeepOriginalAndCleanDownload(t *testing.T) {
	for _, tc := range []struct {
		name, sum, payload string
		status             int
		truncated          bool
	}{
		{name: "invalid digest", sum: "xyz", payload: "new", status: 200},
		{name: "checksum mismatch", sum: digest([]byte("other")), payload: "new", status: 200},
		{name: "HTML with matching digest", sum: digest([]byte("<html>error</html>")), payload: "<html>error</html>", status: 200},
		{name: "HTTP failure", sum: digest([]byte("new")), payload: "new", status: 503},
		{name: "truncated", sum: digest([]byte("new")), payload: "new", status: 200, truncated: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u, bin, old := testUpdater(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.truncated {
					w.Header().Set("Content-Length", "100")
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.payload)
			}))
			defer server.Close()
			_, err := u.apply(context.Background(), UpdateParams{URL: server.URL, SHA256: tc.sum, Restart: true}, nil)
			if err == nil {
				t.Fatal("expected update failure")
			}
			assertFile(t, bin, old)
			assertNoStaged(t, bin)
		})
	}
}

func TestDownloadProgressHashAndStallCancellation(t *testing.T) {
	data := bytes.Repeat([]byte("download"), 8192)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		if r.URL.Path == "/stall" {
			_, _ = w.Write(data[:8])
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		_, _ = w.Write(data)
	}))
	defer server.Close()
	var out bytes.Buffer
	var events []UpdateProgress
	sum, err := downloadFile(context.Background(), server.URL, &out, time.Second, func(p UpdateProgress) { events = append(events, p) })
	if err != nil || sum != digest(data) || !bytes.Equal(out.Bytes(), data) {
		t.Fatalf("download: sum=%s err=%v", sum, err)
	}
	last := events[len(events)-1]
	if last.DownloadedBytes != int64(len(data)) || last.TotalBytes != int64(len(data)) {
		t.Fatalf("missing final progress: %+v", last)
	}
	_, err = downloadFile(context.Background(), server.URL+"/stall", io.Discard, 30*time.Millisecond, nil)
	if err == nil || !strings.Contains(err.Error(), "停滞") {
		t.Fatalf("stall did not time out: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = downloadFile(ctx, server.URL, io.Discard, time.Second, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation ignored: %v", err)
	}
}

func TestApplyCancelsOnDisconnectAndReleasesLock(t *testing.T) {
	u, bin, old := testUpdater(t)
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := u.apply(ctx, UpdateParams{URL: server.URL, SHA256: digest([]byte("new")), Restart: true}, nil)
		done <- err
	}()
	<-started
	_, err := u.apply(context.Background(), UpdateParams{}, nil)
	if err == nil || !strings.Contains(err.Error(), "正在进行") {
		t.Fatalf("concurrent update accepted: %v", err)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	assertFile(t, bin, old)
	assertNoStaged(t, bin)
	result, err := u.apply(context.Background(), UpdateParams{URL: server.URL, SHA256: digest(old), Restart: true}, nil)
	if err != nil || !result.AlreadyCurrent {
		t.Fatalf("update lock not released: %v", err)
	}
}

func TestApplyAtomicReplacementAndRestartRollback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix replacement; Windows helper tested separately")
	}
	data := agentFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(data) }))
	defer server.Close()
	for _, restart := range []bool{false, true} {
		t.Run(fmt.Sprint("restart=", restart), func(t *testing.T) {
			u, bin, old := testUpdater(t)
			calls := 0
			u.restart = func(got, staged string) error {
				calls++
				if got != bin {
					t.Fatalf("wrong executable: %s", got)
				}
				return errors.New("exec failed")
			}
			var phases []string
			result, err := u.apply(context.Background(), UpdateParams{URL: server.URL, SHA256: digest(data), Restart: restart}, func(p UpdateProgress) { phases = append(phases, p.Phase) })
			if err != nil {
				t.Fatal(err)
			}
			assertFile(t, bin, data)
			assertFile(t, bin+".bak", old)
			assertNoStaged(t, bin)
			if calls != 0 {
				t.Fatal("restarted before RPC acknowledgement")
			}
			if phases[len(phases)-1] != "installing" {
				t.Fatalf("missing progress: %v", phases)
			}
			if u.runningSHA() != digest(old) {
				t.Fatal("installed bytes reported as running before restart")
			}
			if restart {
				_, err := u.apply(context.Background(), UpdateParams{}, nil)
				if err == nil || !strings.Contains(err.Error(), "正在进行") {
					t.Fatal("lock released before restart")
				}
				result.afterReply()
				result.afterReply()
				if calls != 1 {
					t.Fatal("restart should run once")
				}
				assertFile(t, bin, old)
				if !strings.Contains(u.errorMessage(), "exec failed") {
					t.Fatal("restart failure was hidden")
				}
			} else if result.Restarting || result.afterReply != nil {
				t.Fatal("restart=false ignored")
			}
		})
	}
}

func TestReplaceFailureDoesNotRemoveOriginal(t *testing.T) {
	_, bin, old := testUpdater(t)
	if err := replaceBinary(bin, filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("expected rename failure")
	}
	assertFile(t, bin, old)
}

func TestWindowsUpdateUsesEncodedPathsAndWaitsBeforeReplace(t *testing.T) {
	config := windowsUpdateConfig{Bin: `C:\Users\a ' & b\zakura-agent.exe`, Staged: `C:\temp\new.exe`, Args: `-data "C:\a b"`, PID: 123}
	script := windowsUpdateScript(config)
	encoded := strings.Split(strings.Split(script, "FromBase64String('")[1], "'")[0]
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var got windowsUpdateConfig
	if err := json.Unmarshal(decoded, &got); err != nil || got != config {
		t.Fatalf("config round trip failed: %+v, %v", got, err)
	}
	if strings.Contains(script, config.Bin) {
		t.Fatal("path interpolated as PowerShell code")
	}
	stop := strings.Index(script, "# Stop and wait")
	wait := strings.Index(script, "while (Get-Process -Id $config.pid")
	replace := strings.Index(script, "[IO.File]::Replace")
	if stop < 0 || wait <= stop || replace <= wait {
		t.Fatal("replacement attempted before stopping and waiting")
	}
	if !strings.Contains(script, "AddSeconds(30)") || !strings.Contains(script, "rollback/restart failed") {
		t.Fatal("missing timeout/rollback")
	}
}
