// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestZakuraBotMountedAppAndSessionRoutes(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Space"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Bot", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	client := server.Client()
	checks := []struct {
		path, key string
		status    int
	}{{"/api/zakurabot/agents", "agents", 200}, {"/api/zakurabot/bots", "bots", 200}, {"/api/zakurabot/spaces", "spaces", 200}, {"/api/zakurabot/agents/" + agent.ID, "agent", 200}, {"/api/zakurabot/agents/" + agent.ID + "/history", "items", 200}, {"/api/zakurabot/agents/" + agent.ID + "/interactions", "interactions", 200}, {"/api/zakurabot/agents/" + agent.ID + "/messages/missing/reactions", "reactions", 200}, {"/api/zakurabot/sessions/" + agent.ID, "session", 200}}
	for _, check := range checks {
		code, body := doJSON(t, client, http.MethodGet, server.URL+check.path, token, nil)
		if code != check.status || body[check.key] == nil {
			t.Fatalf("%s: %d %#v", check.path, code, body)
		}
	}
	code, body := doJSON(t, client, http.MethodPost, server.URL+"/api/zakurabot/sessions/"+agent.ID, token, map[string]any{"action": "start"})
	if code != 200 || body["session"] == nil {
		t.Fatalf("session start: %d %#v", code, body)
	}
	code, body = doJSON(t, client, http.MethodPost, server.URL+"/api/zakurabot/sessions/"+agent.ID, token, map[string]any{"action": "new"})
	if code != 200 || body["session"] == nil {
		t.Fatalf("session new: %d %#v", code, body)
	}
	code, body = doJSON(t, client, http.MethodPost, server.URL+"/api/zakurabot/sessions/"+agent.ID, token, map[string]any{"action": "stop"})
	if code != 200 || body["session"] == nil {
		t.Fatalf("session stop: %d %#v", code, body)
	}
	code, body = doJSON(t, client, http.MethodPost, server.URL+"/api/zakurabot/agents/"+agent.ID+"/messages/message/reactions", token, map[string]any{"emoji": "👍"})
	if code != 201 || body["reaction"] == nil {
		t.Fatalf("reaction add: %d %#v", code, body)
	}
	req, _ := http.NewRequest(http.MethodDelete, server.URL+"/api/zakurabot/agents/"+agent.ID+"/messages/message/reactions?emoji=%F0%9F%91%8D", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("reaction delete: %d", resp.StatusCode)
	}
	for _, path := range []string{"/api/zakurabot/agents/" + agent.ID + "/desktop", "/api/zakurabot/agents/" + agent.ID + "/desktop/frame"} {
		code, _ = doJSON(t, client, http.MethodGet, server.URL+path, token, nil)
		if code != http.StatusServiceUnavailable && code != http.StatusConflict {
			t.Fatalf("desktop disabled %s: %d", path, code)
		}
	}
	code, _ = doJSON(t, client, http.MethodPost, server.URL+"/api/zakurabot/agents/"+agent.ID+"/exec", token, map[string]any{"command": "pwd"})
	if code != http.StatusConflict {
		t.Fatalf("exec without runner: %d", code)
	}
	code, _ = doJSON(t, client, http.MethodPost, server.URL+"/api/zakurabot/agents/"+agent.ID+"/files", token, map[string]any{})
	if code != http.StatusBadRequest && code != http.StatusRequestEntityTooLarge {
		t.Fatalf("invalid upload: %d", code)
	}
	code, _ = doJSON(t, client, http.MethodGet, server.URL+"/api/zakurabot/agents/"+agent.ID+"/files/missing", token, nil)
	if code != http.StatusNotFound {
		t.Fatalf("missing file: %d", code)
	}
	code, _ = doJSON(t, client, http.MethodGet, server.URL+"/api/zakurabot/agents/"+agent.ID+"/interactions/missing", token, nil)
	if code != http.StatusNotFound {
		t.Fatalf("missing interaction: %d", code)
	}
	code, _ = doJSON(t, client, http.MethodPost, server.URL+"/api/zakurabot/agents/"+agent.ID+"/interactions/missing", token, map[string]any{"text": "x"})
	if code != http.StatusNotFound {
		t.Fatalf("answer missing interaction: %d", code)
	}
}
