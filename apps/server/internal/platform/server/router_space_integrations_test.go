package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/config"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	_ "github.com/mattn/go-sqlite3"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

func TestRouterZeroAgentConnectionUsesRegisteredRuntimeLifecycle(t *testing.T) {
	db, e := sql.Open("sqlite3", "file:"+t.Name()+"?mode=memory&cache=shared")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if e = migrations.Apply(context.Background(), db, "sqlite", appdeps.IdentityRebind); e != nil {
		t.Fatal(e)
	}
	gdb, e := gorm.Open(sqlite.New(sqlite.Config{Conn: db}), &gorm.Config{NamingStrategy: schema.NamingStrategy{NoLowerCase: true}})
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var sequence atomic.Int32
	d := &appdeps.Dependencies{Context: ctx, DB: db, Gorm: gdb, Dialect: "sqlite", Rebind: appdeps.IdentityRebind, Clock: time.Now, NewID: func() string {
		return "router-" + time.Now().Format("150405.000000000") + string(rune(sequence.Add(1)+64))
	}, Secret: bytes.Repeat([]byte("k"), 32), PublicURL: "http://local.test"}
	now := time.Now().Format(time.RFC3339Nano)
	if _, e = db.Exec(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES('owner','owner','Owner',?,?)`, now, now); e != nil {
		t.Fatal(e)
	}
	token := "zk_router"
	sum := sha256.Sum256([]byte(token))
	if _, e = db.Exec(`INSERT INTO api_keys(id,tenant_id,name,key_prefix,key_hash,created_at) VALUES('owner-key','owner','owner','zk_router',?,?)`, hex.EncodeToString(sum[:]), now); e != nil {
		t.Fatal(e)
	}
	var initialized atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		result := map[string]any{}
		if req.Method == "initialize" {
			initialized.Add(1)
			result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}))
	defer provider.Close()
	server := httptest.NewServer(Router(config.Config{WebURL: "http://local.test"}, d, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer server.Close()
	request := func(method, path string, body any) (int, map[string]any) {
		t.Helper()
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req, _ := http.NewRequest(method, server.URL+path, bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		res, e := server.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	code, out := request("POST", "/api/spaces", map[string]any{"name": "No agents"})
	if code != 201 {
		t.Fatal(code, out)
	}
	space := out["id"].(string)
	code, out = request("POST", "/api/connections/install", map[string]any{"spaceId": space, "source": provider.URL, "kind": "mcp-http", "name": "Local"})
	if code != 201 {
		t.Fatal(code, out)
	}
	result := out["result"].(map[string]any)
	id := result["id"].(string)
	instance := result["instanceId"].(string)
	code, out = request("POST", "/api/connections/"+id+"/start", nil)
	if code != 200 || initialized.Load() != 1 {
		t.Fatalf("runtime handler lifecycle not wired: %d %#v initializes=%d", code, out, initialized.Load())
	}
	var status string
	_ = db.QueryRow(`SELECT status FROM component_instances WHERE id=?`, instance).Scan(&status)
	if status != "running" {
		t.Fatal(status)
	}
	code, out = request("POST", "/api/connections/"+id+"/stop", nil)
	if code != 200 {
		t.Fatal(code, out)
	}
	_ = db.QueryRow(`SELECT status FROM component_instances WHERE id=?`, instance).Scan(&status)
	if status != "stopped" {
		t.Fatal(status)
	}
	code, out = request("DELETE", "/api/connections/"+id, nil)
	if code != 200 {
		t.Fatal(code, out)
	}
	var count int
	_ = db.QueryRow(`SELECT COUNT(*) FROM component_instances WHERE id=?`, instance).Scan(&count)
	if count != 0 {
		t.Fatal("delete hook not wired")
	}
	if strings.Contains(id, "<nil>") {
		t.Fatal(id)
	}
}
