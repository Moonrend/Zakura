package integrations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/go-chi/chi/v5"
)

func integrationServer(t *testing.T, d *appdeps.Dependencies, lifecycle ...MCPInstanceLifecycle) *httptest.Server {
	t.Helper()
	r := chi.NewRouter()
	RegisterRoutes(r, d, lifecycle...)
	s := httptest.NewServer(r)
	t.Cleanup(s.Close)
	return s
}
func extraSpace(t *testing.T, d *appdeps.Dependencies, id, agent string) {
	t.Helper()
	now := d.Clock().Format("2006-01-02T15:04:05Z07:00")
	if _, e := d.DB.Exec(`INSERT INTO spaces(id,tenant_id,name,slug,description,workspace_kind,workspace_status,config_json,created_at,updated_at) VALUES(?,'ta',?,?,'','local','ready','{}',?,?)`, id, id, id, now, now); e != nil {
		t.Fatal(e)
	}
	if agent != "" {
		if _, e := d.DB.Exec(`INSERT INTO agents(id,tenant_id,space_id,name,slug,description,enable_memory,config_json,created_at,updated_at) VALUES(?,'ta',?,?,?,'',true,'{}',?,?)`, agent, id, agent, agent, now, now); e != nil {
			t.Fatal(e)
		}
	}
}
func boundedKey(t *testing.T, d *appdeps.Dependencies, space, agent, scopes string) string {
	t.Helper()
	token := "zk_bound"
	sum := sha256.Sum256([]byte(token))
	if _, e := d.DB.Exec(`INSERT INTO api_keys(id,tenant_id,name,key_prefix,key_hash,space_id,agent_id,scopes,created_at) VALUES('bound','ta','bound','zk_bound',?,?,?,?,?)`, hex.EncodeToString(sum[:]), space, agent, scopes, d.Clock().Format("2006-01-02")); e != nil {
		t.Fatal(e)
	}
	return token
}
func TestSpaceChannelActualPayloadRoutingAndZeroAgent(t *testing.T) {
	d, token, _ := setup(t)
	extraSpace(t, d, "empty", "")
	extraSpace(t, d, "other", "other-agent")
	s := integrationServer(t, d)
	code, out := request(t, s.Client(), "POST", s.URL+"/api/remote-channels", token, map[string]any{"spaceId": "empty", "agentId": "", "platform": "slack", "label": "Draft", "enabled": false, "credentials": map[string]any{"token": "keep-secret"}, "credentialsEnabled": true, "settings": map[string]any{"allowAll": false}})
	if code != 201 {
		t.Fatalf("zero Agent create %d %#v", code, out)
	}
	row := out["binding"].(map[string]any)
	id := row["id"].(string)
	if row["spaceId"] != "empty" || row["agentId"] != "" || row["enabled"] != false {
		t.Fatalf("dto %#v", row)
	}
	code, out = request(t, s.Client(), "PATCH", s.URL+"/api/remote-channels/"+id, token, map[string]any{"agentId": "agent-ta", "enabled": true})
	if code != 404 {
		t.Fatalf("cross Space reply %d %#v", code, out)
	}
	code, out = request(t, s.Client(), "PATCH", s.URL+"/api/remote-channels/"+id, token, map[string]any{"enabled": true})
	if code != 400 {
		t.Fatalf("unassigned enabled %d %#v", code, out)
	}
	code, out = request(t, s.Client(), "GET", s.URL+"/api/remote-channels?spaceId=space-ta", token, nil)
	if code != 200 || len(out["bindings"].([]any)) != 0 {
		t.Fatalf("Space filter %d %#v", code, out)
	}
	code, out = request(t, s.Client(), "POST", s.URL+"/api/remote-channels", token, map[string]any{"spaceId": "space-ta", "agentId": "agent-ta", "platform": "slack", "enabled": true, "credentials": map[string]any{"token": "keep-secret"}})
	if code != 201 {
		t.Fatal(code, out)
	}
	id = out["binding"].(map[string]any)["id"].(string)
	now := d.Clock().Format("2006-01-02")
	if _, e := d.DB.Exec(`INSERT INTO agents(id,tenant_id,space_id,name,slug,description,enable_memory,config_json,created_at,updated_at) VALUES('reply-two','ta','space-ta','Reply two','reply-two','',true,'{}',?,?)`, now, now); e != nil {
		t.Fatal(e)
	}
	code, out = request(t, s.Client(), "PATCH", s.URL+"/api/remote-channels/"+id, token, map[string]any{"agentId": "reply-two", "spaceId": "space-ta", "enabled": true, "credentials": map[string]any{}, "credentialsEnabled": true, "settings": map[string]any{"allowAll": true, "model": "reply-model"}})
	if code != 200 || out["binding"].(map[string]any)["agentId"] != "reply-two" {
		t.Fatalf("same Space reply PATCH %d %#v", code, out)
	}
	code, out = request(t, s.Client(), "PATCH", s.URL+"/api/remote-channels/"+id, token, map[string]any{"agentId": nil})
	if code != 200 || out["binding"].(map[string]any)["enabled"] != false {
		t.Fatalf("unassign PATCH %d %#v", code, out)
	}
	code, out = request(t, s.Client(), "PATCH", s.URL+"/api/remote-channels/"+id, token, map[string]any{"agentId": "agent-ta", "enabled": true})
	if code != 200 {
		t.Fatal(code, out)
	}
	var before string
	_ = d.DB.QueryRow(`SELECT config_enc FROM agent_channel_bindings WHERE id=?`, id).Scan(&before)
	if _, e := d.DB.Exec(`DELETE FROM agents WHERE id='agent-ta'`); e != nil {
		t.Fatal(e)
	}
	code, out = request(t, s.Client(), "GET", s.URL+"/api/remote-channels?spaceId=space-ta", token, nil)
	if code != 200 {
		t.Fatal(code, out)
	}
	rows := out["bindings"].([]any)
	if len(rows) != 1 {
		t.Fatalf("deleted Agent lost channel %#v", out)
	}
	row = rows[0].(map[string]any)
	if row["agentId"] != "" || row["enabled"] != false {
		t.Fatalf("deleted Agent routing %#v", row)
	}
	var after string
	_ = d.DB.QueryRow(`SELECT config_enc FROM agent_channel_bindings WHERE id=?`, id).Scan(&after)
	if before != after {
		t.Fatal("deletion changed credentials")
	}
}
func TestSpaceConnectorCanonicalCryptoAndLegacyConflict(t *testing.T) {
	d, token, _ := setup(t)
	now := d.Clock().Format("2006-01-02")
	if _, e := d.DB.Exec(`INSERT INTO agents(id,tenant_id,space_id,name,slug,description,enable_memory,config_json,created_at,updated_at) VALUES('second','ta','space-ta','Second','second','',true,'{}',?,?)`, now, now); e != nil {
		t.Fatal(e)
	}
	for _, entry := range []struct{ id, agent, ref, token string }{{"old-a", "agent-ta", "email", "a"}, {"old-b", "second", "email-smtp", "b"}} {
		raw, _ := json.Marshal(map[string]any{"profileKey": "email", "config": map[string]any{"token": entry.token}})
		enc, e := encrypt(d.Secret, "ta:"+entry.agent+":"+entry.ref, raw)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = d.DB.Exec(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,enabled,config_enc,created_at,updated_at) VALUES(?,'ta',?,?,true,?,?,?)`, entry.id, entry.agent, entry.ref, enc, now, now); e != nil {
			t.Fatal(e)
		}
	}
	settings, e := encrypt(d.Secret, "ta:email", []byte(`{"mailbox":"one"}`))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = d.DB.Exec(`INSERT INTO connector_settings(id,scope_key,connector_ref,config_enc,created_at,updated_at) VALUES('settings','ta','email',?,?,?)`, settings, now, now); e != nil {
		t.Fatal(e)
	}
	s := integrationServer(t, d)
	for i := 0; i < 2; i++ {
		code, out := request(t, s.Client(), "GET", s.URL+"/api/connections?spaceId=space-ta", token, nil)
		if code != 200 || len(out["items"].([]any)) != 2 {
			t.Fatalf("conflicts %d %#v", code, out)
		}
		for _, v := range out["items"].([]any) {
			if v.(map[string]any)["status"] != "conflict" {
				t.Fatal("arbitrary canonical pick")
			}
		}
	}
	var count int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM space_connector_installations`).Scan(&count)
	if count != 0 {
		t.Fatal("conflicting configs canonicalized")
	}
	var scope, settingScope string
	_ = d.DB.QueryRow(`SELECT encryption_scope,settings_scope FROM space_connector_legacy_installations WHERE id='old-a'`).Scan(&scope, &settingScope)
	if scope != "ta:agent-ta:email" || settingScope != "ta:email" {
		t.Fatal(scope, settingScope)
	}
	code, out := request(t, s.Client(), "POST", s.URL+"/api/connectors/email-smtp/install", token, map[string]any{"spaceId": "space-ta", "config": map[string]any{"token": "chosen"}})
	if code != 201 {
		t.Fatal(code, out)
	}
	var id, enc string
	_ = d.DB.QueryRow(`SELECT id,config_enc FROM space_connector_installations`).Scan(&id, &enc)
	raw, e := decrypt(d.Secret, "ta:space:space-ta:email-smtp", enc)
	if e != nil || !strings.Contains(string(raw), "chosen") {
		t.Fatal(string(raw), e)
	}
	if _, e = decrypt(d.Secret, "ta:agent-ta:email-smtp", enc); e == nil {
		t.Fatal("legacy crypto scope accepted")
	}
	code, out = request(t, s.Client(), "DELETE", s.URL+"/api/connections/connector:"+id, token, nil)
	if code != 200 {
		t.Fatal(code, out)
	}
	code, out = request(t, s.Client(), "GET", s.URL+"/api/connections?spaceId=space-ta", token, nil)
	if code != 200 || len(out["items"].([]any)) != 0 {
		t.Fatalf("archive resurrected after uninstall %d %#v", code, out)
	}
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM space_connector_legacy_installations`).Scan(&count)
	if count != 2 {
		t.Fatal("conflicting archive lost")
	}
}
func TestSpaceConnectorLegacyExactScopeReseal(t *testing.T) {
	d, _, _ := setup(t)
	now := d.Clock().Format("2006-01-02")
	enc, _ := sealSpaceConnector(d.Secret, "ta:agent-ta:email", []byte(`{"config":{"token":"legacy-token"}}`))
	if _, e := d.DB.Exec(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,enabled,config_enc,created_at,updated_at) VALUES('old','ta','agent-ta','email',false,?,?,?)`, enc, now, now); e != nil {
		t.Fatal(e)
	}
	h := &handler{deps: d}
	for i := 0; i < 2; i++ {
		if e := h.migrateSpaceConnectors(context.Background(), "ta", "space-ta"); e != nil {
			t.Fatal(e)
		}
	}
	var got spaceConnectorInstallation
	if e := d.Gorm.First(&got).Error; e != nil {
		t.Fatal(e)
	}
	if got.Enabled || got.ConnectorRef != "email-smtp" {
		t.Fatal(got)
	}
	cfg, e := h.spaceEnvelope(got)
	if e != nil || cfg.Config["token"] != "legacy-token" {
		t.Fatal(cfg, e)
	}
	var count int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM space_connector_installations`).Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
}
func TestAgentBoundKeyCannotMutateSpaceOwnerViaLegacyAdapter(t *testing.T) {
	d, _, _ := setup(t)
	token := boundedKey(t, d, "space-ta", "agent-ta", "[\"api\"]")
	s := integrationServer(t, d)
	for _, path := range []string{"/api/connectors/slack/install", "/api/connections/install", "/api/remote-channels"} {
		body := map[string]any{"agentId": "agent-ta", "spaceId": "space-ta", "source": "slack", "platform": "slack", "config": map[string]any{"token": "no-write"}}
		code, out := request(t, s.Client(), "POST", s.URL+path, token, body)
		if code != 404 {
			t.Fatalf("legacy shared mutation %s %d %#v", path, code, out)
		}
	}
	code, out := request(t, s.Client(), "GET", s.URL+"/api/connections", token, nil)
	if code != 200 || len(out["items"].([]any)) != 0 {
		t.Fatalf("Agent bound shared list %d %#v", code, out)
	}
	var count int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM space_connector_installations`).Scan(&count)
	if count != 0 {
		t.Fatal("shared install written")
	}
}

func TestSpaceConnectorBoundedListsIDBodyAndCapability(t *testing.T) {
	d, token, _ := setup(t)
	extraSpace(t, d, "other", "other-agent")
	s := integrationServer(t, d)
	code, out := request(t, s.Client(), "POST", s.URL+"/api/connections/install", token, map[string]any{"spaceId": "other", "source": "slack", "config": map[string]any{"token": "hidden"}})
	if code != 201 {
		t.Fatal(code, out)
	}
	id := out["result"].(map[string]any)["id"].(string)
	bounded := boundedKey(t, d, "space-ta", "", "[\"api\"]")
	code, out = request(t, s.Client(), "GET", s.URL+"/api/connections", bounded, nil)
	if code != 200 || len(out["items"].([]any)) != 0 {
		t.Fatal(code, out)
	}
	for _, test := range []struct {
		method, path string
		body         any
	}{{"POST", "/api/connections/" + id + "/start", nil}, {"POST", "/api/connections/install", map[string]any{"source": "slack", "spaceId": "other"}}, {"GET", "/api/connections?spaceId=other", nil}, {"POST", "/api/remote-channels", map[string]any{"spaceId": "space-ta", "agentId": "other-agent", "platform": "slack"}}, {"PUT", "/api/connectors/profiles/slack", map[string]any{"kind": "token"}}} {
		code, out = request(t, s.Client(), test.method, s.URL+test.path, bounded, test.body)
		if code != 404 {
			t.Fatalf("%s: %d %#v", test.path, code, out)
		}
	}
	if _, e := d.DB.Exec(`UPDATE api_keys SET scopes='["mcp"]' WHERE id='bound'`); e != nil {
		t.Fatal(e)
	}
	code, _ = request(t, s.Client(), "GET", s.URL+"/api/connections", bounded, nil)
	if code != http.StatusForbidden {
		t.Fatalf("api capability bypass %d", code)
	}
}

type fakeMCPConnectionsLifecycle struct {
	starts, stops, binds, deletes int
	fail                          bool
}

func (f *fakeMCPConnectionsLifecycle) Bind(context.Context, string, string, string) error {
	f.binds++
	return nil
}
func (f *fakeMCPConnectionsLifecycle) Delete(context.Context, string, string) error {
	f.deletes++
	return nil
}

func (f *fakeMCPConnectionsLifecycle) Start(context.Context, string, string) error {
	f.starts++
	if f.fail {
		return errors.New("probe failed")
	}
	return nil
}
func (f *fakeMCPConnectionsLifecycle) Stop(context.Context, string, string) error {
	f.stops++
	return nil
}
func TestConnectionInstanceLifecycleDelegatesWithoutSQLReady(t *testing.T) {
	d, token, _ := setup(t)
	hook := &fakeMCPConnectionsLifecycle{fail: true}
	s := integrationServer(t, d, hook)
	code, out := request(t, s.Client(), "POST", s.URL+"/api/connections/install", token, map[string]any{"spaceId": "space-ta", "source": "https://mcp.invalid/tools", "kind": "mcp-http", "config": map[string]any{"token": "encrypted"}})
	if code != 201 {
		t.Fatal(code, out)
	}
	result := out["result"].(map[string]any)
	id := result["id"].(string)
	instance := result["instanceId"].(string)
	code, out = request(t, s.Client(), "POST", s.URL+"/api/connections/"+id+"/start", token, nil)
	if code != 400 || hook.starts != 1 {
		t.Fatal(code, out, hook)
	}
	var status, config, secret string
	_ = d.DB.QueryRow(`SELECT status,config_json,secret_json FROM component_instances WHERE id=?`, instance).Scan(&status, &config, &secret)
	if status != "stopped" || strings.Contains(config, "encrypted") || strings.Contains(secret, "encrypted") {
		t.Fatal(status, config, secret)
	}
	code, out = request(t, s.Client(), "POST", s.URL+"/api/connections/"+id+"/stop", token, nil)
	if code != 200 || hook.stops != 1 {
		t.Fatal(code, out, hook)
	}
	code, out = request(t, s.Client(), "POST", s.URL+"/api/connections/"+id+"/bind", token, map[string]any{"spaceId": "space-ta"})
	if code != 200 || hook.binds != 1 {
		t.Fatal(code, out, hook)
	}
	code, out = request(t, s.Client(), "DELETE", s.URL+"/api/connections/"+id, token, nil)
	if code != 200 || hook.deletes != 1 {
		t.Fatal(code, out, hook)
	}
}
