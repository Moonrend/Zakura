package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// e2bTestSetup builds a session-scoped E2B computer with a durably approved,
// not-yet-bound runtime. A session is created first because ReserveRuntime
// requires the runtime's scope to be a real chat.
func e2bTestSetup(t *testing.T) (*handler, computers.Runtime) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	store := NewStore(d)
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "computers"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{Title: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := computers.SealCredentials(d.Secret, "tenant", space.ID, "computer", []byte(`{"apiKey":"test-key","template":"base"}`))
	if err != nil {
		t.Fatal(err)
	}
	now := d.Clock().UTC().Format(time.RFC3339Nano)
	if _, err = d.DB.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,secret_ref,capabilities_json,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES('computer','tenant',?,?,?,?,?,?,?,?,?)`, space.ID, "E2B", "e2b", sealed, "[]", 900, 3600, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB.Exec(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at) VALUES('runtime','tenant',?,'computer',?,?,'op1','creating',?,?)`, space.ID, session.ID, "incarnation", now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB.Exec(`INSERT INTO computer_creation_approvals(runtime_id,create_operation_id,approved_by,approved_at) VALUES('runtime','op1','admin',?)`, now); err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store, mcpSessions: map[string]spaceMCPSession{}}
	r := computers.Runtime{ID: "runtime", ComputerID: "computer", TenantID: "tenant", SpaceID: space.ID, SessionScope: session.ID, Incarnation: "incarnation", CreateOperationID: "op1", State: computers.Creating}
	return h, r
}

func e2bListedJSON(id string, metadata map[string]string) string {
	raw, _ := json.Marshal(map[string]any{"sandboxID": id, "metadata": metadata})
	return string(raw)
}

func TestE2BApprovalRequired(t *testing.T) {
	h, r := e2bTestSetup(t)
	if _, err := h.deps.DB.Exec(`DELETE FROM computer_creation_approvals WHERE runtime_id='runtime'`); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"sandboxID":"sbx-1"}`))
	}))
	defer server.Close()
	adapter := e2bComputerProvider{h: h, apiBase: server.URL, httpClient: server.Client()}
	if _, err := adapter.Create(context.Background(), r); !errors.Is(err, computers.ErrTransitionConflict) {
		t.Fatalf("create without approval: %v", err)
	}
	if _, err := adapter.Find(context.Background(), r); !errors.Is(err, computers.ErrTransitionConflict) {
		t.Fatalf("find without approval: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 0 {
		t.Fatalf("unapproved runtime contacted E2B %d times", calls)
	}
}

func TestE2BCreate(t *testing.T) {
	h, r := e2bTestSetup(t)
	var mu sync.Mutex
	var body map[string]any
	apiKey := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost || req.URL.Path != "/sandboxes" {
			http.Error(w, "unexpected", http.StatusBadRequest)
			return
		}
		mu.Lock()
		apiKey = req.Header.Get("X-API-Key")
		_ = json.NewDecoder(req.Body).Decode(&body)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"sandboxID":"sbx-1","envdAccessToken":"tok-1"}`))
	}))
	defer server.Close()
	adapter := e2bComputerProvider{h: h, apiBase: server.URL, httpClient: server.Client()}
	result, err := adapter.Create(context.Background(), r)
	if err != nil || result.ExternalID != "sbx-1" || result.RootPath != "" {
		t.Fatalf("create: %+v %v", result, err)
	}
	plain, err := computers.OpenCredentials(h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, result.AccessTokenEnc)
	if err != nil {
		t.Fatalf("sealed access token could not be opened: %v", err)
	}
	var token struct {
		EnvdAccessToken string `json:"envdAccessToken"`
	}
	if err := json.Unmarshal(plain, &token); err != nil || token.EnvdAccessToken != "tok-1" {
		t.Fatalf("access token = %q %v", string(plain), err)
	}
	mu.Lock()
	defer mu.Unlock()
	if apiKey != "test-key" {
		t.Fatal("request did not authenticate with the E2B API key")
	}
	if body["templateID"] != "base" {
		t.Fatalf("templateID = %v", body["templateID"])
	}
	if timeout, ok := body["timeout"].(float64); !ok || int(timeout) != 3600 {
		t.Fatalf("timeout = %v", body["timeout"])
	}
	metadata, ok := body["metadata"].(map[string]any)
	if !ok || len(metadata) != 6 {
		t.Fatalf("metadata = %v", body["metadata"])
	}
	for key, want := range e2bMetadata(r) {
		if metadata[key] != want {
			t.Fatalf("metadata[%s] = %v want %v", key, metadata[key], want)
		}
	}
}

func TestE2BCreateWithoutAccessToken(t *testing.T) {
	h, r := e2bTestSetup(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"sandboxID":"sbx-1"}`))
	}))
	defer server.Close()
	adapter := e2bComputerProvider{h: h, apiBase: server.URL, httpClient: server.Client()}
	result, err := adapter.Create(context.Background(), r)
	if err != nil || result.ExternalID != "sbx-1" {
		t.Fatalf("create: %+v %v", result, err)
	}
	if result.AccessTokenEnc != "" {
		t.Fatalf("token without a provider-issued value: %q", result.AccessTokenEnc)
	}
}

func TestE2BFind(t *testing.T) {
	for _, mode := range []string{"missing", "single", "mismatch", "ambiguous"} {
		t.Run(mode, func(t *testing.T) {
			h, r := e2bTestSetup(t)
			var mu sync.Mutex
			metadataQuery := ""
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.Method != http.MethodGet || req.URL.Path != "/sandboxes" {
					http.Error(w, "unexpected", http.StatusBadRequest)
					return
				}
				mu.Lock()
				metadataQuery = req.URL.Query().Get("metadata")
				mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				switch mode {
				case "missing":
					_, _ = w.Write([]byte(`[]`))
				case "single":
					_, _ = w.Write([]byte(`[` + e2bListedJSON("sbx-1", e2bMetadata(r)) + `]`))
				case "mismatch":
					wrong := e2bMetadata(r)
					wrong["zakura.runtime"] = "other"
					_, _ = w.Write([]byte(`[` + e2bListedJSON("sbx-1", wrong) + `]`))
				case "ambiguous":
					_, _ = w.Write([]byte(`[` + e2bListedJSON("sbx-1", e2bMetadata(r)) + `,` + e2bListedJSON("sbx-2", e2bMetadata(r)) + `]`))
				}
			}))
			defer server.Close()
			adapter := e2bComputerProvider{h: h, apiBase: server.URL, httpClient: server.Client()}
			result, err := adapter.Find(context.Background(), r)
			id := result.ExternalID
			switch mode {
			case "missing":
				if err != nil || id != "" {
					t.Fatalf("missing: %q %v", id, err)
				}
			case "single":
				if err != nil || id != "sbx-1" {
					t.Fatalf("single: %q %v", id, err)
				}
			case "mismatch":
				if err == nil {
					t.Fatal("accepted a sandbox owned by another runtime")
				}
			case "ambiguous":
				if err == nil || !strings.Contains(err.Error(), "ambiguous") {
					t.Fatalf("ambiguous: %v", err)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if metadataQuery != "zakura.operation=op1" {
				t.Fatalf("metadata query = %q", metadataQuery)
			}
		})
	}
}

func TestE2BCreateHidesResponseBody(t *testing.T) {
	h, r := e2bTestSetup(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"secret-api-key-in-response"}`))
	}))
	defer server.Close()
	adapter := e2bComputerProvider{h: h, apiBase: server.URL, httpClient: server.Client()}
	_, err := adapter.Create(context.Background(), r)
	if err == nil {
		t.Fatal("expected create error")
	}
	if strings.Contains(err.Error(), "secret-api-key-in-response") {
		t.Fatalf("error leaked the response body: %v", err)
	}
}

func TestE2BDestroy(t *testing.T) {
	for _, mode := range []string{"ok", "not-found", "server-error", "missing-id"} {
		t.Run(mode, func(t *testing.T) {
			h, r := e2bTestSetup(t)
			r.ExternalID = "sbx-1"
			if mode == "missing-id" {
				r.ExternalID = ""
			}
			var mu sync.Mutex
			calls := 0
			path := ""
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				mu.Lock()
				calls++
				path = req.URL.Path
				mu.Unlock()
				if req.Method != http.MethodDelete {
					http.Error(w, "unexpected", http.StatusBadRequest)
					return
				}
				switch mode {
				case "not-found":
					w.WriteHeader(http.StatusNotFound)
				case "server-error":
					w.WriteHeader(http.StatusInternalServerError)
				default:
					w.WriteHeader(http.StatusNoContent)
				}
			}))
			defer server.Close()
			adapter := e2bComputerProvider{h: h, apiBase: server.URL, httpClient: server.Client()}
			err := adapter.Destroy(context.Background(), r)
			switch mode {
			case "ok", "not-found":
				if err != nil {
					t.Fatalf("%s: %v", mode, err)
				}
			case "server-error", "missing-id":
				if err == nil {
					t.Fatalf("%s: expected error", mode)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if mode == "missing-id" {
				if calls != 0 {
					t.Fatalf("runtime without a sandbox contacted E2B %d times", calls)
				}
				return
			}
			if calls != 1 || path != "/sandboxes/sbx-1" {
				t.Fatalf("%s: calls=%d path=%q", mode, calls, path)
			}
		})
	}
}

func TestE2BCrossTenantRejected(t *testing.T) {
	h, r := e2bTestSetup(t)
	foreign := r
	foreign.TenantID = "other"
	foreign.ExternalID = "sbx-1"
	var mu sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	adapter := e2bComputerProvider{h: h, apiBase: server.URL, httpClient: server.Client()}
	if _, err := adapter.Create(context.Background(), foreign); err == nil {
		t.Fatal("cross-tenant create was accepted")
	}
	if _, err := adapter.Find(context.Background(), foreign); err == nil {
		t.Fatal("cross-tenant find was accepted")
	}
	if err := adapter.Destroy(context.Background(), foreign); err == nil {
		t.Fatal("cross-tenant destroy was accepted")
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 0 {
		t.Fatalf("cross-tenant runtime contacted E2B %d times", calls)
	}
}
