// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestLegacyComponentConfigIsDecryptedAndSplit(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	for _, ddl := range []string{`ALTER TABLE component_instances ADD COLUMN provider_id TEXT`, `ALTER TABLE component_instances ADD COLUMN slug TEXT`, `ALTER TABLE component_instances ADD COLUMN config_enc TEXT`} {
		if _, err := d.DB.Exec(ddl); err != nil {
			t.Fatal(err)
		}
	}
	plain := []byte(`{"url":"https://mcp.example.test","headers":{"Authorization":"Bearer secret"},"token":"token-value"}`)
	encrypted, err := secretBox(d.Secret, "legacy", plain)
	if err != nil {
		t.Fatal(err)
	}
	now := d.Clock()
	_, err = d.DB.Exec(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,last_error,created_at,updated_at,provider_id,slug,config_enc) VALUES('legacy','tenant',NULL,'mcp','generic','Legacy','{}','{}','ready',NULL,?,?, 'generic','legacy',?)`, now, now, encrypted)
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: NewStore(d)}
	h.migrateLegacyComponentConfigs(context.Background())
	var configRaw, secretRaw string
	if err := d.DB.QueryRow(`SELECT config_json,secret_json FROM component_instances WHERE id='legacy'`).Scan(&configRaw, &secretRaw); err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if json.Unmarshal([]byte(configRaw), &config) != nil || config["url"] != "https://mcp.example.test" || config["token"] != nil || config["headers"] != nil {
		t.Fatalf("legacy public config migration: %s", configRaw)
	}
	var wrapped struct {
		Enc string `json:"enc"`
	}
	if json.Unmarshal([]byte(secretRaw), &wrapped) != nil || wrapped.Enc == "" {
		t.Fatalf("legacy secret wrapper: %s", secretRaw)
	}
	secretPlain, err := openSecretBox(d.Secret, "mcp:legacy", wrapped.Enc)
	if err != nil || !json.Valid(secretPlain) || !containsAll(string(secretPlain), "Bearer secret", "token-value") {
		t.Fatalf("legacy secret migration: %q %v", secretPlain, err)
	}
}

func TestLegacyComponentMigrationSkipsFreshSchema(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	if h.componentInstanceColumnExists(context.Background(), "config_enc") {
		t.Fatal("fresh component_instances unexpectedly has legacy config_enc column")
	}

	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,last_error,created_at,updated_at) VALUES('native','tenant',NULL,'mcp','generic','Native','{}','{}','ready',NULL,?,?)`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	h.migrateLegacyComponentConfigs(context.Background())
	var configRaw, secretRaw string
	if err := d.DB.QueryRow(`SELECT config_json,secret_json FROM component_instances WHERE id='native'`).Scan(&configRaw, &secretRaw); err != nil {
		t.Fatal(err)
	}
	if configRaw != "{}" || secretRaw != "{}" {
		t.Fatalf("fresh component changed during legacy migration: config=%s secret=%s", configRaw, secretRaw)
	}
}

func containsAll(value string, needles ...string) bool {
	for _, needle := range needles {
		if !strings.Contains(value, needle) {
			return false
		}
	}
	return true
}
