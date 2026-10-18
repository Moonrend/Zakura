// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func uiTestBody() string {
	return `{"catalogVersion":1,"state":{"quantity":2,"query":""},"root":"main","elements":{"main":{"type":"Stack","props":{},"children":["input","total","send"]},"input":{"type":"Input","props":{"label":"数量","type":"number","value":{"$bindState":"/quantity"}},"children":[]},"total":{"type":"Text","props":{"text":{"$computed":"calculate","args":{"operation":"product","values":[{"$state":"/quantity"},10]}}},"children":[]},"send":{"type":"Button","props":{"label":"继续"},"children":[],"on":{"press":{"action":"continueConversation","params":{"message":"继续处理"}}}}}}`
}

func TestGenerativeUIParsesJSONAndPatches(t *testing.T) {
	body := uiTestBody()
	spec, err := parseUISpec(body)
	if err != nil {
		t.Fatal(err)
	}
	var patches strings.Builder
	for _, key := range []string{"catalogVersion", "state", "elements", "root"} {
		raw, _ := json.Marshal(map[string]any{"op": "add", "path": "/" + key, "value": spec[key]})
		patches.Write(raw)
		patches.WriteByte('\n')
	}
	if _, err := parseUISpec(patches.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := parseUISpec(patches.String() + `{"op":"add","path":"/elements/__proto__","value":{}}`); err == nil {
		t.Fatal("prototype path accepted")
	}
	for _, bad := range []string{strings.Replace(body, `"type":"Stack"`, `"type":"HTML"`, 1), strings.Replace(body, `"children":["input","total","send"]`, `"children":["main"]`, 1), strings.Replace(body, `"action":"continueConversation"`, `"action":"fetch"`, 1)} {
		if _, err := parseUISpec(bad); err == nil {
			t.Fatal("invalid UI accepted")
		}
	}
	text := "Before\r\n````markdown\r\n```json-render\r\nignored\r\n```\r\n````\r\n```json-render\r\n" + body + "\r\n```\r\nAfter"
	blocks := uiBlocks(text)
	if len(blocks) != 1 || !blocks[0].Closed || !strings.Contains(blocks[0].Content, `"quantity":2`) {
		t.Fatalf("blocks: %#v", blocks)
	}
	if uiContentDigest(body+"\r\n") != uiContentDigest(body+"\n") {
		t.Fatal("newline normalization differs")
	}
}

func TestUIStateDurabilityRevisionAndIsolation(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	otherToken := seedTenant(t, d, "other")
	store := NewStore(d)
	ctx := context.Background()
	space, err := store.CreateSpace(ctx, "tenant", Space{Name: "S"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	body := uiTestBody()
	content := "```json-render\n" + body + "\n```"
	messageID := "assistant-ui"
	_, err = store.AppendEvent(ctx, "tenant", agent.ID, session.ID, "assistant_message", nil, map[string]any{"messageId": messageID, "content": content})
	if err != nil {
		t.Fatal(err)
	}
	in := uiStateRequest{MessageID: messageID, BlockIndex: 0, CatalogVersion: 1, ContentHash: uiContentDigest(body + "\n"), State: map[string]any{"quantity": float64(5), "query": "filter"}}
	first, err := store.saveUIState(ctx, "tenant", agent.ID, session.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 {
		t.Fatal(first)
	}
	if _, err := store.saveUIState(ctx, "tenant", agent.ID, session.ID, in); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected conflict: %v", err)
	}
	in.ExpectedRevision = 1
	in.State["quantity"] = float64(7)
	second, err := store.saveUIState(ctx, "tenant", agent.ID, session.ID, in)
	if err != nil || second.Revision != 2 {
		t.Fatalf("%#v %v", second, err)
	}
	in.ExpectedRevision = 2
	in.State["quantity"] = "wrong type"
	if _, err := store.saveUIState(ctx, "tenant", agent.ID, session.ID, in); err == nil {
		t.Fatal("invalid state accepted")
	}
	in.State["quantity"] = float64(7)
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	url := server.URL + "/api/agents/" + agent.ID + "/cloud/sessions/" + session.ID + "/ui-state"
	if code, _ := doJSON(t, server.Client(), "PUT", url, otherToken, in); code != 404 {
		t.Fatalf("cross tenant: %d", code)
	}
	code, result := doJSON(t, server.Client(), "PUT", url, token, in)
	if code != 200 || result["revision"] != float64(3) {
		t.Fatalf("HTTP state: %d %#v", code, result)
	}
	events, err := store.ListEvents(ctx, "tenant", agent.ID, session.ID, 0, 100)
	if err != nil || len(events) != 4 || events[3].Type != "ui_state_updated" {
		t.Fatalf("events: %d %v", len(events), err)
	}
	code, fork := doJSON(t, server.Client(), "POST", server.URL+"/api/agents/"+agent.ID+"/cloud/sessions/"+session.ID+"/fork", token, map[string]any{"atSeq": 2})
	if code != 201 {
		t.Fatalf("fork: %d %#v", code, fork)
	}
	forkID, _ := fork["sessionId"].(string)
	forkEvents, err := store.ListEvents(ctx, "tenant", agent.ID, forkID, 0, 100)
	if err != nil || len(forkEvents) != 2 || forkEvents[1].Type != "ui_state_updated" {
		t.Fatalf("fork states: %#v %v", forkEvents, err)
	}
	var forkSnapshot uiStateSnapshot
	_ = json.Unmarshal(forkEvents[1].Payload, &forkSnapshot)
	if forkSnapshot.Revision != 1 || forkSnapshot.State["quantity"] != float64(5) {
		t.Fatalf("fork included later state: %#v", forkSnapshot)
	}
	forkInput := in
	forkInput.ExpectedRevision = 1
	if _, err := store.saveUIState(ctx, "tenant", agent.ID, forkID, forkInput); err != nil {
		t.Fatalf("fork write: %v", err)
	}
	in.MessageID = "missing"
	if code, _ := doJSON(t, server.Client(), "PUT", url, token, in); code != 404 {
		t.Fatalf("missing target: %d", code)
	}
	in.MessageID = messageID
	in.ExpectedRevision = 3
	in.ContentHash = "wrong"
	if code, _ := doJSON(t, server.Client(), "PUT", url, token, in); code != 409 {
		t.Fatalf("hash conflict: %d", code)
	}
}

func TestUIStateSubmissionMessageIsIdempotent(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	ctx := context.Background()
	space, _ := store.CreateSpace(ctx, "tenant", Space{Name: "S"})
	agent, _ := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	session, _ := store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	first, err := store.StartRunWith(ctx, "tenant", agent.ID, session.ID, runStartSpec{MessageID: "submission", Content: "selected state"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store)
	req := TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: session.ID, MessageID: "submission", Content: "selected state", QueueOnConflict: true}
	second, queued, err := service.Start(ctx, req)
	if err != nil || queued != nil || second.ID != first.ID {
		t.Fatalf("duplicate: %#v %#v %v", second, queued, err)
	}
	req.Content = "different state"
	if _, _, err := service.Start(ctx, req); !errors.Is(err, ErrConflict) {
		t.Fatalf("id reuse: %v", err)
	}
	req.MessageID, req.Content = "queued-submission", "next state"
	_, queued, err = service.Start(ctx, req)
	if err != nil || queued == nil {
		t.Fatalf("queue: %#v %v", queued, err)
	}
	if _, duplicate, err := service.Start(ctx, req); err != nil || duplicate == nil || duplicate.ID != queued.ID {
		t.Fatalf("duplicate queue: %#v %v", duplicate, err)
	}
	pending, _ := store.PendingQueue(ctx, "tenant", agent.ID, session.ID)
	if len(pending) != 1 {
		t.Fatalf("duplicate queue entries: %d", len(pending))
	}
}

func TestACPGenerativeUIPromptKeepsUserText(t *testing.T) {
	prompts := make(chan []any, 1)
	fake := &fakeACPAdapter{onRPC: func(_ string, rpc map[string]any, send func(any)) bool {
		if rpc["method"] != "session/prompt" {
			return false
		}
		params, _ := rpc["params"].(map[string]any)
		blocks, _ := params["prompt"].([]any)
		prompts <- blocks
		send(map[string]any{"jsonrpc": "2.0", "id": rpc["id"], "result": map[string]any{"stopReason": "end_turn"}})
		return true
	}}
	manager, agent, session := acpAuthHarness(t, fake)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	rt, err := manager.ensure(ctx, "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err := manager.h.store.StartRun(ctx, "tenant", agent.ID, session.ID, "费用计算器", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.prompt(ctx, run.ID, "费用计算器"); err != nil {
		t.Fatal(err)
	}
	select {
	case blocks := <-prompts:
		if len(blocks) != 2 || blocks[0].(map[string]any)["text"] != "费用计算器" || !strings.Contains(blocks[1].(map[string]any)["text"].(string), "json-render") {
			t.Fatalf("prompt blocks: %#v", blocks)
		}
	case <-ctx.Done():
		t.Fatal("ACP prompt missing")
	}
}

func TestGenerativeUIPromptAvailableWithoutTools(t *testing.T) {
	prompt := buildSystemPrompt(promptInput{Agent: Agent{Name: "A"}, Tools: map[string]bool{}})
	if strings.Contains(generativeUIPrompt, "pushState") || strings.Contains(generativeUIPrompt, "\"repeat\"") || strings.Contains(generativeUIPrompt, "You are a UI generator") {
		t.Fatal("unsupported upstream prompt rules leaked into host capabilities")
	}
	if !strings.Contains(prompt, "json-render") || !strings.Contains(prompt, "continueConversation") {
		t.Fatal("UI prompt missing")
	}
	var catalog struct {
		Version    int            `json:"version"`
		Components map[string]any `json:"components"`
	}
	if json.Unmarshal(generativeUICatalog, &catalog) != nil || catalog.Version != 1 || len(catalog.Components) < 8 {
		t.Fatal("embedded catalog invalid")
	}
}
