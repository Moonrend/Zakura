// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
)

func TestEmailPollIntervalClamp(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want int
	}{
		{"nil", nil, 30},
		{"zero", 0, 30},
		{"below min", 5, 15},
		{"default", 30, 30},
		{"above max", 1200, 900},
		{"negative", -5, 15},
		{"string", "45", 45},
		{"bad string", "abc", 30},
		{"float", float64(60), 60},
	}
	for _, tc := range cases {
		if got := emailPollInterval(tc.in); got != tc.want {
			t.Fatalf("%s: got %d want %d", tc.name, got, tc.want)
		}
	}
}

func TestAllowedSenderSemantics(t *testing.T) {
	cases := []struct {
		rule   string
		sender string
		want   bool
	}{
		{"*", "anyone@example.com", true},
		{"*@trusted.example.com", "bob@trusted.example.com", true},
		{"*@trusted.example.com", "bob@evil.example.com", false},
		{"@trusted.example.com", "bob@trusted.example.com", true},
		{"@trusted.example.com", "bob@evil.example.com", false},
		{"alice@example.com", "Alice@Example.com", true},
		{"alice@example.com", "Bob <alice@example.com>", true},
		{"alice@example.com", "bob@example.com", false},
	}
	for _, tc := range cases {
		if got := allowedSender(tc.sender, []string{tc.rule}); got != tc.want {
			t.Fatalf("rule %q sender %q: got %v want %v", tc.rule, tc.sender, got, tc.want)
		}
	}
	if emailAddress("Bob <bob@x.com>") != "bob@x.com" {
		t.Fatalf("emailAddress extraction failed: %q", emailAddress("Bob <bob@x.com>"))
	}
}

func TestParseBettermailMailsShapes(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"array", `[{"id":"1","from":"a@b.com"}]`, "1"},
		{"list", `{"list":[{"id":"2","from":"a@b.com"}]}`, "2"},
		{"data.list", `{"data":{"list":[{"id":"3","from":"a@b.com"}]}}`, "3"},
	}
	for _, tc := range cases {
		mails := parseBettermailMails([]byte(tc.raw))
		if len(mails) != 1 || mails[0].ID != tc.want {
			t.Fatalf("%s: got %#v", tc.name, mails)
		}
	}
	if mails := parseBettermailMails([]byte(`{}`)); len(mails) != 0 {
		t.Fatalf("empty object should yield no mail: %#v", mails)
	}
	if mails := parseBettermailMails([]byte(`not-json`)); len(mails) != 0 {
		t.Fatalf("invalid json should yield no mail: %#v", mails)
	}
}

func TestEmailPollerFetchesAndInsertsEvent(t *testing.T) {
	d, _, _ := setup(t)
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path != "/mails" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer tok-1" || r.Header.Get("X-API-Key") != "tok-1" {
			t.Errorf("missing auth headers: %v", r.Header)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["to"] != "inbox@example.com" {
			t.Errorf("unexpected to: %v", body["to"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"list": []map[string]any{
			{"id": "m-1", "from": "alice@trusted.com", "to": "inbox@example.com", "subject": "Hi", "text": "hello", "receivedAt": "2024-01-01T00:00:00Z"},
			{"id": "m-2", "from": "spam@evil.com", "subject": "nope", "text": "bad"},
		}}})
	}))
	defer srv.Close()

	cfg, _ := json.Marshal(map[string]any{
		"baseUrl": srv.URL, "apiToken": "tok-1", "mailbox": "inbox@example.com",
		"inboundEnabled": true, "inboundAgentId": "agent-ta", "allowedEmails": "alice@trusted.com",
		"pollIntervalSeconds": "15",
	})
	enc, e := encrypt(d.Secret, "ta:email:conn-1", cfg)
	if e != nil {
		t.Fatal(e)
	}
	now := d.Clock().Format(time.RFC3339Nano)
	row := models.EmailConnectorInstance{ID: strPtr("conn-1"), TenantID: "ta", Name: "bm", Product: "bettermail", Enabled: true, ConfigEnc: enc, CreatedAt: now, UpdatedAt: now}
	if e := d.Gorm.Create(&row).Error; e != nil {
		t.Fatal(e)
	}

	h := &handler{deps: d, client: &http.Client{Timeout: 5 * time.Second}}
	state := &emailPollerState{lastPoll: map[string]int64{}}
	h.pollEmail(context.Background(), state)

	var count int
	if e := d.DB.QueryRow(`SELECT COUNT(*) FROM channel_events WHERE tenant_id='ta' AND provider='email'`).Scan(&count); e != nil || count != 1 {
		t.Fatalf("event count=%d err=%v", count, e)
	}
	var externalID, payloadJSON string
	if e := d.DB.QueryRow(`SELECT external_id, payload_json FROM channel_events WHERE tenant_id='ta'`).Scan(&externalID, &payloadJSON); e != nil {
		t.Fatal(e)
	}
	if externalID != "m-1" {
		t.Fatalf("external id = %q", externalID)
	}
	var payload map[string]any
	_ = json.Unmarshal([]byte(payloadJSON), &payload)
	if payload["agentId"] != "agent-ta" {
		t.Fatalf("payload missing agentId: %#v", payload)
	}
	if text, _ := payload["text"].(string); !strings.Contains(text, "hello") || !strings.Contains(text, "不可信") {
		t.Fatalf("payload text wrong: %#v", payload["text"])
	}

	h.pollEmail(context.Background(), state)
	if requests.Load() != 1 {
		t.Fatalf("throttle failed, requests=%d", requests.Load())
	}
}
