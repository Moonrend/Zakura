// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/reearth/ygo/crdt"
)

func TestRealtimeAPIKeyNeverInheritsCreatorAdmin(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO users(id,email,password_hash,name,status,is_platform_admin,created_at,updated_at) VALUES('admin','admin@example.test','x','Admin','active',TRUE,?,?)`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.DB.Exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES('membership','tenant','admin','owner','active',?,?)`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	raw := "zak_admin-created-key"
	sum := sha256.Sum256([]byte(raw))
	_, err = d.DB.Exec(`INSERT INTO api_keys(id,tenant_id,user_id,name,key_prefix,key_hash,scopes,created_at) VALUES('admin-key','tenant','admin','created by admin','zak_admin',?,'["*"]',?)`, hex.EncodeToString(sum[:]), now)
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: NewStore(d)}
	p, err := h.authenticateRealtime(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if p.UserID != "api-key" || p.Role != "api_key" || p.IsPlatformAdmin || !p.APIKey || p.APIKeyID != "admin-key" {
		t.Fatalf("API key inherited creator privileges: %#v", p)
	}
}

func engineOpen(t *testing.T, base string) (string, string) {
	t.Helper()
	resp, e := http.Get(base + "/api/socket.io?EIO=4&transport=polling")
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.HasPrefix(string(raw), "0") {
		t.Fatalf("engine open: %d %s", resp.StatusCode, raw)
	}
	var open struct {
		SID      string   `json:"sid"`
		Upgrades []string `json:"upgrades"`
	}
	if json.Unmarshal(raw[1:], &open) != nil || open.SID == "" {
		t.Fatalf("invalid open packet %s", raw)
	}
	return open.SID, base + "/api/socket.io?EIO=4&transport=polling&sid=" + open.SID
}
func enginePost(t *testing.T, url, packet string) {
	t.Helper()
	resp, e := http.Post(url, "text/plain", strings.NewReader(packet))
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(raw) != "ok" {
		t.Fatalf("engine post: %d %s", resp.StatusCode, raw)
	}
}
func enginePoll(t *testing.T, url string) string {
	t.Helper()
	resp, e := http.Get(url)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("engine poll: %d %s", resp.StatusCode, raw)
	}
	return string(raw)
}

func TestSocketIOPollingAuthReplayPresenceAndYjsRelay(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	session, _ := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	_, _ = store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "message.created", nil, map[string]any{"role": "assistant", "content": "backlog"})
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	_, c1 := engineOpen(t, server.URL)
	enginePost(t, c1, `40{"token":"`+token+`"}`)
	packets := enginePoll(t, c1)
	if !strings.Contains(packets, `40{"sid"`) || !strings.Contains(packets, `presence:state`) {
		t.Fatalf("connect packets %s", packets)
	}
	enginePost(t, c1, `421["subscribe:session",{"agentId":"`+agent.ID+`","sessionId":"`+session.ID+`","afterSeq":0}]`)
	packets = enginePoll(t, c1)
	if !strings.Contains(packets, `"cloud"`) || !strings.Contains(packets, `"backlog"`) || !strings.Contains(packets, `431[{"afterSeq":1,"ok":true}]`) {
		t.Fatalf("replay/ack packets %s", packets)
	}
	_, c2 := engineOpen(t, server.URL)
	enginePost(t, c2, `40{"token":"`+token+`"}`)
	_ = enginePoll(t, c2)
	enginePost(t, c1, `42["presence:update",{"agentId":"`+agent.ID+`","sessionId":"`+session.ID+`","pane":"chat"}]`)
	packets = enginePoll(t, c2)
	if !strings.Contains(packets, `presence:update`) || !strings.Contains(packets, agent.ID) {
		t.Fatalf("presence packet %s", packets)
	}
	enginePost(t, c2, `422["sync:sub",{"agentId":"`+agent.ID+`","sessionId":"`+session.ID+`"}]`)
	packets = enginePoll(t, c2)
	if !strings.Contains(packets, `432[{"ok":true`) {
		t.Fatalf("sync ack %s", packets)
	}
	enginePost(t, c1, `423["sync:sub",{"agentId":"`+agent.ID+`","sessionId":"`+session.ID+`"}]`)
	packets = enginePoll(t, c1)
	if !strings.Contains(packets, `433[{"ok":true`) {
		t.Fatalf("sender sync ack %s", packets)
	}
	doc := crdt.New(crdt.WithClientID(101))
	text := doc.GetText("body")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "hello", nil) })
	update := base64.StdEncoding.EncodeToString(crdt.EncodeStateAsUpdateV1(doc, nil))
	enginePost(t, c1, `42["sync:update",{"sessionId":"`+session.ID+`","update":"`+update+`"}]`)
	packets = enginePoll(t, c2)
	if !strings.Contains(packets, `sync:update`) || !strings.Contains(packets, update) {
		t.Fatalf("sync relay %s", packets)
	}
}

func TestYjsStateVectorConcurrentCheckpointAndRestart(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "Y", WorkspaceKind: "local"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Y", SpaceID: space.ID})
	session, _ := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	h := &handler{deps: d, store: store}
	key := yjsDocumentKey("tenant", session.ID)
	realtimeHub.Lock()
	delete(realtimeHub.yjs, key)
	realtimeHub.Unlock()

	makeUpdate := func(client uint64, key, value string) string {
		doc := crdt.New(crdt.WithClientID(crdt.ClientID(client)))
		shared := doc.GetMap("shared")
		doc.Transact(func(txn *crdt.Transaction) { shared.Set(txn, key, value) })
		return base64.StdEncoding.EncodeToString(crdt.EncodeStateAsUpdateV1(doc, nil))
	}
	c1 := &realtimeClient{id: "c1", h: h, principal: httpx.Principal{TenantID: "tenant"}, syncSubs: map[string]bool{session.ID: true}, done: make(chan struct{}), send: func(string) error { return nil }}
	c2 := &realtimeClient{id: "c2", h: h, principal: httpx.Principal{TenantID: "tenant"}, syncSubs: map[string]bool{session.ID: true}, done: make(chan struct{}), send: func(string) error { return nil }}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, item := range []struct {
		client *realtimeClient
		value  string
	}{{c1, makeUpdate(1001, "a", "one")}, {c2, makeUpdate(1002, "b", "two")}} {
		wg.Add(1)
		go func(item struct {
			client *realtimeClient
			value  string
		}) {
			defer wg.Done()
			errs <- item.client.syncUpdate(map[string]any{"sessionId": session.ID, "update": item.value})
		}(item)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	// Drop all in-memory state to prove the compacted database checkpoint is
	// sufficient after a process restart.
	realtimeHub.Lock()
	delete(realtimeHub.yjs, key)
	realtimeHub.Unlock()
	restored, err := h.loadYjsDocument(context.Background(), "tenant", session.ID)
	if err != nil {
		t.Fatal(err)
	}
	restored.mu.Lock()
	full := crdt.EncodeStateAsUpdateV1(restored.doc, nil)
	serverVector := crdt.EncodeStateVectorV1(restored.doc)
	restored.mu.Unlock()
	peer := crdt.New(crdt.WithClientID(2001))
	if err := crdt.ApplyUpdateV1(peer, full, nil); err != nil {
		t.Fatal(err)
	}
	shared := peer.GetMap("shared")
	if a, _ := shared.Get("a"); a != "one" {
		t.Fatalf("lost concurrent value a: %#v", a)
	}
	if b, _ := shared.Get("b"); b != "two" {
		t.Fatalf("lost concurrent value b: %#v", b)
	}
	// A reconnect carrying the current state vector gets an empty diff, proving
	// state-vector negotiation rather than update-history replay.
	var ack map[string]any
	if err := c1.syncSubscribe(map[string]any{"agentId": agent.ID, "sessionId": session.ID, "sv": base64.StdEncoding.EncodeToString(serverVector)}, func(value any) { ack, _ = value.(map[string]any) }); err != nil {
		t.Fatal(err)
	}
	diff, err := base64.StdEncoding.DecodeString(fmt.Sprint(ack["update"]))
	if err != nil {
		t.Fatal(err)
	}
	check := crdt.New()
	if err := crdt.ApplyUpdateV1(check, diff, nil); err != nil {
		t.Fatalf("invalid Yjs reconnect diff: %v", err)
	}
	if len(check.StateVector()) != 0 {
		t.Fatalf("current state vector received non-empty diff: %#v", check.StateVector())
	}
}
