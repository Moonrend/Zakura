package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/config"
	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/pgtest"
	platformserver "github.com/Moonrend/Zakura/apps/server/internal/platform/server"
)

// TestPostgresCoreWorkflow is deliberately opt-in locally and mandatory in CI.
// FreshURL supplies an empty private database or schema; never reset public.
func TestPostgresCoreWorkflow(t *testing.T) {
	dsn := pgtest.FreshURL(t, pgtest.URL(t), "integration_core")
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	conn, err := platformdb.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	if conn.Dialect != "postgres" {
		t.Fatalf("expected postgres dialect, got %q", conn.Dialect)
	}
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("apply PostgreSQL migrations: %v", err)
	}
	gormDB, err := conn.Gorm()
	if err != nil {
		t.Fatalf("open gorm: %v", err)
	}

	var seq int
	cfg := config.Config{WebURL: "http://web.test", PublicURL: "http://api.test", Edition: "saas", MultiTenant: true}
	deps := &appdeps.Dependencies{
		DB: conn.DB, Gorm: gormDB, Dialect: conn.Dialect, Rebind: conn.Rebind,
		Clock:  func() time.Time { return time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC) },
		NewID:  func() string { seq++; return fmt.Sprintf("pg-%023d", seq) },
		Secret: bytes.Repeat([]byte("p"), 32), PublicURL: cfg.PublicURL,
		WebURL: cfg.WebURL, Edition: cfg.Edition, MultiTenant: cfg.MultiTenant,
		VerifyDomain: func(context.Context, string, string) error { return nil },
	}
	srv := httptest.NewServer(platformserver.Router(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer srv.Close()

	status, setup := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/setup", "", map[string]any{
		"adminEmail": "postgres@example.test", "adminPassword": "postgres-integration-password",
		"adminName": "Postgres Admin", "tenantName": "Postgres Tenant",
	})
	if status != http.StatusOK {
		t.Fatalf("setup: %d %#v", status, setup)
	}
	session, _ := setup["session"].(string)
	if session == "" {
		t.Fatalf("setup did not return a session: %#v", setup)
	}
	status, bootstrap := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/tenant/onboarding/bootstrap", session, map[string]any{})
	if status != http.StatusOK || bootstrap["agent"] == nil {
		t.Fatalf("bootstrap: %d %#v", status, bootstrap)
	}
	status, login := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/auth/login", "", map[string]any{
		"email": "postgres@example.test", "password": "postgres-integration-password",
	})
	if status != http.StatusOK || login["session"] == nil {
		t.Fatalf("login: %d %#v", status, login)
	}
	status, agents := arrayCall(t, srv.Client(), http.MethodGet, srv.URL+"/api/agents", login["session"].(string))
	if status != http.StatusOK || len(agents) != 1 {
		t.Fatalf("agents: %d %#v", status, agents)
	}

	assertPostgresMigrations(t, ctx, conn)
	var users, tenants, agentCount int
	for query, target := range map[string]*int{
		`SELECT COUNT(*) FROM users`:   &users,
		`SELECT COUNT(*) FROM tenants`: &tenants,
		`SELECT COUNT(*) FROM agents`:  &agentCount,
	} {
		if err = conn.DB.QueryRowContext(ctx, query).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	if users != 1 || tenants != 1 || agentCount != 1 {
		t.Fatalf("unexpected durable rows: users=%d tenants=%d agents=%d", users, tenants, agentCount)
	}

	// Runtime store flow (converted SQL→GORM surface) end-to-end on PostgreSQL.
	agentID := agents[0].(map[string]any)["id"].(string)
	spaceID, _ := agents[0].(map[string]any)["spaceId"].(string)
	if spaceID == "" {
		t.Fatalf("Agent is missing its canonical Space: %#v", agents[0])
	}
	status, created := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/agents/"+agentID+"/cloud/sessions", session, map[string]any{"title": "pg e2e session"})
	if status != http.StatusCreated || created["id"] == nil {
		t.Fatalf("create session: %d %#v", status, created)
	}
	sessionID := created["id"].(string)
	status, listed := jsonCall(t, srv.Client(), http.MethodGet, srv.URL+"/api/agents/"+agentID+"/cloud/sessions", session, nil)
	if status != http.StatusOK {
		t.Fatalf("list sessions: %d %#v", status, listed)
	}
	if sessions, ok := listed["sessions"].([]any); !ok || len(sessions) != 1 {
		t.Fatalf("list sessions payload: %#v", listed)
	}
	status, fetched := jsonCall(t, srv.Client(), http.MethodGet, srv.URL+"/api/agents/"+agentID+"/cloud/sessions/"+sessionID, session, nil)
	if status != http.StatusOK {
		t.Fatalf("get session: %d %#v", status, fetched)
	}
	if sess, ok := fetched["session"].(map[string]any); !ok || sess["title"] != "pg e2e session" || sess["status"] != "active" || sess["createdAt"] == "0001-01-01T00:00:00Z" {
		t.Fatalf("get session payload: %#v", fetched)
	}
	status, patched := jsonCall(t, srv.Client(), http.MethodPatch, srv.URL+"/api/agents/"+agentID+"/cloud/sessions/"+sessionID, session, map[string]any{"title": "pg e2e session v2"})
	if status != http.StatusOK {
		t.Fatalf("patch session: %d %#v", status, patched)
	}
	if patched["title"] != "pg e2e session v2" {
		t.Fatalf("patch session payload: %#v", patched)
	}
	var storedTitle string
	if err = conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT title FROM cloud_agent_sessions WHERE id=?`), sessionID).Scan(&storedTitle); err != nil {
		t.Fatalf("session row: %v", err)
	}
	if storedTitle != "pg e2e session v2" {
		t.Fatalf("session title in PG: %q", storedTitle)
	}

	// A real loopback MCP upstream exercises the same HTTP initialization and
	// Space-scoped capability/call path as production, without external services.
	var mcpInitializations, mcpCalls atomic.Int64
	mcpUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&request) != nil {
			http.Error(w, "invalid MCP request", http.StatusBadRequest)
			return
		}
		var result any
		switch request.Method {
		case "initialize":
			mcpInitializations.Add(1)
			result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}}}
		case "tools/list":
			result = map[string]any{"tools": []map[string]any{{"name": "echo", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"text": map[string]any{"type": "string"}}}}}}
		case "resources/list":
			result = map[string]any{"resources": []any{}}
		case "resources/templates/list":
			result = map[string]any{"resourceTemplates": []any{}}
		case "prompts/list":
			result = map[string]any{"prompts": []any{}}
		case "tools/call":
			if request.Params["name"] != "echo" {
				http.Error(w, "unexpected tool", http.StatusBadRequest)
				return
			}
			mcpCalls.Add(1)
			result = map[string]any{"content": []map[string]any{{"type": "text", "text": "pg loopback echo"}}}
		default:
			http.Error(w, "unexpected MCP method", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}))
	defer mcpUpstream.Close()
	status, instance := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/instances", session, map[string]any{
		"type": "mcp", "name": "pg-e2e-mcp", "providerId": "pg-e2e-mcp", "spaceId": spaceID,
		"config": map[string]any{"url": mcpUpstream.URL, "transport": "http"},
	})
	if status != http.StatusCreated || instance["id"] == nil || instance["status"] != "stopped" {
		t.Fatalf("create Space MCP instance: %d %#v", status, instance)
	}
	instanceID := instance["id"].(string)
	var canonicalOwner string
	var spaceOwned bool
	if err = conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT config_json::jsonb->>'ownerSpaceId',agent_id IS NULL FROM component_instances WHERE id=?`), instanceID).Scan(&canonicalOwner, &spaceOwned); err != nil || canonicalOwner != spaceID || !spaceOwned {
		t.Fatalf("canonical MCP ownership: owner=%q spaceOwned=%v err=%v", canonicalOwner, spaceOwned, err)
	}
	var bindings int
	if err = conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT COUNT(*) FROM agent_bindings WHERE instance_id=? AND space_id=? AND agent_id IS NULL`), instanceID, spaceID).Scan(&bindings); err != nil || bindings != 1 {
		t.Fatalf("explicit Space MCP binding: count=%d err=%v", bindings, err)
	}
	status, instances := arrayCall(t, srv.Client(), http.MethodGet, srv.URL+"/api/instances", session)
	if status != http.StatusOK || len(instances) != 1 || instances[0].(map[string]any)["status"] != "stopped" || mcpInitializations.Load() != 0 {
		t.Fatalf("list stopped instances: %d %#v initializations=%d", status, instances, mcpInitializations.Load())
	}
	status, startedMCP := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/instances/"+instanceID+"/start", session, map[string]any{})
	if status != http.StatusOK || startedMCP["status"] != "running" || mcpInitializations.Load() != 1 {
		t.Fatalf("start MCP requires real upstream initialization: %d %#v initializations=%d", status, startedMCP, mcpInitializations.Load())
	}
	status, capabilities := jsonCall(t, srv.Client(), http.MethodGet, srv.URL+"/api/spaces/"+spaceID+"/mcp/capabilities", session, nil)
	tools, _ := capabilities["tools"].([]any)
	if status != http.StatusOK || len(tools) != 1 || tools[0].(map[string]any)["instanceId"] != instanceID {
		t.Fatalf("Space MCP capabilities: %d %#v", status, capabilities)
	}
	status, called := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/mcp/call", session, map[string]any{"spaceId": spaceID, "instanceId": instanceID, "toolName": "echo", "arguments": map[string]any{"text": "hello"}})
	if status != http.StatusOK || called["ok"] != true || mcpCalls.Load() != 1 || !strings.Contains(fmt.Sprint(called["result"]), "pg loopback echo") {
		t.Fatalf("Space MCP tool call: %d %#v calls=%d", status, called, mcpCalls.Load())
	}
	status, _ = jsonCall(t, srv.Client(), http.MethodPatch, srv.URL+"/api/instances/"+instanceID, session, map[string]any{"name": "pg-e2e-mcp-v2"})
	if status != http.StatusOK {
		t.Fatalf("patch instance: %d", status)
	}
	status, stoppedMCP := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/instances/"+instanceID+"/stop", session, map[string]any{})
	if status != http.StatusOK || stoppedMCP["ok"] != true {
		t.Fatalf("stop MCP instance: %d %#v", status, stoppedMCP)
	}
	var stoppedStatus string
	if err = conn.DB.QueryRowContext(ctx, conn.Rebind(`SELECT status FROM component_instances WHERE id=?`), instanceID).Scan(&stoppedStatus); err != nil || stoppedStatus != "stopped" {
		t.Fatalf("persisted stopped MCP: status=%q err=%v", stoppedStatus, err)
	}
	status, _ = jsonCall(t, srv.Client(), http.MethodDelete, srv.URL+"/api/instances/"+instanceID, session, nil)
	if status != http.StatusOK {
		t.Fatalf("delete instance: %d", status)
	}

	status, memory := jsonCall(t, srv.Client(), http.MethodPost, srv.URL+"/api/agents/"+agentID+"/memory/items", session, map[string]any{"content": "pg e2e memory item"})
	if status != http.StatusCreated || memory["id"] == nil {
		t.Fatalf("create memory: %d %#v", status, memory)
	}
	memID := memory["id"].(string)
	status, memList := jsonCall(t, srv.Client(), http.MethodGet, srv.URL+"/api/agents/"+agentID+"/memory/items", session, nil)
	if status != http.StatusOK {
		t.Fatalf("list memory: %d %#v", status, memList)
	}
	if items, ok := memList["items"].([]any); !ok || len(items) != 1 {
		t.Fatalf("list memory payload: %#v", memList)
	}
	status, _ = jsonCall(t, srv.Client(), http.MethodDelete, srv.URL+"/api/agents/"+agentID+"/memory/items/"+memID, session, nil)
	if status != http.StatusOK {
		t.Fatalf("delete memory: %d", status)
	}

	status, _ = jsonCall(t, srv.Client(), http.MethodDelete, srv.URL+"/api/agents/"+agentID+"/cloud/sessions/"+sessionID, session, nil)
	if status != http.StatusOK {
		t.Fatalf("delete session: %d", status)
	}
}

func TestPostgresLegacyCompatibility(t *testing.T) {
	dsn := pgtest.FreshURL(t, pgtest.URL(t), "integration_legacy")
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	conn, err := platformdb.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	legacy := []string{
		`CREATE TABLE platform_meta(id TEXT PRIMARY KEY DEFAULT 'platform',setup_completed BOOLEAN NOT NULL DEFAULT FALSE,mode TEXT NOT NULL DEFAULT 'single-tenant',version TEXT NOT NULL DEFAULT '0.1.0',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
		`INSERT INTO platform_meta(id,setup_completed) VALUES('platform',TRUE)`,
		`CREATE TABLE component_instances(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,provider_id TEXT NOT NULL,name TEXT NOT NULL,slug TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'stopped',config_enc TEXT NOT NULL,endpoint_url TEXT,health_status TEXT NOT NULL DEFAULT 'unknown',last_error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
		`CREATE TABLE provider_catalog(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',version TEXT NOT NULL DEFAULT '1.0.0',capabilities TEXT NOT NULL DEFAULT '[]',config_schema TEXT NOT NULL DEFAULT '{}',category TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
	}
	for _, statement := range legacy {
		if _, err = conn.DB.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("upgrade pinned PostgreSQL schema: %v", err)
	}
	assertPostgresMigrations(t, ctx, conn)
	var setup bool
	if err = conn.DB.QueryRowContext(ctx, `SELECT setup_completed FROM platform_meta WHERE singleton=1`).Scan(&setup); err != nil || !setup {
		t.Fatalf("legacy platform row was not adopted: setup=%v err=%v", setup, err)
	}
	for table, columns := range map[string][]string{
		"component_instances": {"component_type", "component_ref", "config_json", "secret_json"},
		"provider_catalog":    {"kind", "manifest_json", "enabled"},
	} {
		for _, column := range columns {
			var count int
			if err = conn.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=$2`, table, column).Scan(&count); err != nil || count != 1 {
				t.Fatalf("legacy compatibility column %s.%s: count=%d err=%v", table, column, count, err)
			}
		}
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO tenants(id,slug,name,is_default,onboarding_completed,onboarding_steps,created_at,updated_at) VALUES('legacy-tenant','legacy-tenant','Legacy Tenant',FALSE,FALSE,'{}',NOW(),NOW())`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,created_at,updated_at) VALUES('canonical-component','legacy-tenant',NULL,'mcp','example','Example','{}','{}','ready',NOW(),NOW())`); err != nil {
		t.Fatalf("canonical component write after PostgreSQL legacy upgrade: %v", err)
	}
}

// TestPostgresPinnedDrizzleUpgrade executes every pinned TypeScript migration
// through a real PostgreSQL wire connection before applying the native additive
// migration. This catches type/DDL compatibility that SQLite and PGlite cannot
// prove. This archival check is separate from the required native suite: supply
// ZAKURA_REFERENCE_DRIZZLE_DIR from an immutable preserved checkout to select it.
func TestPostgresPinnedDrizzleUpgrade(t *testing.T) {
	dsnEnv := pgtest.URL(t)
	drizzleDir := os.Getenv("ZAKURA_REFERENCE_DRIZZLE_DIR")
	if drizzleDir == "" {
		pgtest.Unavailable(t, "archival PostgreSQL upgrade unverified: ZAKURA_REFERENCE_DRIZZLE_DIR is not set")
	}
	dsn := pgtest.FreshURL(t, dsnEnv, "integration_drizzle")
	files, err := filepath.Glob(filepath.Join(drizzleDir, "*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("pinned Drizzle migrations unavailable at %q: %v", drizzleDir, err)
	}
	sort.Strings(files)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	conn, err := platformdb.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	statements := 0
	for _, file := range files {
		raw, readErr := os.ReadFile(file)
		if readErr != nil {
			t.Fatal(readErr)
		}
		for _, statement := range strings.Split(string(raw), "--> statement-breakpoint") {
			statement = strings.TrimSpace(statement)
			if statement == "" {
				continue
			}
			if _, err = conn.DB.ExecContext(ctx, statement); err != nil {
				t.Fatalf("pinned migration %s statement %d: %v", filepath.Base(file), statements+1, err)
			}
			statements++
		}
	}
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("native migration over complete pinned schema: %v", err)
	}
	assertPostgresMigrations(t, ctx, conn)
	var tables, columns int
	if err = conn.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=current_schema()`).Scan(&tables); err != nil {
		t.Fatal(err)
	}
	if err = conn.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=current_schema()`).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if statements < 500 || tables < 84 || columns < 998 {
		t.Fatalf("incomplete pinned upgrade: statements=%d tables=%d columns=%d", statements, tables, columns)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO tenants(id,slug,name,is_default,onboarding_completed,onboarding_steps,created_at,updated_at) VALUES('go-write-tenant','go-write-tenant','Go Write Tenant',FALSE,FALSE,'{}',NOW(),NOW())`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,created_at,updated_at) VALUES('go-write-component','go-write-tenant',NULL,'mcp','example','Example','{}','{}','ready',NOW(),NOW())`); err != nil {
		t.Fatalf("canonical component write on pinned schema: %v", err)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO tenant_domains(id,tenant_id,domain,join_mode,verification_token,created_at,updated_at) VALUES('go-write-domain','go-write-tenant','go-write.example','invite_only','token',NOW(),NOW())`); err != nil {
		t.Fatalf("canonical tenant-domain write on pinned schema: %v", err)
	}
	// The legacy schema uses TIMESTAMPTZ while a few additive compatibility
	// columns are TEXT. Prepare the portable casts used by the live handler.
	if _, err = conn.DB.ExecContext(ctx, `PREPARE session_inventory(text) AS SELECT id,COALESCE(ip,''),COALESCE(user_agent,''),COALESCE(CAST(last_seen_at AS TEXT),CAST(created_at AS TEXT)),CAST(created_at AS TEXT),CAST(expires_at AS TEXT) FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`); err != nil {
		t.Fatalf("legacy session inventory SQL: %v", err)
	}
}

func assertPostgresMigrations(t *testing.T, ctx context.Context, conn *platformdb.Connection) {
	t.Helper()
	reference, err := platformdb.Open(ctx, "file:"+filepath.Join(t.TempDir(), "migration-ledger.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer reference.DB.Close()
	if err := migrations.Apply(ctx, reference.DB, reference.Dialect, reference.Rebind); err != nil {
		t.Fatalf("apply reference migration registry: %v", err)
	}
	pgtest.AssertMigrationLedger(t, ctx, conn.DB, reference.DB)
	if err := migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatalf("reapply PostgreSQL migrations: %v", err)
	}
	pgtest.AssertMigrationLedger(t, ctx, conn.DB, reference.DB)
}

// Keep imports used even if this test is compiled in isolation by tooling that
// prunes sibling test files containing jsonCall.
var _ = json.NewDecoder
