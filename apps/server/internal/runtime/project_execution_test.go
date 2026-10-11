// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
)

// This test crosses the public HTTP API, authenticated runner WebSocket,
// provider gateway, SQL execution journal, and the real agent binary. The model
// fixture supplies deterministic decisions; no runner or filesystem operation
// is mocked. Keeping both TCP endpoints in this process also works in isolated
// test network namespaces.
func TestProjectExecutionRealRunnerRecoveryReviewAndMerge(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant-project")
	otherToken := seedTenant(t, d, "tenant-other")
	humanToken := projectTestHumanToken(t, d, "tenant-project", "reviewer")
	storageRoot := t.TempDir()
	binary := projectTestAgentBinary(t)
	runnerToken := "rnr_project-integration-runner"
	hash := sha256.Sum256([]byte(runnerToken))
	now := runtimeTimeString(d.Clock())
	_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('project-node','tenant-project','Project Runner','project-runner','computer','offline',?,'{}','{}',?,'{}',false,?,?)`, hex.EncodeToString(hash[:]), storageRoot, now, now)
	if err != nil {
		t.Fatal(err)
	}
	node := "project-node"
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant-project", Space{Name: "Project Workspace", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant-project", Agent{Name: "Project Author", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	boundToken := "zk_project-bound-agent"
	boundHash := sha256.Sum256([]byte(boundToken))
	if _, err = d.DB.Exec(`INSERT INTO api_keys(id,tenant_id,agent_id,space_id,name,key_prefix,key_hash,created_at) VALUES('project-bound-key','tenant-project',?,?,'Bound key','zk_pro',?,?)`, agent.ID, space.ID, hex.EncodeToString(boundHash[:]), now); err != nil {
		t.Fatal(err)
	}
	sourceRoot := filepath.Join(storageRoot, "spaces", space.ID, "workspace")
	if err = os.MkdirAll(sourceRoot, 0700); err != nil {
		t.Fatal(err)
	}
	projectTestWrite(t, filepath.Join(sourceRoot, "feature.txt"), "baseline\n")
	projectTestWrite(t, filepath.Join(sourceRoot, "note.txt"), "initial note\n")
	orphanIDs := []string{"prior_writer_a", "prior_writer_b"}
	projectTestSeedSourceIntents(t, storageRoot, space.ID, orphanIDs)

	var modelCalls atomic.Int32
	blockedAfterWrite := make(chan struct{}, 1)
	var blockOnce sync.Once
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		modelCalls.Add(1)
		if r.Header.Get("Authorization") != "Bearer project-provider-key" {
			t.Errorf("gateway did not authenticate provider request: %q", r.Header.Get("Authorization"))
		}
		var payload struct {
			Messages  []map[string]any `json:"messages"`
			MaxTokens int64            `json:"max_tokens"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.MaxTokens < 128 {
			t.Errorf("invalid bounded provider request: %v, max_tokens=%d", err, payload.MaxTokens)
			w.WriteHeader(400)
			return
		}
		var first, receiptRecovery bool
		var tools []string
		for _, message := range payload.Messages {
			text, _ := message["content"].(string)
			first = first || strings.Contains(text, "TASK_ONE")
			receiptRecovery = receiptRecovery || strings.Contains(text, "RECOVER_RECEIPT")
			if message["role"] == "tool" {
				id, _ := message["tool_call_id"].(string)
				tools = append(tools, id)
			}
		}
		if first && len(tools) > 0 {
			shouldBlock := false
			blockOnce.Do(func() { shouldBlock = true })
			if shouldBlock {
				blockedAfterWrite <- struct{}{}
				<-r.Context().Done()
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		var message map[string]any
		finish := "tool_calls"
		switch {
		case receiptRecovery:
			finish = "stop"
			message = map[string]any{"role": "assistant", "content": "The persisted runner receipt confirms the branch artifact was written."}
		case first && len(tools) == 0:
			message = projectTestToolMessage("create_feature", "fs_write", map[string]any{"path": "feature.txt", "content": "new feature\n"})
		case first:
			finish = "stop"
			message = map[string]any{"role": "assistant", "content": "Created the feature artifact with the required contents."}
		case len(tools) == 0:
			message = projectTestToolMessage("inspect_dependency", "fs_read", map[string]any{"path": "feature.txt"})
		case len(tools) == 1:
			if text, _ := payload.Messages[len(payload.Messages)-1]["content"].(string); !strings.Contains(text, "new feature") {
				t.Errorf("dependent task did not receive materialized dependency contents: %s", text)
			}
			message = projectTestToolMessage("derive_artifact", "fs_write", map[string]any{"path": "derived.txt", "content": "derived from new feature\n"})
		default:
			finish = "stop"
			message = map[string]any{"role": "assistant", "content": "Read the dependency branch and created its derived artifact."}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message, "finish_reason": finish}}, "usage": map[string]any{"total_tokens": 50}})
	}))
	t.Cleanup(provider.Close)
	upstream, err := store.CreateUpstream(context.Background(), "tenant-project", Upstream{Name: "Project Fixture", Protocol: "openai", Config: raw(map[string]any{"baseUrl": provider.URL, "apiKey": "project-provider-key"})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateRoute(context.Background(), "tenant-project", ModelRoute{Name: "Project Model", Capability: "chat", UpstreamID: upstream.ID, Model: "project-model", IsDefault: true}); err != nil {
		t.Fatal(err)
	}

	h, server, shutdown := projectTestServer(t, d)
	stopAgent := projectTestRunAgent(t, binary, server.URL, runnerToken, storageRoot)
	projectTestWaitRunner(t, h, node)
	if err = h.projectEngine.Start(h.deps.Context); err != nil {
		t.Fatal(err)
	}
	base := server.URL + "/api/project-executions"
	code, out := doJSON(t, server.Client(), "GET", base, "", nil)
	projectTestStatus(t, code, 401, out)
	config := mission.Config{MaxTasks: 20, RequireReview: true, ExternalEffects: "deny", Budget: mission.Budget{MaxTokens: 150000, MaxModelCalls: 20, MaxToolCalls: 20, MaxWallSeconds: 120, MaxConcurrent: 2}}
	definition := projectDefinitionBody{SpaceID: space.ID, Name: "Dependency artifact pipeline", Goal: "Produce a reviewed feature and its dependent artifact", Config: config, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{
		{ID: "author", Title: "Author feature", Prompt: "TASK_ONE: write feature.txt with new feature", AgentID: agent.ID, Writes: []string{"feature.txt"}, MaxAttempts: 2, Checks: []mission.CheckSpec{{ID: "feature-content", Kind: "text_contains", Path: "feature.txt", Pattern: "new feature", Required: true}}},
		{ID: "derive", Title: "Derive result", Prompt: "TASK_TWO: inspect feature.txt and create derived.txt", AgentID: agent.ID, DependsOn: []string{"author"}, Writes: []string{"derived.txt"}, MaxAttempts: 2, Checks: []mission.CheckSpec{{ID: "derived-content", Kind: "text_contains", Path: "derived.txt", Pattern: "derived from new feature", Required: true}}},
	}}}
	code, created := doJSON(t, server.Client(), "POST", base, token, definition)
	projectTestStatus(t, code, 201, created)
	pid := projectTestString(t, created, "id")
	projectURL := base + "/" + pid
	code, out = doJSON(t, server.Client(), "GET", projectURL, otherToken, nil)
	projectTestStatus(t, code, 404, out)
	code, out = doJSON(t, server.Client(), "GET", base, boundToken, nil)
	projectTestStatus(t, code, 403, out)
	code, out = doJSON(t, server.Client(), "GET", base, otherToken, nil)
	projectTestStatus(t, code, 200, out)
	if items, ok := out["items"].([]any); !ok || len(items) != 0 {
		t.Fatalf("cross-tenant project listing: %#v", out)
	}
	definition.ExpectedRevision = int64(created["revision"].(float64))
	definition.Goal = "Produce immutable reviewed feature artifacts across restarts"
	code, updated := doJSON(t, server.Client(), "PATCH", projectURL, token, definition)
	projectTestStatus(t, code, 200, updated)
	code, out = doJSON(t, server.Client(), "PATCH", projectURL, token, definition)
	projectTestStatus(t, code, 409, out)
	projectTestSourceRecovery(t, h, server, d, pid, space.ID, storageRoot, token, humanToken, orphanIDs, definition, false, func() {
		stopAgent()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := h.hub.get(node); err != nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("disconnected source runner remained available")
	}, func() {
		stopAgent = projectTestRunAgent(t, binary, server.URL, runnerToken, storageRoot)
		projectTestWaitRunner(t, h, node)
	})
	invalid := definition.Plan
	invalid.Tasks = append([]mission.TaskSpec(nil), invalid.Tasks...)
	invalid.Tasks[0].DependsOn = []string{"derive"}
	code, out = doJSON(t, server.Client(), "POST", projectURL+"/plan/validate", token, map[string]any{"plan": invalid})
	projectTestStatus(t, code, 422, out)
	code, out = doJSON(t, server.Client(), "POST", projectURL+"/runs", token, map[string]any{"expectedRevision": definition.ExpectedRevision})
	projectTestStatus(t, code, 409, out)
	code, runJSON := doJSON(t, server.Client(), "POST", projectURL+"/runs", token, map[string]any{"expectedRevision": updated["revision"]})
	projectTestStatus(t, code, 201, runJSON)
	rid := projectTestString(t, runJSON, "id")
	runURL := projectURL + "/runs/" + rid
	select {
	case <-blockedAfterWrite:
	case <-time.After(15 * time.Second):
		_, out = doJSON(t, server.Client(), "GET", runURL, token, nil)
		t.Fatalf("first persisted write was not followed by a model decision: %#v", out)
	}
	tasks, err := h.projects.ListTasks(context.Background(), "tenant-project", pid, rid)
	if err != nil {
		t.Fatal(err)
	}
	first := projectTestTask(t, tasks, "author")
	ops, err := h.projects.ListOperations(context.Background(), "tenant-project", pid, rid, first.ID)
	if err != nil || len(ops) != 1 || ops[0].Status != "completed" || ops[0].Call.Effect != "workspace_write" {
		t.Fatalf("write was not persisted before the next model request: %+v %v", ops, err)
	}
	writeOperation := ops[0]
	if first.SessionID == "" || first.BranchID == "" {
		t.Fatalf("task identity was not durable: %+v", first)
	}
	firstSession := first.SessionID
	for _, mutation := range []struct {
		method, suffix string
		body           any
	}{
		{"POST", "/messages", map[string]any{"content": "interfering prompt"}},
		{"POST", "/cancel", map[string]any{}},
		{"POST", "/fork", map[string]any{}},
		{"PATCH", "", map[string]any{"title": "interfering title"}},
		{"DELETE", "", nil},
	} {
		code, out = doJSON(t, server.Client(), mutation.method, server.URL+"/api/agents/"+agent.ID+"/cloud/sessions/"+first.SessionID+mutation.suffix, token, mutation.body)
		projectTestStatus(t, code, 409, out)
	}
	projectTestRead(t, filepath.Join(sourceRoot, "feature.txt"), "baseline\n")
	if _, err = os.Stat(filepath.Join(sourceRoot, "derived.txt")); !os.IsNotExist(err) {
		t.Fatalf("isolated task touched the original workspace: %v", err)
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err = h.projectEngine.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	stopCancel()
	stopAgent()
	shutdown()

	// Rebuild the server handler, engine, runner process and all in-memory caches;
	// only SQLite and the agent's files survive this restart.
	h, server, shutdown = projectTestServer(t, d)
	stopAgent = projectTestRunAgent(t, binary, server.URL, runnerToken, storageRoot)
	projectTestWaitRunner(t, h, node)
	if err = h.projectEngine.Start(h.deps.Context); err != nil {
		t.Fatal(err)
	}
	base = server.URL + "/api/project-executions"
	projectURL = base + "/" + pid
	runURL = projectURL + "/runs/" + rid
	first = projectTestWaitTask(t, h, pid, rid, "author", "waiting_review")
	if first.SessionID != firstSession {
		t.Fatalf("restart replaced managed task session: %+v", first)
	}
	code, artifact := doJSON(t, server.Client(), "GET", projectURL+"/branches/"+first.BranchID+"/file?path=feature.txt", humanToken, nil)
	projectTestStatus(t, code, 200, artifact)
	if artifact["content"] != "new feature\n" {
		t.Fatalf("reviewer cannot inspect the isolated task branch: %#v", artifact)
	}
	code, artifact = doJSON(t, server.Client(), "GET", projectURL+"/snapshots/"+first.SnapshotID+"/file?path=feature.txt", humanToken, nil)
	projectTestStatus(t, code, 200, artifact)
	if artifact["content"] != "new feature\n" || artifact["snapshotId"] != first.SnapshotID {
		t.Fatalf("reviewer cannot inspect the exact immutable artifact: %#v", artifact)
	}
	code, out = doJSON(t, server.Client(), "GET", projectURL+"/branches/"+first.BranchID+"/file?path=..%2Fnote.txt", humanToken, nil)
	projectTestStatus(t, code, 400, out)
	code, out = doJSON(t, server.Client(), "GET", projectURL+"/snapshots/"+first.SnapshotID+"/file?path=feature.txt", otherToken, nil)
	projectTestStatus(t, code, 404, out)
	ops, err = h.projects.ListOperations(context.Background(), "tenant-project", pid, rid, first.ID)
	if err != nil || len(ops) != 1 || ops[0].ID != writeOperation.ID || !ops[0].UpdatedAt.Equal(writeOperation.UpdatedAt) {
		t.Fatalf("recovery replayed or replaced the completed write: %+v %v", ops, err)
	}
	projectTestApproveTask(t, server, runURL, token, humanToken, first)
	second := projectTestWaitTask(t, h, pid, rid, "derive", "waiting_review")
	if second.BaseSnapshot != first.SnapshotID {
		t.Fatalf("dependency artifact did not become the dependent branch baseline: %+v %+v", first, second)
	}
	projectTestApproveTask(t, server, runURL, token, humanToken, second)
	completed := projectTestWaitRun(t, h, pid, rid, "completed")
	if completed.ToolCalls != 3 || completed.ModelCalls != 6 || modelCalls.Load() != 6 || completed.Tokens != 8192+5*50 {
		t.Fatalf("execution or recovery duplicated model/tool decisions: run=%+v provider_calls=%d", completed, modelCalls.Load())
	}
	code, out = doJSON(t, server.Client(), "POST", runURL+"/fork", token, map[string]any{"expectedProjectRevision": updated["revision"].(float64) - 1})
	projectTestStatus(t, code, 409, out)
	code, forkedJSON := doJSON(t, server.Client(), "POST", runURL+"/fork", token, map[string]any{"expectedProjectRevision": updated["revision"]})
	projectTestStatus(t, code, 201, forkedJSON)
	forked := projectTestDecode[mission.Run](t, forkedJSON)
	if forked.ID == completed.ID || forked.BaseSnapshot != completed.BaseSnapshot || forked.ModelCalls != 0 || forked.ToolCalls != 0 {
		t.Fatalf("fork replaced its source run or repeated completed work: %+v", forked)
	}
	forkTasks, err := h.projects.ListTasks(context.Background(), "tenant-project", pid, forked.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, previous := range []mission.Task{first, second} {
		retained := projectTestTask(t, forkTasks, previous.Spec.ID)
		if retained.ID == previous.ID || retained.Status != "waiting_review" || retained.SnapshotID != previous.SnapshotID || retained.ReusedFromTaskID != previous.ID || retained.ReusedFromRunID != rid {
			t.Fatalf("fork did not bind retained output to fresh task review: %+v", retained)
		}
		projectTestApproveTask(t, server, projectURL+"/runs/"+forked.ID, token, humanToken, retained)
	}
	forked = projectTestWaitRun(t, h, pid, forked.ID, "completed")
	if forked.ModelCalls != 0 || forked.ToolCalls != 0 || forked.Tokens != 0 || modelCalls.Load() != 6 {
		t.Fatalf("accepted fork incurred fresh execution: %+v, provider_calls=%d", forked, modelCalls.Load())
	}
	code, detail := doJSON(t, server.Client(), "GET", runURL+"/tasks/"+second.ID, token, nil)
	projectTestStatus(t, code, 200, detail)
	checks := detail["verifications"].([]any)
	if len(checks) != 1 || checks[0].(map[string]any)["snapshotId"] != second.SnapshotID {
		t.Fatalf("acceptance was not bound to the immutable snapshot: %#v", detail)
	}
	code, out = doJSON(t, server.Client(), "GET", runURL+"/compare?leftTask="+first.ID+"&rightTask="+second.ID, token, nil)
	projectTestStatus(t, code, 200, out)
	if len(out["diff"].([]any)) != 1 {
		t.Fatalf("artifact comparison did not isolate derived file: %#v", out)
	}
	code, events := doJSON(t, server.Client(), "GET", projectURL+"/events?runId="+rid, token, nil)
	projectTestStatus(t, code, 200, events)
	if len(events["items"].([]any)) < 10 || events["cursor"].(float64) <= 0 {
		t.Fatalf("missing persistent execution timeline: %#v", events)
	}
	code, later := doJSON(t, server.Client(), "GET", projectURL+"/events?runId="+rid+"&after="+fmt.Sprint(int64(events["cursor"].(float64))), token, nil)
	projectTestStatus(t, code, 200, later)
	if len(later["items"].([]any)) != 0 {
		t.Fatalf("event cursor repeated existing history: %#v", later)
	}
	projectTestRead(t, filepath.Join(sourceRoot, "feature.txt"), "baseline\n")
	preview := projectTestMergePreview(t, server, runURL, token, completed, first, second)
	if preview.Status != "ready" || preview.Plan.Result.ID != second.SnapshotID {
		t.Fatalf("merged snapshot was not validated: %+v", preview)
	}
	preview = projectTestMergeReview(t, server, runURL, token, humanToken, preview)
	projectTestWrite(t, filepath.Join(sourceRoot, "note.txt"), "concurrent source edit\n")
	code, uncertain := doJSON(t, server.Client(), "POST", runURL+"/merges/"+preview.ID+"/apply", humanToken, map[string]any{"expectedRevision": preview.Revision, "confirmation": "merge"})
	projectTestStatus(t, code, 202, uncertain)
	if uncertain["status"] != "unknown" {
		t.Fatalf("stale source mutation was not retained for reconciliation: %#v", uncertain)
	}
	projectTestRead(t, filepath.Join(sourceRoot, "feature.txt"), "baseline\n")
	code, reconciled := doJSON(t, server.Client(), "POST", runURL+"/merges/"+preview.ID+"/reconcile", humanToken, map[string]any{"expectedRevision": uncertain["revision"], "decision": "inspect", "comment": "Inspect the durable runner operation without replaying it."})
	projectTestStatus(t, code, 200, reconciled)
	if reconciled["status"] != "abandoned" {
		t.Fatalf("pre-effect runner rejection was not reconciled: %#v", reconciled)
	}

	projectTestWrite(t, filepath.Join(sourceRoot, "feature.txt"), "manual competing feature\n")
	conflicted := projectTestMergePreview(t, server, runURL, token, completed, first, second)
	if conflicted.Status != "conflicted" || len(conflicted.Plan.Conflicts) != 1 {
		t.Fatalf("overlapping source edit was not surfaced as a merge conflict: %+v", conflicted)
	}
	code, resolvedJSON := doJSON(t, server.Client(), "POST", runURL+"/merges/"+conflicted.ID+"/resolve", humanToken, map[string]any{"expectedRevision": conflicted.Revision, "resolutions": []map[string]any{{"conflictId": conflicted.Plan.Conflicts[0].ID, "choice": "theirs"}}})
	projectTestStatus(t, code, 201, resolvedJSON)
	resolved := projectTestDecode[projectMergePreview](t, resolvedJSON)
	if resolved.ID == conflicted.ID || resolved.Status != "ready" || resolved.OriginalPreviewID != conflicted.ID {
		t.Fatalf("resolution did not create a newly verified preview: %+v", resolved)
	}
	code, out = doJSON(t, server.Client(), "POST", runURL+"/merges/"+resolved.ID+"/review", humanToken, map[string]any{"expectedRevision": resolved.Revision, "snapshotId": conflicted.Plan.Result.ID, "decision": "approved", "comment": "Wrong snapshot must not approve a resolved artifact."})
	projectTestStatus(t, code, 409, out)
	resolved = projectTestMergeReview(t, server, runURL, token, humanToken, resolved)
	applyURL := runURL + "/merges/" + resolved.ID + "/apply"
	code, out = doJSON(t, server.Client(), "POST", applyURL, humanToken, map[string]any{"expectedRevision": resolved.Revision})
	projectTestStatus(t, code, 400, out)
	code, out = doJSON(t, server.Client(), "POST", applyURL, token, map[string]any{"expectedRevision": resolved.Revision, "confirmation": "merge"})
	projectTestStatus(t, code, 403, out)
	code, out = doJSON(t, server.Client(), "POST", applyURL, humanToken, map[string]any{"expectedRevision": resolved.Revision - 1, "confirmation": "merge"})
	projectTestStatus(t, code, 409, out)
	code, applied := doJSON(t, server.Client(), "POST", applyURL, humanToken, map[string]any{"expectedRevision": resolved.Revision, "confirmation": "merge"})
	projectTestStatus(t, code, 200, applied)
	if applied["status"] != "applied" {
		t.Fatalf("approved immutable result was not merged: %#v", applied)
	}
	projectTestRead(t, filepath.Join(sourceRoot, "feature.txt"), "new feature\n")
	projectTestRead(t, filepath.Join(sourceRoot, "derived.txt"), "derived from new feature\n")
	projectTestRead(t, filepath.Join(sourceRoot, "note.txt"), "concurrent source edit\n")
	code, audited := doJSON(t, server.Client(), "GET", runURL+"/merges/"+resolved.ID, humanToken, nil)
	projectTestStatus(t, code, 200, audited)
	if len(audited["audit"].([]any)) != 3 {
		t.Fatalf("missing human review and merge intent/completion audit: %#v", audited)
	}
	projectTestRecoverRunnerReceipt(t, h, d, space.ID, agent.ID, sourceRoot, storageRoot)
	stopAgent()
	shutdown()
}

func projectTestServer(t *testing.T, d *appdeps.Dependencies) (*handler, *httptest.Server, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	copyDeps := *d
	d = &copyDeps
	d.Context = ctx
	h := &handler{deps: d, store: NewStore(d), mcpSessions: map[string]spaceMCPSession{}}
	h.hub = newRunnerHub(d)
	h.service = NewService(h.store)
	h.acp = newACPRuntimeManager(h)
	h.service.catalogProvider = func(ctx context.Context, tenant, agent string) (agentCatalog, error) {
		return h.cachedAgentToolCatalog(ctx, tenant, agent)
	}
	h.service.loadedTools = h.sessionLoadedTools
	h.service.toolRunner = h.dispatchAgentTool
	h.projects = projectexec.NewStore(d.DB, d.Dialect, d.Rebind)
	h.initializeProjectKnowledge()
	h.initializeProjectRequirements()
	h.initializeProjectSignoffs()
	h.projectBridge = &projectBridge{h: h}
	h.projectEngine = projectexec.NewEngine(h.projects, h.projectBridge, h.projectBridge, projectexec.EngineConfig{WorkerID: d.NewID(), Workers: 2, Lease: 500 * time.Millisecond, HeartbeatInterval: 100 * time.Millisecond, PollInterval: 20 * time.Millisecond, MaxDecisionTokens: 8192})
	router := chi.NewRouter()
	router.Handle("/api/runtime-nodes/hub", http.HandlerFunc(h.runnerHubHTTP))
	router.Route("/api", func(api chi.Router) {
		api.Use(httpx.Auth(d))
		api.Use(RequireAPIScope)
		api.Use(h.guardProjectManagedSession)
		h.registerCore(api)
		h.registerProjectExecutions(api)
	})
	server := httptest.NewServer(router)
	var once sync.Once
	shutdown := func() {
		once.Do(func() {
			cancel()
			stopCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if err := h.projectEngine.Stop(stopCtx); err != nil {
				t.Errorf("stop project engine: %v", err)
			}
			server.Close()
		})
	}
	t.Cleanup(shutdown)
	return h, server, shutdown
}

func projectTestHumanToken(t *testing.T, d *appdeps.Dependencies, tenant, user string, roles ...string) string {
	t.Helper()
	role := "member"
	if len(roles) > 0 {
		role = roles[0]
	}
	now := d.Clock()
	expires := now.Add(time.Hour)
	sid := "session-" + user
	claims := jwt.MapClaims{"sub": user, "tenantId": tenant, "email": user + "@example.test", "role": role, "sid": sid, "iat": now.Unix(), "exp": expires.Unix()}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(d.Secret)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(token))
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,created_at,updated_at) VALUES(?,?,?,?)`, []any{user, user + "@example.test", runtimeTimeString(now), runtimeTimeString(now)}},
		{`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)`, []any{"membership-" + user, tenant, user, role, runtimeTimeString(now), runtimeTimeString(now)}},
		{`INSERT INTO user_sessions(id,user_id,tenant_id,email,role,token_hash,expires_at,last_seen_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, []any{sid, user, tenant, user + "@example.test", role, hex.EncodeToString(sum[:]), runtimeTimeString(expires), runtimeTimeString(now), runtimeTimeString(now)}},
	} {
		if _, err = d.DB.Exec(query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	return token
}

func projectTestAgentBinary(t *testing.T) string {
	t.Helper()
	if binary := os.Getenv("ZAKURA_TEST_AGENT_BINARY"); binary != "" {
		return binary
	}
	_, filename, _, ok := goruntime.Caller(0)
	if !ok {
		t.Fatal("locate repository for real runner build")
	}
	binary := filepath.Join(t.TempDir(), "zakura-agent")
	command := exec.Command(filepath.Join(goruntime.GOROOT(), "bin", "go"), "build", "-o", binary, "./cmd/zakura-agent")
	command.Dir = filepath.Clean(filepath.Join(filepath.Dir(filename), "../../../../apps/agent"))
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build actual agent binary: %v\n%s", err, output)
	}
	return binary
}

func projectTestRunAgent(t *testing.T, binary, server, token, root string) func() {
	t.Helper()
	command := exec.Command(binary, "-server", server, "-token", token, "-data", root, "-kind", "computer")
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = command.Process.Signal(os.Interrupt)
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("real agent process: %v\n%s", err, output.String())
				}
			case <-time.After(5 * time.Second):
				_ = command.Process.Kill()
				<-done
				t.Errorf("real agent did not stop gracefully:\n%s", output.String())
			}
		})
	}
	t.Cleanup(stop)
	return stop
}

func projectTestWaitRunner(t *testing.T, h *handler, node string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := h.hub.get(node); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("actual agent did not connect to authenticated runner hub")
}

func projectTestToolMessage(id, name string, args map[string]any) map[string]any {
	raw, _ := json.Marshal(args)
	return map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": string(raw)}}}}
}

func projectTestWaitTask(t *testing.T, h *handler, pid, rid, spec, status string) mission.Task {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var task mission.Task
	for time.Now().Before(deadline) {
		tasks, err := h.projects.ListTasks(context.Background(), "tenant-project", pid, rid)
		if err != nil {
			t.Fatal(err)
		}
		task = projectTestTask(t, tasks, spec)
		if task.Status == status {
			return task
		}
		if task.Status == "failed" || task.Status == "cancelled" {
			t.Fatalf("task failed while awaiting %s: %+v", status, task)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("task did not reach %s: %+v", status, task)
	return task
}

func projectTestWaitRun(t *testing.T, h *handler, pid, rid, status string) mission.Run {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var run mission.Run
	for time.Now().Before(deadline) {
		var err error
		run, err = h.projects.GetRun(context.Background(), "tenant-project", pid, rid)
		if err != nil {
			t.Fatal(err)
		}
		if run.Status == status {
			return run
		}
		if run.Status == "failed" || run.Status == "cancelled" {
			t.Fatalf("run failed while awaiting %s: %+v", status, run)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("run did not reach %s: %+v", status, run)
	return run
}

func projectTestTask(t *testing.T, tasks []mission.Task, spec string) mission.Task {
	t.Helper()
	for _, task := range tasks {
		if task.Spec.ID == spec {
			return task
		}
	}
	t.Fatalf("task spec %s absent from %+v", spec, tasks)
	return mission.Task{}
}

func projectTestApproveTask(t *testing.T, server *httptest.Server, runURL, apiToken, humanToken string, task mission.Task) {
	t.Helper()
	reviewURL := runURL + "/tasks/" + task.ID + "/reviews"
	body := map[string]any{"snapshotId": task.SnapshotID, "decision": "approved", "comment": "Inspected the exact immutable artifact and its acceptance evidence."}
	code, out := doJSON(t, server.Client(), "POST", reviewURL, apiToken, body)
	projectTestStatus(t, code, 403, out)
	code, out = doJSON(t, server.Client(), "POST", reviewURL, humanToken, map[string]any{"snapshotId": "wrong-snapshot", "decision": "approved", "comment": "Reject stale artifact approval."})
	projectTestStatus(t, code, 409, out)
	code, out = doJSON(t, server.Client(), "POST", reviewURL, humanToken, body)
	projectTestStatus(t, code, 201, out)
	if out["authorId"] != "reviewer" || out["snapshotId"] != task.SnapshotID {
		t.Fatalf("review identity or immutable artifact binding changed: %#v", out)
	}
	code, out = doJSON(t, server.Client(), "POST", reviewURL, humanToken, body)
	projectTestStatus(t, code, 409, out)
}

func projectTestMergePreview(t *testing.T, server *httptest.Server, runURL, token string, run mission.Run, tasks ...mission.Task) projectMergePreview {
	t.Helper()
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
	}
	code, out := doJSON(t, server.Client(), "POST", runURL+"/merges/preview", token, map[string]any{"taskIds": ids, "expectedRunRevision": run.Revision})
	projectTestStatus(t, code, 201, out)
	return projectTestDecode[projectMergePreview](t, out)
}

func projectTestMergeReview(t *testing.T, server *httptest.Server, runURL, apiToken, humanToken string, preview projectMergePreview) projectMergePreview {
	t.Helper()
	body := map[string]any{"expectedRevision": preview.Revision, "snapshotId": preview.Plan.Result.ID, "decision": "approved", "comment": "Reviewed the combined immutable artifact and rerun acceptance evidence."}
	url := runURL + "/merges/" + preview.ID + "/review"
	code, out := doJSON(t, server.Client(), "POST", url, apiToken, body)
	projectTestStatus(t, code, 403, out)
	code, out = doJSON(t, server.Client(), "POST", url, humanToken, body)
	projectTestStatus(t, code, 200, out)
	reviewed := projectTestDecode[projectMergePreview](t, out)
	if reviewed.Status != "approved" || reviewed.ReviewedBy != "reviewer" || reviewed.ReviewID == "" {
		t.Fatalf("human review not retained: %+v", reviewed)
	}
	return reviewed
}

func projectTestDecode[T any](t *testing.T, value map[string]any) T {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out T
	if err = json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func projectTestString(t *testing.T, value map[string]any, key string) string {
	t.Helper()
	out, ok := value[key].(string)
	if !ok || out == "" {
		t.Fatalf("missing %s in %#v", key, value)
	}
	return out
}

func projectTestStatus(t *testing.T, got, expected int, body map[string]any) {
	t.Helper()
	if got != expected {
		t.Fatalf("HTTP %d, expected %d: %#v", got, expected, body)
	}
}

func projectTestWrite(t *testing.T, file, contents string) {
	t.Helper()
	if err := os.WriteFile(file, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
}

func projectTestRead(t *testing.T, file, expected string) {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil || string(raw) != expected {
		t.Fatalf("artifact %s: %q, expected %q: %v", filepath.Base(file), raw, expected, err)
	}
}

func projectTestRecoverRunnerReceipt(t *testing.T, h *handler, d *appdeps.Dependencies, spaceID, agentID, sourceRoot, storageRoot string) {
	t.Helper()
	ctx := context.Background()
	stopCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	if err := h.projectEngine.Stop(stopCtx); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	p, err := h.projects.CreateProject(ctx, mission.Project{TenantID: "tenant-project", SpaceID: spaceID, Name: "Recover a dispatched artifact write", Goal: "Recover an acknowledged runner effect without repeating it", Config: mission.Config{MaxTasks: 10, ExternalEffects: "deny", Budget: mission.Budget{MaxTokens: 50000, MaxModelCalls: 10, MaxToolCalls: 10, MaxWallSeconds: 120, MaxConcurrent: 1}}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "receipt", Title: "Recover runner receipt", Prompt: "RECOVER_RECEIPT: finish the artifact recorded by the durable runner operation", AgentID: agentID, Writes: []string{"receipt.txt"}, MaxAttempts: 2, Checks: []mission.CheckSpec{{ID: "receipt-contents", Kind: "text_contains", Path: "receipt.txt", Pattern: "written once", Required: true}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	scope := projectScope(p)
	base, err := h.projectBridge.Base(ctx, scope)
	if err != nil {
		t.Fatal(err)
	}
	run, err := h.projects.CreateRun(ctx, p.TenantID, p.ID, base)
	if err != nil {
		t.Fatal(err)
	}
	a, err := h.projects.ClaimTask(ctx, "interrupted-worker", 500*time.Millisecond)
	if err != nil || a == nil || a.Run.ID != run.ID {
		t.Fatalf("claim receipt task: %+v %v", a, err)
	}
	ref := projectexec.FenceRequest{Scope: scope, RunID: run.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}
	branch, err := h.projectBridge.Fork(ctx, scope, base, a.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.projects.InitializeTaskBranch(ctx, ref, branch, base); err != nil {
		t.Fatal(err)
	}
	a.Task.BranchID, a.Task.BaseSnapshot = branch, base
	cp, err := h.projects.SaveCheckpoint(ctx, ref, mission.Checkpoint{TaskID: a.Task.ID, Messages: []mission.Message{{"role": "user", "content": a.Task.Spec.Prompt}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.projects.ReserveDecisionBudget(ctx, ref, 100); err != nil {
		t.Fatal(err)
	}
	call := mission.ToolCall{ID: "receipt-write", Name: "fs_write", Arguments: raw(map[string]any{"path": "receipt.txt", "content": "written once\n"}), Effect: "workspace_write"}
	cp, err = h.projects.RecordModelDecision(ctx, ref, cp.Sequence, mission.Decision{Message: projectTestToolMessage(call.ID, call.Name, map[string]any{"path": "receipt.txt", "content": "written once\n"}), Tools: []mission.ToolCall{call}, Tokens: 50})
	if err != nil {
		t.Fatal(err)
	}
	a.Checkpoint = cp
	op, created, err := h.projects.BeginOperation(ctx, ref, cp.ID, call)
	if err != nil || !created {
		t.Fatalf("prepare receipt write: %+v %v", op, err)
	}
	op, err = h.projects.StartOperation(ctx, ref, op.ID, op.Revision)
	if err != nil {
		t.Fatal(err)
	}
	result, err := h.projectBridge.Perform(ctx, *a, op)
	if err != nil || result.Error != "" {
		t.Fatalf("real runner write: %+v %v", result, err)
	}
	journalPath := filepath.Join(storageRoot, "projects", spaceID, p.ID, "operations", op.ID+".json")
	before, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	var recorded struct {
		Status string          `json:"status"`
		Result json.RawMessage `json:"result"`
	}
	if err = json.Unmarshal(before, &recorded); err != nil || recorded.Status != "completed" || !bytes.Equal(recorded.Result, result.Content) {
		t.Fatalf("runner did not durably acknowledge its effect: %s %v", before, err)
	}
	// The simulated interruption is precisely after the real runner receipt and
	// before CompleteOperation. The next worker must inspect, rather than invoke,
	// this still-running SQL operation.
	h.projectEngine = projectexec.NewEngine(h.projects, h.projectBridge, h.projectBridge, projectexec.EngineConfig{WorkerID: "receipt-recovery-worker", Workers: 1, Lease: 500 * time.Millisecond, HeartbeatInterval: 100 * time.Millisecond, PollInterval: 20 * time.Millisecond, MaxDecisionTokens: 8192})
	if err = h.projectEngine.Start(h.deps.Context); err != nil {
		t.Fatal(err)
	}
	completed := projectTestWaitRun(t, h, p.ID, run.ID, "completed")
	if completed.ModelCalls != 2 || completed.ToolCalls != 1 {
		t.Fatalf("receipt recovery added decisions or effects: %+v", completed)
	}
	ops, err := h.projects.ListOperations(ctx, p.TenantID, p.ID, run.ID, a.Task.ID)
	if err != nil || len(ops) != 1 || ops[0].ID != op.ID || ops[0].Status != "completed" || !bytes.Equal(ops[0].Result, result.Content) {
		t.Fatalf("runner receipt did not reconcile the existing operation: %+v %v", ops, err)
	}
	after, err := os.ReadFile(journalPath)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("receipt recovery modified or replayed the runner journal: before=%s after=%s err=%v", before, after, err)
	}
	if _, err = os.Stat(filepath.Join(sourceRoot, "receipt.txt")); !os.IsNotExist(err) {
		t.Fatalf("receipt recovery leaked its branch artifact into the source: %v", err)
	}
}

func TestProjectExecutionRejectsUncheckpointableModelDecisions(t *testing.T) {
	catalog := agentCatalog{Tools: []agentTool{{Name: "fs_write", Kind: "builtin"}, {Name: "vendor_mutation", Kind: "mcp"}}}
	for _, test := range []struct{ name, response string }{
		{"invalid arguments", `{"choices":[{"message":{"tool_calls":[{"id":"one","function":{"name":"fs_write","arguments":"{"}}]}}]}`},
		{"array arguments", `{"choices":[{"message":{"tool_calls":[{"id":"one","function":{"name":"fs_write","arguments":"[]"}}]}}]}`},
		{"null arguments", `{"choices":[{"message":{"tool_calls":[{"id":"one","function":{"name":"fs_write","arguments":"null"}}]}}]}`},
		{"missing call identity", `{"choices":[{"message":{"tool_calls":[{"function":{"name":"fs_write","arguments":"{}"}}]}}]}`},
		{"unavailable tool", `{"choices":[{"message":{"tool_calls":[{"id":"one","function":{"name":"memory_remember","arguments":"{}"}}]}}]}`},
		{"duplicate call identity", `{"choices":[{"message":{"tool_calls":[{"id":"one","function":{"name":"fs_write","arguments":"{}"}},{"id":"one","function":{"name":"fs_write","arguments":"{}"}}]}}]}`},
		{"truncated result", `{"choices":[{"message":{"content":"Looks complete"},"finish_reason":"length"}]}`},
		{"filtered result", `{"choices":[{"message":{"content":"Looks complete"},"finish_reason":"content_filter"}]}`},
		{"empty finished result", `{"choices":[{"message":{"content":"  "},"finish_reason":"stop"}]}`},
		{"negative usage", `{"choices":[{"message":{"content":"Done"}}],"usage":{"total_tokens":-1}}`},
		{"missing assistant", `{"usage":{"total_tokens":100}}`},
		{"truncated anthropic", `{"content":[{"type":"text","text":"Done"}],"stop_reason":"max_tokens"}`},
		{"malformed anthropic input", `{"content":[{"type":"tool_use","id":"one","name":"fs_write","input":[]}]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if decision, err := parseProjectDecision([]byte(test.response), catalog); err == nil {
				t.Fatalf("unsafe model response became a persistent decision: %+v", decision)
			}
		})
	}
	decision, err := parseProjectDecision([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"first","function":{"name":"fs_write","arguments":"{\"path\":\"out.txt\",\"content\":\"hello\"}"}},{"id":"second","function":{"name":"vendor_mutation","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":125}}`), catalog)
	if err != nil || decision.Done || decision.Tokens != 125 || len(decision.Tools) != 2 || decision.Tools[0].Effect != "workspace_write" || decision.Tools[1].Effect != "external_write" {
		t.Fatalf("model effects were not classified from the actual catalog: %+v %v", decision, err)
	}
	decision, err = parseProjectDecision([]byte(`{"content":[{"type":"tool_use","id":"first","name":"fs_write","input":{"path":"out.txt","content":"hello"}}],"stop_reason":"tool_use","usage":{"input_tokens":30,"output_tokens":20}}`), catalog)
	if err != nil || decision.Done || decision.Tokens != 50 || len(decision.Tools) != 1 || decision.Tools[0].Effect != "workspace_write" {
		t.Fatalf("Anthropic decision did not retain usage and effect identity: %+v %v", decision, err)
	}
}

func TestProjectModelProjectionRetainsCompleteToolGroups(t *testing.T) {
	a := mission.Assignment{Project: mission.Project{Goal: "Preserve dependency artifacts"}, Task: mission.Task{Spec: mission.TaskSpec{Title: "Continue", Prompt: "Inspect before editing", Writes: []string{"src"}}}, DependencyResults: map[string]string{"prior": "The dependency is complete"}}
	a.Checkpoint.Messages = []mission.Message{
		projectTestToolMessage("old-call", "fs_read", map[string]any{"path": "old.txt", "description": strings.Repeat("large previous context ", 1000)}),
		{"role": "tool", "tool_call_id": "old-call", "content": strings.Repeat("old tool output ", 1000)},
		{"role": "assistant", "content": "Earlier group finished"},
		projectTestToolMessage("current-call", "fs_read", map[string]any{"path": "src/current.txt"}),
		{"role": "tool", "tool_call_id": "current-call", "content": "Current artifact contents"},
	}
	messages, err := projectModelMessages(a, "fs_read inspects the isolated branch", 4096)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(messages)
	if err != nil || len(encoded) > 4096 || bytes.Contains(encoded, []byte("old-call")) || !bytes.Contains(encoded, []byte("current-call")) {
		t.Fatalf("bounded model projection split or retained oversized groups: %s %v", encoded, err)
	}
	seenCalls := map[string]bool{}
	for _, message := range messages {
		if message["role"] == "tool" {
			if id, _ := message["tool_call_id"].(string); !seenCalls[id] {
				t.Fatalf("projection contains orphaned tool result: %#v", message)
			}
		}
		if calls, ok := message["tool_calls"].([]any); ok {
			for _, call := range calls {
				seenCalls[call.(map[string]any)["id"].(string)] = true
			}
		}
	}
	// Projection must not mutate the authoritative checkpoint messages.
	if len(a.Checkpoint.Messages) != 5 || a.Checkpoint.Messages[0]["tool_calls"].([]any)[0].(map[string]any)["id"] != "old-call" {
		t.Fatal("model projection mutated the persistent journal")
	}
}

func TestProjectExecutionRequiresApplicationLifetimeContext(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant-context")
	h := &handler{deps: d, store: NewStore(d)}
	h.initializeProjectExecutions()
	if h.projectStartErr == nil {
		t.Fatal("project engine started without a managed application context")
	}
	router := chi.NewRouter()
	h.registerProjectExecutions(router)
	request := httptest.NewRequest(http.MethodGet, "/project-executions/", nil)
	request = request.WithContext(httpx.WithPrincipal(request.Context(), httpx.Principal{TenantID: "tenant-context", UserID: "member", Role: "member"}))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 503 {
		t.Fatalf("uninitialized engine accepted work: %d %s", response.Code, response.Body)
	}
	if err := h.projectEngine.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func projectTestSeedSourceIntents(t *testing.T, storageRoot, spaceID string, ids []string) {
	t.Helper()
	root := filepath.Join(storageRoot, "source-processes")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		// Represent an active registration left by a previous agent instance. No
		// live host process is created; the real restarted agent must load these
		// intents conservatively and require the operator's explicit attestation.
		data, err := json.Marshal(map[string]any{"id": id, "spaceId": spaceID, "state": "active", "startedAt": time.Now().Add(-time.Hour).UTC(), "updatedAt": time.Now().Add(-time.Hour).UTC()})
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(root, id+".json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func projectTestSourceRecovery(t *testing.T, h *handler, server *httptest.Server, d *appdeps.Dependencies, pid, spaceID, storageRoot, apiToken, memberToken string, ids []string, definition projectDefinitionBody, drain bool, disconnect, reconnect func()) {
	t.Helper()
	otherProject, err := h.projects.CreateProject(context.Background(), mission.Project{TenantID: "tenant-project", SpaceID: spaceID, Name: "Separate source audit scope", Goal: definition.Goal, Plan: definition.Plan, Config: definition.Config})
	if err != nil {
		t.Fatal(err)
	}
	adminToken := projectTestHumanToken(t, d, "tenant-project", "source-admin", "admin")
	ownerToken := projectTestHumanToken(t, d, "tenant-project", "source-owner", "owner")
	otherOwnerToken := projectTestHumanToken(t, d, "tenant-other", "source-other-owner", "owner")
	url := server.URL + "/api/project-executions/" + pid + "/source"
	code, activities := doJSON(t, server.Client(), "GET", url+"/activities", memberToken, nil)
	projectTestStatus(t, code, 200, activities)
	records, ok := activities["activities"].([]any)
	if !ok || len(records) != len(ids) {
		t.Fatalf("real agent lost prior source writer intents: %#v", activities)
	}
	for i, raw := range records {
		activity := raw.(map[string]any)
		if activity["id"] != ids[i] || activity["spaceId"] != spaceID || activity["status"] != "orphaned" || activity["runtimeLive"] != false {
			t.Fatalf("restart treated an orphan as a known live process: %#v", activity)
		}
	}
	code, out := doJSON(t, server.Client(), "GET", url+"/activities", otherOwnerToken, nil)
	projectTestStatus(t, code, 404, out)
	request := map[string]any{"activityIds": ids, "confirmation": "writers_stopped", "comment": "The prior source writers were stopped and their exact intents inspected."}
	for _, denied := range []string{memberToken, apiToken} {
		code, out = doJSON(t, server.Client(), "POST", url+"/quiescence", denied, request)
		projectTestStatus(t, code, 403, out)
		code, out = doJSON(t, server.Client(), "GET", url+"/attestations", denied, nil)
		projectTestStatus(t, code, 403, out)
	}
	code, out = doJSON(t, server.Client(), "POST", url+"/quiescence", otherOwnerToken, request)
	projectTestStatus(t, code, 404, out)
	// Exercise the route's OAuth boundary after authentication has supplied a
	// principal. Even an owner-shaped OAuth principal cannot attest human action.
	focused := chi.NewRouter()
	focused.Route("/api", h.registerProjectExecutions)
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	oauthRequest := httptest.NewRequest("POST", "/api/project-executions/"+pid+"/source/quiescence", bytes.NewReader(encoded))
	oauthRequest = oauthRequest.WithContext(httpx.WithPrincipal(oauthRequest.Context(), httpx.Principal{TenantID: "tenant-project", UserID: "source-owner", Role: "owner", SessionID: "oauth-session", OAuth: true}))
	oauthResponse := httptest.NewRecorder()
	focused.ServeHTTP(oauthResponse, oauthRequest)
	if oauthResponse.Code != 403 {
		t.Fatalf("OAuth principal attested source writers: %d %s", oauthResponse.Code, oauthResponse.Body)
	}
	for _, invalid := range []map[string]any{
		{"activityIds": ids, "confirmation": "writers_stopped", "comment": " "},
		{"activityIds": ids, "confirmation": "writers_stopped", "comment": strings.Repeat("x", 4097)},
		{"activityIds": ids, "confirmation": "writers_stopped", "comment": strings.Repeat("界", 1366)},
		{"activityIds": ids, "confirmation": "approve", "comment": "Different confirmation phrase"},
		{"activityIds": []string{}, "confirmation": "writers_stopped", "comment": "No exact source activity set"},
		{"activityIds": []string{ids[0], ids[0]}, "confirmation": "writers_stopped", "comment": "Duplicate source activity"},
	} {
		code, out = doJSON(t, server.Client(), "POST", url+"/quiescence", adminToken, invalid)
		projectTestStatus(t, code, 400, out)
	}
	var count int
	if err = d.DB.QueryRow(`SELECT COUNT(*) FROM execution_source_attestations WHERE tenant_id='tenant-project' AND project_id=?`, pid).Scan(&count); err != nil || count != 0 {
		t.Fatalf("denied or malformed attestation reached the RPC intent journal: %d %v", count, err)
	}
	code, incomplete := doJSON(t, server.Client(), "POST", url+"/quiescence", adminToken, map[string]any{"activityIds": ids[:1], "confirmation": "writers_stopped", "comment": "This incomplete set must remain protected."})
	projectTestStatus(t, code, 202, incomplete)
	if incomplete["status"] != "unknown" {
		t.Fatalf("RPC rejection was not retained for receipt inspection: %#v", incomplete)
	}
	incompleteID := projectTestString(t, incomplete, "id")
	code, activities = doJSON(t, server.Client(), "GET", url+"/activities", ownerToken, nil)
	projectTestStatus(t, code, 200, activities)
	if len(activities["activities"].([]any)) != len(ids) {
		t.Fatalf("incomplete attestation cleared source writer protection: %#v", activities)
	}
	disconnect()
	code, lost := doJSON(t, server.Client(), "POST", url+"/quiescence", adminToken, request)
	projectTestStatus(t, code, 202, lost)
	lostID := projectTestString(t, lost, "id")
	if lost["status"] != "unknown" {
		t.Fatalf("lost source RPC did not retain durable intent: %#v", lost)
	}
	if _, err := os.Stat(filepath.Join(storageRoot, "projects", spaceID, pid, "operations", lostID+".json")); !os.IsNotExist(err) {
		t.Fatalf("offline runner unexpectedly recorded the undispatched mutation: %v", err)
	}
	project, err := h.projects.GetProject(context.Background(), "tenant-project", pid)
	if err != nil {
		t.Fatal(err)
	}
	code, out = doJSON(t, server.Client(), "DELETE", server.URL+"/api/project-executions/"+pid, adminToken, map[string]any{"expectedRevision": project.Revision})
	projectTestStatus(t, code, 409, out)
	if drain {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := h.beforeTenantDelete(ctx, "tenant-project")
		cancel()
		if err == nil || !strings.Contains(err.Error(), "source writer attestations") {
			t.Fatalf("tenant deletion did not preserve unresolved source audit: %v", err)
		}
		draining, err := h.projects.TenantDraining(context.Background(), "tenant-project")
		if err != nil || !draining {
			t.Fatalf("tenant shutdown did not durably fence new work: draining=%v err=%v", draining, err)
		}
	}
	reconnect()
	boundaryComment := strings.Repeat("界", 1365) + "x"
	request["comment"] = boundaryComment
	code, confirmed := doJSON(t, server.Client(), "POST", url+"/quiescence", adminToken, request)
	projectTestStatus(t, code, 200, confirmed)
	confirmedID := projectTestString(t, confirmed, "id")
	if confirmed["status"] != "confirmed" || confirmed["authorId"] != "source-admin" || confirmed["comment"] != boundaryComment || confirmed["result"].(map[string]any)["reviewId"] != confirmedID {
		t.Fatalf("human receipt and SQL audit did not bind the same attestation: %#v", confirmed)
	}
	code, inspected := doJSON(t, server.Client(), "POST", url+"/attestations/"+incompleteID+"/inspect", ownerToken, map[string]any{})
	projectTestStatus(t, code, 200, inspected)
	if inspected["status"] != "failed" || inspected["inspection"].(map[string]any)["known"] != true {
		t.Fatalf("known failed receipt was superseded by a later covering confirmation: %#v", inspected)
	}
	code, superseded := doJSON(t, server.Client(), "POST", url+"/attestations/"+lostID+"/inspect", ownerToken, map[string]any{})
	projectTestStatus(t, code, 200, superseded)
	if superseded["status"] != "superseded" {
		t.Fatalf("later exact human approval did not resolve missing runner intent conservatively: %#v", superseded)
	}
	var supersededStatus, supersededResult string
	if err = d.DB.QueryRow(`SELECT status,result_json FROM execution_source_attestations WHERE tenant_id='tenant-project' AND project_id=? AND id=?`, pid, lostID).Scan(&supersededStatus, &supersededResult); err != nil {
		t.Fatal(err)
	}
	if supersededStatus != "superseded" || !strings.Contains(supersededResult, confirmedID) {
		t.Fatalf("superseded source audit lost its covering human proof: status=%s result=%s", supersededStatus, supersededResult)
	}
	var storedStatus, storedAuthor, storedComment, storedIDs, storedResult string
	if err = d.DB.QueryRow(`SELECT status,author_id,comment,activity_ids_json,result_json FROM execution_source_attestations WHERE tenant_id='tenant-project' AND project_id=? AND id=?`, pid, confirmedID).Scan(&storedStatus, &storedAuthor, &storedComment, &storedIDs, &storedResult); err != nil {
		t.Fatal(err)
	}
	if storedStatus != "confirmed" || storedAuthor != "source-admin" || storedComment != boundaryComment || len(storedComment) != 4096 || !strings.Contains(storedIDs, ids[0]) || !strings.Contains(storedResult, confirmedID) {
		t.Fatalf("source SQL approval/receipt history mismatch: status=%s author=%s ids=%s result=%s comment_bytes=%d", storedStatus, storedAuthor, storedIDs, storedResult, len(storedComment))
	}
	for _, id := range ids {
		data, err := os.ReadFile(filepath.Join(storageRoot, "source-processes", id+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var record struct{ State, Resolution, ReviewID, Comment string }
		if err = json.Unmarshal(data, &record); err != nil || record.State != "settled" || record.Resolution != "human_attestation" || record.ReviewID != confirmedID || record.Comment != boundaryComment {
			t.Fatalf("real runner lost durable source writer approval: %s %v", data, err)
		}
	}
	code, activities = doJSON(t, server.Client(), "GET", url+"/activities", memberToken, nil)
	projectTestStatus(t, code, 200, activities)
	if len(activities["activities"].([]any)) != 0 {
		t.Fatalf("confirmed source intents remain active: %#v", activities)
	}
	code, empty := doJSON(t, server.Client(), "POST", url+"/quiescence", ownerToken, map[string]any{"activityIds": []string{"no_active_writer"}, "confirmation": "writers_stopped", "comment": "No active source writer exists; reject this fake set."})
	expectedHistory := 3
	if drain {
		projectTestStatus(t, code, 409, empty)
	} else {
		projectTestStatus(t, code, 202, empty)
		code, inspected = doJSON(t, server.Client(), "POST", url+"/attestations/"+projectTestString(t, empty, "id")+"/inspect", ownerToken, map[string]any{})
		projectTestStatus(t, code, 200, inspected)
		if inspected["status"] != "failed" {
			t.Fatalf("empty source set accepted a fabricated writer: %#v", inspected)
		}
		expectedHistory++
	}
	code, history := doJSON(t, server.Client(), "GET", url+"/attestations", ownerToken, nil)
	projectTestStatus(t, code, 200, history)
	if len(history["items"].([]any)) != expectedHistory {
		t.Fatalf("source SQL audit lost rejected or confirmed attestations: %#v", history)
	}
	code, out = doJSON(t, server.Client(), "GET", url+"/attestations", otherOwnerToken, nil)
	projectTestStatus(t, code, 404, out)
	code, out = doJSON(t, server.Client(), "POST", url+"/attestations/"+incompleteID+"/inspect", otherOwnerToken, map[string]any{})
	projectTestStatus(t, code, 404, out)
	code, out = doJSON(t, server.Client(), "POST", server.URL+"/api/project-executions/"+otherProject.ID+"/source/attestations/"+incompleteID+"/inspect", ownerToken, map[string]any{})
	projectTestStatus(t, code, 404, out)
}

func TestProjectSourceAttestationPersistsIntentBeforeRunnerDispatch(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant-source-order")
	adminToken := projectTestHumanToken(t, d, "tenant-source-order", "source-order-admin", "admin")
	now := runtimeTimeString(d.Clock())
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('source-order-node','tenant-source-order','Order Probe','order-probe','computer','online','order-probe-token','{}','{}',?,'{}',false,?,?)`, t.TempDir(), now, now); err != nil {
		t.Fatal(err)
	}
	h, server, shutdown := projectTestServer(t, d)
	defer shutdown()
	node := "source-order-node"
	space, err := h.store.CreateSpace(context.Background(), "tenant-source-order", Space{Name: "Source Order", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "tenant-source-order", Agent{Name: "Source Order Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	p, err := h.projects.CreateProject(context.Background(), mission.Project{TenantID: "tenant-source-order", SpaceID: space.ID, Name: "Observe source intent ordering", Goal: "Commit source attestation intent before sending the runner mutation", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "unused", Title: "Unused task", Prompt: "No project task executes in this ordering test", AgentID: agent.ID, Checks: []mission.CheckSpec{{ID: "unused-check", Kind: "path_exists", Path: "unused.txt", Required: true}}}}}, Config: mission.Config{MaxTasks: 10, ExternalEffects: "deny"}})
	if err != nil {
		t.Fatal(err)
	}
	// This narrowly bounded transport fixture handles one confirm call solely to
	// inspect SQL at its dispatch boundary. Real runner semantics are exercised
	// by TestProjectExecutionRealRunnerRecoveryReviewAndMerge above.
	serverConn, fixtureConn := net.Pipe()
	session := &runnerSession{hub: h.hub, nodeID: node, conn: serverConn, rw: bufio.NewReadWriter(bufio.NewReader(serverConn), bufio.NewWriter(serverConn)), writeGate: make(chan struct{}, 1), pending: map[string]chan runnerReply{}, streams: map[string]func(string, []byte){}, done: make(chan struct{})}
	session.ready.Store(true)
	session.lastSeen.Store(time.Now().UnixMilli())
	h.hub.install(session)
	go session.readLoop()
	release := make(chan struct{})
	var releaseOnce sync.Once
	cleanup := func() {
		releaseOnce.Do(func() { close(release) })
		_ = fixtureConn.Close()
		session.close(fmt.Errorf("source ordering fixture finished"))
		h.hub.remove(session)
	}
	t.Cleanup(cleanup)
	observed := make(chan error, 1)
	go func() {
		defer fixtureConn.Close()
		_ = fixtureConn.SetDeadline(time.Now().Add(10 * time.Second))
		var frame struct {
			Type, ID, Method string
			Params           map[string]any
		}
		if err := json.Unmarshal([]byte(readServerText(t, bufio.NewReader(fixtureConn))), &frame); err != nil {
			observed <- err
			return
		}
		if frame.Type != "req" || frame.Method != "project.source.confirm" || frame.Params["spaceId"] != space.ID || frame.Params["projectId"] != p.ID || frame.Params["approved"] != true {
			observed <- fmt.Errorf("unexpected source RPC: %+v", frame)
			return
		}
		operationID, ok := frame.Params["operationId"].(string)
		if !ok || operationID == "" || frame.Params["reviewId"] != operationID {
			observed <- fmt.Errorf("source mutation lacks immutable attestation identity: %+v", frame)
			return
		}
		var status, author, ids, comment string
		if err := d.DB.QueryRow(`SELECT status,author_id,activity_ids_json,comment FROM execution_source_attestations WHERE tenant_id=? AND project_id=? AND id=?`, p.TenantID, p.ID, operationID).Scan(&status, &author, &ids, &comment); err != nil {
			observed <- fmt.Errorf("runner was dispatched before its SQL intent: %w", err)
			return
		}
		if status != "pending" || author != "source-order-admin" || ids != `["old_source_writer"]` || comment != "The exact source writer was stopped." {
			observed <- fmt.Errorf("runner observed incorrect SQL intent: status=%s author=%s ids=%s comment=%s", status, author, ids, comment)
			return
		}
		observed <- nil
		response, err := json.Marshal(map[string]any{"type": "res", "id": frame.ID, "ok": true, "result": map[string]any{"confirmed": []string{"old_source_writer"}, "reviewId": operationID}})
		if err != nil {
			t.Error(err)
			return
		}
		writeMaskedText(t, fixtureConn, string(response))
		<-release
	}()
	url := server.URL + "/api/project-executions/" + p.ID + "/source/quiescence"
	code, out := doJSON(t, server.Client(), "POST", url, adminToken, map[string]any{"activityIds": []string{"old_source_writer"}, "confirmation": "writers_stopped", "comment": "The exact source writer was stopped."})
	projectTestStatus(t, code, 200, out)
	select {
	case err := <-observed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("source dispatch was not observed")
	}
	if out["status"] != "confirmed" || out["authorId"] != "source-order-admin" {
		t.Fatalf("runner receipt was not persisted after intent: %#v", out)
	}
	var status string
	if err = d.DB.QueryRow(`SELECT status FROM execution_source_attestations WHERE tenant_id=? AND project_id=? AND id=?`, p.TenantID, p.ID, out["id"]).Scan(&status); err != nil || status != "confirmed" {
		t.Fatalf("source receipt SQL result: %s %v", status, err)
	}
	if err = h.projectEngine.CancelTenant(context.Background(), p.TenantID); err != nil {
		t.Fatal(err)
	}
	code, out = doJSON(t, server.Client(), "POST", url, adminToken, map[string]any{"activityIds": []string{"another_writer"}, "confirmation": "writers_stopped", "comment": "A draining tenant must reject new source mutation intents."})
	projectTestStatus(t, code, 409, out)
	var count int
	if err = d.DB.QueryRow(`SELECT COUNT(*) FROM execution_source_attestations WHERE tenant_id=? AND project_id=?`, p.TenantID, p.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("tenant draining allowed another source mutation intent: %d %v", count, err)
	}
	cleanup()
}

func TestProjectSourceRecoveryDuringTenantShutdown(t *testing.T) {
	d := testDeps(t)
	apiToken := seedTenant(t, d, "tenant-project")
	seedTenant(t, d, "tenant-other")
	memberToken := projectTestHumanToken(t, d, "tenant-project", "reviewer")
	storageRoot := t.TempDir()
	binary := projectTestAgentBinary(t)
	runnerToken := "rnr_source-shutdown-runner"
	sum := sha256.Sum256([]byte(runnerToken))
	now := runtimeTimeString(d.Clock())
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('source-shutdown-node','tenant-project','Source Shutdown','source-shutdown','computer','offline',?,'{}','{}',?,'{}',false,?,?)`, hex.EncodeToString(sum[:]), storageRoot, now, now); err != nil {
		t.Fatal(err)
	}
	h, server, shutdown := projectTestServer(t, d)
	defer shutdown()
	node := "source-shutdown-node"
	space, err := h.store.CreateSpace(context.Background(), "tenant-project", Space{Name: "Source Shutdown Space", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "tenant-project", Agent{Name: "Source Shutdown Agent", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	definition := projectDefinitionBody{SpaceID: space.ID, Name: "Recover source administrative uncertainty", Goal: "Retain source writer audit while deletion is paused", Config: mission.Config{MaxTasks: 10, ExternalEffects: "deny"}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "unused", Title: "Unused task", Prompt: "No project task starts during source administrative recovery", AgentID: agent.ID, Checks: []mission.CheckSpec{{ID: "unused-check", Kind: "path_exists", Path: "unused.txt", Required: true}}}}}}
	p, err := h.projects.CreateProject(context.Background(), mission.Project{TenantID: "tenant-project", SpaceID: space.ID, Name: definition.Name, Goal: definition.Goal, Plan: definition.Plan, Config: definition.Config})
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{"prior_writer_a", "prior_writer_b"}
	projectTestSeedSourceIntents(t, storageRoot, space.ID, ids)
	stopAgent := projectTestRunAgent(t, binary, server.URL, runnerToken, storageRoot)
	projectTestWaitRunner(t, h, node)
	projectTestSourceRecovery(t, h, server, d, p.ID, space.ID, storageRoot, apiToken, memberToken, ids, definition, true, func() {
		stopAgent()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := h.hub.get(node); err != nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("source shutdown runner did not become unavailable")
	}, func() {
		stopAgent = projectTestRunAgent(t, binary, server.URL, runnerToken, storageRoot)
		projectTestWaitRunner(t, h, node)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = h.beforeTenantDelete(ctx, "tenant-project"); err != nil {
		t.Fatalf("resolved source attestations still prevent tenant shutdown: %v", err)
	}
	stopAgent()
	var count int
	if err = d.DB.QueryRow(`SELECT COUNT(*) FROM execution_source_attestations WHERE tenant_id='tenant-project' AND project_id=? AND status IN ('confirmed','failed','superseded')`, p.ID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("shutdown hook discarded resolved administrative audit before tenant deletion: count=%d err=%v", count, err)
	}
}
