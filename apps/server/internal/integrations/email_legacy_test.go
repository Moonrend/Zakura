// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestLegacyEmailRefCandidates(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"email-smtp", []string{"email-smtp", "email"}},
		{"email-mailgun", []string{"email-mailgun", "email"}},
		{"email", []string{"email", "email-smtp"}},
		{"slack", []string{"slack"}},
		{"remote-zakurabot", []string{"remote-zakurabot"}},
	}
	for _, c := range cases {
		got := legacyEmailRef(c.in)
		if len(got) != len(c.want) {
			t.Fatalf("legacyEmailRef(%q) = %#v, want %#v", c.in, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("legacyEmailRef(%q) = %#v, want %#v", c.in, got, c.want)
			}
		}
	}
}

func TestInstallationConfigLegacyEmailFallback(t *testing.T) {
	d, _, _ := setup(t)
	h := &handler{deps: d}
	now := d.Clock().Format(time.RFC3339Nano)

	legacy, _ := json.Marshal(map[string]any{"config": map[string]any{"fromEmail": "legacy@example.com"}})
	encLegacy, e := encrypt(d.Secret, "ta:agent-ta:email", legacy)
	if e != nil {
		t.Fatal(e)
	}
	if _, e := d.DB.Exec(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,enabled,config_enc,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)`, "inst-legacy", "ta", "agent-ta", "email", encLegacy, now, now); e != nil {
		t.Fatal(e)
	}

	cfg, e := h.installationConfig(context.Background(), "ta", "agent-ta", "email-smtp")
	if e != nil {
		t.Fatalf("legacy fallback: %v", e)
	}
	if cfg["fromEmail"] != "legacy@example.com" {
		t.Fatalf("legacy installation config not returned: %#v", cfg)
	}

	modern, _ := json.Marshal(map[string]any{"config": map[string]any{"fromEmail": "modern@example.com"}})
	encModern, e := encrypt(d.Secret, "ta:agent-ta:email-smtp", modern)
	if e != nil {
		t.Fatal(e)
	}
	if _, e := d.DB.Exec(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,enabled,config_enc,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)`, "inst-modern", "ta", "agent-ta", "email-smtp", encModern, now, now); e != nil {
		t.Fatal(e)
	}
	cfg, e = h.installationConfig(context.Background(), "ta", "agent-ta", "email-smtp")
	if e != nil {
		t.Fatalf("modern installation: %v", e)
	}
	if cfg["fromEmail"] != "modern@example.com" {
		t.Fatalf("primary ref must win over legacy fallback: %#v", cfg)
	}
}

func TestInstallationConfigLegacyEmailSettingsFallback(t *testing.T) {
	d, _, _ := setup(t)
	h := &handler{deps: d}
	now := d.Clock().Format(time.RFC3339Nano)

	install, _ := json.Marshal(map[string]any{"config": map[string]any{}})
	encInstall, _ := encrypt(d.Secret, "ta:agent-ta:email-smtp", install)
	if _, e := d.DB.Exec(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,enabled,config_enc,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)`, "inst-modern", "ta", "agent-ta", "email-smtp", encInstall, now, now); e != nil {
		t.Fatal(e)
	}
	setting, _ := json.Marshal(map[string]any{"inboundEnabled": true})
	encSetting, _ := encrypt(d.Secret, "ta:email", setting)
	if _, e := d.DB.Exec(`INSERT INTO connector_settings(id,scope_key,connector_ref,config_enc,created_at,updated_at) VALUES(?,?,?,?,?,?)`, "set-legacy", "ta", "email", encSetting, now, now); e != nil {
		t.Fatal(e)
	}

	cfg, e := h.installationConfig(context.Background(), "ta", "agent-ta", "email-smtp")
	if e != nil {
		t.Fatalf("settings fallback: %v", e)
	}
	if cfg["inboundEnabled"] != true {
		t.Fatalf("legacy settings not merged: %#v", cfg)
	}
}

func TestListConnectorsMergesLegacyEmailInstallations(t *testing.T) {
	d, token, _ := setup(t)
	now := d.Clock().Format(time.RFC3339Nano)
	if _, e := d.DB.Exec(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,enabled,config_enc,created_at,updated_at) VALUES('inst-legacy','ta','agent-ta','email',1,'',?,?)`, now, now); e != nil {
		t.Fatal(e)
	}
	r := chi.NewRouter()
	RegisterRoutes(r, d)
	srv := httptest.NewServer(r)
	defer srv.Close()

	code, out := request(t, srv.Client(), "GET", srv.URL+"/api/connectors", token, nil)
	if code != 200 {
		t.Fatalf("connectors: %d %#v", code, out)
	}
	connectors, _ := out["connectors"].([]any)
	for _, raw := range connectors {
		item, _ := raw.(map[string]any)
		if item["ref"] == "email-smtp" {
			if n, _ := item["installedAgents"].(float64); n != 1 {
				t.Fatalf("legacy email install must count for email-smtp: %#v", item["installedAgents"])
			}
			return
		}
	}
	t.Fatalf("email-smtp connector missing from catalog")
}
