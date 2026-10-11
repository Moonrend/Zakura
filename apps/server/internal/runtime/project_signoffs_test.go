// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/signoff"
)

type signoffHTTPFixture struct {
	h                                         *handler
	d                                         *appdeps.Dependencies
	server                                    *httptest.Server
	project                                   mission.Project
	run                                       mission.Run
	preview                                   projectMergePreview
	api, owner, first, second, third, foreign string
	baseURL, runURL, source                   string
	clock                                     *atomic.Int64
}

func TestProjectSignoffLegacyReceiptSummaryDoesNotInventVoteEvidence(t *testing.T) {
	f := newIndependentSignoffHTTPFixture(t)
	ctx := context.Background()
	preview, err := f.h.mutateMerge(ctx, f.p, f.run.ID, f.preview.ID, f.preview.Revision, "signoff-a", "test.legacy_receipt", "Pre-signoff migration fixture", func(_ *sql.Tx, preview *projectMergePreview) error {
		preview.Status = "approved"
		preview.ReviewID = "legacy_review_receipt"
		preview.ReviewedBy = "signoff-a"
		preview.ReviewComment = "Historical human review"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	get := func() signoff.Summary {
		code, out := doJSON(t, f.server.Client(), "GET", f.url+"/merges/"+preview.ID+"/signoffs?runId="+f.run.ID, f.key, nil)
		projectTestStatus(t, code, 200, out)
		return projectTestDecode[signoff.Summary](t, out["summary"].(map[string]any))
	}
	summary := get()
	if !summary.LegacyApproval || !summary.Quorum || summary.Approvals != 1 || summary.Evidence != nil || len(summary.Votes) != 0 {
		t.Fatalf("historical receipt changed authority or invented evidence %+v", summary)
	}
	gate := func() error {
		tx, e := f.d.DB.BeginTx(ctx, nil)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback()
		if e = f.h.lockProjectMutation(ctx, tx, f.p); e != nil {
			t.Fatal(e)
		}
		return f.h.requireProjectSignoffTx(ctx, tx, f.p, &preview)
	}
	if err = gate(); err != nil {
		t.Fatal("default legacy compatibility failed", err)
	}
	if _, err = f.d.DB.Exec(`UPDATE users SET suspended_at='now' WHERE id='signoff-a'`); err != nil {
		t.Fatal(err)
	}
	summary = get()
	if summary.Quorum || summary.Approvals != 0 || !summary.LegacyApproval {
		t.Fatal("legacy display retained inactive authority", summary)
	}
	if err = gate(); err == nil {
		t.Fatal("legacy gate accepted suspended signer")
	}
	if _, err = f.d.DB.Exec(`UPDATE users SET suspended_at=NULL WHERE id='signoff-a'`); err != nil {
		t.Fatal(err)
	}
	f.policy(t, 0, 2, []string{"owner", "admin", "member"})
	preview = f.preview
	summary = get()
	if summary.LegacyApproval || summary.Quorum || preview.Status != "ready" || preview.ReviewID != "" {
		t.Fatal("configured policy reused legacy authority", summary, preview)
	}
}

func newSignoffHTTPFixture(t *testing.T) signoffHTTPFixture {
	t.Helper()
	ctx := context.Background()
	d := testDeps(t)
	clock := new(atomic.Int64)
	clock.Store(time.Now().UTC().UnixNano())
	d.Clock = func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	api := seedTenant(t, d, "tenant-signoff")
	foreign := seedTenant(t, d, "tenant-signoff-foreign")
	owner := projectTestHumanToken(t, d, "tenant-signoff", "signoff-owner", "owner")
	first := projectTestHumanToken(t, d, "tenant-signoff", "signoff-first")
	second := projectTestHumanToken(t, d, "tenant-signoff", "signoff-second")
	third := projectTestHumanToken(t, d, "tenant-signoff", "signoff-third")
	root := t.TempDir()
	runnerToken := "rnr_signoff-runner"
	hash := sha256.Sum256([]byte(runnerToken))
	now := runtimeTimeString(d.Clock())
	node := "signoff-node"
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES(?,?,?,?,?,'offline',?,'{}','{}',?,'{}',false,?,?)`, node, "tenant-signoff", "Signoff Node", node, "computer", hex.EncodeToString(hash[:]), root, now, now); err != nil {
		t.Fatal(err)
	}
	h, server, shutdown := projectTestServer(t, d)
	t.Cleanup(shutdown)
	space, err := h.store.CreateSpace(ctx, "tenant-signoff", Space{Name: "Signoff workspace", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(ctx, "tenant-signoff", Agent{Name: "Author", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	p, err := h.projects.CreateProject(ctx, mission.Project{TenantID: "tenant-signoff", SpaceID: space.ID, CreatedBy: "signoff-owner", Name: "Independent reviewers", Goal: "Require human quorum before writing source", Config: mission.Config{MaxTasks: 10, ExternalEffects: "deny"}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "feature", Title: "Feature", Prompt: "Implement feature", AgentID: agent.ID, Writes: []string{"feature.txt"}, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "feature.txt", Required: true}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "spaces", space.ID, "workspace")
	if err = os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	projectTestWrite(t, filepath.Join(source, "baseline.txt"), "Original source\n")
	stop := projectTestRunAgent(t, projectTestAgentBinary(t), server.URL, runnerToken, root)
	t.Cleanup(stop)
	projectTestWaitRunner(t, h, node)
	base, err := h.projectBridge.Base(ctx, projectScope(p))
	if err != nil {
		t.Fatal(err)
	}
	run, err := h.projects.CreateRun(ctx, p.TenantID, p.ID, base, p.Revision)
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := h.projects.ClaimTask(ctx, "signoff-worker", time.Minute)
	if err != nil || assignment == nil {
		t.Fatalf("claim %+v %v", assignment, err)
	}
	ref := projectexec.FenceRequest{Scope: assignment.Scope, RunID: run.ID, TaskID: assignment.Task.ID, Owner: assignment.Task.LeaseOwner, Fence: assignment.Task.Fence}
	branch, err := h.projectBridge.Fork(ctx, projectScope(p), base, assignment.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.projects.InitializeTaskBranch(ctx, ref, branch, base); err != nil {
		t.Fatal(err)
	}
	var response json.RawMessage
	if err = h.projectBridge.rpc(ctx, projectScope(p), "project.branch.write", map[string]any{"operationId": "signoff_author_write", "branchId": branch, "path": "feature.txt", "content": "Actual reviewed feature\n"}, &response); err != nil {
		t.Fatal(err)
	}
	snapshot, err := h.projectBridge.Snapshot(ctx, projectScope(p), branch)
	if err != nil {
		t.Fatal(err)
	}
	verification, err := h.projectBridge.Verify(ctx, projectScope(p), branch, assignment.Task.Spec.Checks)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.projects.RecordVerification(ctx, ref, verification); err != nil {
		t.Fatal(err)
	}
	if err = h.projects.CompleteTask(ctx, ref, "Ready for final signoff", snapshot); err != nil {
		t.Fatal(err)
	}
	run, err = h.projects.GetRun(ctx, p.TenantID, p.ID, run.ID)
	if err != nil || run.Status != "completed" {
		t.Fatalf("run %+v %v", run, err)
	}
	baseURL := server.URL + "/api/project-executions/" + p.ID
	runURL := baseURL + "/runs/" + run.ID
	task, err := h.projects.GetTask(ctx, p.TenantID, p.ID, run.ID, assignment.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	preview := projectTestMergePreview(t, server, runURL, api, run, task)
	return signoffHTTPFixture{h: h, d: d, server: server, project: p, run: run, preview: preview, api: api, owner: owner, first: first, second: second, third: third, foreign: foreign, baseURL: baseURL, runURL: runURL, source: source, clock: clock}
}
func (f signoffHTTPFixture) summary(t *testing.T, preview projectMergePreview) signoff.Summary {
	t.Helper()
	code, out := doJSON(t, f.server.Client(), "GET", f.baseURL+"/merges/"+preview.ID+"/signoffs?runId="+preview.RunID, f.api, nil)
	projectTestStatus(t, code, 200, out)
	return projectTestDecode[signoff.Summary](t, out["summary"].(map[string]any))
}
func (f signoffHTTPFixture) vote(t *testing.T, preview projectMergePreview, policy signoff.Policy, token, decision string) (int, map[string]any) {
	t.Helper()
	return doJSON(t, f.server.Client(), "POST", f.baseURL+"/merges/"+preview.ID+"/signoffs?runId="+preview.RunID, token, map[string]any{"expectedRevision": preview.Revision, "snapshotId": preview.Plan.Result.ID, "policyHash": policy.Hash, "decision": decision, "comment": "I independently reviewed this exact artifact."})
}
func (f signoffHTTPFixture) policy(t *testing.T, expected int64, rules signoff.Rules, token string) (int, map[string]any) {
	t.Helper()
	return doJSON(t, f.server.Client(), "PUT", f.baseURL+"/review-policy", token, map[string]any{"expectedRevision": expected, "minApprovals": rules.MinApprovals, "eligibleReviewerIds": rules.EligibleReviewerIDs, "eligibleRoles": rules.EligibleRoles, "disallowProjectCreator": rules.DisallowProjectCreator, "expirySeconds": rules.ExpirySeconds})
}
func (f signoffHTTPFixture) reload(t *testing.T, preview projectMergePreview) projectMergePreview {
	t.Helper()
	out, err := f.h.loadMerge(context.Background(), f.project.TenantID, f.project.ID, preview.RunID, preview.ID)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func (f signoffHTTPFixture) delivery(t *testing.T, preview projectMergePreview, release string) (int, map[string]any) {
	t.Helper()
	return doJSON(t, f.server.Client(), "POST", f.baseURL+"/deliveries", f.first, map[string]any{"runId": preview.RunID, "previewId": preview.ID, "expectedPreviewRevision": preview.Revision, "name": "Signed artifact", "version": release, "comment": "Publish independently approved artifact."})
}
func (f signoffHTTPFixture) withdraw(t *testing.T, preview projectMergePreview, policy signoff.Policy, voteID, token string) (int, map[string]any) {
	t.Helper()
	return doJSON(t, f.server.Client(), "POST", f.baseURL+"/merges/"+preview.ID+"/signoffs/"+voteID+"/withdraw?runId="+preview.RunID, token, map[string]any{"expectedRevision": preview.Revision, "snapshotId": preview.Plan.Result.ID, "policyHash": policy.Hash})
}

func TestProjectSignoffHTTPQuorumWithdrawalPolicyExpiryAndCurrentMembership(t *testing.T) {
	f := newSignoffHTTPFixture(t)
	preview := f.preview
	// Existing projects remain compatible with one real human reviewer.
	code, out := doJSON(t, f.server.Client(), "POST", f.runURL+"/merges/"+preview.ID+"/review", f.first, map[string]any{"expectedRevision": preview.Revision, "snapshotId": preview.Plan.Result.ID, "decision": "approved", "comment": "Default policy review of the actual artifact."})
	projectTestStatus(t, code, 200, out)
	preview = projectTestDecode[projectMergePreview](t, out)
	if preview.Status != "approved" || len(preview.ReviewEvidence) == 0 {
		t.Fatal("default human review lost receipt")
	}
	rules := signoff.Rules{MinApprovals: 2, EligibleReviewerIDs: []string{"signoff-owner", "signoff-first", "signoff-second", "signoff-third"}, EligibleRoles: []string{"owner", "admin", "member"}, DisallowProjectCreator: true, ExpirySeconds: 60}
	for _, token := range []string{f.api, f.first} {
		code, out := f.policy(t, 0, rules, token)
		projectTestStatus(t, code, 403, out)
	}
	code, out = f.policy(t, 0, rules, f.owner)
	projectTestStatus(t, code, 200, out)
	policy := projectTestDecode[signoff.Policy](t, out["policy"].(map[string]any))
	stale := preview
	preview = f.reload(t, preview)
	if preview.Status != "ready" || preview.ReviewID != "" || len(preview.ReviewEvidence) != 0 || preview.Revision <= stale.Revision {
		t.Fatal("first policy failed to invalidate legacy receipt")
	}
	code, out = f.vote(t, stale, policy, f.first, "approved")
	projectTestStatus(t, code, 409, out)
	code, out = f.policy(t, 0, rules, f.owner)
	projectTestStatus(t, code, 409, out)
	code, out = f.vote(t, preview, policy, f.api, "approved")
	projectTestStatus(t, code, 403, out)
	code, out = f.vote(t, preview, policy, f.owner, "approved")
	if code == 200 {
		t.Fatal("excluded creator cast a counting approval")
	}
	code, out = f.vote(t, preview, policy, f.first, "approved")
	projectTestStatus(t, code, 200, out)
	preview = projectTestDecode[projectMergePreview](t, out)
	if preview.Status != "ready" || preview.ReviewID != "" || len(preview.ReviewEvidence) != 0 {
		t.Fatal("one voter bypassed two-person policy")
	}
	code, out = f.vote(t, preview, policy, f.first, "approved")
	projectTestStatus(t, code, 409, out)
	code, out = f.vote(t, preview, policy, f.second, "approved")
	projectTestStatus(t, code, 200, out)
	preview = projectTestDecode[projectMergePreview](t, out)
	summary := f.summary(t, preview)
	if preview.Status != "approved" || !summary.Quorum || summary.Approvals != 2 || summary.EligibleCount != 3 || len(summary.Evidence.Participants) != 2 {
		t.Fatalf("quorum %+v", summary)
	}
	code, out = f.delivery(t, preview, "v1")
	projectTestStatus(t, code, 201, out)
	artifact := projectTestDecode[projectDelivery](t, out)
	var evidence signoff.Evidence
	if err := json.Unmarshal(artifact.Manifest.Review.Evidence, &evidence); err != nil {
		t.Fatal(err)
	}
	if evidence.PolicyHash != policy.Hash || len(evidence.Participants) != 2 || evidence.Binding.SnapshotID != preview.Plan.Result.ID {
		t.Fatal("delivery dropped exact distinct reviewer proof")
	}
	firstVote := summary.Evidence.Participants[0].VoteID
	for _, v := range summary.Votes {
		if v.UserID == "signoff-first" {
			firstVote = v.ID
		}
	}
	code, out = f.withdraw(t, preview, policy, firstVote, f.second)
	projectTestStatus(t, code, 404, out)
	code, out = f.withdraw(t, preview, policy, firstVote, f.first)
	projectTestStatus(t, code, 200, out)
	preview = projectTestDecode[projectMergePreview](t, out)
	if preview.Status != "ready" || preview.ReviewID != "" || len(preview.ReviewEvidence) != 0 {
		t.Fatal("withdrawal failed to remove aggregate approval")
	}
	code, out = f.withdraw(t, preview, policy, firstVote, f.first)
	projectTestStatus(t, code, 404, out)
	code, out = f.vote(t, preview, policy, f.first, "approved")
	projectTestStatus(t, code, 200, out)
	preview = projectTestDecode[projectMergePreview](t, out)
	// Current membership, rather than the role cached with the old vote, gates
	// both source apply and a fresh archive publication in their transaction.
	if _, err := f.d.DB.Exec(`UPDATE tenant_memberships SET status='suspended' WHERE tenant_id=? AND user_id=?`, f.project.TenantID, "signoff-second"); err != nil {
		t.Fatal(err)
	}
	code, out = doJSON(t, f.server.Client(), "POST", f.runURL+"/merges/"+preview.ID+"/apply", f.first, map[string]any{"expectedRevision": preview.Revision, "confirmation": "merge"})
	if code == 200 || code == 202 {
		t.Fatal("removed reviewer allowed source effect")
	}
	code, out = f.delivery(t, preview, "removed-member")
	if code == 201 {
		t.Fatal("removed reviewer allowed export")
	}
	if _, err := os.Stat(filepath.Join(f.source, "feature.txt")); !os.IsNotExist(err) {
		t.Fatal("failed signoff gate wrote source")
	}
	if _, err := f.d.DB.Exec(`UPDATE tenant_memberships SET status='active' WHERE tenant_id=? AND user_id=?`, f.project.TenantID, "signoff-second"); err != nil {
		t.Fatal(err)
	}
	f.clock.Add(int64(61 * time.Second))
	summary = f.summary(t, preview)
	if summary.Quorum || summary.Approvals != 0 {
		t.Fatal("expired quorum persisted")
	}
	code, out = f.delivery(t, preview, "expired")
	if code == 201 {
		t.Fatal("expired votes exported artifact")
	}
	code, out = doJSON(t, f.server.Client(), "POST", f.runURL+"/merges/"+preview.ID+"/apply", f.first, map[string]any{"expectedRevision": preview.Revision, "confirmation": "merge"})
	if code == 200 || code == 202 {
		t.Fatal("expired votes mutated source")
	}
	for _, v := range summary.Votes {
		if v.Status != "active" {
			continue
		}
		token := f.first
		if v.UserID == "signoff-second" {
			token = f.second
		}
		code, out = f.withdraw(t, preview, policy, v.ID, token)
		projectTestStatus(t, code, 200, out)
		preview = projectTestDecode[projectMergePreview](t, out)
	}
	for _, token := range []string{f.first, f.second} {
		code, out = f.vote(t, preview, policy, token, "approved")
		projectTestStatus(t, code, 200, out)
		preview = projectTestDecode[projectMergePreview](t, out)
	}
	oldPolicy := policy
	code, out = f.policy(t, policy.Revision, rules, f.owner)
	projectTestStatus(t, code, 200, out)
	policy = projectTestDecode[signoff.Policy](t, out["policy"].(map[string]any))
	preview = f.reload(t, preview)
	if preview.Status != "ready" || preview.ReviewID != "" || policy.Hash == oldPolicy.Hash {
		t.Fatal("same rules at new policy revision reused old approvals")
	}
	code, out = f.vote(t, preview, oldPolicy, f.first, "approved")
	projectTestStatus(t, code, 409, out)
	for _, token := range []string{f.first, f.second} {
		code, out = f.vote(t, preview, policy, token, "approved")
		projectTestStatus(t, code, 200, out)
		preview = projectTestDecode[projectMergePreview](t, out)
	}
	summary = f.summary(t, preview)
	if !summary.Quorum {
		t.Fatal("fresh policy votes failed")
	}
	changed := 0
	withdrawn := 0
	for _, v := range summary.Votes {
		if v.Reason == "policy_changed" {
			changed++
		}
		if v.Reason == "withdrawn" {
			withdrawn++
		}
	}
	if changed < 2 || withdrawn < 2 {
		t.Fatal("policy/withdrawal audit history disappeared")
	}
	code, out = doJSON(t, f.server.Client(), "POST", f.runURL+"/merges/"+preview.ID+"/apply", f.first, map[string]any{"expectedRevision": preview.Revision, "confirmation": "merge"})
	projectTestStatus(t, code, 200, out)
	preview = projectTestDecode[projectMergePreview](t, out)
	if preview.Status != "applied" {
		t.Fatalf("source apply %+v", preview)
	}
	content, err := os.ReadFile(filepath.Join(f.source, "feature.txt"))
	if err != nil || string(content) != "Actual reviewed feature\n" {
		t.Fatal("quorum did not release actual source apply")
	}
	rules.MinApprovals = 3
	code, out = f.policy(t, policy.Revision, rules, f.owner)
	projectTestStatus(t, code, 200, out)
	historic := f.reload(t, preview)
	if historic.Revision != preview.Revision || historic.Status != "applied" || historic.ReviewID != preview.ReviewID {
		t.Fatal("policy edit rewrote already published history")
	}
	code, out = f.withdraw(t, historic, policy, summary.Evidence.Participants[0].VoteID, f.first)
	if code == 200 {
		t.Fatal("published signoff could be withdrawn")
	}
	for _, path := range []string{"/review-policy", "/review-policy/history", "/merges/" + preview.ID + "/signoffs?runId=" + preview.RunID} {
		code, out = doJSON(t, f.server.Client(), "GET", f.baseURL+path, f.foreign, nil)
		projectTestStatus(t, code, 404, out)
	}
}
