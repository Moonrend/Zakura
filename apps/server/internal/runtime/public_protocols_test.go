// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
)

func TestAuthenticatedOTelContractAndFiltering(t *testing.T) {
	forwarded := make(chan map[string]any, 1)
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		forwarded <- body
		w.WriteHeader(http.StatusOK)
	}))
	defer collector.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", collector.URL+"/v1/logs")
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	response, err := http.Get(server.URL + "/api/otel/config")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var config map[string]any
	_ = json.NewDecoder(response.Body).Decode(&config)
	if response.StatusCode != http.StatusOK || config["enabled"] != true || config["collector"] != true || config["ingest"] != "/api/otel/v1/logs" {
		t.Fatalf("public OTel config: %d %#v", response.StatusCode, config)
	}
	payload := func(severity int) map[string]any {
		return map[string]any{
			"resourceLogs": []any{
				map[string]any{
					"resource": map[string]any{},
					"scopeLogs": []any{
						map[string]any{
							"logRecords": []any{
								map[string]any{"severityNumber": severity, "body": map[string]any{"stringValue": "boom"}},
							},
						},
					},
				},
			},
		}
	}
	post := func(body any, token, forwardedFor string) int {
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPost, server.URL+"/api/otel/v1/logs", bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if forwardedFor != "" {
			req.Header.Set("X-Forwarded-For", forwardedFor)
		}
		resp, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if status := post(payload(9), "", "198.51.100.10"); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status %d", status)
	}
	if status := post(payload(9), token, "198.51.100.11"); status != http.StatusNoContent {
		t.Fatalf("info status %d", status)
	}
	if status := post(payload(17), token, "198.51.100.12"); status != http.StatusAccepted {
		t.Fatalf("error status %d", status)
	}
	select {
	case body := <-forwarded:
		raw, _ := json.Marshal(body)
		if !bytes.Contains(raw, []byte(`"user.id"`)) || !bytes.Contains(raw, []byte(`"tenant.id"`)) {
			t.Fatalf("actor IDs not stamped: %s", raw)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("OTel payload was not forwarded")
	}
}

func TestOTelLimiterBoundsAndExpiresIdentityBuckets(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	limits := newOTelLimiter()
	for i := 0; i < otelMaxRateBuckets; i++ {
		if limits.rateLimited(fmt.Sprintf("actor-%d", i), now) {
			t.Fatalf("actor %d was rejected before the bucket cap", i)
		}
	}
	if !limits.rateLimited("overflow", now) {
		t.Fatal("new identity was accepted beyond the bucket cap")
	}
	if len(limits.clients) != otelMaxRateBuckets {
		t.Fatalf("bucket count %d exceeds fixed cap %d", len(limits.clients), otelMaxRateBuckets)
	}
	if limits.rateLimited("fresh", now.Add(otelRateWindow)) {
		t.Fatal("fresh identity was rejected after stale buckets expired")
	}
	if len(limits.clients) != 1 {
		t.Fatalf("expired buckets were not evicted: %d remain", len(limits.clients))
	}
}

func TestOTelLimiterAppliesGlobalResourceCaps(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	clientLimits := newOTelLimiter()
	for request := 0; request < otelClientRequestLimit; request++ {
		if clientLimits.rateLimited("same-actor", now) {
			t.Fatalf("request %d was rejected before the per-client cap", request)
		}
	}
	if !clientLimits.rateLimited("same-actor", now) {
		t.Fatal("request was accepted beyond the per-client cap")
	}

	limits := newOTelLimiter()
	for actor := 0; actor < otelGlobalRequestLimit/otelClientRequestLimit; actor++ {
		for request := 0; request < otelClientRequestLimit; request++ {
			if limits.rateLimited(fmt.Sprintf("actor-%d", actor), now) {
				t.Fatalf("request %d for actor %d was rejected before the global cap", request, actor)
			}
		}
	}
	if !limits.rateLimited("global-overflow", now) {
		t.Fatal("request was accepted beyond the global cap")
	}

	byteLimits := newOTelLimiter()
	if byteLimits.bytesLimited(otelGlobalByteLimit-1, now) || !byteLimits.bytesLimited(2, now) {
		t.Fatal("global byte budget did not reject overflow")
	}
	byteLimits = newOTelLimiter()
	byteLimits.global = otelGlobalBucket{bytes: otelGlobalByteLimit - 1, resetAt: now.Add(otelRateWindow)}
	reader := &otelByteBudgetReader{reader: strings.NewReader("xx"), limits: byteLimits, now: func() time.Time { return now }}
	if _, err := io.ReadAll(reader); !errors.Is(err, errOTelByteBudget) {
		t.Fatalf("body reader did not enforce the global byte budget: %v", err)
	}
	for i := 0; i < otelMaxConcurrentIngest; i++ {
		if !acquireOTelSlot(byteLimits.ingestSlots) {
			t.Fatalf("ingest slot %d was rejected before the concurrency cap", i)
		}
	}
	if acquireOTelSlot(byteLimits.ingestSlots) {
		t.Fatal("ingest was accepted beyond the concurrency cap")
	}
	for i := 0; i < otelMaxConcurrentIngest; i++ {
		<-byteLimits.ingestSlots
	}
	for i := 0; i < otelMaxConcurrentForwards; i++ {
		if !acquireOTelSlot(byteLimits.forwardSlots) {
			t.Fatalf("forward slot %d was rejected before the concurrency cap", i)
		}
	}
	if acquireOTelSlot(byteLimits.forwardSlots) {
		t.Fatal("forward was accepted beyond the concurrency cap")
	}
}

func TestPublicRunnerTokenRoutes(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	token := "rnr_public-route-test"
	sum := sha256.Sum256([]byte(token))
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Node','node','computer','offline',?,'{}','{}','/tmp','{}',FALSE,?,?)`, hex.EncodeToString(sum[:]), now, now)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	heartbeat := func(auth string) (*http.Response, map[string]any) {
		raw := strings.NewReader(`{"agentVersion":"1.2.3","hostInfo":{"os":"linux"}}`)
		req, _ := http.NewRequest(http.MethodPost, server.URL+"/api/runtime-nodes/node/heartbeat", raw)
		req.Header.Set("Authorization", "Bearer "+auth)
		req.Header.Set("Content-Type", "application/json")
		resp, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&body)
		return resp, body
	}
	if response, _ := heartbeat("bad"); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad heartbeat status %d", response.StatusCode)
	}
	response, body := heartbeat(token)
	if response.StatusCode != http.StatusOK || body["node"] == nil {
		t.Fatalf("heartbeat: %d %#v", response.StatusCode, body)
	}
	install, err := http.Get(server.URL + "/api/runtime-nodes/node/install.sh?token=" + url.QueryEscape(token) + "&kind=server")
	if err != nil {
		t.Fatal(err)
	}
	installBody, _ := io.ReadAll(install.Body)
	install.Body.Close()
	if install.StatusCode != http.StatusOK || !bytes.Contains(installBody, []byte("ZAKURA_AGENT_TOKEN")) || !bytes.Contains(installBody, []byte(token)) {
		t.Fatalf("install: %d %s", install.StatusCode, installBody)
	}
	invalid, err := http.Get(server.URL + "/api/runtime-nodes/node/install.sh?token=rnr_wrong")
	if err != nil {
		t.Fatal(err)
	}
	defer invalid.Body.Close()
	if invalid.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invalid install status %d", invalid.StatusCode)
	}
}

func TestZakuraBotRequiresHelloAndReturnsRoster(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO users(id,email,password_hash,name,status,is_platform_admin,created_at,updated_at) VALUES('user','u@example.test','x','User','active',FALSE,?,?)`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.DB.Exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES('member','tenant','user','member','active',?,?)`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Space"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	seed := sha256.Sum256(append(append([]byte{}, d.Secret...), []byte("zakura-oauth-eddsa-v1")...))
	claims := jwt.MapClaims{"iss": d.PublicURL, "sub": "user", "tenantId": "tenant", "scope": "api", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}
	access, err := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims).SignedString(ed25519.NewKeyFromSeed(seed[:]))
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	conn, reader := openRawWebSocket(t, server.URL, "/api/zakurabot/ws", "")
	defer conn.Close()
	writeMaskedText(t, conn, fmt.Sprintf(`{"type":"hello","protocol":1,"token":%q,"client":{"name":"test","version":"1"}}`, access))
	var ready map[string]any
	if err := json.Unmarshal([]byte(readServerText(t, reader)), &ready); err != nil {
		t.Fatal(err)
	}
	agents, _ := ready["agents"].([]any)
	if ready["type"] != "ready" || ready["protocol"] != float64(1) || len(agents) != 1 || agents[0].(map[string]any)["id"] != agent.ID {
		t.Fatalf("ready contract: %#v", ready)
	}
	writeMaskedText(t, conn, `{"type":"ping"}`)
	var agentsFrame, pong map[string]any
	_ = json.Unmarshal([]byte(readServerText(t, reader)), &agentsFrame)
	_ = json.Unmarshal([]byte(readServerText(t, reader)), &pong)
	if agentsFrame["type"] != "agents" || pong["type"] != "pong" {
		t.Fatalf("ping frames: %#v %#v", agentsFrame, pong)
	}

	writeMaskedText(t, conn, fmt.Sprintf(`{"type":"interrupt","agentId":%q,"requestId":"stop-1"}`, agent.ID))
	var stopped map[string]any
	_ = json.Unmarshal([]byte(readServerText(t, reader)), &stopped)
	if stopped["type"] != "interrupt_ack" || stopped["agentId"] != agent.ID || stopped["requestId"] != "stop-1" {
		t.Fatalf("stop must acknowledge without reporting idle: %#v", stopped)
	}
	var threads int64
	if err := d.Gorm.Table("agent_channel_threads").Where("tenant_id=?", "tenant").Count(&threads).Error; err != nil {
		t.Fatal(err)
	}
	if threads != 0 {
		t.Fatal("stopping an idle bot created a conversation")
	}

	queryConn, queryReader := openRawWebSocket(t, server.URL, "/api/zakurabot/ws?token=forbidden", "")
	defer queryConn.Close()
	var rejection map[string]any
	_ = json.Unmarshal([]byte(readServerText(t, queryReader)), &rejection)
	if rejection["type"] != "error" || rejection["fatal"] != true {
		t.Fatalf("query credential rejection: %#v", rejection)
	}
}

func openRawWebSocket(t *testing.T, serverURL, path, authorization string) (net.Conn, *bufio.Reader) {
	t.Helper()
	u, _ := url.Parse(serverURL)
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	headers := ""
	if authorization != "" {
		headers = "Authorization: Bearer " + authorization + "\r\n"
	}
	_, _ = fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\n%sConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", path, u.Host, headers)
	reader := bufio.NewReader(conn)
	status, _ := reader.ReadString('\n')
	if !strings.Contains(status, "101") {
		conn.Close()
		t.Fatalf("upgrade status %s", status)
	}
	for {
		line, _ := reader.ReadString('\n')
		if line == "\r\n" {
			break
		}
	}
	return conn, reader
}
