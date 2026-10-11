// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
	"github.com/Moonrend/Zakura/packages/projectkit/campaign"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
)

// Both restarts occur after real durable effects and before their SQL
// observations. The recovery API must inspect existing receipts and identities
// rather than capture the changed source or create another run.
func TestCampaignRealRunnerReceiptRecoveryCommonBaseAndActualComparison(t *testing.T) {
	d := testDeps(t)
	key := seedTenant(t, d, "tenant-project")
	other := seedTenant(t, d, "campaign-other")
	human := projectTestHumanToken(t, d, "tenant-project", "campaign-reviewer")
	ctx := context.Background()
	root := t.TempDir()
	binary := projectTestAgentBinary(t)
	runnerToken := "rnr_campaign-real-runner"
	hash := sha256.Sum256([]byte(runnerToken))
	now := runtimeTimeString(d.Clock())
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('campaign-node','tenant-project','Campaign Runner','campaign-runner','computer','offline',?,'{}','{}',?,'{}',false,?,?)`, hex.EncodeToString(hash[:]), root, now, now); err != nil {
		t.Fatal(err)
	}
	store := NewStore(d)
	node := "campaign-node"
	space, err := store.CreateSpace(ctx, "tenant-project", Space{Name: "Experiment Workspace", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	left, err := store.CreateAgent(ctx, "tenant-project", Agent{Name: "Baseline Author", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	right, err := store.CreateAgent(ctx, "tenant-project", Agent{Name: "Candidate Author", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	sourceRoot := filepath.Join(root, "spaces", space.ID, "workspace")
	if err := os.MkdirAll(sourceRoot, 0700); err != nil {
		t.Fatal(err)
	}
	projectTestWrite(t, filepath.Join(sourceRoot, "artifact.txt"), "immutable baseline\n")
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var request struct {
			Model    string           `json:"model"`
			Messages []map[string]any `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || r.Header.Get("Authorization") != "Bearer campaign-provider-key" {
			t.Error("campaign provider request did not use the real authenticated gateway")
			w.WriteHeader(400)
			return
		}
		if request.Model != "campaign-model-a" && request.Model != "campaign-model-b" {
			t.Errorf("configured model route was not selected: %s", request.Model)
		}
		var message map[string]any
		finish := "tool_calls"
		observed := false
		for _, entry := range request.Messages {
			if entry["role"] != "tool" {
				continue
			}
			text, _ := entry["content"].(string)
			if !strings.Contains(text, "immutable baseline") || strings.Contains(text, "changed live source") {
				t.Errorf("variant did not read its frozen copied base: %s", text)
			}
			observed = true
		}
		if observed {
			finish = "stop"
			message = map[string]any{"role": "assistant", "content": "The isolated branch contains the common immutable baseline."}
		} else {
			message = projectTestToolMessage("inspect_base", "fs_read", map[string]any{"path": "artifact.txt"})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message, "finish_reason": finish}}, "usage": map[string]any{"total_tokens": 7}})
	}))
	t.Cleanup(provider.Close)
	upstream, err := store.CreateUpstream(ctx, "tenant-project", Upstream{Name: "Campaign Fixture", Protocol: "openai", Config: raw(map[string]any{"baseUrl": provider.URL, "apiKey": "campaign-provider-key"})})
	if err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"campaign-model-a", "campaign-model-b"} {
		if _, err := store.CreateRoute(ctx, "tenant-project", ModelRoute{Name: model, Capability: "chat", UpstreamID: upstream.ID, Model: model, IsDefault: model == "campaign-model-a"}); err != nil {
			t.Fatal(err)
		}
	}
	h, runnerServer, _ := projectTestServer(t, d)
	router := chi.NewRouter()
	router.Route("/api", func(r chi.Router) {
		r.Use(httpx.Auth(h.deps))
		r.Use(RequireAPIScope)
		h.registerProjectTemplates(r)
		h.registerProjectCampaigns(r)
	})
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	stop := projectTestRunAgent(t, binary, runnerServer.URL, runnerToken, root)
	projectTestWaitRunner(t, h, node)
	restart := func() {
		stop()
		stop = projectTestRunAgent(t, binary, runnerServer.URL, runnerToken, root)
		projectTestWaitRunner(t, h, node)
	}
	config := mission.Config{MaxTasks: 10, ExternalEffects: "deny", Budget: mission.Budget{MaxTokens: 50000, MaxModelCalls: 20, MaxToolCalls: 40, MaxWallSeconds: 120, MaxConcurrent: 1}}
	checks := []mission.CheckSpec{{ID: "common-content", Kind: "text_contains", Path: "artifact.txt", Pattern: "immutable baseline", Required: true}}
	source, err := h.projects.CreateProject(ctx, mission.Project{TenantID: "tenant-project", SpaceID: space.ID, Name: "Original Source", Goal: "Inspect the common baseline", Config: config, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "inspect", Title: "Inspect common baseline", Prompt: "Read artifact.txt and report its contents", AgentID: left.ID, Writes: []string{"artifact.txt"}, MaxAttempts: 1, Checks: checks}}}})
	if err != nil {
		t.Fatal(err)
	}
	definition := blueprint.Definition{Name: "Inspect common baseline", ProjectName: "Inspect baseline", Goal: source.Goal, Config: config, Parameters: []blueprint.Parameter{}, Tasks: []blueprint.Task{{Key: "inspect", Title: "Inspect common baseline", Prompt: "Read artifact.txt and report its contents", AgentRole: "author", Writes: []string{"artifact.txt"}, MaxAttempts: 1, Checks: checks}}}
	template, err := h.templateStore().Create(ctx, source.TenantID, "", definition)
	if err != nil {
		t.Fatal(err)
	}
	base := server.URL + "/api/project-campaigns"
	body := campaignCreateBody{Name: "Real independent variants", SourceProjectID: source.ID, TemplateID: template.ID, ExpectedTemplateRevision: template.Revision, TemplateVersion: 1, BaselineID: "baseline", Budget: mission.Budget{MaxTokens: 100000, MaxModelCalls: 40, MaxToolCalls: 80, MaxWallSeconds: 240, MaxConcurrent: 1}, Parameters: map[string]json.RawMessage{}, Variants: []campaign.VariantSpec{{ID: "baseline", Name: "Baseline", AgentMapping: map[string]string{"author": left.ID}, Models: map[string]string{"author": "campaign-model-a"}}, {ID: "candidate", Name: "Candidate", AgentMapping: map[string]string{"author": right.ID}, Models: map[string]string{"author": "campaign-model-b"}}}}
	code, out := doJSON(t, server.Client(), "POST", base, key, body)
	projectTestStatus(t, code, 201, out)
	c := projectTestDecode[campaign.Campaign](t, out)
	if c.Status != "draft" || c.CaptureState != "unfrozen" || calls.Load() != 0 {
		t.Fatal("creation performed work", c, calls.Load())
	}
	for _, v := range c.Definition.Variants {
		p, err := h.projects.GetProject(ctx, c.TenantID, v.Project.ID)
		if err != nil || p.Status != "draft" || p.Config.Budget.MaxTokens != 50000 {
			t.Fatalf("child draft/cap: %+v %v", p, err)
		}
	}
	url := base + "/" + c.ID
	code, out = doJSON(t, server.Client(), "GET", url, other, nil)
	projectTestStatus(t, code, 404, out)
	code, out = doJSON(t, server.Client(), "POST", url+"/freeze", key, map[string]any{"expectedRevision": c.Revision, "confirmation": "freeze", "comment": "API key cannot confirm source capture"})
	projectTestStatus(t, code, 403, out)
	code, out = doJSON(t, server.Client(), "POST", url+"/freeze", human, map[string]any{"expectedRevision": c.Revision, "comment": "Must explicitly confirm capture"})
	projectTestStatus(t, code, 400, out)
	// Simulate the server stopping after the runner has committed its source
	// capture, but before the server recorded the observed snapshot.
	c, err = h.campaignStore().Capture(ctx, c.TenantID, c.ID, "campaign-reviewer", "Capture once", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	var captured campaignSnapshotResult
	if err = h.projectBridge.rpc(ctx, projectScope(source), "project.base", map[string]any{"operationId": c.CaptureOperationID}, &captured); err != nil {
		t.Fatal(err)
	}
	captureID := c.CaptureOperationID
	projectTestWrite(t, filepath.Join(sourceRoot, "artifact.txt"), "changed live source\n")
	restart()
	inspect := func() {
		t.Helper()
		code, out = doJSON(t, server.Client(), "POST", url+"/inspect", human, map[string]any{"expectedRevision": c.Revision, "comment": "Inspect durable identities after interruption"})
		projectTestStatus(t, code, 200, out)
		c = projectTestDecode[campaign.Campaign](t, out["campaign"].(map[string]any))
	}
	inspect()
	if c.BaseSnapshot != captured.SnapshotID || c.CaptureOperationID != captureID || c.CaptureState != "ready" {
		t.Fatal("capture was repeated or original receipt lost", c)
	}
	// Interrupt after a real cross-project CAS copy. The copied snapshot and
	// operation survive a runner restart without any source materialization.
	c, err = h.campaignStore().Copy(ctx, c.TenantID, c.ID, "baseline", "campaign-reviewer", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	leftVariant := c.Definition.Variants[0]
	var copied campaignSnapshotResult
	if err = h.projectBridge.rpc(ctx, projectScope(leftVariant.Project), "project.snapshot.copy", map[string]any{"operationId": leftVariant.CopyOperationID, "sourceProjectId": source.ID, "snapshotId": c.BaseSnapshot}, &copied); err != nil {
		t.Fatal(err)
	}
	if copied.SnapshotID != c.BaseSnapshot {
		t.Fatal("copy changed snapshot identity")
	}
	restart()
	inspect()
	if c.Definition.Variants[0].State != "ready" {
		t.Fatal("copy receipt was not recovered", c)
	}
	code, out = doJSON(t, server.Client(), "POST", url+"/variants/candidate/copy", human, map[string]any{"expectedRevision": c.Revision, "comment": "Copy common input to second variant"})
	projectTestStatus(t, code, 200, out)
	c = projectTestDecode[campaign.Campaign](t, out)
	for _, v := range c.Definition.Variants {
		var content struct {
			Content string `json:"content"`
		}
		if err = h.projectBridge.rpc(ctx, projectScope(v.Project), "project.snapshot.read", map[string]any{"snapshotId": c.BaseSnapshot, "path": "artifact.txt"}, &content); err != nil || content.Content != "immutable baseline\n" {
			t.Fatalf("child CAS lacks frozen baseline: %+v %v", content, err)
		}
	}
	// SQL commit interruption is recovered from the original reserved run ID.
	c, err = h.campaignStore().Start(ctx, c.TenantID, c.ID, "baseline", "campaign-reviewer", "Reserve baseline run", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	leftVariant = c.Definition.Variants[0]
	run, err := h.projects.CreateRunOnce(ctx, c.TenantID, leftVariant.Project.ID, c.BaseSnapshot, leftVariant.Project.Revision, leftVariant.RunID)
	if err != nil {
		t.Fatal(err)
	}
	inspect()
	if c.Definition.Variants[0].RunID != run.ID || c.Definition.Variants[0].State != "started" {
		t.Fatal("SQL recovery did not reuse reserved run", c)
	}
	code, out = doJSON(t, server.Client(), "POST", url+"/variants/candidate/start", human, map[string]any{"expectedRevision": c.Revision, "confirmation": "start", "comment": "Concurrent slot must remain occupied"})
	projectTestStatus(t, code, 409, out)
	if calls.Load() != 0 {
		t.Fatal("draft/recovery APIs scheduled provider calls")
	}
	if err = h.projectEngine.Start(h.deps.Context); err != nil {
		t.Fatal(err)
	}
	leftRun := projectTestWaitRun(t, h, leftVariant.Project.ID, run.ID, "completed")
	// A crash before SQL insertion is explicitly unknown. Pause/resume settles
	// the absence as not_started, preserves the grant, and never starts a run.
	c, err = h.campaignStore().Start(ctx, c.TenantID, c.ID, "candidate", "campaign-reviewer", "Reserve candidate before interruption", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	reservedCandidate := c.Definition.Variants[1].RunID
	inspect()
	if c.Definition.Variants[1].State != "start_unknown" {
		t.Fatal("missing SQL receipt did not expose explicit retry", c)
	}
	code, out = doJSON(t, server.Client(), "POST", url+"/control", human, map[string]any{"expectedRevision": c.Revision, "action": "pause", "comment": "Pause the pending candidate grant"})
	projectTestStatus(t, code, 200, out)
	c = projectTestDecode[campaign.Campaign](t, out["campaign"].(map[string]any))
	if c.Status != "paused" || c.Definition.Variants[1].RunID != reservedCandidate {
		t.Fatal("pause did not preserve a fenced pending grant", c)
	}
	code, out = doJSON(t, server.Client(), "POST", url+"/variants/candidate/retry-start", human, map[string]any{"expectedRevision": c.Revision, "confirmation": "start", "comment": "Paused grants cannot retry"})
	projectTestStatus(t, code, 409, out)
	code, out = doJSON(t, server.Client(), "POST", url+"/control", human, map[string]any{"expectedRevision": c.Revision, "action": "resume", "comment": "Permit an explicit retry of the candidate grant"})
	projectTestStatus(t, code, 200, out)
	c = projectTestDecode[campaign.Campaign](t, out["campaign"].(map[string]any))
	var candidateRuns int
	if err = d.DB.QueryRow(`SELECT count(*) FROM execution_runs WHERE project_id=?`, c.Definition.Variants[1].Project.ID).Scan(&candidateRuns); err != nil || candidateRuns != 0 {
		t.Fatalf("control fabricated a run: %d %v", candidateRuns, err)
	}
	code, out = doJSON(t, server.Client(), "POST", url+"/variants/candidate/retry-start", human, map[string]any{"expectedRevision": c.Revision, "confirmation": "start", "comment": "Explicitly retry the same candidate reservation"})
	projectTestStatus(t, code, 200, out)
	c = projectTestDecode[campaign.Campaign](t, out["campaign"].(map[string]any))
	rightVariant := c.Definition.Variants[1]
	if rightVariant.RunID != reservedCandidate {
		t.Fatal("explicit retry replaced the reserved run identity")
	}
	rightRun := projectTestWaitRun(t, h, rightVariant.Project.ID, rightVariant.RunID, "completed")
	if leftRun.BaseSnapshot != c.BaseSnapshot || rightRun.BaseSnapshot != c.BaseSnapshot {
		t.Fatal("variants did not use the same immutable base")
	}
	for _, v := range c.Definition.Variants {
		var n int
		if err = d.DB.QueryRow(`SELECT count(*) FROM execution_runs WHERE tenant_id=? AND project_id=?`, c.TenantID, v.Project.ID).Scan(&n); err != nil || n != 1 {
			t.Fatalf("recovery duplicated run: %d %v", n, err)
		}
	}
	code, out = doJSON(t, server.Client(), "GET", url, key, nil)
	projectTestStatus(t, code, 200, out)
	comparison := projectTestDecode[campaign.Comparison](t, out["comparison"].(map[string]any))
	if !comparison.Comparable || len(comparison.Measurements) != 2 || len(comparison.Differences) != 2 || calls.Load() != 4 {
		t.Fatalf("actual comparison: %+v; calls=%d", comparison, calls.Load())
	}
	for _, m := range comparison.Measurements {
		if m.Samples != 1 || m.AcceptanceRate == nil || *m.AcceptanceRate != 1 || m.RequiredChecksObserved != 1 || m.ChargedTokens != 14 || m.ModelCalls != 2 || m.ToolCalls != 1 || m.ProviderReportedTokens != nil {
			t.Fatalf("comparison invented or lost actual evidence: %+v", m)
		}
	}
	projectTestRead(t, filepath.Join(sourceRoot, "artifact.txt"), "changed live source\n")
	code, out = doJSON(t, server.Client(), "POST", url+"/variants/baseline/start", human, map[string]any{"expectedRevision": c.Revision, "confirmation": "start", "comment": "A completed variant may not add another sample"})
	projectTestStatus(t, code, 409, out)
}
