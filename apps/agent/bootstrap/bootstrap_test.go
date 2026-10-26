package bootstrap

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestInstallationConcurrentInitialization(t *testing.T) {
	directory := t.TempDir()
	var wg sync.WaitGroup
	installations := make([]Installation, 8)
	errorsSeen := make([]error, 8)
	for i := range installations {
		wg.Go(func() { installations[i], errorsSeen[i] = Initialize(context.Background(), directory) })
	}
	wg.Wait()
	for i, err := range errorsSeen {
		if err != nil {
			t.Fatal(err)
		}
		if !installations[i].Valid() || installations[i] != installations[0] {
			t.Fatal("initialization changed installation identity")
		}
	}
	i, err := Read(directory)
	if err != nil || i != installations[0] {
		t.Fatalf("read after restart: %v", err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(directory, "installation.json"))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("secret permissions: %v", info.Mode())
		}
	}
}

func TestEnrollmentPersistsWithoutContactingServerAgain(t *testing.T) {
	bootstrapDirectory, state := t.TempDir(), t.TempDir()
	i, err := Initialize(context.Background(), bootstrapDirectory)
	if err != nil {
		t.Fatal(err)
	}
	want := Credential{i.ID, "node", "incarnation", "rnr_" + strings.Repeat("a", 43)}
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/api/runtime-nodes/installation/enroll" || r.Header.Get("Authorization") != "Bearer "+i.Secret {
			t.Error("wrong enrollment request")
			w.WriteHeader(401)
			return
		}
		var request Request
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.InstallationID != i.ID || request.NodeIncarnation != "incarnation" {
			t.Error("wrong identity")
			w.WriteHeader(400)
			return
		}
		_ = json.NewEncoder(w).Encode(want)
	}))
	defer server.Close()
	credential, err := Wait(context.Background(), server.URL, bootstrapDirectory, state, "incarnation")
	if err != nil || credential != want {
		t.Fatalf("enroll: %v", err)
	}
	server.Close()
	again, err := Wait(context.Background(), server.URL, bootstrapDirectory, state, "incarnation")
	if err != nil || again != want || requests.Load() != 1 {
		t.Fatalf("restart: %v requests=%d", err, requests.Load())
	}
	if _, err := Wait(context.Background(), server.URL, bootstrapDirectory, state, "replacement"); err == nil {
		t.Fatal("changed identity reused credential")
	}
	if _, err := Wait(context.Background(), server.URL+"/other", bootstrapDirectory, state, "incarnation"); err == nil {
		t.Fatal("changed control plane reused credential")
	}
}

func TestEnrollmentResponseHandling(t *testing.T) {
	i, err := Initialize(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		status int
		retry  bool
		body   string
	}{
		{"setup", 409, true, ""}, {"startup", 503, true, ""}, {"revoked", 403, false, i.Secret},
		{"redirect", 302, false, ""}, {"malformed", 200, false, "{}"},
		{"trailing", 200, false, `{"installationId":"` + i.ID + `","nodeId":"node","nodeIncarnation":"incarnation","token":"rnr_` + strings.Repeat("a", 43) + `"} {}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			_, retry, err := enroll(context.Background(), server.Client(), server.URL, t.TempDir(), "incarnation", i)
			if retry != test.retry || !retry && err == nil {
				t.Fatalf("retry=%v err=%v", retry, err)
			}
			if err != nil && strings.Contains(err.Error(), i.Secret) {
				t.Fatal("response body leaked")
			}
		})
	}
}

func TestEnrollmentWaitCancelsBeforeSetup(t *testing.T) {
	directory := t.TempDir()
	if _, err := Initialize(context.Background(), directory); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusConflict) }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := Wait(ctx, server.URL, directory, t.TempDir(), "incarnation"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancel: %v", err)
	}
}
