package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

// This fixture exercises the public route and the authenticated WebSocket
// runner. It uses captured real files, not a replacement semantic RPC response.
func TestProjectSemanticHTTPRealFrozenArtifactsAndTenantScope(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant-semantic")
	otherToken := seedTenant(t, d, "tenant-semantic-other")
	root := t.TempDir()
	node := "semantic-node"
	runnerToken := "rnr_semantic-runner"
	sum := sha256.Sum256([]byte(runnerToken))
	now := runtimeTimeString(d.Clock())
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES(?,?,?,?,?,'offline',?,'{}','{}',?,'{}',false,?,?)`, node, "tenant-semantic", "Semantic Node", "semantic-node", "computer", hex.EncodeToString(sum[:]), root, now, now); err != nil {
		t.Fatal(err)
	}
	h, server, shutdown := projectTestServer(t, d)
	defer shutdown()
	space, err := h.store.CreateSpace(context.Background(), "tenant-semantic", Space{Name: "Semantic Artifacts", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "tenant-semantic", Agent{Name: "Semantic Author", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	definition := mission.Project{TenantID: "tenant-semantic", SpaceID: space.ID, Name: "Artifact code navigation", Goal: "Track immutable exported APIs", Config: mission.Config{MaxTasks: 10, ExternalEffects: "deny"}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "before", Title: "Baseline", Prompt: "Baseline artifact", AgentID: agent.ID, Writes: []string{"api.go"}, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "api.go", Required: true}}}, {ID: "after", Title: "Revision", Prompt: "Changed artifact", AgentID: agent.ID, Writes: []string{"api.go"}, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "api.go", Required: true}}}}}}
	project, err := h.projects.CreateProject(context.Background(), definition)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "spaces", space.ID, "workspace")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	projectTestWrite(t, filepath.Join(source, "api.go"), "package p\nfunc Exported(value string) int { return 1 }\n")
	stop := projectTestRunAgent(t, projectTestAgentBinary(t), server.URL, runnerToken, root)
	defer stop()
	projectTestWaitRunner(t, h, node)
	base, err := h.projectBridge.Base(context.Background(), projectScope(project))
	if err != nil {
		t.Fatal(err)
	}
	url := server.URL + "/api/project-executions/" + project.ID + "/snapshots/" + base + "/semantic"
	code, out := doJSON(t, server.Client(), "GET", url, token, nil)
	projectTestStatus(t, code, 200, out)
	if out["snapshotId"] != base || out["complete"] != true || out["indexedFiles"] != float64(1) {
		t.Fatalf("semantic summary %#v", out)
	}
	code, out = doJSON(t, server.Client(), "GET", url+"/search?q=Exported&exportedOnly=true&limit=1", token, nil)
	projectTestStatus(t, code, 200, out)
	symbols := out["symbols"].([]any)
	if len(symbols) != 1 || symbols[0].(map[string]any)["confidence"] != "syntax" {
		t.Fatalf("search %#v", out)
	}
	symbolID := symbols[0].(map[string]any)["id"].(string)
	code, out = doJSON(t, server.Client(), "GET", url+"/symbol/"+symbolID, token, nil)
	projectTestStatus(t, code, 200, out)
	if out["symbol"].(map[string]any)["name"] != "Exported" {
		t.Fatalf("navigation %#v", out)
	}
	code, out = doJSON(t, server.Client(), "GET", url+"/file?path=api.go&limit=1", token, nil)
	projectTestStatus(t, code, 200, out)
	if out["truncated"] != true || out["totalSymbols"] != float64(2) {
		t.Fatalf("file bound %#v", out)
	}
	for _, suffix := range []string{"", "/search?q=Exported", "/file?path=api.go", "/symbol/" + symbolID} {
		code, out = doJSON(t, server.Client(), "GET", url+suffix, otherToken, nil)
		projectTestStatus(t, code, 404, out)
	}
	for _, suffix := range []string{"/search?limit=1001", "/search?offset=-1", "/search?exportedOnly=invalid", "/file?path=../api.go", "/symbol/bad", "/compare?before=bad"} {
		code, out = doJSON(t, server.Client(), "GET", url+suffix, token, nil)
		projectTestStatus(t, code, 400, out)
	}
	// Editing original files does not affect the index of an immutable artifact.
	projectTestWrite(t, filepath.Join(source, "api.go"), "package p\nfunc SourceOnly() {}\n")
	code, out = doJSON(t, server.Client(), "GET", url+"/search?q=Exported", token, nil)
	projectTestStatus(t, code, 200, out)
	if out["total"] != float64(1) {
		t.Fatalf("live source leaked into semantic cache %#v", out)
	}
	branch, err := h.projectBridge.Fork(context.Background(), projectScope(project), base, "semantic-artifact-task")
	if err != nil {
		t.Fatal(err)
	}
	var write json.RawMessage
	if err = h.projectBridge.rpc(context.Background(), projectScope(project), "project.branch.write", map[string]any{"operationId": "semantic_http_write", "branchId": branch, "path": "api.go", "content": "package p\nfunc Replacement() {}\n"}, &write); err != nil {
		t.Fatal(err)
	}
	after, err := h.projectBridge.Snapshot(context.Background(), projectScope(project), branch)
	if err != nil {
		t.Fatal(err)
	}
	afterURL := server.URL + "/api/project-executions/" + project.ID + "/snapshots/" + after + "/semantic"
	code, out = doJSON(t, server.Client(), "GET", afterURL+"/compare?before="+base, token, nil)
	projectTestStatus(t, code, 200, out)
	changes := out["apiChanges"].([]any)
	breaking := false
	for _, raw := range changes {
		change := raw.(map[string]any)
		if change["kind"] == "removed" && change["classification"] == "breaking" {
			breaking = true
			if _, ok := change["after"].([]any); !ok {
				t.Fatalf("empty API declarations must be arrays %#v", change)
			}
		}
	}
	if !breaking {
		t.Fatalf("API comparison %#v", out)
	}
	run, err := h.projects.CreateRun(context.Background(), project.TenantID, project.ID, base)
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := h.projects.ListTasks(context.Background(), project.TenantID, project.ID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var left, right string
	for _, task := range tasks {
		task.SnapshotID = base
		if task.Spec.ID == "after" {
			task.SnapshotID = after
			right = task.ID
		} else {
			left = task.ID
		}
		raw, _ := json.Marshal(task)
		if _, err = d.DB.Exec(`UPDATE execution_tasks SET task_json=? WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`, raw, project.TenantID, project.ID, run.ID, task.ID); err != nil {
			t.Fatal(err)
		}
	}
	compareURL := server.URL + "/api/project-executions/" + project.ID + "/runs/" + run.ID + "/semantic/compare?leftTask=" + left + "&rightTask=" + right
	code, out = doJSON(t, server.Client(), "GET", compareURL, token, nil)
	projectTestStatus(t, code, 200, out)
	if out["beforeSnapshot"] != base || out["afterSnapshot"] != after {
		t.Fatalf("task comparison not snapshot-bound %#v", out)
	}
	code, out = doJSON(t, server.Client(), "GET", compareURL, otherToken, nil)
	projectTestStatus(t, code, 404, out)
	second, err := h.projects.CreateRun(context.Background(), project.TenantID, project.ID, base)
	if err != nil {
		t.Fatal(err)
	}
	wrongURL := strings.Replace(compareURL, "/runs/"+run.ID, "/runs/"+second.ID, 1)
	code, out = doJSON(t, server.Client(), "GET", wrongURL, token, nil)
	projectTestStatus(t, code, 404, out)
	// Another project on the same space still has an independent object store.
	definition.Name = "Other scope"
	otherProject, err := h.projects.CreateProject(context.Background(), definition)
	if err != nil {
		t.Fatal(err)
	}
	otherURL := strings.Replace(url, "/"+project.ID+"/", "/"+otherProject.ID+"/", 1)
	code, out = doJSON(t, server.Client(), "GET", otherURL, token, nil)
	if code != 400 && code != 404 {
		t.Fatalf("foreign scoped snapshot was observable: %d %#v", code, out)
	}
	projectTestRead(t, filepath.Join(source, "api.go"), "package p\nfunc SourceOnly() {}\n")
	stop()
	shutdown()
}
