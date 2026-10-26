package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestComputerDispatchNeverFallsBack(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	ctx := context.Background()
	space, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES('cloud','tenant',?,'Cloud','e2b','now','now')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	chat, err := h.store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.computerStore().SetSessionDefault(ctx, "tenant", space.ID, chat.ID, "cloud"); err != nil {
		t.Fatal(err)
	}
	run, err := h.store.StartRun(ctx, "tenant", agent.ID, chat.ID, "hi", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx = context.WithValue(ctx, computerRunKey{}, run.ID)
	for _, name := range []string{"shell_exec", "fs_read", "mcp__shell", "instance:exec"} {
		_, err = h.dispatchAgentTool(ctx, "tenant", agent.ID, chat.ID, "call", name, []byte(`{}`))
		if err == nil || !strings.Contains(err.Error(), "never falls back to the server computer") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := h.resolveExecutionGuard(ctx, "tenant", agent.ID, "wrong", nil); err == nil {
		t.Fatal("cross-session execution allowed")
	}
	if _, err := h.resolveExecutionGuard(ctx, "tenant", agent.ID, chat.ID, []byte(`{"computerId":""}`)); err == nil {
		t.Fatal("empty override accepted")
	}
	if _, err := h.resolveExecutionGuard(context.Background(), "tenant", agent.ID, chat.ID, nil); err == nil {
		t.Fatal("missing run accepted")
	}
}

func TestComputerBoundToolClassification(t *testing.T) {
	for _, name := range []string{"shell_exec", "fs_write", "apply_patch", "desktop_info", "mcp__exec", "server:tool"} {
		if !computerBoundTool(name) {
			t.Fatal(name)
		}
	}
	for _, name := range []string{"ask_user", "memory_search", "tool_search", "web_search"} {
		if computerBoundTool(name) {
			t.Fatal(name)
		}
	}
}

func TestListComputersUsesFrozenRunAndScope(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	base := context.Background()
	space, err := h.store.CreateSpace(base, "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(base, "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"one", "two"} {
		if err := d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES(?,'tenant',?,?,'e2b','now','now')`, id, space.ID, id).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, initial := range []string{"", "one"} {
		chat, err := h.store.CreateSession(base, "tenant", "", agent.ID, Session{})
		if err != nil {
			t.Fatal(err)
		}
		if initial != "" {
			if err := h.computerStore().SetSessionDefault(base, "tenant", space.ID, chat.ID, initial); err != nil {
				t.Fatal(err)
			}
		}
		run, err := h.store.StartRun(base, "tenant", agent.ID, chat.ID, "hi", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		ctx := context.WithValue(base, computerRunKey{}, run.ID)
		if err := h.computerStore().SetSessionDefault(base, "tenant", space.ID, chat.ID, "two"); err != nil {
			t.Fatal(err)
		}
		raw, err := h.dispatchAgentTool(ctx, "tenant", agent.ID, chat.ID, "call", "list_computers", []byte(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Computers []map[string]any `json:"computers"`
			Default   *string          `json:"defaultComputerId"`
			Server    *string          `json:"serverComputerId"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Computers) != 3 || result.Server == nil || *result.Server != "server:"+space.ID {
			t.Fatalf("catalog: %s", raw)
		}
		// The Run keeps the computer pinned at its start: the chat's choice then,
		// or the Space server computer, never a choice made afterwards.
		want := initial
		if want == "" {
			want = "server:" + space.ID
		}
		if result.Default == nil || *result.Default != want {
			t.Fatalf("mutable choice leaked: %s", raw)
		}
		for _, c := range result.Computers {
			for _, field := range []string{"secretRef", "settings", "apiKey", "tenantId"} {
				if _, ok := c[field]; ok {
					t.Fatalf("private field %s exposed", field)
				}
			}
		}
		for _, scope := range [][3]string{{"foreign", agent.ID, chat.ID}, {"tenant", "wrong", chat.ID}, {"tenant", agent.ID, "wrong"}} {
			if _, err := h.runListComputers(ctx, scope[0], scope[1], scope[2]); err == nil {
				t.Fatalf("invalid scope accepted: %v", scope)
			}
		}
		if _, err := h.runListComputers(base, "tenant", agent.ID, chat.ID); err == nil {
			t.Fatal("missing Run accepted")
		}
	}
}
