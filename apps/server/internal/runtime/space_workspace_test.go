// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func workspaceTestRouter(h *handler, p httpx.Principal) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), p)))
		})
	})
	h.registerWorkspace(r)
	return r
}
func workspaceTestRequest(t *testing.T, router http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var value map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &value); err != nil {
		t.Fatalf("invalid response %d %s", rec.Code, rec.Body.String())
	}
	return rec.Code, value
}
func TestSpaceWorkspaceZeroAgentsAndLegacyAdapters(t *testing.T) {
	t.Setenv("ZAKURA_WORKSPACE_ROOT", t.TempDir())
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	router := workspaceTestRouter(h, httpx.Principal{TenantID: "tenant"})
	base := "/spaces/" + space.ID
	if code, value := workspaceTestRequest(t, router, "POST", base+"/fs/write", `{"path":"a.txt","content":"space"}`); code != 200 {
		t.Fatalf("write %d %#v", code, value)
	}
	if code, value := workspaceTestRequest(t, router, "POST", base+"/projects", `{"name":"demo","withWorkspace":true}`); code != 200 {
		t.Fatalf("create %d %#v", code, value)
	}
	for _, name := range []string{"A", "B"} {
		agent, e := h.store.CreateAgent(context.Background(), "tenant", Agent{Name: name, SpaceID: space.ID})
		if e != nil {
			t.Fatal(e)
		}
		for _, suffix := range []string{"/fs/read?path=a.txt", "/projects"} {
			code, value := workspaceTestRequest(t, router, "GET", "/agents/"+agent.ID+suffix, "")
			if code != 200 {
				t.Fatalf("adapter %d %#v", code, value)
			}
		}
	}
	if code, value := workspaceTestRequest(t, router, "PUT", base+"/projects/demo/instructions", `{"content":"file rules"}`); code != 200 {
		t.Fatalf("instructions %d %#v", code, value)
	}
	if code, value := workspaceTestRequest(t, router, "GET", base+"/projects", ""); code != 200 || value["projects"].([]any)[0].(map[string]any)["instructions"] != "" {
		t.Fatalf("file unexpectedly overwrote conversation instructions %d %#v", code, value)
	}
}
func TestSpaceWorkspaceAPIKeyBinding(t *testing.T) {
	t.Setenv("ZAKURA_WORKSPACE_ROOT", t.TempDir())
	h, agentID := newWebHandler(t)
	agent, _ := h.store.GetAgent(context.Background(), "tenant", agentID)
	other, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, path string
		p          httpx.Principal
		want       int
	}{
		{"space own", "/spaces/" + agent.SpaceID + "/projects", httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: agent.SpaceID}, 200},
		{"space other", "/spaces/" + other.ID + "/projects", httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: agent.SpaceID}, 404},
		{"agent own adapter", "/agents/" + agentID + "/projects", httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: agentID}, 200},
		{"agent cannot use space", "/spaces/" + agent.SpaceID + "/projects", httpx.Principal{TenantID: "tenant", APIKey: true, AgentID: agentID}, 404},
		{"other tenant", "/spaces/" + agent.SpaceID + "/projects", httpx.Principal{TenantID: "outsider"}, 404},
	} {
		t.Run(test.name, func(t *testing.T) {
			code, value := workspaceTestRequest(t, workspaceTestRouter(h, test.p), "GET", test.path, "")
			if code != test.want {
				t.Fatalf("%d %#v", code, value)
			}
		})
	}
}
func TestSpaceWorkspaceIgnoresSelectedToolComputer(t *testing.T) {
	t.Setenv("ZAKURA_WORKSPACE_ROOT", t.TempDir())
	h, agentID := newWebHandler(t)
	agent, _ := h.store.GetAgent(context.Background(), "tenant", agentID)
	req := httptest.NewRequest("GET", "/", nil)
	req = req.WithContext(context.WithValue(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant"}), computerExecKey{}, &resolvedExecution{nodeID: "wrong", hostRoot: "wrong", spaceID: "wrong"}))
	params := chi.NewRouteContext()
	params.URLParams.Add("id", agentID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, params))
	remote, selected, err := h.requestRemoteWorkspace(req)
	if err != nil || selected || remote != nil {
		t.Fatalf("management inherited selected computer %#v %v %v", remote, selected, err)
	}
	fs, err := h.requestWorkspace(req)
	if err != nil || !strings.HasSuffix(filepath.ToSlash(fs.root), "tenant/"+agent.SpaceID) {
		t.Fatalf("wrong workspace %s %v", fs.root, err)
	}
	// A pinned execution never rereads the Space's now-unbound node and falls
	// back to a local directory; the captured runner must be used or fail.
	_, selected, err = h.remoteWorkspace(context.WithValue(context.Background(), computerExecKey{}, &resolvedExecution{legacy: true, nodeID: "captured-offline", spaceID: agent.SpaceID}), "tenant", agentID)
	if !selected || err == nil {
		t.Fatal("pinned server silently redirected to current Space config")
	}
}
func TestProjectCloneWithoutExecutingServerIsHonest(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ZAKURA_WORKSPACE_ROOT", root)
	h, agentID := newWebHandler(t)
	agent, _ := h.store.GetAgent(context.Background(), "tenant", agentID)
	router := workspaceTestRouter(h, httpx.Principal{TenantID: "tenant"})
	code, value := workspaceTestRequest(t, router, "POST", "/spaces/"+agent.SpaceID+"/projects", `{"name":"clone","gitUrl":"https://example.invalid/repo.git"}`)
	if code != 502 || !strings.Contains(value["error"].(string), "executing Space server") {
		t.Fatalf("clone %d %#v", code, value)
	}
	var count int
	_ = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM space_projects`).Scan(&count)
	if count != 0 {
		t.Fatal("failed clone retained successful project")
	}
	if _, err := os.Stat(filepath.Join(root, "tenant", agent.SpaceID, "projects", "clone")); !os.IsNotExist(err) {
		t.Fatalf("clone silently made empty directory %v", err)
	}
}
func TestProjectRenameDeleteReferencesAndIntentRecovery(t *testing.T) {
	t.Setenv("ZAKURA_WORKSPACE_ROOT", t.TempDir())
	h, agentID := newWebHandler(t)
	ctx := context.Background()
	agent, _ := h.store.GetAgent(ctx, "tenant", agentID)
	router := workspaceTestRouter(h, httpx.Principal{TenantID: "tenant"})
	base := "/spaces/" + agent.SpaceID + "/projects"
	code, value := workspaceTestRequest(t, router, "POST", base, `{"name":"old","withWorkspace":true}`)
	if code != 200 {
		t.Fatalf("create %d %#v", code, value)
	}
	other, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "B", SpaceID: agent.SpaceID})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{agentID, other.ID} {
		project := "old"
		if _, err := h.store.CreateSession(ctx, "tenant", "", id, Session{Title: "test", Project: &project}); err != nil {
			t.Fatal(err)
		}
		if _,err:=h.createScheduleInternal(ctx,"tenant",id,Schedule{Name:"Schedule",Prompt:"test",TriggerKind:"listener",Project:&project});err!=nil{t.Fatal(err)}
	}
	// Offline remote failure retains intent and leaves all metadata/references at old.
	_, err = h.deps.DB.Exec(`UPDATE spaces SET runtime_node_id='offline' WHERE id=?`, agent.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	code, value = workspaceTestRequest(t, router, "PATCH", base+"/old", `{"slug":"new"}`)
	if code != 409 || value["pendingOperation"] == nil {
		t.Fatalf("pending %d %#v", code, value)
	}
	var refs int
	_ = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM cloud_agent_sessions WHERE project='old'`).Scan(&refs)
	if refs != 2 {
		t.Fatal("refs changed before remote operation")
	}
	_, _ = h.deps.DB.Exec(`UPDATE spaces SET runtime_node_id=NULL WHERE id=?`, agent.SpaceID)
	code, value = workspaceTestRequest(t, router, "PATCH", base+"/old", `{"slug":"new"}`)
	if code != 200 {
		t.Fatalf("retry %d %#v", code, value)
	}
	_ = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM cloud_agent_sessions WHERE project='new'`).Scan(&refs)
	if refs != 2 {
		t.Fatal("rename did not synchronize all agents")
	}
	_ = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM agent_schedules WHERE project='new'`).Scan(&refs)
	if refs!=2{t.Fatal("rename did not synchronize schedule references")}
	code, value = workspaceTestRequest(t, router, "DELETE", base+"/new", "")
	if code != 200 {
		t.Fatalf("delete %d %#v", code, value)
	}
	_ = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM cloud_agent_sessions WHERE project IS NOT NULL`).Scan(&refs)
	if refs != 0 {
		t.Fatal("delete did not unbind sessions")
	}
	space, _ := h.store.GetSpace(ctx, "tenant", agent.SpaceID)
	if strings.Contains(string(space.Config), projectIntentsKey) {
		t.Fatalf("intent not cleared %s", space.Config)
	}
}
func TestProjectConfigLegacyPrecedenceAndNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	for file, content := range map[string]string{"CLAUDE.md": "legacy", ".agents/skills/build/SKILL.md": "canonical", ".claude/skills/build/SKILL.md": "legacy", ".zakura/skills/old/SKILL.md": "old", ".claude/settings.json": `{"permissions":{"allow":["safe"]},"hooks":{"Stop":[]}}`} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, file)), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	reader := localProjectReader(dir)
	snapshot := projectSnapshotFromReader("demo", reader)
	if snapshot["instructions"].(map[string]any)["file"] != "CLAUDE.md" {
		t.Fatal(snapshot)
	}
	if skills := snapshot["skills"].([]map[string]any); len(skills) != 2 || skills[0]["path"] != ".agents/skills/build/SKILL.md" {
		t.Fatal(skills)
	}
	if got := projectSkillDirectory(reader, "old"); got != ".zakura/skills/old" {
		t.Fatal(got)
	}
	raw, err := projectHooksContent(reader, ".claude/settings.json", map[string]any{"Stop": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	_ = json.Unmarshal(raw, &settings)
	if settings["permissions"] == nil {
		t.Fatal("hook save overwrote other settings")
	}
	if _, err := projectHooksContent(reader, "AGENTS.md", nil); err == nil {
		t.Fatal("hooks could overwrite instruction file")
	}
}
