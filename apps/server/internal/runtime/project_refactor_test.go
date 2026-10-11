package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/refactor"
)

func TestProjectRefactorHTTPNativeWorkerAndIsolatedCandidate(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant-refactor")
	otherToken := seedTenant(t, d, "tenant-refactor-other")
	human := projectTestHumanToken(t, d, "tenant-refactor", "rename-reviewer")
	root := t.TempDir()
	node := "rename-node"
	runnerToken := "rnr_rename-native-runner"
	sum := sha256.Sum256([]byte(runnerToken))
	now := runtimeTimeString(d.Clock())
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES(?,?,?,?,?,'offline',?,'{}','{}',?,'{}',false,?,?)`, node, "tenant-refactor", "Rename Node", "rename-node", "computer", hex.EncodeToString(sum[:]), root, now, now); err != nil {
		t.Fatal(err)
	}
	h, server, shutdown := projectTestServer(t, d)
	defer shutdown()
	space, err := h.store.CreateSpace(context.Background(), "tenant-refactor", Space{Name: "Rename Workspace", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "tenant-refactor", Agent{Name: "Rename Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	definition := mission.Project{TenantID: "tenant-refactor", SpaceID: space.ID, Name: "Compiler-checked rename", Goal: "Refactor an immutable library API", Config: mission.Config{MaxTasks: 10, RequireReview: true, ExternalEffects: "deny", Budget: mission.Budget{MaxTokens: 20000, MaxModelCalls: 20, MaxToolCalls: 30, MaxConcurrent: 1}}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "verify", Title: "Verify renamed artifacts", Prompt: "Read and accept the renamed local project", AgentID: agent.ID, Writes: []string{"lib"}, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "lib/api.go", Required: true}}}}}}
	project, err := h.projects.CreateProject(context.Background(), definition)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "spaces", space.ID, "workspace")
	if err = os.MkdirAll(filepath.Join(source, "lib"), 0700); err != nil {
		t.Fatal(err)
	}
	library := "package lib\n// Exported is documentation.\nfunc Exported(value int) int { return value + 1 }\nfunc Shadow() int { Exported := func() int { return 9 }; return Exported() }\n"
	consumer := "package app\nimport dep \"example.com/rename/lib\"\nfunc Use() int { return dep.Exported(1) }\n"
	projectTestWrite(t, filepath.Join(source, "go.mod"), "module example.com/rename\ngo 1.23\n")
	projectTestWrite(t, filepath.Join(source, "lib/api.go"), library)
	projectTestWrite(t, filepath.Join(source, "main.go"), consumer)
	stop := projectTestRunAgent(t, projectTestAgentBinary(t), server.URL, runnerToken, root)
	defer stop()
	projectTestWaitRunner(t, h, node)
	base, err := h.projectBridge.Base(context.Background(), projectScope(project))
	if err != nil {
		t.Fatal(err)
	}
	url := server.URL + "/api/project-executions/" + project.ID
	code, out := doJSON(t, server.Client(), "GET", url+"/snapshots/"+base+"/semantic/search?q=Exported&kind=function", token, nil)
	projectTestStatus(t, code, 200, out)
	symbols := out["symbols"].([]any)
	if len(symbols) != 1 {
		t.Fatalf("original symbol %#v", out)
	}
	rename := map[string]any{"snapshotId": base, "path": "lib/api.go", "symbolId": symbols[0].(map[string]any)["id"], "newName": "Calculate"}
	code, out = doJSON(t, server.Client(), "POST", url+"/refactors/preview", token, rename)
	projectTestStatus(t, code, 200, out)
	encoded, _ := json.Marshal(out)
	var preview refactor.Preview
	if err = json.Unmarshal(encoded, &preview); err != nil {
		t.Fatal(err)
	}
	if len(preview.Files) != 2 || preview.References != 1 || !preview.ExportedAPIChanged || !preview.RequiresHumanReview {
		t.Fatalf("typed rename preview %#v", preview)
	}
	code, out = doJSON(t, server.Client(), "GET", url+"/branches", token, nil)
	projectTestStatus(t, code, 200, out)
	if len(out["branches"].([]any)) != 0 {
		t.Fatal("preview created a branch before human confirmation")
	}
	apply := map[string]any{}
	for key, value := range rename {
		apply[key] = value
	}
	apply["previewId"] = preview.ID
	apply["confirmation"] = "create_branch"
	code, out = doJSON(t, server.Client(), "POST", url+"/refactors/apply", token, apply)
	projectTestStatus(t, code, 403, out)
	code, out = doJSON(t, server.Client(), "POST", url+"/refactors/apply", otherToken, apply)
	projectTestStatus(t, code, 403, out)
	bad := map[string]any{}
	for key, value := range apply {
		bad[key] = value
	}
	bad["confirmation"] = "merge"
	code, out = doJSON(t, server.Client(), "POST", url+"/refactors/apply", human, bad)
	projectTestStatus(t, code, 400, out)
	code, out = doJSON(t, server.Client(), "POST", url+"/refactors/apply", human, apply)
	projectTestStatus(t, code, 201, out)
	encoded, _ = json.Marshal(out)
	var candidate refactor.Candidate
	if err = json.Unmarshal(encoded, &candidate); err != nil {
		t.Fatal(err)
	}
	if candidate.PreviewID != preview.ID || candidate.SnapshotID == base || candidate.AcceptanceInherited || !candidate.RequiresHumanReview {
		t.Fatalf("candidate %#v", candidate)
	}
	code, repeated := doJSON(t, server.Client(), "POST", url+"/refactors/apply", human, apply)
	projectTestStatus(t, code, 201, repeated)
	if repeated["id"] != candidate.ID || repeated["branchId"] != candidate.BranchID || repeated["snapshotId"] != candidate.SnapshotID {
		t.Fatalf("human retry duplicated branch receipt %#v", repeated)
	}
	code, out = doJSON(t, server.Client(), "GET", url+"/branches", token, nil)
	projectTestStatus(t, code, 200, out)
	if len(out["branches"].([]any)) != 1 {
		t.Fatalf("duplicate candidates %#v", out)
	}
	code, out = doJSON(t, server.Client(), "GET", url+"/snapshots/"+candidate.SnapshotID+"/file?path=main.go", token, nil)
	projectTestStatus(t, code, 200, out)
	if out["content"] != "package app\nimport dep \"example.com/rename/lib\"\nfunc Use() int { return dep.Calculate(1) }\n" {
		t.Fatalf("cross-package reference not changed %#v", out)
	}
	projectTestRead(t, filepath.Join(source, "lib/api.go"), library)
	projectTestRead(t, filepath.Join(source, "main.go"), consumer)

	// Represent a crash after the complete capture proof was fsynced but before
	// the normal operation result became durable. Recovery must verify the CAS
	// patch proof and settle this old intent without creating another branch.
	receiptPath := filepath.Join(root, "projects", space.ID, project.ID, "operations", candidate.ID+".json")
	receiptBytes, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	var receipt map[string]any
	if err = json.Unmarshal(receiptBytes, &receipt); err != nil {
		t.Fatal(err)
	}
	receipt["status"] = "running"
	receipt["result"] = nil
	interrupted, _ := json.Marshal(receipt)
	if err = os.WriteFile(receiptPath, interrupted, 0600); err != nil {
		t.Fatal(err)
	}
	stop()
	stop = projectTestRunAgent(t, projectTestAgentBinary(t), server.URL, runnerToken, root)
	projectTestWaitRunner(t, h, node)
	code, out = doJSON(t, server.Client(), "GET", url+"/refactors/"+candidate.ID, token, nil)
	projectTestStatus(t, code, 200, out)
	if out["snapshotId"] != candidate.SnapshotID {
		t.Fatalf("candidate receipt not durable across actual restart %#v", out)
	}
	recoveredBytes, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(recoveredBytes, &receipt); err != nil || receipt["status"] != "completed" {
		t.Fatalf("capture proof did not settle interrupted receipt %#v %v", receipt, err)
	}
	code, out = doJSON(t, server.Client(), "GET", url+"/branches", token, nil)
	projectTestStatus(t, code, 200, out)
	if len(out["branches"].([]any)) != 1 {
		t.Fatal("proof recovery replayed branch creation")
	}

	code, out = doJSON(t, server.Client(), "GET", url+"/refactors/"+candidate.ID, otherToken, nil)
	projectTestStatus(t, code, 404, out)
	runRequest := map[string]any{"expectedRevision": project.Revision}
	code, out = doJSON(t, server.Client(), "POST", url+"/refactors/"+candidate.ID+"/runs", token, runRequest)
	projectTestStatus(t, code, 403, out)
	code, out = doJSON(t, server.Client(), "POST", url+"/refactors/"+candidate.ID+"/runs", human, map[string]any{"expectedRevision": project.Revision - 1})
	projectTestStatus(t, code, 409, out)
	code, out = doJSON(t, server.Client(), "POST", url+"/refactors/"+candidate.ID+"/runs", human, runRequest)
	projectTestStatus(t, code, 201, out)
	if out["baseSnapshot"] != candidate.SnapshotID || out["modelCalls"] != float64(0) || out["tokens"] != float64(0) {
		t.Fatalf("fresh acceptance run %#v", out)
	}
	rid := out["id"].(string)
	tasks, err := h.projects.ListTasks(context.Background(), project.TenantID, project.ID, rid)
	if err != nil || len(tasks) != 1 || tasks[0].SnapshotID != "" || tasks[0].ReusedFromRunID != "" {
		t.Fatalf("acceptance inherited stale artifacts %#v %v", tasks, err)
	}
	reviews, err := h.projects.ListReviews(context.Background(), project.TenantID, project.ID, rid)
	if err != nil || len(reviews) != 0 {
		t.Fatalf("reviews were inherited %#v %v", reviews, err)
	}
	stop()
	shutdown()
}
