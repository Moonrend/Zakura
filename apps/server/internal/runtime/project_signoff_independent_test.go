// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/signoff"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

type independentSignoffHTTPFixture struct {
	h                       *handler
	d                       *appdeps.Dependencies
	server                  *httptest.Server
	p                       mission.Project
	run                     mission.Run
	preview                 projectMergePreview
	key, admin, a, b, other string
	url, legacyURL          string
}

func newIndependentSignoffHTTPFixture(t *testing.T) independentSignoffHTTPFixture {
	t.Helper()
	d := testDeps(t)
	key := seedTenant(t, d, "tenant-independent-signoff")
	other := seedTenant(t, d, "tenant-independent-other")
	admin := projectTestHumanToken(t, d, "tenant-independent-signoff", "signoff-admin", "admin")
	a := projectTestHumanToken(t, d, "tenant-independent-signoff", "signoff-a")
	b := projectTestHumanToken(t, d, "tenant-independent-signoff", "signoff-b")
	h, server, _ := projectTestServer(t, d)
	ctx := context.Background()
	space, err := h.store.CreateSpace(ctx, "tenant-independent-signoff", Space{Name: "Signoff independent review"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(ctx, "tenant-independent-signoff", Agent{Name: "Artifact author", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	p, err := h.projects.CreateProject(ctx, mission.Project{TenantID: "tenant-independent-signoff", SpaceID: space.ID, CreatedBy: "signoff-admin", Name: "Independent signoff", Goal: "Protect the actual artifact", Config: mission.Config{MaxTasks: 10}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "implementation", Title: "Implementation", Prompt: "Implement output", AgentID: agent.ID, MaxAttempts: 1, Writes: []string{"result.txt"}, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "result.txt", Required: true}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := h.projects.CreateRun(ctx, p.TenantID, p.ID, strings.Repeat("a", 64), p.Revision)
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := h.projects.ClaimTask(ctx, "independent-signoff-worker", time.Minute)
	if err != nil || assignment == nil {
		t.Fatalf("claim actual task: %+v %v", assignment, err)
	}
	ref := projectexec.FenceRequest{Scope: assignment.Scope, RunID: run.ID, TaskID: assignment.Task.ID, Owner: assignment.Task.LeaseOwner, Fence: assignment.Task.Fence}
	if err = h.projects.InitializeTaskBranch(ctx, ref, "fixture_branch", run.BaseSnapshot); err != nil {
		t.Fatal(err)
	}
	taskSnapshot := strings.Repeat("b", 64)
	verification := workbenchVerification(t, assignment.Task, taskSnapshot, assignment.Task.Spec.Checks)
	if _, err = h.projects.RecordVerification(ctx, ref, verification); err != nil {
		t.Fatal(err)
	}
	if err = h.projects.CompleteTask(ctx, ref, "Artifact acceptance passed", taskSnapshot); err != nil {
		t.Fatal(err)
	}
	run, err = h.projects.GetRun(ctx, p.TenantID, p.ID, run.ID)
	if err != nil || run.Status != "completed" {
		t.Fatalf("completed run: %+v %v", run, err)
	}
	task, err := h.projects.GetTask(ctx, p.TenantID, p.ID, run.ID, assignment.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	final := strings.Repeat("c", 64)
	preview := projectMergePreview{ID: h.store.id(), ProjectID: p.ID, RunID: run.ID, RunRevision: run.Revision, Status: "ready", PlanID: strings.Repeat("e", 64), Plan: workspace.MergePlan{ID: strings.Repeat("e", 64), Result: workspace.Snapshot{ID: final}}, ExpectedBase: run.BaseSnapshot, TaskSnapshots: map[string]string{task.ID: task.SnapshotID}, Verifications: []mission.Verification{workbenchVerification(t, task, final, task.Spec.Checks)}}
	if err = h.saveMerge(ctx, p, preview); err != nil {
		t.Fatal(err)
	}
	preview, err = h.loadMerge(ctx, p.TenantID, p.ID, run.ID, preview.ID)
	if err != nil {
		t.Fatal(err)
	}
	url := server.URL + "/api/project-executions/" + p.ID
	return independentSignoffHTTPFixture{h: h, d: d, server: server, p: p, run: run, preview: preview, key: key, admin: admin, a: a, b: b, other: other, url: url, legacyURL: url + "/runs/" + run.ID + "/merges/" + preview.ID}
}

func (f *independentSignoffHTTPFixture) policy(t *testing.T, expected int64, approvals int, roles []string) signoff.Policy {
	t.Helper()
	code, out := doJSON(t, f.server.Client(), "PUT", f.url+"/review-policy", f.admin, map[string]any{"expectedRevision": expected, "minApprovals": approvals, "eligibleRoles": roles, "eligibleReviewerIds": []string{}, "expirySeconds": 60, "disallowProjectCreator": false})
	projectTestStatus(t, code, 200, out)
	p := projectTestDecode[signoff.Policy](t, out["policy"].(map[string]any))
	var err error
	f.preview, err = f.h.loadMerge(context.Background(), f.p.TenantID, f.p.ID, f.run.ID, f.preview.ID)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func (f *independentSignoffHTTPFixture) vote(t *testing.T, token string, policy signoff.Policy, wantStatus string) {
	t.Helper()
	code, out := doJSON(t, f.server.Client(), "POST", f.url+"/merges/"+f.preview.ID+"/signoffs?runId="+f.run.ID, token, map[string]any{"expectedRevision": f.preview.Revision, "policyHash": policy.Hash, "snapshotId": f.preview.Plan.Result.ID, "decision": "approved", "comment": "Reviewed exact composed artifact"})
	projectTestStatus(t, code, 200, out)
	f.preview = projectTestDecode[projectMergePreview](t, out)
	if f.preview.Status != wantStatus {
		t.Fatalf("vote status %s, wanted %s", f.preview.Status, wantStatus)
	}
}

func TestProjectIndependentSignoffDefaultPolicyResetAndTwoReviewRoutes(t *testing.T) {
	f := newIndependentSignoffHTTPFixture(t)
	code, out := doJSON(t, f.server.Client(), "POST", f.legacyURL+"/review", f.a, map[string]any{"expectedRevision": f.preview.Revision, "snapshotId": f.preview.Plan.Result.ID, "decision": "approved", "comment": "Default remains one human reviewer"})
	projectTestStatus(t, code, 200, out)
	f.preview = projectTestDecode[projectMergePreview](t, out)
	if f.preview.Status != "approved" || len(f.preview.ReviewEvidence) == 0 {
		t.Fatalf("default one-review compatibility lost: %+v", f.preview)
	}
	policy := f.policy(t, 0, 2, []string{"admin", "member"})
	if f.preview.Status != "ready" || f.preview.ReviewID != "" || len(f.preview.ReviewEvidence) != 0 {
		t.Fatalf("policy edit reused old approval: %+v", f.preview)
	}
	f.vote(t, f.a, policy, "ready")
	code, out = doJSON(t, f.server.Client(), "POST", f.legacyURL+"/review", f.a, map[string]any{"expectedRevision": f.preview.Revision, "snapshotId": f.preview.Plan.Result.ID, "decision": "approved", "comment": "Same human must not vote twice via alternate route"})
	projectTestStatus(t, code, 409, out)
	code, out = doJSON(t, f.server.Client(), "POST", f.legacyURL+"/review", f.b, map[string]any{"expectedRevision": f.preview.Revision, "snapshotId": f.preview.Plan.Result.ID, "decision": "approved", "comment": "Independent second human review"})
	projectTestStatus(t, code, 200, out)
	f.preview = projectTestDecode[projectMergePreview](t, out)
	var proof signoff.Evidence
	if err := json.Unmarshal(f.preview.ReviewEvidence, &proof); err != nil {
		t.Fatal(err)
	}
	if f.preview.Status != "approved" || proof.Required != 2 || len(proof.Participants) != 2 || proof.PolicyHash != policy.Hash || proof.Binding.SnapshotID != f.preview.Plan.Result.ID {
		t.Fatalf("missing exact independent provenance: %+v", proof)
	}
	firstVote := proof.Participants[0].VoteID
	withdrawURL := f.url + "/merges/" + f.preview.ID + "/signoffs/" + firstVote + "/withdraw?runId=" + f.run.ID
	body := map[string]any{"expectedRevision": f.preview.Revision, "snapshotId": f.preview.Plan.Result.ID, "policyHash": policy.Hash}
	code, out = doJSON(t, f.server.Client(), "POST", withdrawURL, f.b, body)
	projectTestStatus(t, code, 404, out)
	code, out = doJSON(t, f.server.Client(), "POST", withdrawURL, f.a, body)
	projectTestStatus(t, code, 200, out)
	f.preview = projectTestDecode[projectMergePreview](t, out)
	if f.preview.Status != "ready" || f.preview.ReviewID != "" || len(f.preview.ReviewEvidence) != 0 {
		t.Fatalf("withdrawal left usable approval: %+v", f.preview)
	}
	f.vote(t, f.a, policy, "approved")
	if err := json.Unmarshal(f.preview.ReviewEvidence, &proof); err != nil {
		t.Fatal(err)
	}
	for _, participant := range proof.Participants {
		if participant.VoteID == firstVote {
			t.Fatalf("withdrawn approval resurrected: %+v", proof)
		}
	}
	var taskReviews int
	if err := f.d.DB.QueryRow(`SELECT COUNT(*) FROM execution_reviews WHERE tenant_id=? AND project_id=?`, f.p.TenantID, f.p.ID).Scan(&taskReviews); err != nil || taskReviews != 0 {
		t.Fatalf("final merge signoff changed task-review semantics: count=%d err=%v", taskReviews, err)
	}
}

func TestProjectIndependentSignoffCurrentMembershipAndExpiryFencePublication(t *testing.T) {
	for _, mutation := range []string{"member removal", "role no longer eligible", "user suspended", "approval expired"} {
		t.Run(mutation, func(t *testing.T) {
			f := newIndependentSignoffHTTPFixture(t)
			policy := f.policy(t, 0, 2, []string{"admin", "member"})
			f.vote(t, f.a, policy, "ready")
			f.vote(t, f.b, policy, "approved")
			var err error
			switch mutation {
			case "member removal":
				_, err = f.d.DB.Exec(`DELETE FROM tenant_memberships WHERE tenant_id=? AND user_id='signoff-a'`, f.p.TenantID)
			case "role no longer eligible":
				_, err = f.d.DB.Exec(`UPDATE tenant_memberships SET role='owner' WHERE tenant_id=? AND user_id='signoff-a'`, f.p.TenantID)
			case "user suspended":
				_, err = f.d.DB.Exec(`UPDATE users SET status='suspended',suspended_at='now' WHERE id='signoff-a'`)
			case "approval expired":
				var raw string
				if err = f.d.DB.QueryRow(`SELECT vote_json FROM execution_signoff_votes WHERE tenant_id=? AND project_id=? AND preview_id=? AND user_id='signoff-a' AND status='active'`, f.p.TenantID, f.p.ID, f.preview.ID).Scan(&raw); err == nil {
					var vote signoff.Vote
					if err = json.Unmarshal([]byte(raw), &vote); err == nil {
						vote.CreatedAt = time.Now().Add(-time.Hour)
						var updated []byte
						if updated, err = json.Marshal(vote); err == nil {
							_, err = f.d.DB.Exec(`UPDATE execution_signoff_votes SET vote_json=? WHERE id=?`, string(updated), vote.ID)
						}
					}
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			code, out := doJSON(t, f.server.Client(), "POST", f.legacyURL+"/apply", f.admin, map[string]any{"expectedRevision": f.preview.Revision, "confirmation": "merge"})
			projectTestStatus(t, code, 409, out)
			current, err := f.h.loadMerge(context.Background(), f.p.TenantID, f.p.ID, f.run.ID, f.preview.ID)
			if err != nil || current.Status != "approved" || current.Revision != f.preview.Revision || current.OperationID != "" {
				t.Fatalf("denied quorum left outbound merge intent: %+v err=%v", current, err)
			}
			code, out = doJSON(t, f.server.Client(), "POST", f.url+"/deliveries", f.admin, map[string]any{"runId": f.run.ID, "previewId": f.preview.ID, "expectedPreviewRevision": f.preview.Revision, "name": "Quorum artifact", "version": "1", "comment": "Package exact approved artifact"})
			projectTestStatus(t, code, 409, out)
			var deliveries int
			if err := f.d.DB.QueryRow(`SELECT COUNT(*) FROM execution_deliveries WHERE tenant_id=? AND project_id=?`, f.p.TenantID, f.p.ID).Scan(&deliveries); err != nil || deliveries != 0 {
				t.Fatalf("denied quorum left outbound package: count=%d err=%v", deliveries, err)
			}
		})
	}
}

func TestProjectIndependentSignoffLegacyReviewValidatesFinalAcceptance(t *testing.T) {
	f := newIndependentSignoffHTTPFixture(t)
	// The signed artifact must carry proof for its own final snapshot, even
	// when the caller uses the existing single-review HTTP route.
	var err error
	f.preview, err = f.h.mutateMerge(context.Background(), f.p, f.run.ID, f.preview.ID, f.preview.Revision, "signoff-admin", "fixture.corrupt_proof", "Independent negative fixture", func(_ *sql.Tx, p *projectMergePreview) error {
		p.Verifications[0].SnapshotID = strings.Repeat("d", 64)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	code, out := doJSON(t, f.server.Client(), "POST", f.legacyURL+"/review", f.a, map[string]any{"expectedRevision": f.preview.Revision, "snapshotId": f.preview.Plan.Result.ID, "decision": "approved", "comment": "Approval must verify the final artifact evidence"})
	if code != 400 && code != 409 {
		t.Fatalf("invalid final evidence acquired approval: HTTP %d %#v", code, out)
	}
	var votes int
	if err := f.d.DB.QueryRow(`SELECT COUNT(*) FROM execution_signoff_votes WHERE tenant_id=? AND project_id=?`, f.p.TenantID, f.p.ID).Scan(&votes); err != nil || votes != 0 {
		t.Fatalf("invalid artifact acquired signature: count=%d err=%v", votes, err)
	}
}
