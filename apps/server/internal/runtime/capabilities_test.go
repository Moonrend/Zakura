// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestComposerInventoryAndSessionToolDetails(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Space", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Agent", SpaceID: space.ID, EnableMemory: true})
	if err != nil {
		t.Fatal(err)
	}
	now := d.Clock()
	_, err = d.DB.Exec(`INSERT INTO skills(id,tenant_id,name,title,description,builtin,source_json,files_json,file_count,size_bytes,auto_update,created_at,updated_at) VALUES('skill','tenant','review','Review','Review code',FALSE,'{}','[]',0,0,TRUE,?,?)`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.DB.Exec(`INSERT INTO agent_skills(id,tenant_id,agent_id,skill_id,name,enabled,path,status,created_at,updated_at) VALUES('agent-skill','tenant',?,'skill','review',TRUE,'/skills/review','installed',?,?)`, agent.ID, now, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.DB.Exec(`INSERT INTO provider_catalog(id,name,kind,manifest_json,enabled,updated_at) VALUES('github','GitHub','connector','{"tools":[{"name":"list_issues"},{"name":"create_issue"}]}',TRUE,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.DB.Exec(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,enabled,config_enc,created_at,updated_at) VALUES('install','tenant',?,'github',TRUE,'',?,?)`, agent.ID, now, now)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	code, body := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agents/"+agent.ID+"/cloud/composer", token, nil)
	if code != http.StatusOK {
		t.Fatalf("composer: %d %#v", code, body)
	}
	skills, _ := body["skills"].([]any)
	groups, _ := body["groups"].([]any)
	if len(skills) != 1 || skills[0].(map[string]any)["name"] != "review" || len(groups) < 6 {
		t.Fatalf("non-empty composer inventory: %#v", body)
	}
	foundConnector := false
	for _, raw := range groups {
		group := raw.(map[string]any)
		if group["id"] == "connector:github" {
			foundConnector = true
			tools := group["tools"].([]any)
			if len(tools) != 2 || tools[0] != "github__list_issues" {
				t.Fatalf("connector tools: %#v", group)
			}
		}
	}
	if !foundConnector {
		t.Fatalf("connector group missing: %#v", groups)
	}

	session, err := store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{Title: "Tools"})
	if err != nil {
		t.Fatal(err)
	}
	runID := "run"
	_, _ = store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "tool.started", &runID, map[string]any{"toolCallId": "call-1", "name": "re_github__list_issues", "arguments": map[string]any{"repo": "owner/repo"}})
	_, _ = store.AppendEvent(context.Background(), "tenant", agent.ID, session.ID, "tool.completed", &runID, map[string]any{"toolCallId": "call-1", "result": map[string]any{"count": 2}})
	code, body = doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agents/"+agent.ID+"/cloud/sessions/"+session.ID+"/tools?ids=call-1,missing", token, nil)
	tools, _ := body["tools"].([]any)
	if code != http.StatusOK || len(tools) != 1 {
		t.Fatalf("tool details: %d %#v", code, body)
	}
	detail := tools[0].(map[string]any)
	if detail["toolCallId"] != "call-1" || detail["name"] != "re_github__list_issues" || detail["arguments"] == "" || detail["resultText"] == "" {
		t.Fatalf("tool detail shape: %#v", detail)
	}
}
