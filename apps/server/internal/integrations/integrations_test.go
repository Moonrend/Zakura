// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	_ "github.com/mattn/go-sqlite3"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

func setup(t *testing.T) (*appdeps.Dependencies, string, string) {
	t.Helper()
	db, e := sql.Open("sqlite3", "file:"+t.Name()+"?mode=memory&cache=shared")
	if e != nil {
		t.Fatal(e)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	_, _ = db.Exec(`PRAGMA foreign_keys=ON`)
	if e = migrations.Apply(context.Background(), db, "sqlite", appdeps.IdentityRebind); e != nil {
		t.Fatal(e)
	}
	gdb, e := gorm.Open(sqlite.New(sqlite.Config{Conn: db}), &gorm.Config{NamingStrategy: schema.NamingStrategy{NoLowerCase: true}})
	if e != nil {
		t.Fatal(e)
	}
	var seq atomic.Int64
	d := &appdeps.Dependencies{DB: db, Gorm: gdb, Dialect: "sqlite", Rebind: appdeps.IdentityRebind, Clock: func() time.Time { return time.Now().UTC() }, NewID: func() string { return fmt.Sprintf("i-%06d", seq.Add(1)) }, Secret: bytes.Repeat([]byte("k"), 32), PublicURL: "http://example.test"}
	for _, tenant := range []string{"ta", "tb"} {
		now := d.Clock().Format(time.RFC3339Nano)
		if _, e = db.Exec(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES(?,?,?,?,?)`, tenant, tenant, tenant, now, now); e != nil {
			t.Fatal(e)
		}
		token := "zk_" + tenant
		sum := sha256.Sum256([]byte(token))
		if _, e = db.Exec(`INSERT INTO api_keys(id,tenant_id,name,key_prefix,key_hash,created_at) VALUES(?,?,?,?,?,?)`, `key-`+tenant, tenant, "test", token, hex.EncodeToString(sum[:]), now); e != nil {
			t.Fatal(e)
		}
		space, agent := "space-"+tenant, "agent-"+tenant
		if _, e = db.Exec(`INSERT INTO spaces(id,tenant_id,name,slug,description,workspace_kind,workspace_status,config_json,created_at,updated_at) VALUES(?,?,?,?,?,'local','ready','{}',?,?)`, space, tenant, "space", space, "", now, now); e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(`INSERT INTO agents(id,tenant_id,space_id,name,slug,description,enable_memory,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,true,'{}',?,?)`, agent, tenant, space, "agent", agent, "", now, now); e != nil {
			t.Fatal(e)
		}
	}
	return d, "zk_ta", "zk_tb"
}
func request(t *testing.T, c *http.Client, method, url, token string, v any) (int, map[string]any) {
	t.Helper()
	var b []byte
	if v != nil {
		b, _ = json.Marshal(v)
	}
	req, _ := http.NewRequest(method, url, bytes.NewReader(b))
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

func TestConnectorEncryptionRetryIsolationAndWebhookIdempotency(t *testing.T) {
	d, tokA, tokB := setup(t)
	var attempts atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret-token" {
			t.Errorf("missing provider auth: %q", r.Header.Get("Authorization"))
		}
		if attempts.Add(1) == 1 {
			w.WriteHeader(429)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	}))
	defer provider.Close()
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	client := server.Client()
	code, out := request(t, client, "PUT", server.URL+"/api/connectors/profiles/slack-main", tokA, map[string]any{"label": "Slack", "kind": "oauth2", "config": map[string]any{"baseUrl": provider.URL, "accessToken": "secret-token", "webhookSecret": "hook-secret"}})
	if code != 200 {
		t.Fatalf("profile %d %#v", code, out)
	}
	code, out = request(t, client, "POST", server.URL+"/api/connectors/slack/install", tokA, map[string]any{"agentId": "agent-ta", "profileKey": "slack-main"})
	if code != 201 {
		t.Fatalf("install %d %#v", code, out)
	}
	code, out = request(t, client, "POST", server.URL+"/api/connectors/slack/send", tokA, map[string]any{"agentId": "agent-ta", "action": "chat.postMessage", "payload": map[string]any{"channel": "C1", "text": "hello"}})
	if code != 200 || attempts.Load() != 2 {
		t.Fatalf("send retry %d attempts=%d %#v", code, attempts.Load(), out)
	}
	code, out = request(t, client, "GET", server.URL+"/api/connectors/profiles", tokA, nil)
	serialized, _ := json.Marshal(out)
	if code != 200 || strings.Contains(string(serialized), "secret-token") {
		t.Fatalf("credential leak: %d %s", code, serialized)
	}
	code, out = request(t, client, "GET", server.URL+"/api/agents/agent-tb/connectors", tokB, nil)
	if code != 200 || len(out["connectors"].([]any)) != 0 {
		t.Fatalf("tenant leak: %d %#v", code, out)
	}
	body := []byte(`{"text":"from slack"}`)
	ts := "1700000000"
	mac := hmac.New(sha256.New, []byte("hook-secret"))
	mac.Write([]byte("v0:" + ts + ":" + string(body)))
	sig := "v0=" + hex.EncodeToString(mac.Sum(nil))
	for i := 0; i < 2; i++ {
		req, _ := http.NewRequest("POST", server.URL+"/api/connectors/slack/events?tenantId=ta&agentId=agent-ta", bytes.NewReader(body))
		req.Header.Set("X-Slack-Request-Timestamp", ts)
		req.Header.Set("X-Slack-Signature", sig)
		resp, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode != 202 {
			t.Fatalf("webhook %d", resp.StatusCode)
		}
	}
	var count int
	if e := d.DB.QueryRow(`SELECT COUNT(*) FROM channel_events WHERE tenant_id='ta' AND provider='slack'`).Scan(&count); e != nil || count != 1 {
		t.Fatalf("idempotency count=%d err=%v", count, e)
	}
	var enc string
	if e := d.DB.QueryRow(`SELECT config_enc FROM connector_auth_profiles WHERE scope_key='ta' AND profile_key='slack-main'`).Scan(&enc); e != nil || strings.Contains(enc, "secret-token") {
		t.Fatalf("plaintext credential at rest")
	}
}

func TestIntegrationRouteGroupsAreRegistered(t *testing.T) {
	d, _, _ := setup(t)
	r := chi.NewRouter()
	RegisterRoutes(r, d)
	got := map[string]bool{}
	if e := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		got[method+" "+route] = true
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	expected := []string{"POST /api/connections/install", "POST /api/connections/sources", "DELETE /api/connections/sources/{id}", "POST /api/connections/{id}/start", "POST /api/connections/{id}/stop", "GET /api/providers", "GET /api/remote-channels", "POST /api/remote-channels", "PATCH /api/remote-channels/{id}", "POST /api/email/inbound/{tenantId}", "POST /api/email/inbound/{tenantId}/{connectorId}"}
	for _, key := range expected {
		if !got[key] {
			t.Errorf("missing route %s", key)
		}
	}
}

func TestProviderCatalogUsesMigratedSchema(t *testing.T) {
	d, token, _ := setup(t)
	now := d.Clock()
	_, e := d.DB.Exec(`INSERT INTO provider_catalog(id,name,kind,manifest_json,enabled,updated_at) VALUES('custom','Custom','mcp','{"description":"Custom provider","capabilities":["tools"]}',true,?)`, now)
	if e != nil {
		t.Fatal(e)
	}
	r := chi.NewRouter()
	RegisterRoutes(r, d)
	srv := httptest.NewServer(r)
	defer srv.Close()
	code, out := request(t, srv.Client(), "GET", srv.URL+"/api/providers", token, nil)
	if code != 200 {
		t.Fatalf("providers: %d %#v", code, out)
	}
	raw, _ := json.Marshal(out)
	if !strings.Contains(string(raw), "Custom provider") {
		t.Fatalf("custom provider missing: %s", raw)
	}
}

func TestConnectorAndRemoteChannelContracts(t *testing.T) {
	d, token, _ := setup(t)
	r := chi.NewRouter()
	RegisterRoutes(r, d)
	srv := httptest.NewServer(r)
	defer srv.Close()
	code, out := request(t, srv.Client(), "GET", srv.URL+"/api/connectors", token, nil)
	if code != 200 {
		t.Fatalf("connectors: %d %#v", code, out)
	}
	connectors, _ := out["connectors"].([]any)
	if len(connectors) == 0 {
		t.Fatalf("no connectors returned")
	}
	hasRemote := false
	for _, raw := range connectors {
		item, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("connector not an object: %#v", raw)
		}
		pkg, _ := item["package"].(map[string]any)
		if slug, _ := pkg["slug"].(string); slug == "" {
			t.Fatalf("connector %v missing package.slug", item["ref"])
		}
		auth, _ := item["auth"].(map[string]any)
		if kind, _ := auth["kind"].(string); kind == "" {
			t.Fatalf("connector %v missing auth.kind", item["ref"])
		}
		if ref, _ := item["ref"].(string); strings.HasPrefix(ref, "remote-") {
			hasRemote = true
		}
	}
	if !hasRemote {
		t.Fatalf("no remote- connector in catalog")
	}
	code, out = request(t, srv.Client(), "GET", srv.URL+"/api/remote-channels", token, nil)
	if code != 200 {
		t.Fatalf("remote-channels: %d %#v", code, out)
	}
	if _, ok := out["bindings"].([]any); !ok {
		t.Fatalf("remote-channels missing bindings array: %#v", out)
	}
	if _, ok := out["initialized"].(bool); !ok {
		t.Fatalf("remote-channels missing initialized: %#v", out)
	}
	if base, _ := out["webhookBaseUrl"].(string); base == "" {
		t.Fatalf("remote-channels missing webhookBaseUrl: %#v", out)
	}
}

func TestRemoteChannelCreateAndApproveContracts(t *testing.T) {
	d, token, _ := setup(t)
	r := chi.NewRouter()
	RegisterRoutes(r, d)
	srv := httptest.NewServer(r)
	defer srv.Close()
	client := srv.Client()

	code, out := request(t, client, "POST", srv.URL+"/api/remote-channels", token, map[string]any{
		"agentId":            "agent-ta",
		"platform":           "slack",
		"label":              "Slack",
		"enabled":            true,
		"credentials":        map[string]any{"botToken": "xoxb-secret"},
		"credentialsEnabled": true,
		"settings":           map[string]any{"allowAll": false, "allowedUsers": []string{}, "pendingUsers": []any{}, "model": "", "modelRouteId": nil},
	})
	if code != 201 {
		t.Fatalf("create remote channel: %d %#v", code, out)
	}
	binding, ok := out["binding"].(map[string]any)
	if !ok {
		t.Fatalf("create missing binding: %#v", out)
	}
	id, _ := binding["id"].(string)
	if id == "" {
		t.Fatalf("binding missing id: %#v", binding)
	}
	if _, ok := binding["settings"].(map[string]any); !ok {
		t.Fatalf("binding missing settings: %#v", binding)
	}
	if enabled, _ := binding["credentialsEnabled"].(bool); !enabled {
		t.Fatalf("credentialsEnabled should be true: %#v", binding)
	}
	fields, _ := binding["configuredFields"].([]any)
	if len(fields) != 1 || fields[0] != "botToken" {
		t.Fatalf("configuredFields wrong: %#v", binding["configuredFields"])
	}

	code, out = request(t, client, "GET", srv.URL+"/api/remote-channels", token, nil)
	if code != 200 {
		t.Fatalf("list remote channels: %d %#v", code, out)
	}
	bindings, _ := out["bindings"].([]any)
	found := false
	for _, raw := range bindings {
		item, _ := raw.(map[string]any)
		if item["id"] == id {
			found = true
		}
	}
	if !found {
		t.Fatalf("created binding not listed: %#v", out["bindings"])
	}

	code, out = request(t, client, "PATCH", srv.URL+"/api/remote-channels/"+id, token, map[string]any{
		"settings":    map[string]any{"allowAll": false, "allowedUsers": []string{}, "pendingUsers": []any{}, "model": "gpt-4o", "modelRouteId": nil},
		"credentials": map[string]any{},
	})
	if code != 200 {
		t.Fatalf("patch settings only: %d %#v", code, out)
	}
	code, out = request(t, client, "GET", srv.URL+"/api/remote-channels", token, nil)
	if code != 200 {
		t.Fatalf("list after patch: %d %#v", code, out)
	}
	var afterPatch map[string]any
	for _, raw := range out["bindings"].([]any) {
		item, _ := raw.(map[string]any)
		if item["id"] == id {
			afterPatch = item
		}
	}
	if afterPatch == nil {
		t.Fatalf("binding missing after patch: %#v", out["bindings"])
	}
	if enabled, _ := afterPatch["credentialsEnabled"].(bool); !enabled {
		t.Fatalf("credentialsEnabled should remain true after settings-only patch: %#v", afterPatch)
	}
	afterFields, _ := afterPatch["configuredFields"].([]any)
	if len(afterFields) != 1 || afterFields[0] != "botToken" {
		t.Fatalf("configuredFields changed after settings-only patch: %#v", afterPatch["configuredFields"])
	}

	if _, e := d.DB.Exec(`UPDATE agent_channel_bindings SET settings_json=? WHERE id=?`, `{"allowAll":false,"allowedUsers":[],"pendingUsers":[{"userKey":"U1","email":"u1@example.com","requestedAt":"2024-01-01T00:00:00.000Z"}]}`, id); e != nil {
		t.Fatal(e)
	}
	code, out = request(t, client, "POST", srv.URL+"/api/remote-channels/"+id+"/access/approve", token, map[string]any{"userKey": "U1"})
	if code != 200 {
		t.Fatalf("approve: %d %#v", code, out)
	}
	settings, _ := out["settings"].(map[string]any)
	allowed, _ := settings["allowedUsers"].([]any)
	if len(allowed) != 1 || allowed[0] != "U1" {
		t.Fatalf("allowedUsers wrong: %#v", settings)
	}
	if pending, _ := settings["pendingUsers"].([]any); len(pending) != 0 {
		t.Fatalf("pendingUsers not cleared: %#v", settings)
	}
	binding, _ = out["binding"].(map[string]any)
	bsettings, _ := binding["settings"].(map[string]any)
	ballowed, _ := bsettings["allowedUsers"].([]any)
	if len(ballowed) != 1 || ballowed[0] != "U1" {
		t.Fatalf("binding settings not updated: %#v", binding)
	}

	code, out = request(t, client, "POST", srv.URL+"/api/remote-channels/"+id+"/access/approve", token, map[string]any{"userKey": "  "})
	if code != 400 {
		t.Fatalf("blank userKey should 400: %d %#v", code, out)
	}

	code, out = request(t, client, "POST", srv.URL+"/api/remote-channels", token, map[string]any{"agentId": "agent-ta", "platform": "myspace"})
	if code != 400 {
		t.Fatalf("unsupported platform should 400: %d %#v", code, out)
	}
}

func platformAdminSession(t *testing.T, d *appdeps.Dependencies, tenantID string) string {
	t.Helper()
	now := d.Clock().Format(time.RFC3339Nano)
	userID, email, sessionID := "user-"+tenantID, tenantID+"@example.com", "sess-"+tenantID
	if _, e := d.DB.Exec(`INSERT INTO users(id,email,name,password_hash,is_platform_admin,status,created_at,updated_at) VALUES(?,?,?,?,1,'active',?,?)`, userID, email, "Admin", nil, now, now); e != nil {
		t.Fatal(e)
	}
	if _, e := d.DB.Exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'owner','active',?,?)`, "m-"+tenantID, tenantID, userID, now, now); e != nil {
		t.Fatal(e)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": userID, "tenantId": tenantID, "email": email, "role": "owner", "sid": sessionID, "isPlatformAdmin": true, "iat": d.Clock().Unix(), "exp": d.Clock().Add(time.Hour).Unix()})
	raw, e := tok.SignedString(d.Secret)
	if e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256([]byte(raw))
	if _, e = d.DB.Exec(`INSERT INTO user_sessions(id,user_id,tenant_id,email,role,is_platform_admin,token_hash,expires_at,last_seen_at,created_at) VALUES(?,?,?,?,'owner',1,?,?,?,?)`, sessionID, userID, tenantID, email, hex.EncodeToString(sum[:]), d.Clock().Add(time.Hour).Format(time.RFC3339Nano), now, now); e != nil {
		t.Fatal(e)
	}
	return raw
}

func TestPlatformProfileScopes(t *testing.T) {
	d, tokA, _ := setup(t)
	r := chi.NewRouter()
	RegisterRoutes(r, d)
	srv := httptest.NewServer(r)
	defer srv.Close()
	client := srv.Client()

	code, out := request(t, client, "GET", srv.URL+"/api/connectors/profiles?scope=platform", tokA, nil)
	if code != 403 {
		t.Fatalf("tenant user platform list should 403: %d %#v", code, out)
	}
	code, out = request(t, client, "PUT", srv.URL+"/api/connectors/profiles/slack?scope=platform", tokA, map[string]any{"label": "Slack", "kind": "oauth2", "config": map[string]any{}})
	if code != 403 {
		t.Fatalf("tenant user platform put should 403: %d %#v", code, out)
	}
	code, out = request(t, client, "DELETE", srv.URL+"/api/connectors/profiles/slack?scope=platform", tokA, nil)
	if code != 403 {
		t.Fatalf("tenant user platform delete should 403: %d %#v", code, out)
	}

	admin := platformAdminSession(t, d, "ta")
	code, out = request(t, client, "PUT", srv.URL+"/api/connectors/profiles/slack?scope=platform", admin, map[string]any{"label": "Slack Site", "kind": "oauth2", "enabled": true, "config": map[string]any{"clientId": "platform-id", "clientSecret": "platform-secret"}})
	if code != 200 {
		t.Fatalf("platform put: %d %#v", code, out)
	}
	putProfile, _ := out["profile"].(map[string]any)
	if putProfile["key"] != "slack" || putProfile["label"] != "Slack Site" || putProfile["kind"] != "oauth2" || putProfile["custom"] != false {
		t.Fatalf("platform put profile shape: %#v", out)
	}
	putRefs, _ := putProfile["connectorRefs"].([]any)
	if len(putRefs) != 1 || putRefs[0] != "slack" {
		t.Fatalf("platform put connectorRefs: %#v", putProfile["connectorRefs"])
	}
	putFields, _ := putProfile["fields"].([]any)
	if len(putFields) != 2 {
		t.Fatalf("platform put fields: %#v", putProfile["fields"])
	}
	putConfigured, _ := putProfile["configuredFields"].([]any)
	if len(putConfigured) != 2 {
		t.Fatalf("platform put configuredFields: %#v", putProfile["configuredFields"])
	}

	code, out = request(t, client, "GET", srv.URL+"/api/connectors/profiles?scope=platform", admin, nil)
	if code != 200 {
		t.Fatalf("platform list: %d %#v", code, out)
	}
	profiles, _ := out["profiles"].([]any)
	if len(profiles) != 1 {
		t.Fatalf("platform list size: %#v", out)
	}
	got, _ := profiles[0].(map[string]any)
	if got["key"] != "slack" || got["docsUrl"] != "https://api.slack.com/apps" {
		t.Fatalf("platform list shape: %#v", profiles[0])
	}

	code, out = request(t, client, "GET", srv.URL+"/api/connectors/profiles", tokA, nil)
	if code != 200 {
		t.Fatalf("tenant list: %d %#v", code, out)
	}
	tprofiles, _ := out["profiles"].([]any)
	found := false
	for _, raw := range tprofiles {
		item, _ := raw.(map[string]any)
		if item["profileKey"] == "slack" {
			found = true
			if _, ok := item["key"]; ok {
				t.Fatalf("tenant shape should keep profileKey only: %#v", item)
			}
			cf, _ := item["configuredFields"].([]any)
			if len(cf) != 2 {
				t.Fatalf("tenant view of platform profile configuredFields: %#v", item)
			}
		}
	}
	if !found {
		t.Fatalf("tenant list missing platform profile: %#v", tprofiles)
	}

	var scopeKey string
	if e := d.DB.QueryRow(`SELECT scope_key FROM connector_auth_profiles WHERE profile_key='slack'`).Scan(&scopeKey); e != nil || scopeKey != "platform" {
		t.Fatalf("platform profile not stored under platform scope: %q err=%v", scopeKey, e)
	}
	var enc string
	if e := d.DB.QueryRow(`SELECT config_enc FROM connector_auth_profiles WHERE scope_key='platform' AND profile_key='slack'`).Scan(&enc); e != nil || strings.Contains(enc, "platform-secret") {
		t.Fatalf("platform credential not encrypted: err=%v", e)
	}

	code, out = request(t, client, "DELETE", srv.URL+"/api/connectors/profiles/slack?scope=platform", admin, nil)
	if code != 200 {
		t.Fatalf("platform delete: %d %#v", code, out)
	}
	var remaining int
	if e := d.DB.QueryRow(`SELECT COUNT(*) FROM connector_auth_profiles WHERE scope_key='platform' AND profile_key='slack'`).Scan(&remaining); e != nil || remaining != 0 {
		t.Fatalf("platform profile not deleted: %d err=%v", remaining, e)
	}
}

func TestPlatformCustomProfileHasNoRefs(t *testing.T) {
	d, _, _ := setup(t)
	r := chi.NewRouter()
	RegisterRoutes(r, d)
	srv := httptest.NewServer(r)
	defer srv.Close()
	admin := platformAdminSession(t, d, "ta")
	code, out := request(t, srv.Client(), "PUT", srv.URL+"/api/connectors/profiles/custom-profile?scope=platform", admin, map[string]any{"label": "Custom", "kind": "token", "config": map[string]any{}})
	if code != 200 {
		t.Fatalf("custom put: %d %#v", code, out)
	}
	profile, _ := out["profile"].(map[string]any)
	if profile["custom"] != true {
		t.Fatalf("custom profile should be custom: %#v", profile)
	}
	if refs, _ := profile["connectorRefs"].([]any); refs == nil || len(refs) != 0 {
		t.Fatalf("custom profile refs should be empty array: %#v", profile["connectorRefs"])
	}
	if _, ok := profile["docsUrl"]; ok {
		t.Fatalf("custom profile should omit docsUrl: %#v", profile)
	}
	if fields, _ := profile["fields"].([]any); fields == nil || len(fields) != 0 {
		t.Fatalf("custom profile fields should be empty array: %#v", profile["fields"])
	}
}
