// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/go-chi/chi/v5"
)

func signedWebhookRequest(t *testing.T, client *http.Client, target string, body []byte, headers map[string]string) (int, map[string]any) {
	t.Helper()
	req, e := http.NewRequest(http.MethodPost, target, bytes.NewReader(body))
	if e != nil {
		t.Fatal(e)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, e := client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func slackWebhookSignature(secret string, body []byte) map[string]string {
	timestamp := "1700000000"
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("v0:" + timestamp + ":" + string(body)))
	return map[string]string{
		"X-Slack-Request-Timestamp": timestamp,
		"X-Slack-Signature":         "v0=" + hex.EncodeToString(mac.Sum(nil)),
	}
}

func emailWebhookSignature(secret, messageID string, body []byte) map[string]string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return map[string]string{
		"Message-Id":         messageID,
		"X-Zakura-Signature": "sha256=" + hex.EncodeToString(mac.Sum(nil)),
	}
}

func channelEventCount(t *testing.T, deps *appdeps.Dependencies, provider string) int {
	t.Helper()
	var count int
	if e := deps.DB.QueryRow(`SELECT COUNT(*) FROM channel_events WHERE tenant_id='ta' AND provider=?`, provider).Scan(&count); e != nil {
		t.Fatal(e)
	}
	return count
}

func TestRemoteWebhookEnforcesSenderPolicyBeforeQueue(t *testing.T) {
	deps, token, _ := setup(t)
	router := chi.NewRouter()
	RegisterRoutes(router, deps)
	server := httptest.NewServer(router)
	defer server.Close()

	code, out := request(t, server.Client(), http.MethodPost, server.URL+"/api/remote-channels", token, map[string]any{
		"agentId":            "agent-ta",
		"platform":           "slack",
		"label":              "Slack",
		"enabled":            true,
		"credentials":        map[string]any{"signingSecret": "remote-secret"},
		"credentialsEnabled": true,
		"settings":           map[string]any{"allowAll": false, "allowedUsers": []string{}, "pendingUsers": []any{}},
	})
	if code != http.StatusCreated {
		t.Fatalf("create remote channel: %d %#v", code, out)
	}
	binding := out["binding"].(map[string]any)
	bindingID := binding["id"].(string)
	webhookURL := server.URL + "/api/remote-channels/ta/" + bindingID + "/webhook"

	unknownBody := []byte(`{"event":{"user":"U-unknown"},"text":"untrusted"}`)
	code, out = signedWebhookRequest(t, server.Client(), webhookURL, unknownBody, slackWebhookSignature("remote-secret", unknownBody))
	if code != http.StatusAccepted || out["pending"] != true {
		t.Fatalf("unknown sender should be pending: %d %#v", code, out)
	}
	if got := channelEventCount(t, deps, "slack"); got != 0 {
		t.Fatalf("unknown sender created %d executable events", got)
	}
	var receiptCount int
	if e := deps.DB.QueryRow(`SELECT COUNT(*) FROM agent_channel_events WHERE tenant_id='ta' AND binding_id=?`, bindingID).Scan(&receiptCount); e != nil || receiptCount != 0 {
		t.Fatalf("unknown sender created receipt events: count=%d err=%v", receiptCount, e)
	}
	var settingsJSON string
	if e := deps.DB.QueryRow(`SELECT settings_json FROM agent_channel_bindings WHERE id=?`, bindingID).Scan(&settingsJSON); e != nil {
		t.Fatal(e)
	}
	var settings map[string]any
	_ = json.Unmarshal([]byte(settingsJSON), &settings)
	pending := settings["pendingUsers"].([]any)
	if len(pending) != 1 || pending[0].(map[string]any)["userKey"] != "U-unknown" {
		t.Fatalf("unknown sender was not quarantined: %#v", settings)
	}

	code, out = request(t, server.Client(), http.MethodPost, server.URL+"/api/remote-channels/"+bindingID+"/access/approve", token, map[string]any{"userKey": "U-unknown"})
	if code != http.StatusOK {
		t.Fatalf("approve sender: %d %#v", code, out)
	}
	spoofedBody := []byte(`{"event":{"user":"U-blocked"},"user":{"id":"U-unknown"},"text":"spoofed"}`)
	code, out = signedWebhookRequest(t, server.Client(), webhookURL, spoofedBody, slackWebhookSignature("remote-secret", spoofedBody))
	if code != http.StatusAccepted || out["pending"] != true || channelEventCount(t, deps, "slack") != 0 {
		t.Fatalf("non-canonical sender alias bypassed policy: %d %#v", code, out)
	}

	allowedBody := unknownBody
	code, out = signedWebhookRequest(t, server.Client(), webhookURL, allowedBody, slackWebhookSignature("remote-secret", allowedBody))
	if code != http.StatusAccepted || out["externalId"] == "" {
		t.Fatalf("approved sender was rejected: %d %#v", code, out)
	}
	if got := channelEventCount(t, deps, "slack"); got != 1 {
		t.Fatalf("approved sender created %d events", got)
	}

	if _, e := deps.DB.Exec(`UPDATE agent_channel_bindings SET settings_json=? WHERE id=?`, `{"allowAll":true,"allowedUsers":[],"pendingUsers":[]}`, bindingID); e != nil {
		t.Fatal(e)
	}
	allowAllBody := []byte(`{"text":"allowed without sender identity"}`)
	code, out = signedWebhookRequest(t, server.Client(), webhookURL, allowAllBody, slackWebhookSignature("remote-secret", allowAllBody))
	if code != http.StatusAccepted || out["externalId"] == "" || channelEventCount(t, deps, "slack") != 2 {
		t.Fatalf("allowAll channel rejected a signed event: %d %#v", code, out)
	}
}

func TestEmailWebhookEnforcesInboundPolicyBeforeQueue(t *testing.T) {
	deps, _, _ := setup(t)
	router := chi.NewRouter()
	RegisterRoutes(router, deps)
	server := httptest.NewServer(router)
	defer server.Close()

	storeConfig := func(config map[string]any) string {
		raw, _ := json.Marshal(config)
		enc, e := encrypt(deps.Secret, "ta:email:mail-1", raw)
		if e != nil {
			t.Fatal(e)
		}
		return enc
	}
	now := deps.Clock().Format(time.RFC3339Nano)
	connector := models.EmailConnectorInstance{
		ID: strPtr("mail-1"), TenantID: "ta", Name: "Inbound", Product: "smtp", Enabled: true,
		ConfigEnc: storeConfig(map[string]any{"inboundSecret": "email-secret", "inboundEnabled": false, "inboundAgentId": "agent-ta", "allowedEmails": "*"}),
		CreatedAt: now, UpdatedAt: now,
	}
	if e := deps.Gorm.Create(&connector).Error; e != nil {
		t.Fatal(e)
	}
	webhookURL := server.URL + "/api/email/inbound/ta/mail-1"
	body := []byte(`{"from":"Alice <alice@example.com>","text":"hello"}`)
	code, out := signedWebhookRequest(t, server.Client(), webhookURL, body, emailWebhookSignature("email-secret", "disabled", body))
	if code != http.StatusAccepted || out["ignored"] != true || channelEventCount(t, deps, "email") != 0 {
		t.Fatalf("disabled inbound email was queued: %d %#v", code, out)
	}

	config := storeConfig(map[string]any{"inboundSecret": "email-secret", "inboundEnabled": true, "inboundAgentId": "agent-ta", "allowedEmails": "alice@example.com"})
	if e := deps.Gorm.Model(&models.EmailConnectorInstance{}).Where("id = ?", "mail-1").Update("config_enc", config).Error; e != nil {
		t.Fatal(e)
	}
	blockedBody := []byte(`{"from":"mallory@example.net","text":"blocked"}`)
	code, out = signedWebhookRequest(t, server.Client(), webhookURL, blockedBody, emailWebhookSignature("email-secret", "blocked", blockedBody))
	if code != http.StatusAccepted || out["ignored"] != true || channelEventCount(t, deps, "email") != 0 {
		t.Fatalf("non-allowlisted email was queued: %d %#v", code, out)
	}
	aliasBody := []byte(`{"from":"alice@example.com","data":{"from":"mallory@example.net"},"text":"alias"}`)
	code, out = signedWebhookRequest(t, server.Client(), webhookURL, aliasBody, emailWebhookSignature("email-secret", "alias", aliasBody))
	if code != http.StatusAccepted || out["ignored"] != true || channelEventCount(t, deps, "email") != 0 {
		t.Fatalf("non-canonical email alias bypassed policy: %d %#v", code, out)
	}

	code, out = signedWebhookRequest(t, server.Client(), webhookURL, body, emailWebhookSignature("email-secret", "allowed", body))
	if code != http.StatusAccepted || out["externalId"] != "allowed" {
		t.Fatalf("allowlisted email was rejected: %d %#v", code, out)
	}
	if got := channelEventCount(t, deps, "email"); got != 1 {
		t.Fatalf("allowlisted email created %d events", got)
	}

	malformedBody := []byte(`{"from":"Alice <alice@example.com>, Mallory <mallory@example.net>","text":"ambiguous"}`)
	code, _ = signedWebhookRequest(t, server.Client(), webhookURL, malformedBody, emailWebhookSignature("email-secret", "ambiguous", malformedBody))
	if code != http.StatusBadRequest || channelEventCount(t, deps, "email") != 1 {
		t.Fatalf("ambiguous sender reached the queue: status=%d", code)
	}
}
