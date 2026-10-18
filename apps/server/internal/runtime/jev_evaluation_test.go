// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func jevFixture(t *testing.T, response string) (*Store, *Gateway, Upstream, ModelRoute, *atomic.Int32) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	calls := &atomic.Int32{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "POST" || r.URL.Path != "/v1/systemone" {
			t.Errorf("native endpoint = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer fixture-key" {
			t.Errorf("missing native Bearer authentication")
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["model"] != jevDefaultModel {
			t.Errorf("invalid native request")
		}
		questions, _ := body["questions"].(map[string]any)
		approval, _ := questions["approval"].(map[string]any)
		criteria, _ := approval["criteria"].(map[string]any)
		if approval["type"] != "choice" || criteria["allow"] == nil || criteria["deny"] == nil || len(criteria) != 2 {
			t.Errorf("invalid approval choice schema: %#v", approval)
		}
		state, _ := body["state"].(map[string]any)
		if state["apiKey"] != nil && state["apiKey"] != "[redacted]" {
			t.Error("evaluation state leaked credential")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(provider.Close)
	store := NewStore(d)
	upstream, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Jev fixture", Protocol: "typesafe", Config: rawJSON(map[string]any{"baseUrl": provider.URL + "/v1", "apiKey": "fixture-key"})})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ensureJevPreset(context.Background(), "tenant", upstream); err != nil {
		t.Fatal(err)
	}
	routes, err := store.ListRoutes(context.Background(), "tenant", "evaluation")
	if err != nil || len(routes) != 1 {
		t.Fatalf("preset routes=%v err=%v", routes, err)
	}
	return store, NewGateway(store), upstream, routes[0], calls
}

const validJevAnswer = `{"model":"jev-1.13.0","answers":{"approval":{"type":"choice","choice":"allow","confidence":0.61,"probabilities":{"allow":0.99,"deny":0.01}}}}`

func TestJevNativeEvaluationConfidenceAndStrictSelection(t *testing.T) {
	store, gateway, _, route, calls := jevFixture(t, validJevAnswer)
	ctx := context.Background()
	for _, selection := range []string{route.ID, *route.Alias} {
		out, err := gateway.evaluateApproval(ctx, "tenant", selection, map[string]any{"tool": "shell", "apiKey": "private-state-key"})
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		_ = json.Unmarshal(out, &result)
		if result["provider"] != "jev" || result["decision"] != "allow" || result["confidence"] != 0.61 || result["model"] != "jev-1.13.0" || result["latencyMs"] == nil {
			t.Fatalf("normalized result=%s", out)
		}
	}
	for _, selection := range []string{"", "deleted-route", jevDefaultModel} {
		if _, err := gateway.evaluateApproval(ctx, "tenant", selection, "test"); err == nil {
			t.Fatalf("selection %q fell back", selection)
		}
	}
	seedTenant(t, store.deps, "other")
	if _, err := gateway.evaluateApproval(ctx, "other", route.ID, "test"); err == nil {
		t.Fatal("cross-tenant evaluation accepted")
	}
	if calls.Load() != 2 {
		t.Fatalf("unexpected calls=%d", calls.Load())
	}
	if err := store.deps.Gorm.Table("upstream_models").Where("upstream_id=?", route.UpstreamID).Delete(nil).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.evaluateApproval(ctx, "tenant", route.ID, "test"); err == nil || calls.Load() != 2 {
		t.Fatal("deleted inventory model must not evaluate or fall back")
	}
}

func TestJevRejectsInvalidAnswers(t *testing.T) {
	cases := []string{
		`{"model":"jev-1","answers":{"approval":{"type":"choice","choice":"allow","probabilities":{"allow":1,"deny":0}}}}`,
		strings.Replace(validJevAnswer, `"confidence":0.61`, `"confidence":null`, 1),
		strings.Replace(validJevAnswer, `"confidence":0.61`, `"confidence":1.1`, 1),
		strings.Replace(validJevAnswer, `"confidence":0.61`, `"confidence":"0.9"`, 1),
		strings.Replace(validJevAnswer, `"choice":"allow"`, `"choice":"approve"`, 1),
		strings.Replace(validJevAnswer, `"type":"choice"`, `"type":"score"`, 1),
		strings.Replace(validJevAnswer, `"model":"jev-1.13.0"`, `"model":"gpt-other"`, 1),
		strings.Replace(validJevAnswer, `"allow":0.99`, `"allow":2`, 1),
		strings.Replace(validJevAnswer, `"deny":0.01`, `"deny":0.8`, 1),
		`{"model":"jev-1","answers":{}}`,
		`not-json`,
	}
	for i, answer := range cases {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			_, gateway, _, route, calls := jevFixture(t, answer)
			if _, err := gateway.evaluateApproval(context.Background(), "tenant", route.ID, "test"); err == nil {
				t.Fatalf("invalid answer accepted: %s", answer)
			}
			if calls.Load() != 1 {
				t.Fatalf("invalid answer retried: %d", calls.Load())
			}
		})
	}
}

func TestJevPresetLocalOnlyAndCannotChat(t *testing.T) {
	store, gateway, upstream, route, calls := jevFixture(t, validJevAnswer)
	ctx := context.Background()
	h := &handler{deps: store.deps, store: store, service: NewService(store)}
	for i := 0; i < 2; i++ {
		if err := store.ensureJevPreset(ctx, "tenant", upstream); err != nil {
			t.Fatal(err)
		}
		list, err := h.fetchUpstreamModelList(ctx, "tenant", upstream)
		if err != nil || len(list) != 1 || list[0].Capability != "evaluation" {
			t.Fatalf("local catalog=%v err=%v", list, err)
		}
		if _, err := h.discoverUpstreamModels(ctx, "tenant", upstream.ID); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("Jev catalog contacted provider")
	}
	if _, err := gateway.doCandidate(ctx, "tenant", "chat", []byte(`{"messages":[]}`), route, upstream); err == nil || calls.Load() != 0 {
		t.Fatal("Jev reached chat endpoint")
	}
	routes, _ := store.ListRoutes(ctx, "tenant", "evaluation")
	if len(routes) != 1 || routes[0].Alias == nil || *routes[0].Alias == "" || routes[0].IsDefault {
		t.Fatalf("non-idempotent preset=%v", routes)
	}
	allRoutes, _ := store.ListRoutes(ctx, "tenant", "")
	if len(allRoutes) != 1 {
		t.Fatalf("Jev preset created chat routes: %v", allRoutes)
	}
	if err := store.deps.Gorm.Table("model_routes").Where("id=?", route.ID).Update("status", "disabled").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.evaluateApproval(ctx, "tenant", route.ID, "test"); err == nil {
		t.Fatal("disabled route accepted")
	}
}

func TestModelCredentialsPreserveClearRedactAndDecryptErrors(t *testing.T) {
	d := testDeps(t)
	cfg := map[string]any{"apiKey": "sentinel-key", "accessToken": "sentinel-access", "refreshToken": "sentinel-refresh"}
	if err := protectModelConfig(d.Secret, "tenant", "up", cfg, ""); err != nil {
		t.Fatal(err)
	}
	enc := cfg["credentialEnc"].(string)
	for _, value := range []any{"", "***", "••••", nil} {
		incoming := map[string]any{"apiKey": value}
		if err := protectModelConfig(d.Secret, "tenant", "up", incoming, enc); err != nil || incoming["credentialEnc"] != enc {
			t.Fatalf("blank/mask did not preserve: %v", err)
		}
	}
	incoming := map[string]any{"apiKey": "replacement", "clearRefreshToken": true}
	if err := protectModelConfig(d.Secret, "tenant", "up", incoming, enc); err != nil {
		t.Fatal(err)
	}
	up := Upstream{ID: "up", Config: rawJSON(incoming)}
	loaded, err := loadUpstreamConfig(d.Secret, "tenant", up)
	if err != nil || loaded.APIKey != "replacement" || loaded.AccessToken != "sentinel-access" {
		t.Fatalf("merged credentials failed: %v", err)
	}
	visible := string(rawJSON(redactUpstream(up)))
	for _, forbidden := range []string{"sentinel-", "replacement", "credentialEnc", `"apiKey"`, `"accessToken"`, `"refreshToken"`} {
		if strings.Contains(visible, forbidden) {
			t.Fatalf("credential response leaked %q", forbidden)
		}
	}
	if !strings.Contains(visible, `"hasApiKey":true`) || !strings.Contains(visible, `"hasRefreshToken":false`) {
		t.Fatalf("missing presence flags=%s", visible)
	}
	cleared := map[string]any{"clearCredentials": true}
	if err := protectModelConfig(d.Secret, "tenant", "up", cleared, enc); err != nil || cleared["credentialEnc"] != nil {
		t.Fatalf("explicit clear failed: %v", err)
	}
	if err := protectModelConfig(d.Secret, "tenant", "up", map[string]any{"apiKey": "new"}, "broken"); err == nil {
		t.Fatal("corrupt envelope silently overwritten")
	}
	if _, err := loadUpstreamConfig(d.Secret, "tenant", Upstream{ID: "up", Config: json.RawMessage(`{"credentialEnc":"broken","apiKey":"fallback"}`)}); err == nil {
		t.Fatal("corrupt envelope silently used plaintext fallback")
	}
}

func TestLegacyJevPendingMigrationPreservesPrivateScope(t *testing.T) {
	d := testDeps(t)
	gate := map[string]any{"jevApiKey": "legacy-private-key", "jevBaseUrl": "https://example.test", "jevModel": "jev-latest", "confidenceThreshold": 0.8, "routeId": "explicit-new-route"}
	if err := protectLegacyJevGate(d.Secret, "tenant", "agent", gate); err != nil {
		t.Fatal(err)
	}
	enc := gate["jevMigrationEnc"].(string)
	if gate["jevApiKey"] != nil || gate["jevBaseUrl"] != nil || gate["jevModel"] != nil || gate["jevMigrationPending"] != true || gate["routeId"] != "explicit-new-route" || strings.Contains(enc, "legacy-private-key") {
		t.Fatalf("unsafe pending migration=%v", gate)
	}
	if err := protectLegacyJevGate(d.Secret, "tenant", "agent", gate); err != nil || gate["jevMigrationEnc"] != enc {
		t.Fatalf("migration not idempotent: %v", err)
	}
	if err := protectLegacyJevGate(d.Secret, "tenant", "other-agent", gate); err == nil {
		t.Fatal("pending secret crossed Agent scope")
	}
	gate["jevApiKey"] = "conflicting-key"
	if err := protectLegacyJevGate(d.Secret, "tenant", "agent", gate); err == nil || gate["jevMigrationEnc"] != enc {
		t.Fatal("migration conflict discarded recovery secret")
	}
	var count int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM model_upstreams`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("private credential promoted to tenant provider: %d %v", count, err)
	}
}

func TestJevStateRedaction(t *testing.T) {
	out := redactEvaluationState(map[string]any{"command": "curl -H 'Authorization: Bearer private-token' https://example.test?api_key=private-key", "nested": []any{map[string]any{"refresh_token": "refresh-private", "tool": "fetch"}}})
	serialized := string(rawJSON(out))
	for _, forbidden := range []string{"private-token", "private-key", "refresh-private"} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("evaluation state leaked %s", forbidden)
		}
	}
}

func TestJevEvaluationCancellation(t *testing.T) {
	_, gateway, _, route, calls := jevFixture(t, validJevAnswer)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	if _, err := gateway.evaluateApproval(ctx, "tenant", route.ID, "test"); err == nil || time.Since(started) > time.Second || calls.Load() != 0 {
		t.Fatal("cancelled evaluation made a provider request")
	}
}

func TestJevHTTPProviderCredentialContract(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	// Creation must not attempt a real external request, even for Jev defaults.
	code, out := doJSON(t, server.Client(), "POST", server.URL+"/api/model-upstreams", token, map[string]any{"name": "Jev", "protocol": "typesafe", "config": map[string]any{"baseUrl": "https://example.invalid", "apiKey": "http-sentinel"}})
	if code != 201 {
		t.Fatalf("create=%d %v", code, out)
	}
	id := out["id"].(string)
	for _, incoming := range []map[string]any{{"apiKey": ""}, {"apiKey": "***"}, {"timeoutMs": 1000}} {
		code, out = doJSON(t, server.Client(), "PATCH", server.URL+"/api/model-upstreams/"+id, token, map[string]any{"config": incoming})
		if code != 200 {
			t.Fatalf("patch=%d %v", code, out)
		}
		visible := string(rawJSON(out))
		if strings.Contains(visible, "http-sentinel") || strings.Contains(visible, "credentialEnc") || !strings.Contains(visible, `"hasApiKey":true`) {
			t.Fatalf("unsafe credential response=%s", visible)
		}
	}
	upstream, err := NewStore(d).GetUpstream(context.Background(), "tenant", id)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := loadUpstreamConfig(d.Secret, "tenant", upstream)
	if err != nil || loaded.APIKey != "http-sentinel" || loaded.BaseURL != "https://example.invalid" {
		t.Fatalf("patch lost credential or connection: %v", err)
	}
}
