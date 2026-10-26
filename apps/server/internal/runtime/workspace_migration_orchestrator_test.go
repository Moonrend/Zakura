// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/go-chi/chi/v5"
)

type migrationRig struct {
	h               *handler
	space           Space
	mu              sync.Mutex
	sourceStatus    string
	targetStatus    string
	targetContainer computerContainer
	phase           string
	digest          string
	archive         []byte
	failAt          string
	effects         []string
}

func migrationFixtureArchive(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	for _, header := range []*tar.Header{
		{Name: ".", Typeflag: tar.TypeDir, Mode: 0750},
		{Name: ".home", Typeflag: tar.TypeDir, Mode: 0700},
		{Name: ".home/credential", Typeflag: tar.TypeReg, Mode: 0600, Size: 6},
		{Name: "run.sh", Typeflag: tar.TypeReg, Mode: 0755, Size: 6},
		{Name: "run-link", Typeflag: tar.TypeSymlink, Mode: 0777, Linkname: "run.sh"},
	} {
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Size > 0 {
			_, _ = tw.Write([]byte("sample"))
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func newMigrationRig(t *testing.T, running bool, failAt string) *migrationRig {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	for _, node := range []string{"source", "target"} {
		hash := sha256.Sum256([]byte("rnr_" + node))
		if err := d.Gorm.Table("runtime_nodes").Create(map[string]any{"id": node, "tenant_id": "tenant", "name": node, "slug": node, "kind": "computer", "status": "offline", "token_hash": hex.EncodeToString(hash[:]), "capabilities_json": "{}", "host_info_json": "{}", "storage_root": "/fixture", "labels_json": "{}", "is_shared": false, "created_at": "before", "updated_at": "before"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	store := NewStore(d)
	source := "source"
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Migration", RuntimeNodeID: &source, WorkspaceKind: "container"})
	if err != nil {
		t.Fatal(err)
	}
	status := "stopped"
	containerStatus := "exited"
	if running {
		status, containerStatus = "running", "running"
	}
	if err := d.Gorm.Table("spaces").Where("id=?", space.ID).Update("workspace_status", status).Error; err != nil {
		t.Fatal(err)
	}
	space.WorkspaceStatus = status
	h := &handler{deps: d, store: store, hub: newRunnerHub(d), mcpSessions: map[string]spaceMCPSession{}}
	h.service = NewService(store)
	rig := &migrationRig{h: h, space: space, sourceStatus: containerStatus, failAt: failAt, archive: migrationFixtureArchive(t)}
	digest := sha256.Sum256(rig.archive)
	rig.digest = hex.EncodeToString(digest[:])
	router := chi.NewRouter()
	router.Handle("/api/runtime-nodes/hub", http.HandlerFunc(h.runnerHubHTTP))
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	for _, node := range []string{"source", "target"} {
		node := node
		startMigrationRunner(t, server.URL, "rnr_"+node, func(method string, params map[string]any) (any, error) { return rig.handle(node, method, params) })
	}
	deadline := time.Now().Add(3 * time.Second)
	for _, node := range []string{"source", "target"} {
		for {
			if _, err := h.hub.get(node); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("fixture runners did not attach")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	return rig
}

func (r *migrationRig) handle(node, method string, params map[string]any) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch method {
	case "sys.info":
		return map[string]any{"version": "fixture", "kind": "computer", "storageRoot": "/fixture", "capabilities": map[string]any{"host": true, "docker": true, "privateAtomicFS": true, "filesystemNoFollowStat": true, "filesystemWorkspaceMigration": true, "dockerCreateReceipts": true}, "hostInfo": map[string]any{"platform": "linux"}}, nil
	case "docker.list":
		state, id := r.sourceStatus, "source-workspace"
		if node == "target" {
			state, id = r.targetStatus, "target-workspace"
		}
		if state == "" {
			return []any{}, nil
		}
		if node == "target" && r.targetContainer.DockerID != "" {
			return []computerContainer{r.targetContainer}, nil
		}
		return []map[string]any{{"dockerId": id, "name": id, "image": "fixture-image", "status": state, "labels": map[string]string{"zakura.tenant": "tenant", "zakura.space": r.space.ID, "zakura.purpose": "workspace"}}}, nil
	case "docker.stop":
		if params["remove"] == true {
			return nil, errors.New("source container must be retained")
		}
		r.effects = append(r.effects, node+":stop")
		if node == "source" {
			r.sourceStatus = "exited"
		} else {
			r.targetStatus = "exited"
		}
		return map[string]any{"ok": true}, nil
	case "docker.start":
		r.effects = append(r.effects, node+":start")
		if node == "source" {
			r.sourceStatus = "running"
		} else {
			r.targetStatus = "running"
		}
		return map[string]any{"ok": true}, nil
	case "host.fs.mkdir":
		return map[string]any{"abs": "/fixture/workspace", "ok": true}, nil
	case "docker.images":
		return []computerImageStatus{}, nil
	case "docker.pull":
		return map[string]any{"ok": true}, nil
	case "docker.create":
		r.effects = append(r.effects, node+":create")
		if r.failAt == "restore" && node == "target" {
			return nil, errors.New("fixture startup failed")
		}
		r.targetStatus = "running"
		r.targetContainer = workspaceReceiptFixture(params, "target-workspace")
		return r.targetContainer, nil
	case "docker.create.status":
		return workspaceReceiptStatusFixture(r.targetContainer), nil
	case "host.fs.migration":
		op := fmt.Sprint(params["operation"])
		r.effects = append(r.effects, node+":"+op)
		if r.failAt == op && op != "commit" {
			return nil, errors.New("fixture " + op + " failure")
		}
		switch op {
		case "inspect":
			return map[string]any{"phase": "inspected", "size": len(r.archive), "entries": 5}, nil
		case "export":
			return map[string]any{"phase": "exported", "archiveBase64": base64.StdEncoding.EncodeToString(r.archive), "archiveSha256": r.digest, "size": len(r.archive)}, nil
		case "prepare":
			r.phase = "prepared"
		case "import":
			if params["archiveSha256"] != r.digest || params["archiveBase64"] != base64.StdEncoding.EncodeToString(r.archive) {
				return nil, errors.New("archive changed in transfer")
			}
			r.phase = "imported"
		case "verify":
			r.phase = "verified"
		case "commit":
			r.phase = "committed"
			if r.failAt == "commit" {
				return nil, errors.New("fixture dropped commit response")
			}
		case "status":
		default:
			return nil, fmt.Errorf("unexpected migration operation %s", op)
		}
		return map[string]any{"phase": r.phase, "archiveSha256": r.digest, "verified": r.phase == "verified" || r.phase == "committed"}, nil
	}
	return nil, fmt.Errorf("unexpected fixture method %s", method)
}

func (r *migrationRig) run(t *testing.T) (models.WorkspaceMigration, *workspaceLease) {
	t.Helper()
	ctx := context.Background()
	lease, err := r.h.acquireSpaceWorkspace(ctx, "tenant", r.space.ID, "migrating", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	id, phase := "migration-fixture", "queued"
	job := models.WorkspaceMigration{ID: &id, TenantID: "tenant", SpaceID: r.space.ID, SourceNodeID: "source", TargetNodeID: "target", Status: "pending", Phase: &phase, CreatedAt: "before", UpdatedAt: "before", ExcludePatternsJSON: "[]"}
	if err := r.h.deps.Gorm.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	r.h.runLeasedWorkspaceMigration(ctx, id, lease, "target")
	if err := r.h.deps.Gorm.Where("id=?", id).Take(&job).Error; err != nil {
		t.Fatal(err)
	}
	return job, lease
}

func TestWorkspaceMigrationOrchestratesRunningWorkspace(t *testing.T) {
	r := newMigrationRig(t, true, "")
	job, _ := r.run(t)
	if job.Status != "completed" || job.Phase == nil || *job.Phase != "completed" || !job.SourceRetained {
		t.Fatalf("migration=%+v", job)
	}
	space, err := r.h.store.GetSpace(context.Background(), "tenant", r.space.ID)
	if err != nil || space.RuntimeNodeID == nil || *space.RuntimeNodeID != "target" || space.WorkspaceStatus != "running" {
		t.Fatalf("space=%+v err=%v", space, err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sourceStatus != "exited" || r.targetStatus != "running" {
		t.Fatalf("source/target status=%s/%s", r.sourceStatus, r.targetStatus)
	}
	want := []string{"source:stop", "source:export", "target:import", "target:verify", "target:commit", "target:create"}
	index := 0
	for _, effect := range r.effects {
		if index < len(want) && effect == want[index] {
			index++
		}
	}
	if index != len(want) {
		t.Fatalf("wrong effect order=%v", r.effects)
	}
	var leases int64
	if err := r.h.deps.Gorm.Table("computer_workspace_leases").Count(&leases).Error; err != nil || leases != 0 {
		t.Fatalf("lease not finished=%d %v", leases, err)
	}
}

func TestWorkspaceMigrationPreflightFailureNeverStopsSource(t *testing.T) {
	r := newMigrationRig(t, true, "inspect")
	job, _ := r.run(t)
	if job.Status != "failed" {
		t.Fatalf("job=%+v", job)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sourceStatus != "running" {
		t.Fatal("source stopped despite unsupported preflight")
	}
	for _, effect := range r.effects {
		if effect == "source:stop" || effect == "target:import" {
			t.Fatalf("unsafe preflight effects=%v", r.effects)
		}
	}
}

func TestWorkspaceMigrationDroppedCommitReplyRecoversFromReceipt(t *testing.T) {
	r := newMigrationRig(t, false, "commit")
	job, lease := r.run(t)
	if job.Status != "waiting" || !lease.retained {
		t.Fatalf("unconfirmed commit unlocked: %+v", job)
	}
	space, _ := r.h.store.GetSpace(context.Background(), "tenant", r.space.ID)
	if *space.RuntimeNodeID != "source" {
		t.Fatal("binding switched before commit acknowledgement")
	}
	// Restart continuation uses durable status, not a second export/import.
	if err := r.h.recoverWorkspaceMigration(context.Background(), lease); err != nil {
		t.Fatal(err)
	}
	space, _ = r.h.store.GetSpace(context.Background(), "tenant", r.space.ID)
	if *space.RuntimeNodeID != "target" || space.WorkspaceStatus != "stopped" {
		t.Fatalf("recovered binding=%+v", space)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	imports := 0
	for _, effect := range r.effects {
		if effect == "target:import" {
			imports++
		}
	}
	if imports != 1 {
		t.Fatalf("recovery repeated import=%d", imports)
	}
}

func TestWorkspaceMigrationPostSwitchFailureKeepsTargetAndSource(t *testing.T) {
	r := newMigrationRig(t, true, "restore")
	job, lease := r.run(t)
	space, _ := r.h.store.GetSpace(context.Background(), "tenant", r.space.ID)
	if job.Status != "waiting" || job.Phase == nil || *job.Phase != "restore_failed" || *space.RuntimeNodeID != "target" || !lease.retained || !job.SourceRetained {
		t.Fatalf("dishonest restore failure job=%+v space=%+v", job, space)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sourceStatus != "exited" {
		t.Fatal("post-switch failure restarted old source")
	}
}

func TestWorkspaceMigrationFailedRestoreDoesNotDuplicateCreate(t *testing.T) {
	r := newMigrationRig(t, true, "restore")
	_, lease := r.run(t)
	if err := r.h.recoverWorkspaceMigration(context.Background(), lease); err == nil {
		t.Fatal("unknown target create was repeated")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	creates := 0
	for _, effect := range r.effects {
		if effect == "target:create" {
			creates++
		}
	}
	if creates != 1 {
		t.Fatalf("target creates=%d", creates)
	}
}

func TestWorkspaceMigrationRestoredSourceCannotActivateStaleSnapshot(t *testing.T) {
	r := newMigrationRig(t, true, "commit")
	job, lease := r.run(t)
	if job.Status != "waiting" {
		t.Fatalf("job=%+v", job)
	}
	if err := r.h.recoverWorkspaceMigration(context.Background(), lease); err == nil {
		t.Fatal("resumed source was switched to a stale snapshot")
	}
	space, _ := r.h.store.GetSpace(context.Background(), "tenant", r.space.ID)
	if *space.RuntimeNodeID != "source" {
		t.Fatal("source binding lost")
	}
}

func TestWorkspaceMigrationPauseKeepsQueuedMessages(t *testing.T) {
	r := newMigrationRig(t, false, "")
	ctx := context.Background()
	agent, err := r.h.store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: r.space.ID})
	if err != nil {
		t.Fatal(err)
	}
	session, err := r.h.store.CreateSession(ctx, "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	run, err := r.h.store.StartRun(ctx, "tenant", agent.ID, session.ID, "first", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.h.store.Enqueue(ctx, "tenant", agent.ID, session.ID, QueueMessage{Content: "queued"}); err != nil {
		t.Fatal(err)
	}
	liveCtx, cancel := context.WithCancel(ctx)
	live := r.h.service.registerRun(run.ID, session.ID, cancel)
	go func() {
		<-liveCtx.Done()
		_ = r.h.store.FinishRun(context.Background(), "tenant", agent.ID, session.ID, run.ID, "cancelled", nil, nil)
		r.h.service.unregisterRun(live)
		r.h.service.startNext(ctx, "tenant", agent.ID, session.ID)
	}()
	lease, err := r.h.acquireSpaceWorkspace(ctx, "tenant", r.space.ID, "migrating", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.release()
	if err := r.h.migrationPauseRuns(ctx, lease); err != nil {
		t.Fatal(err)
	}
	queued, err := r.h.store.PendingQueue(ctx, "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(queued) != 1 {
		t.Fatalf("migration consumed queued input=%d", len(queued))
	}
}

func TestWorkspaceMigrationInterruptedJournalRemainsProtected(t *testing.T) {
	r := newMigrationRig(t, false, "")
	lease, err := r.h.acquireSpaceWorkspace(context.Background(), "tenant", r.space.ID, "migrating", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	id, phase := "interrupted", "pausing"
	manifest := migrationManifest{Version: 1, Source: "source", Target: "target", PreviousStatus: "stopped"}
	raw := string(rawJSON(manifest))
	job := models.WorkspaceMigration{ID: &id, TenantID: "tenant", SpaceID: r.space.ID, SourceNodeID: "source", TargetNodeID: "target", Status: "running", Phase: &phase, ManifestJSON: &raw, CreatedAt: "before", UpdatedAt: "before", ExcludePatternsJSON: "[]"}
	if err := r.h.deps.Gorm.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	if err := r.h.recoverWorkspaceMigration(context.Background(), lease); err == nil || !lease.retained {
		t.Fatal("restart without receipt unlocked workspace")
	}
	encoded, _ := json.Marshal(manifest)
	if len(encoded) == 0 {
		t.Fatal("journal missing")
	}
}
