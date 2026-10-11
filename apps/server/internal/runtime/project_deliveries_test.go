// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/delivery"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func deliveryHTTPBytes(t *testing.T, server *httptest.Server, method, url, token string, data []byte, headers map[string]string) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, url, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, body
}

func TestProjectDeliveryHTTPActualReviewedArtifactRangesChannelsImportAndFreshRun(t *testing.T) {
	ctx := context.Background()
	d := testDeps(t)
	token := seedTenant(t, d, "tenant-delivery")
	other := seedTenant(t, d, "tenant-delivery-other")
	human := projectTestHumanToken(t, d, "tenant-delivery", "reviewer")
	root := t.TempDir()
	node := "delivery-node"
	runnerToken := "rnr_delivery-runner"
	hash := sha256.Sum256([]byte(runnerToken))
	now := runtimeTimeString(d.Clock())
	if _, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES(?,?,?,?,?,'offline',?,'{}','{}',?,'{}',false,?,?)`, node, "tenant-delivery", "Delivery Node", "delivery-node", "computer", hex.EncodeToString(hash[:]), root, now, now); err != nil {
		t.Fatal(err)
	}
	h, server, shutdown := projectTestServer(t, d)
	defer shutdown()
	h.initializeProjectRequirements()
	space, err := h.store.CreateSpace(ctx, "tenant-delivery", Space{Name: "Delivery workspace", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(ctx, "tenant-delivery", Agent{Name: "Artifact author", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	project, err := h.projects.CreateProject(ctx, mission.Project{TenantID: "tenant-delivery", SpaceID: space.ID, Name: "Useful feature", Goal: "Ship reviewed artifacts", Config: mission.Config{RequireReview: true, MaxTasks: 10, ExternalEffects: "deny"}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "feature", Title: "Author feature", Prompt: "Implement useful artifact", AgentID: agent.ID, Writes: []string{"feature.txt"}, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "feature.txt", Required: true}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "spaces", space.ID, "workspace")
	if err = os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	projectTestWrite(t, filepath.Join(source, "baseline.txt"), "original source remains private\n")
	stop := projectTestRunAgent(t, projectTestAgentBinary(t), server.URL, runnerToken, root)
	defer stop()
	projectTestWaitRunner(t, h, node)
	base, err := h.projectBridge.Base(ctx, projectScope(project))
	if err != nil {
		t.Fatal(err)
	}
	run, err := h.projects.CreateRun(ctx, project.TenantID, project.ID, base, project.Revision)
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := h.projects.ClaimTask(ctx, "delivery-worker", time.Minute)
	if err != nil || assignment == nil {
		t.Fatalf("claim: %+v %v", assignment, err)
	}
	ref := projectexec.FenceRequest{Scope: assignment.Scope, RunID: run.ID, TaskID: assignment.Task.ID, Owner: assignment.Task.LeaseOwner, Fence: assignment.Task.Fence}
	branch, err := h.projectBridge.Fork(ctx, projectScope(project), base, assignment.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.projects.InitializeTaskBranch(ctx, ref, branch, base); err != nil {
		t.Fatal(err)
	}
	var write json.RawMessage
	if err = h.projectBridge.rpc(ctx, projectScope(project), "project.branch.write", map[string]any{"operationId": "delivery_author_write", "branchId": branch, "path": "feature.txt", "content": strings.Repeat("useful feature artifact\n", 14000)}, &write); err != nil {
		t.Fatal(err)
	}
	snapshot, err := h.projectBridge.Snapshot(ctx, projectScope(project), branch)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := h.projectBridge.Verify(ctx, projectScope(project), branch, assignment.Task.Spec.Checks)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.projects.RecordVerification(ctx, ref, verified); err != nil {
		t.Fatal(err)
	}
	if err = h.projects.CompleteTask(ctx, ref, "Useful artifact authored", snapshot); err != nil {
		t.Fatal(err)
	}
	baseURL := server.URL + "/api/project-executions/" + project.ID
	runURL := baseURL + "/runs/" + run.ID
	task, err := h.projects.GetTask(ctx, project.TenantID, project.ID, run.ID, assignment.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	projectTestApproveTask(t, server, runURL, token, human, task)
	run, err = h.projects.GetRun(ctx, project.TenantID, project.ID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	task, err = h.projects.GetTask(ctx, project.TenantID, project.ID, run.ID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	preview := projectTestMergePreview(t, server, runURL, token, run, task)
	createBody := func(version string) map[string]any {
		return map[string]any{"runId": run.ID, "previewId": preview.ID, "expectedPreviewRevision": preview.Revision, "name": "Useful feature", "version": version, "comment": "Package the reviewed frozen artifact."}
	}
	code, body := doJSON(t, server.Client(), "POST", baseURL+"/deliveries", human, createBody("v1"))
	if code == 201 {
		t.Fatal("unreviewed merge became a delivery")
	}
	preview = projectTestMergeReview(t, server, runURL, token, human, preview)
	code, body = doJSON(t, server.Client(), "POST", baseURL+"/deliveries", token, createBody("v1"))
	projectTestStatus(t, code, 403, body)
	code, body = doJSON(t, server.Client(), "POST", baseURL+"/deliveries", human, createBody("v1"))
	projectTestStatus(t, code, 201, body)
	artifact := projectTestDecode[projectDelivery](t, body)
	if artifact.Status != "ready" || artifact.Archive == nil || artifact.Manifest == nil || artifact.SnapshotID != preview.Plan.Result.ID || artifact.UntrustedReview {
		t.Fatalf("review binding lost: %+v", artifact)
	}
	archiveURL := baseURL + "/deliveries/" + artifact.ID + "/archive"
	code, headers, archive := deliveryHTTPBytes(t, server, "GET", archiveURL, token, nil, nil)
	actualHash := sha256.Sum256(archive)
	if code != 200 || int64(len(archive)) != artifact.Archive.Bytes || hex.EncodeToString(actualHash[:]) != artifact.Archive.SHA256 || headers.Get("Cache-Control") != "private, no-store" {
		t.Fatal("actual download differs from frozen archive")
	}
	for _, sample := range []struct {
		Range      string
		Start, End int
	}{{"bytes=0-31", 0, 32}, {"bytes=-37", len(archive) - 37, len(archive)}, {"bytes=" + strings.TrimSpace(deliveryJSONNumber(int64(len(archive)-5))) + "-", len(archive) - 5, len(archive)}} {
		code, headers, data := deliveryHTTPBytes(t, server, "GET", archiveURL, token, nil, map[string]string{"Range": sample.Range})
		if code != 206 || !bytes.Equal(data, archive[sample.Start:sample.End]) || headers.Get("Content-Range") == "" {
			t.Fatalf("byte range failed %s %d", sample.Range, code)
		}
	}
	code, _, data := deliveryHTTPBytes(t, server, "GET", archiveURL, token, nil, map[string]string{"Range": "bytes=0-31", "If-Range": "different-revision"})
	if code != 200 || !bytes.Equal(data, archive) {
		t.Fatal("If-Range mismatch served partial content")
	}
	code, _, _ = deliveryHTTPBytes(t, server, "GET", archiveURL, token, nil, map[string]string{"Range": "bytes=0-1,3-4"})
	if code != 416 {
		t.Fatal("multipart range unexpectedly accepted")
	}
	code, _, _ = deliveryHTTPBytes(t, server, "GET", archiveURL, other, nil, nil)
	if code != 404 {
		t.Fatal("foreign tenant downloaded artifact")
	}
	// The cache is authoritative only after identity/hash validation. A lost
	// control-plane reply can be inspected without preparing another archive.
	artifact, err = h.mutateDelivery(ctx, project, artifact.ID, "delivery", artifact.Revision, false, "test_lost_receipt", "test", "", func(_ *sql.Tx, current *projectDelivery) error {
		current.Status = "unknown"
		current.Archive = nil
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	code, body = doJSON(t, server.Client(), "POST", baseURL+"/deliveries/"+artifact.ID+"/inspect", token, map[string]any{})
	projectTestStatus(t, code, 200, body)
	artifact = projectTestDecode[projectDelivery](t, body)
	if artifact.Status != "ready" || artifact.Archive.SHA256 != hex.EncodeToString(actualHash[:]) {
		t.Fatal("inspection did not recover frozen cache receipt")
	}
	channelURL := baseURL + "/deliveries/channels/stable"
	promote := map[string]any{"deliveryId": artifact.ID, "expectedRevision": 0, "comment": "Promote reviewed v1."}
	code, body = doJSON(t, server.Client(), "PUT", channelURL, token, promote)
	projectTestStatus(t, code, 403, body)
	code, body = doJSON(t, server.Client(), "PUT", channelURL, human, promote)
	projectTestStatus(t, code, 200, body)
	code, body = doJSON(t, server.Client(), "PUT", channelURL, human, promote)
	projectTestStatus(t, code, 409, body)
	code, body = doJSON(t, server.Client(), "POST", baseURL+"/deliveries/"+artifact.ID+"/revoke", human, map[string]any{"expectedRevision": artifact.Revision, "comment": "Attempt active-channel revoke."})
	if code == 200 {
		t.Fatal("active release channel was silently revoked")
	}
	code, body = doJSON(t, server.Client(), "POST", baseURL+"/deliveries", human, createBody("v2"))
	projectTestStatus(t, code, 201, body)
	second := projectTestDecode[projectDelivery](t, body)
	code, body = doJSON(t, server.Client(), "PUT", channelURL, human, map[string]any{"deliveryId": second.ID, "expectedRevision": 1, "comment": "Promote reviewed v2."})
	projectTestStatus(t, code, 200, body)
	code, body = doJSON(t, server.Client(), "POST", baseURL+"/deliveries/"+artifact.ID+"/revoke", token, map[string]any{"expectedRevision": artifact.Revision, "comment": "Revoke old release."})
	projectTestStatus(t, code, 403, body)
	code, body = doJSON(t, server.Client(), "POST", baseURL+"/deliveries/"+artifact.ID+"/revoke", human, map[string]any{"expectedRevision": artifact.Revision, "comment": "Revoke old release."})
	projectTestStatus(t, code, 200, body)
	code, _, _ = deliveryHTTPBytes(t, server, "GET", archiveURL, token, nil, nil)
	if code == 200 {
		t.Fatal("revoked artifact was downloadable")
	}
	code, body = doJSON(t, server.Client(), "POST", baseURL+"/imports", token, map[string]any{"name": "Imported package", "totalBytes": len(archive), "sha256": hex.EncodeToString(actualHash[:])})
	projectTestStatus(t, code, 201, body)
	transfer := projectTestDecode[projectDelivery](t, body)
	importURL := baseURL + "/imports/" + transfer.ID
	for offset := 0; offset < len(archive); {
		end := min(offset+delivery.ChunkBytes, len(archive))
		code, _, data = deliveryHTTPBytes(t, server, "PUT", importURL+"/chunks?offset="+deliveryJSONNumber(int64(offset)), token, archive[offset:end], nil)
		if code != 200 {
			t.Fatalf("HTTP chunk rejected: %d %s", code, data)
		}
		if err := json.Unmarshal(data, &transfer); err != nil {
			t.Fatal(err)
		}
		offset = int(transfer.Received)
	}
	code, body = doJSON(t, server.Client(), "POST", importURL+"/finish", token, map[string]any{})
	projectTestStatus(t, code, 200, body)
	transfer = projectTestDecode[projectDelivery](t, body)
	if transfer.Status != "completed" || !transfer.UntrustedReview || transfer.Manifest.Review.ID != preview.ReviewID {
		t.Fatal("foreign provenance became trusted approval")
	}
	// A receiver freezes its CURRENT local plan; no donor review/checkpoint/task
	// success enters the new run, even though the immutable files are retained.
	project.Plan.Tasks[0].Prompt = "Revise the imported artifact with new local instructions"
	project.Plan.Tasks[0].Title = "Local revision"
	project, err = h.projects.UpdateProject(ctx, project.TenantID, project.ID, project.Revision, project)
	if err != nil {
		t.Fatal(err)
	}
	code, body = doJSON(t, server.Client(), "POST", importURL+"/runs", token, map[string]any{"expectedRevision": project.Revision})
	projectTestStatus(t, code, 403, body)
	code, body = doJSON(t, server.Client(), "POST", importURL+"/runs", human, map[string]any{"expectedRevision": project.Revision - 1})
	projectTestStatus(t, code, 409, body)
	code, body = doJSON(t, server.Client(), "POST", importURL+"/runs", human, map[string]any{"expectedRevision": project.Revision})
	projectTestStatus(t, code, 201, body)
	fresh := projectTestDecode[mission.Run](t, body)
	frozen, err := h.projects.GetRunProject(ctx, project.TenantID, project.ID, fresh.ID)
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := h.projects.ListTasks(ctx, project.TenantID, project.ID, fresh.ID)
	if err != nil {
		t.Fatal(err)
	}
	reviews, err := h.projects.ListReviews(ctx, project.TenantID, project.ID, fresh.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.BaseSnapshot != transfer.SnapshotID || fresh.PlanVersion != 2 || frozen.Plan.Tasks[0].Prompt != project.Plan.Tasks[0].Prompt || !frozen.Config.RequireReview || len(reviews) != 0 || len(tasks) != 1 || tasks[0].Status != "pending" || tasks[0].ReusedFromTaskID != "" || fresh.Tokens != 0 {
		t.Fatalf("import inherited execution state or stale plan: %+v %+v", fresh, tasks)
	}
	projectTestRead(t, filepath.Join(source, "baseline.txt"), "original source remains private\n")
	if _, err := os.Stat(filepath.Join(source, "feature.txt")); !os.IsNotExist(err) {
		t.Fatal("delivery/import wrote original source")
	}
	stop()
	shutdown()
}

func deliveryJSONNumber(value int64) string { raw, _ := json.Marshal(value); return string(raw) }

func TestDeliveryRangesRejectOverflowAndUnsatisfiableRequests(t *testing.T) {
	for _, value := range []string{"bytes=9223372036854775808-", "bytes=10-9", "bytes=-0", "bytes=100-", "items=0-1", "bytes=0-1,3-4"} {
		if _, _, _, err := deliveryRange(value, 100); err == nil {
			t.Fatalf("invalid range accepted %q", value)
		}
	}
	start, end, partial, err := deliveryRange("bytes=-1000", 100)
	if err != nil || !partial || start != 0 || end != 99 {
		t.Fatal("long suffix did not clamp to real archive")
	}
}
