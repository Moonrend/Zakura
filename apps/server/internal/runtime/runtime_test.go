// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/migrations"
	"github.com/go-chi/chi/v5"
	_ "github.com/mattn/go-sqlite3"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

func testDeps(t *testing.T) *appdeps.Dependencies {
	t.Helper()
	db, e := sql.Open("sqlite3", "file:"+t.Name()+"?mode=memory&cache=shared")
	if e != nil {
		t.Fatal(e)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	if _, e = db.Exec(`PRAGMA foreign_keys=ON`); e != nil {
		t.Fatal(e)
	}
	if e = migrations.Apply(context.Background(), db, "sqlite", appdeps.IdentityRebind); e != nil {
		t.Fatal(e)
	}
	var n atomic.Int64
	gdb, gerr := gorm.Open(sqlite.New(sqlite.Config{Conn: db}), &gorm.Config{NamingStrategy: schema.NamingStrategy{NoLowerCase: true}})
	if gerr != nil {
		t.Fatal(gerr)
	}
	return &appdeps.Dependencies{DB: db, Gorm: gdb, Dialect: "sqlite", Rebind: appdeps.IdentityRebind, Clock: func() time.Time { return time.Now().UTC() }, NewID: func() string { return fmt.Sprintf("id-%06d", n.Add(1)) }, Secret: bytes.Repeat([]byte("s"), 32), PublicURL: "http://example.test"}
}
func seedTenant(t *testing.T, d *appdeps.Dependencies, id string) string {
	t.Helper()
	now := d.Clock().Format(time.RFC3339Nano)
	if _, e := d.DB.Exec(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES(?,?,?,?,?)`, id, id, id, now, now); e != nil {
		t.Fatal(e)
	}
	token := "zk_" + id
	sum := sha256.Sum256([]byte(token))
	if _, e := d.DB.Exec(`INSERT INTO api_keys(id,tenant_id,name,key_prefix,key_hash,created_at) VALUES(?,?,?,?,?,?)`, "key-"+id, id, "test", token[:5], hex.EncodeToString(sum[:]), now); e != nil {
		t.Fatal(e)
	}
	return token
}
func doJSON(t *testing.T, c *http.Client, method, url, token string, body any) (int, map[string]any) {
	t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req, _ := http.NewRequest(method, url, bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, e := c.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}
func doArray(t *testing.T, c *http.Client, method, url, token string) (int, []any) {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, e := c.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	var out []any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestHTTPDurabilityTenantIsolationAndQueue(t *testing.T) {
	d := testDeps(t)
	tok1, tok2 := seedTenant(t, d, "tenant-a"), seedTenant(t, d, "tenant-b")
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("missing decrypted model credential: %q", r.Header.Get("Authorization"))
		}
		entered <- struct{}{}
		<-release
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "answer"}}}})
	}))
	defer provider.Close()
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	client := server.Client()
	code, out := doJSON(t, client, "POST", server.URL+"/api/spaces", tok1, map[string]any{"name": "Primary", "workspaceKind": "local"})
	if code != 201 {
		t.Fatalf("space: %d %#v", code, out)
	}
	space := out["id"].(string)
	code, spaces := doArray(t, client, "GET", server.URL+"/api/spaces", tok2)
	if code != 200 || len(spaces) != 0 {
		t.Fatalf("tenant leak: %d %#v", code, spaces)
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/agents", tok1, map[string]any{"name": "dot", "spaceId": space, "enableMemory": true})
	if code != 201 {
		t.Fatalf("agent: %d %#v", code, out)
	}
	agent := out["id"].(string)
	if out["starting"] != false || out["apiKey"] == nil || out["mcpAgentUrl"] == nil {
		t.Fatalf("agent create contract: %#v", out)
	}
	createdKey := out["apiKey"].(map[string]any)["rawKey"].(string)
	if !strings.HasPrefix(createdKey, "zak_") {
		t.Fatalf("agent key prefix: %q", createdKey)
	}
	code, agentsWithNewKey := doArray(t, client, "GET", server.URL+"/api/agents", createdKey)
	if code != http.StatusOK || len(agentsWithNewKey) != 1 {
		t.Fatalf("new zak_ key authentication: %d %#v", code, agentsWithNewKey)
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/model-upstreams", tok1, map[string]any{"name": "fake", "protocol": "openai", "config": map[string]any{"baseUrl": provider.URL, "apiKey": "test-key"}})
	if code != 201 {
		t.Fatalf("upstream: %d %#v", code, out)
	}
	up := out["id"].(string)
	var storedConfig string
	if e := d.DB.QueryRow(`SELECT config_json FROM model_upstreams WHERE id=?`, up).Scan(&storedConfig); e != nil || strings.Contains(storedConfig, "test-key") {
		t.Fatalf("model credential not encrypted: %v %s", e, storedConfig)
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/model-routes", tok1, map[string]any{"name": "default", "capability": "chat", "upstreamId": up, "model": "fake-model", "isDefault": true})
	if code != 201 {
		t.Fatalf("route: %d %#v", code, out)
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/agents/"+agent+"/cloud/sessions", tok1, map[string]any{"title": "test"})
	if code != 201 {
		t.Fatalf("session: %d %#v", code, out)
	}
	sid := out["id"].(string)
	code, out = doJSON(t, client, "POST", server.URL+"/api/agents/"+agent+"/cloud/sessions/"+sid+"/messages", tok1, map[string]any{"content": "first"})
	if code != 202 || out["runId"] == nil {
		t.Fatalf("first: %d %#v", code, out)
	}
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("provider was not called")
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/agents/"+agent+"/cloud/sessions/"+sid+"/messages", tok1, map[string]any{"content": "second", "followUpMode": "queue"})
	if code != 202 || out["queued"] != true {
		t.Fatalf("queue: %d %#v", code, out)
	}
	release <- struct{}{}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("queued turn did not start")
	}
	release <- struct{}{}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		code, out = doJSON(t, client, "GET", server.URL+"/api/agents/"+agent+"/cloud/sessions/"+sid, tok1, nil)
		if code == 200 {
			session := out["session"].(map[string]any)
			if session["activeRunId"] == nil && len(out["queue"].([]any)) == 0 {
				events := out["events"].([]any)
				if len(events) < 8 {
					t.Fatalf("missing event history: %#v", events)
				}
				return
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("run did not settle: %#v", out)
}

func TestRunCancellationAndPathJail(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, e := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if e != nil {
		t.Fatal(e)
	}
	agent, e := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if e != nil {
		t.Fatal(e)
	}
	sess, e := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	if e != nil {
		t.Fatal(e)
	}
	run, e := store.StartRun(context.Background(), "tenant", agent.ID, sess.ID, "hello", nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	cancelled, e := store.CancelRun(context.Background(), "tenant", agent.ID, sess.ID)
	if e != nil {
		t.Fatal(e)
	}
	if cancelled.ID != run.ID || cancelled.Status != "cancelled" {
		t.Fatalf("bad cancellation %#v", cancelled)
	}
	root := t.TempDir()
	outside := t.TempDir()
	if e = os.Symlink(outside, filepath.Join(root, "escape")); e != nil {
		t.Skipf("symlink unavailable: %v", e)
	}
	fs := workspaceFS{root: root}
	if _, e = fs.resolve("../secret", false); e == nil {
		t.Fatal("accepted parent traversal")
	}
	if _, e = fs.resolve("escape/secret", false); e == nil {
		t.Fatal("accepted symlink traversal")
	}
}

func TestRunnerEnrollmentAndFileShare(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	t.Setenv("ZAKURA_WORKSPACE_ROOT", t.TempDir())
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	client := server.Client()
	code, out := doJSON(t, client, "POST", server.URL+"/api/spaces", token, map[string]any{"name": "Files", "workspaceKind": "local"})
	if code != 201 {
		t.Fatalf("space: %d %#v", code, out)
	}
	space := out["id"].(string)
	code, out = doJSON(t, client, "POST", server.URL+"/api/agents", token, map[string]any{"name": "Files Agent", "spaceId": space})
	if code != 201 {
		t.Fatalf("agent: %d %#v", code, out)
	}
	agent := out["id"].(string)
	code, out = doJSON(t, client, "POST", server.URL+"/api/runtime-nodes", token, map[string]any{"name": "runner", "kind": "computer", "storageRoot": t.TempDir()})
	if code != 201 {
		t.Fatalf("node: %d %#v", code, out)
	}
	node := out["node"].(map[string]any)["id"].(string)
	runnerToken := out["token"].(string)
	code, out = doJSON(t, client, "POST", server.URL+"/api/runtime-nodes/register", "", map[string]any{"id": node, "token": runnerToken, "endpoint": "http://127.0.0.1:9000", "agentVersion": "test"})
	if code != 200 {
		t.Fatalf("register: %d %#v", code, out)
	}
	code, out = doJSON(t, client, "GET", server.URL+"/api/runtime-nodes", token, nil)
	if code != 200 || out["canUseLocalRunner"] == nil {
		t.Fatalf("runtime nodes contract: %d %#v", code, out)
	}
	nodes := out["nodes"].([]any)
	if len(nodes) != 1 || nodes[0].(map[string]any)["access"] != "owned" {
		t.Fatalf("runtime node access contract: %#v", out)
	}
	code, out = doJSON(t, client, "GET", server.URL+"/api/mcp/policies/bootstrap", token, nil)
	if code != 200 || out["policies"] == nil || out["apiKeys"] == nil || out["instances"] == nil {
		t.Fatalf("mcp bootstrap contract: %d %#v", code, out)
	}
	code, out = doJSON(t, client, "GET", server.URL+"/api/platform-services", token, nil)
	if code != 200 || out["services"] == nil || out["catalog"] == nil || out["canManage"] == nil {
		t.Fatalf("platform services contract: %d %#v", code, out)
	}
	code, out = doJSON(t, client, "GET", server.URL+"/api/settings/network/overview", token, nil)
	if code != 200 {
		t.Fatalf("network overview: %d %#v", code, out)
	}
	for _, key := range []string{"mesh", "defaultProvider", "exposureEnabled", "runners", "activeExposures", "exposuresToday", "auditEventsToday", "hostJoinsTailscale"} {
		if _, ok := out[key]; !ok {
			t.Fatalf("network overview missing %s: %#v", key, out)
		}
	}
	code, out = doJSON(t, client, "PUT", server.URL+"/api/settings/network/security", token, map[string]any{"enabled": true, "exposureEnabled": true, "defaultTtlMinutes": 30, "maxTtlMinutes": 120, "maxActivePerAgent": 2, "maxActivePerTenant": 10, "deniedPorts": []int{22}, "auditRetentionDays": 30})
	if code != 200 {
		t.Fatalf("network policy upsert: %d %#v", code, out)
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/agents/"+agent+"/fs/write", token, map[string]any{"path": "report.txt", "content": "durable report"})
	if code != 200 {
		t.Fatalf("write: %d %#v", code, out)
	}
	revision, _ := out["revision"].(string)
	if revision == "" {
		t.Fatalf("write revision missing: %#v", out)
	}
	code, out = doJSON(t, client, "GET", server.URL+"/api/agents/"+agent+"/fs/list?path=/", token, nil)
	if code != 200 {
		t.Fatalf("fs list: %d %#v", code, out)
	}
	entries := out["entries"].([]any)
	entry := entries[0].(map[string]any)
	for _, key := range []string{"name", "path", "size", "mode", "modTime", "isDir"} {
		if _, ok := entry[key]; !ok {
			t.Fatalf("fs entry missing %s: %#v", key, entry)
		}
	}
	code, out = doJSON(t, client, "GET", server.URL+"/api/agents/"+agent+"/fs/read?path=report.txt", token, nil)
	if code != 200 || out["revision"] != revision {
		t.Fatalf("fs read contract: %d %#v", code, out)
	}
	code, _ = doJSON(t, client, "POST", server.URL+"/api/agents/"+agent+"/fs/write", token, map[string]any{"path": "report.txt", "content": "lost update", "expectedRevision": "bad"})
	if code != 409 {
		t.Fatalf("expected revision conflict, got %d", code)
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/agents/"+agent+"/fs/share", token, map[string]any{"path": "report.txt", "ttlMinutes": 5})
	if code != 201 {
		t.Fatalf("share: %d %#v", code, out)
	}
	shareURL := out["share"].(map[string]any)["url"].(string)
	shareURL = strings.Replace(shareURL, d.PublicURL, server.URL, 1)
	resp, e := client.Get(shareURL)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != "durable report" {
		t.Fatalf("download: %d %q", resp.StatusCode, body)
	}
}
