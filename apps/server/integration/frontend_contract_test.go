package integration_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/config"
	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	platformserver "github.com/Moonrend/Zakura/apps/server/internal/platform/server"
	"github.com/golang-jwt/jwt/v5"
)

func TestPreservedFrontendCoreContracts(t *testing.T) {
	ctx := context.Background()
	var mailMu sync.Mutex
	mails := []map[string]any{}
	mailServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/emails" || r.Header.Get("Authorization") != "Bearer deterministic-fake-token" {
			http.Error(w, "bad mail request", http.StatusBadRequest)
			return
		}
		var payload map[string]any
		if json.NewDecoder(r.Body).Decode(&payload) != nil {
			http.Error(w, "bad JSON", http.StatusBadRequest)
			return
		}
		mailMu.Lock()
		mails = append(mails, payload)
		mailMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"mail-1"}`))
	}))
	defer mailServer.Close()
	dataDir := t.TempDir()
	conn, err := platformdb.Open(ctx, "file:"+filepath.Join(dataDir, "contract.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatal(err)
	}
	gormDB, err := conn.Gorm()
	if err != nil {
		t.Fatal(err)
	}
	var seq atomic.Int64
	cfg := config.Config{WebURL: "http://web.test", PublicURL: "http://api.test", Edition: "saas", MultiTenant: true}
	deps := &appdeps.Dependencies{DB: conn.DB, Gorm: gormDB, Dialect: conn.Dialect, Rebind: conn.Rebind, Clock: func() time.Time { return time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC) }, NewID: func() string { return fmt.Sprintf("%026d", seq.Add(1)) }, Secret: bytes.Repeat([]byte("z"), 32), PublicURL: cfg.PublicURL, WebURL: cfg.WebURL, DataDir: dataDir, Edition: cfg.Edition, MultiTenant: cfg.MultiTenant, VerifyDomain: func(context.Context, string, string) error { return nil }}
	router := platformserver.Router(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(router)
	defer srv.Close()
	client := srv.Client()
	status, platform := jsonCall(t, client, http.MethodGet, srv.URL+"/api/platform", "", nil)
	if status != 200 || platform["setupCompleted"] != false || platform["edition"] != "saas" {
		t.Fatalf("public platform discovery: %d %#v", status, platform)
	}
	status, registeredClient := jsonCall(t, client, http.MethodPost, srv.URL+"/oauth/register", "", map[string]any{
		"client_name": "Frontend OAuth", "redirect_uris": []string{"http://127.0.0.1:4567/callback"},
		"grant_types": []string{"authorization_code"}, "response_types": []string{"code"},
		"token_endpoint_auth_method": "none", "scope": "openid mcp",
	})
	clientID, _ := registeredClient["client_id"].(string)
	if status != http.StatusCreated || clientID == "" {
		t.Fatalf("dynamic client registration: %d %#v", status, registeredClient)
	}
	infoURL := srv.URL + "/api/oauth/authorize-info?response_type=code&client_id=" + clientID + "&redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2Fcallback&scope=openid%20mcp&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_abc&code_challenge_method=S256"
	status, authorizeInfo := jsonCall(t, client, http.MethodGet, infoURL, "", nil)
	if status != http.StatusOK || authorizeInfo["client"] == nil {
		t.Fatalf("public authorize info: %d %#v", status, authorizeInfo)
	}
	status, setup := jsonCall(t, client, http.MethodPost, srv.URL+"/api/setup", "", map[string]any{"adminEmail": "admin@example.com", "adminPassword": "frontend-contract-pass", "adminName": "Admin", "tenantName": "Acme"})
	if status != 200 {
		t.Fatalf("setup: %d %#v", status, setup)
	}
	session, must := setup["session"].(string)
	if !must || session == "" {
		t.Fatalf("setup session shape: %#v", setup)
	}
	status, me := jsonCall(t, client, http.MethodGet, srv.URL+"/api/me", session, nil)
	if status != 200 {
		t.Fatalf("me: %d %#v", status, me)
	}
	for _, key := range []string{"user", "tenant", "role", "multiTenant", "edition", "connect"} {
		if _, ok := me[key]; !ok {
			t.Errorf("/api/me missing %s", key)
		}
	}
	user := me["user"].(map[string]any)
	tenant := me["tenant"].(map[string]any)
	if user["avatarRev"] != float64(0) || user["canUseLocalRunner"] != true {
		t.Fatalf("me user DTO fields: %#v", user)
	}
	for _, event := range []appdeps.UsageRecord{
		{TenantID: tenant["id"].(string), UserID: user["id"].(string), Category: "auth", Action: "login", Summary: "password"},
		{TenantID: tenant["id"].(string), UserID: user["id"].(string), Category: "session", Action: "session_created", AgentID: "agent-usage", SessionID: "session-usage", Summary: "chat"},
		{TenantID: tenant["id"].(string), UserID: user["id"].(string), Category: "run", Action: "run_completed", DurationMS: 1200, ResourceKind: "run", ResourceID: "run-usage"},
		{TenantID: tenant["id"].(string), UserID: user["id"].(string), Category: "tool", Action: "tool_called", Status: "error", DurationMS: 25, Summary: "tool failed"},
	} {
		if deps.RecordUsage == nil {
			t.Fatal("usage recorder was not installed")
		}
		if err = deps.RecordUsage(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	status, usageBundle := jsonCall(t, client, http.MethodGet, srv.URL+"/api/usage/me?days=30", session, nil)
	summary, _ := usageBundle["summary"].(map[string]any)
	totals, _ := summary["totals"].(map[string]any)
	events, _ := usageBundle["events"].([]any)
	if status != http.StatusOK || totals["logins"] != float64(1) || totals["sessionsStarted"] != float64(1) || totals["runsOk"] != float64(1) || totals["toolCalls"] != float64(1) || totals["toolErrors"] != float64(1) || usageBundle["eventTotal"] != float64(4) || len(events) != 4 {
		t.Fatalf("usage bundle contract: %d %#v", status, usageBundle)
	}
	status, tenantUsage := jsonCall(t, client, http.MethodGet, srv.URL+"/api/usage/users?days=30", session, nil)
	usageUsers, _ := tenantUsage["users"].([]any)
	if status != http.StatusOK || len(usageUsers) != 1 || usageUsers[0].(map[string]any)["runsOk"] != float64(1) {
		t.Fatalf("tenant usage contract: %d %#v", status, tenantUsage)
	}
	status, _ = jsonCall(t, client, http.MethodGet, srv.URL+"/api/usage/me?category=invalid", session, nil)
	if status != http.StatusBadRequest {
		t.Fatalf("invalid usage category status=%d", status)
	}
	storedAvatar := []byte{0xff, 0xd8, 0xff, 0xd9}
	if _, err = deps.DB.Exec(`UPDATE users SET avatar_mime='image/jpeg',avatar_data=?,avatar_updated_at=? WHERE id=?`, storedAvatar, deps.Clock().Format(time.RFC3339Nano), user["id"]); err != nil {
		t.Fatal(err)
	}
	avatarReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/users/"+user["id"].(string)+"/avatar", nil)
	avatarReq.Header.Set("Authorization", "Bearer "+session)
	avatarResp, err := client.Do(avatarReq)
	if err != nil {
		t.Fatal(err)
	}
	avatarBytes, _ := io.ReadAll(avatarResp.Body)
	avatarResp.Body.Close()
	if avatarResp.StatusCode != http.StatusOK || !bytes.Equal(avatarBytes, storedAvatar) || avatarResp.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("stored avatar retrieval: status=%d type=%q body=%x", avatarResp.StatusCode, avatarResp.Header.Get("Content-Type"), avatarBytes)
	}
	deleteAvatarReq, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/me/avatar", nil)
	deleteAvatarReq.Header.Set("Authorization", "Bearer "+session)
	deleteAvatarResp, err := client.Do(deleteAvatarReq)
	if err != nil {
		t.Fatal(err)
	}
	deleteAvatarResp.Body.Close()
	if deleteAvatarResp.StatusCode != http.StatusOK {
		t.Fatalf("avatar delete status=%d", deleteAvatarResp.StatusCode)
	}
	oauthAPI := signOAuthAccess(t, deps.Secret, cfg.PublicURL, user["id"].(string), tenant["id"].(string), "api")
	status, oauthMe := jsonCall(t, client, http.MethodGet, srv.URL+"/api/me", oauthAPI, nil)
	if status != http.StatusOK || oauthMe["user"] == nil {
		t.Fatalf("OAuth api-scope principal: %d %#v", status, oauthMe)
	}
	oauthMCP := signOAuthAccess(t, deps.Secret, cfg.PublicURL, user["id"].(string), tenant["id"].(string), "mcp")
	status, initialized := jsonCall(t, client, http.MethodPost, srv.URL+"/mcp", oauthMCP, map[string]any{"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": map[string]any{}})
	if status != http.StatusNotFound || initialized["error"] != "tenant_mcp_removed" {
		t.Fatalf("retired tenant MCP root contract: %d %#v", status, initialized)
	}
	status, denied := jsonCall(t, client, http.MethodGet, srv.URL+"/api/me", oauthMCP, nil)
	if status != http.StatusForbidden || denied["error"] != "insufficient_scope" {
		t.Fatalf("OAuth scope barrier: %d %#v", status, denied)
	}
	status, emailSettings := jsonCall(t, client, http.MethodGet, srv.URL+"/api/settings/email/transactional", session, nil)
	if status != http.StatusOK || emailSettings["enabled"] != false || emailSettings["hasApiToken"] != false {
		t.Fatalf("transactional email defaults: %d %#v", status, emailSettings)
	}
	status, emailSettings = jsonCall(t, client, http.MethodPut, srv.URL+"/api/settings/email/transactional", session, map[string]any{
		"enabled": true, "fromEmail": "hello@example.test", "baseUrl": mailServer.URL, "providerId": "amail", "apiToken": "deterministic-fake-token",
	})
	if status != http.StatusOK || emailSettings["ready"] != true || emailSettings["hasApiToken"] != true || emailSettings["fromEmail"] != "hello@example.test" {
		t.Fatalf("transactional email update: %d %#v", status, emailSettings)
	}
	if _, leaked := emailSettings["apiToken"]; leaked {
		t.Fatalf("transactional email leaked token: %#v", emailSettings)
	}
	status, inviteMail := jsonCall(t, client, http.MethodPost, srv.URL+"/api/tenant/invites", session, map[string]any{"email": "invitee@example.test", "role": "member"})
	if status != http.StatusCreated || inviteMail["emailed"] != true || inviteMail["acceptUrl"] == nil {
		t.Fatalf("transactional invite email: %d %#v", status, inviteMail)
	}
	status, verificationMail := jsonCall(t, client, http.MethodPost, srv.URL+"/api/me/verify-email", session, map[string]any{})
	if status != http.StatusOK || verificationMail["sent"] != true {
		t.Fatalf("transactional verification email: %d %#v", status, verificationMail)
	}
	status, resetMail := jsonCall(t, client, http.MethodPost, srv.URL+"/api/auth/forgot-password", "", map[string]any{"email": "admin@example.com"})
	if status != http.StatusOK || resetMail["sent"] != true {
		t.Fatalf("transactional reset email request: %d %#v", status, resetMail)
	}
	mailMu.Lock()
	mailCount := len(mails)
	mailMu.Unlock()
	if mailCount != 3 {
		t.Fatalf("expected invite, verification and reset mail, got %d", mailCount)
	}
	status, adminPlatform := jsonCall(t, client, http.MethodGet, srv.URL+"/api/admin/platform", session, nil)
	if status != http.StatusOK || adminPlatform["setupCompleted"] != true || adminPlatform["version"] == nil || adminPlatform["mode"] == nil {
		t.Fatalf("admin platform contract: %d %#v", status, adminPlatform)
	}
	status, adminStats := jsonCall(t, client, http.MethodGet, srv.URL+"/api/admin/stats", session, nil)
	if status != http.StatusOK || adminStats["users"] == nil || adminStats["tenants"] == nil || adminStats["runners"] == nil {
		t.Fatalf("admin stats contract: %d %#v", status, adminStats)
	}
	now := deps.Clock().UTC().Format(time.RFC3339Nano)
	if _, err = deps.DB.Exec(`INSERT INTO oauth_clients(id,tenant_id,client_id,client_name,redirect_uris_json,grant_types_json,response_types_json,token_endpoint_auth_method,scope,registration_type,created_at,updated_at) VALUES('tenant-client',?,'client-tenant','Tenant Client','["https://client.example/callback"]','["authorization_code"]','["code"]','none','mcp','dynamic',?,?)`, tenant["id"], now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = deps.DB.Exec(`INSERT INTO upstream_oauth_clients(id,tenant_id,mcp_url,host,client_id,secret_enc,client_name,source,registration_endpoint,scope,instance_id,created_at,updated_at) VALUES('outbound-client',?,'https://mcp.example/mcp','mcp.example','upstream-client','encrypted','Upstream Client','dcr','https://mcp.example/register','mcp',NULL,?,?)`, tenant["id"], now, now); err != nil {
		t.Fatal(err)
	}
	status, oauthClients := jsonCall(t, client, http.MethodGet, srv.URL+"/api/admin/oauth-clients?page=1&pageSize=1&q=client", session, nil)
	if status != http.StatusOK || oauthClients["items"] == nil || oauthClients["total"] != float64(2) || oauthClients["pageSize"] != float64(1) || oauthClients["tenantId"] != tenant["id"] {
		t.Fatalf("admin OAuth pagination contract: %d %#v", status, oauthClients)
	}
	status, outboundClients := jsonCall(t, client, http.MethodGet, srv.URL+"/api/admin/oauth-clients?direction=outbound", session, nil)
	outboundItems, _ := outboundClients["items"].([]any)
	if status != http.StatusOK || len(outboundItems) != 1 || outboundItems[0].(map[string]any)["direction"] != "outbound" {
		t.Fatalf("admin outbound OAuth contract: %d %#v", status, outboundClients)
	}
	status, _ = jsonCall(t, client, http.MethodDelete, srv.URL+"/api/admin/oauth-clients/outbound/outbound-client", session, nil)
	if status != http.StatusOK {
		t.Fatalf("admin outbound OAuth revoke status=%d", status)
	}
	status, _ = jsonCall(t, client, http.MethodDelete, srv.URL+"/api/admin/oauth-clients/outbound/outbound-client", session, nil)
	if status != http.StatusNotFound {
		t.Fatalf("missing outbound OAuth revoke status=%d", status)
	}
	status, adminUsers := jsonCall(t, client, http.MethodGet, srv.URL+"/api/admin/users", session, nil)
	if status != http.StatusOK || adminUsers["items"] == nil {
		t.Fatalf("admin users contract: %d %#v", status, adminUsers)
	}
	status, managed := jsonCall(t, client, http.MethodPost, srv.URL+"/api/admin/users", session, map[string]any{"email": "managed@example.test", "password": "managed-user-password", "name": "Managed", "tenantName": "Managed Team", "canUseLocalRunner": true})
	managedUser, userOK := managed["user"].(map[string]any)
	managedTenant, tenantOK := managed["tenant"].(map[string]any)
	if status != http.StatusCreated || !userOK || !tenantOK || managedUser["id"] == nil || managedTenant["id"] == nil {
		t.Fatalf("admin user create: %d %#v", status, managed)
	}
	status, managedDetail := jsonCall(t, client, http.MethodGet, srv.URL+"/api/admin/users/"+managedUser["id"].(string), session, nil)
	if status != http.StatusOK || managedDetail["memberships"] == nil || managedDetail["identities"] == nil || managedDetail["runners"] == nil {
		t.Fatalf("admin user detail: %d %#v", status, managedDetail)
	}
	status, tenantDetail := jsonCall(t, client, http.MethodGet, srv.URL+"/api/admin/tenants/"+managedTenant["id"].(string), session, nil)
	if status != http.StatusOK || tenantDetail["members"] == nil || tenantDetail["runners"] == nil {
		t.Fatalf("admin tenant detail: %d %#v", status, tenantDetail)
	}
	status, sortedUsers := jsonCall(t, client, http.MethodGet, srv.URL+"/api/admin/users?sort=email&order=asc&pageSize=100", session, nil)
	sortedItems, _ := sortedUsers["items"].([]any)
	if status != http.StatusOK || len(sortedItems) < 2 || sortedItems[0].(map[string]any)["email"] != "admin@example.com" || sortedItems[1].(map[string]any)["email"] != "managed@example.test" {
		t.Fatalf("admin user sorting contract: %d %#v", status, sortedUsers)
	}
	status, tenantUsers := jsonCall(t, client, http.MethodGet, srv.URL+"/api/admin/users?tenantId="+managedTenant["id"].(string), session, nil)
	tenantItems, _ := tenantUsers["items"].([]any)
	if status != http.StatusOK || len(tenantItems) != 1 || tenantItems[0].(map[string]any)["id"] != managedUser["id"] {
		t.Fatalf("admin tenant user filter: %d %#v", status, tenantUsers)
	}
	if _, err = deps.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_by_user_id,created_at,updated_at) VALUES('managed-runner',?,?,?,'computer','online','{}','{}','/srv/zakura','{}',FALSE,?,?,?)`, managedTenant["id"], "Managed Runner", "managed-runner", managedUser["id"], now, now); err != nil {
		t.Fatal(err)
	}
	status, runners := jsonCall(t, client, http.MethodGet, srv.URL+"/api/admin/runners", session, nil)
	if status != http.StatusOK || runners["items"] == nil || runners["limits"] == nil {
		t.Fatalf("admin runners contract: %d %#v", status, runners)
	}
	status, sharedRunner := jsonCall(t, client, http.MethodPatch, srv.URL+"/api/admin/runners/managed-runner", session, map[string]any{"isShared": true})
	if status != http.StatusOK || sharedRunner["runner"].(map[string]any)["isShared"] != true {
		t.Fatalf("admin runner patch: %d %#v", status, sharedRunner)
	}
	status, defaultsApplied := jsonCall(t, client, http.MethodPost, srv.URL+"/api/admin/users/"+managedUser["id"].(string)+"/agent-defaults/apply", session, map[string]any{})
	if status != http.StatusOK || defaultsApplied["updated"] == nil || defaultsApplied["tenants"] != float64(1) {
		t.Fatalf("admin agent defaults apply: %d %#v", status, defaultsApplied)
	}
	status, deletedManaged := jsonCall(t, client, http.MethodDelete, srv.URL+"/api/admin/users/"+managedUser["id"].(string), session, nil)
	if status != http.StatusOK || deletedManaged["deletedTenants"] != float64(1) {
		t.Fatalf("admin user aggregate delete: %d %#v", status, deletedManaged)
	}
	status, boot := jsonCall(t, client, http.MethodPost, srv.URL+"/api/tenant/onboarding/bootstrap", session, map[string]any{})
	if status != 200 {
		t.Fatalf("bootstrap: %d %#v", status, boot)
	}
	bootAgent, _ := boot["agent"].(map[string]any)
	agentID, _ := bootAgent["id"].(string)
	if agentID == "" {
		t.Fatalf("bootstrap shape: %#v", boot)
	}
	for _, key := range []string{"name", "slug", "enableComputer", "enableMemory"} {
		if _, ok := bootAgent[key]; !ok {
			t.Fatalf("bootstrap agent missing %s: %#v", key, boot)
		}
	}
	if _, ok := bootAgent["mcpAgentUrl"]; ok {
		t.Fatalf("bootstrap agent should not expose mcpAgentUrl: %#v", boot)
	}
	bootSpaces, _ := boot["spaces"].([]any)
	if len(bootSpaces) == 0 {
		t.Fatalf("bootstrap spaces shape: %#v", boot)
	}
	bootSpace, _ := bootSpaces[0].(map[string]any)
	bootSpaceSlug, _ := bootSpace["slug"].(string)
	if bootSpaceSlug == "" || bootSpace["mcpUrl"] == nil {
		t.Fatalf("bootstrap space shape: %#v", boot)
	}
	agentOAuth := signOAuthAgentAccess(t, deps.Secret, cfg.PublicURL, user["id"].(string), tenant["id"].(string), agentID, "mcp")
	status, initialized = jsonCall(t, client, http.MethodPost, srv.URL+"/mcp/spaces/"+bootSpaceSlug, agentOAuth, map[string]any{"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": map[string]any{}})
	if status != http.StatusOK || initialized["result"] == nil {
		t.Fatalf("space-scoped OAuth MCP initialize: %d %#v", status, initialized)
	}
	status, aliasInitialized := jsonCall(t, client, http.MethodPost, srv.URL+"/mcp/agents/"+bootAgent["slug"].(string), agentOAuth, map[string]any{"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": map[string]any{}})
	if status != http.StatusOK || aliasInitialized["result"] == nil {
		t.Fatalf("agent alias OAuth MCP initialize: %d %#v", status, aliasInitialized)
	}
	status, agentList := arrayCall(t, client, http.MethodGet, srv.URL+"/api/agents", session)
	if status != 200 || len(agentList) != 1 {
		t.Fatalf("agents array: %d %#v", status, agentList)
	}
	status, created := jsonCall(t, client, http.MethodPost, srv.URL+"/api/agents/"+agentID+"/cloud/sessions", session, map[string]any{"title": "Frontend conversation", "kind": "chat"})
	if status != 201 {
		t.Fatalf("session create: %d %#v", status, created)
	}
	cloud := created
	if cloud["id"] == nil || cloud["title"] != "Frontend conversation" {
		t.Fatalf("session envelope: %#v", created)
	}
	status, connect := jsonCall(t, client, http.MethodGet, srv.URL+"/api/connect", session, nil)
	if status != 200 {
		t.Fatalf("connect: %d %#v", status, connect)
	}
	for _, key := range []string{"publicBaseUrl", "spaceMcpPattern", "agentMcpPattern", "authorizationServer", "spaces", "authMethods"} {
		if _, ok := connect[key]; !ok {
			t.Errorf("/api/connect missing %s", key)
		}
	}
	status, createdKey := jsonCall(t, client, http.MethodPost, srv.URL+"/api/api-keys", session, map[string]any{"name": "contract", "scopes": []string{"*"}})
	rawKey, _ := createdKey["rawKey"].(string)
	prefix, _ := createdKey["keyPrefix"].(string)
	createdScopes, _ := createdKey["scopes"].([]any)
	if status != http.StatusCreated || !strings.HasPrefix(rawKey, "zak_") || len(prefix) != 12 || len(createdScopes) != 1 || createdScopes[0] != "*" {
		t.Fatalf("API key contract: %d %#v", status, createdKey)
	}
	status, keyedAgents := arrayCall(t, client, http.MethodGet, srv.URL+"/api/agents", rawKey)
	if status != http.StatusOK || len(keyedAgents) != 1 {
		t.Fatalf("API key authentication: %d %#v", status, keyedAgents)
	}
	status, keyedMe := jsonCall(t, client, http.MethodGet, srv.URL+"/api/me", rawKey, nil)
	keyedUser, _ := keyedMe["user"].(map[string]any)
	if status != http.StatusOK || keyedUser["id"] != "api-key" || keyedMe["isPlatformAdmin"] != false || keyedMe["canUseLocalRunner"] != false {
		t.Fatalf("API-key /api/me contract: %d %#v", status, keyedMe)
	}
	status, mcpOnlyKey := jsonCall(t, client, http.MethodPost, srv.URL+"/api/api-keys", session, map[string]any{"name": "mcp-only", "scopes": []string{"mcp"}})
	mcpOnlyRaw, _ := mcpOnlyKey["rawKey"].(string)
	if status != http.StatusCreated || mcpOnlyRaw == "" {
		t.Fatalf("MCP-only API key create: %d %#v", status, mcpOnlyKey)
	}
	status, deniedKey := jsonCall(t, client, http.MethodGet, srv.URL+"/api/me", mcpOnlyRaw, nil)
	if status != http.StatusForbidden || deniedKey["error"] != "insufficient_scope" {
		t.Fatalf("MCP-only key escaped to platform API: %d %#v", status, deniedKey)
	}
	status, _ = jsonCall(t, client, http.MethodDelete, srv.URL+"/api/api-keys/"+createdKey["id"].(string), session, nil)
	if status != http.StatusOK {
		t.Fatalf("API key revoke status: %d", status)
	}
	status, _ = arrayCall(t, client, http.MethodGet, srv.URL+"/api/agents", rawKey)
	if status != http.StatusUnauthorized {
		t.Fatalf("revoked API key status: %d", status)
	}
}

func signOAuthAccess(t *testing.T, secret []byte, issuer, userID, tenantID, scope string) string {
	return signOAuthAgentAccess(t, secret, issuer, userID, tenantID, "", scope)
}

func signOAuthAgentAccess(t *testing.T, secret []byte, issuer, userID, tenantID, agentID, scope string) string {
	t.Helper()
	seed := sha256.Sum256(append(append([]byte{}, secret...), []byte("zakura-oauth-eddsa-v1")...))
	privateKey := ed25519.NewKeyFromSeed(seed[:])
	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, jwt.MapClaims{
		"iss": issuer, "sub": userID, "tenantId": tenantID, "aid": agentID, "scope": scope,
		"iat": now.Add(-time.Minute).Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	raw, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func arrayCall(t *testing.T, c *http.Client, method, url, token string) (int, []any) {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func jsonCall(t *testing.T, c *http.Client, method, url, token string, body any) (int, map[string]any) {
	t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req, _ := http.NewRequest(method, url, bytes.NewReader(raw))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}
