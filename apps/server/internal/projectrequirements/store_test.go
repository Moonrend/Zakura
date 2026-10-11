package projectrequirements

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/requirements"
	_ "github.com/mattn/go-sqlite3"
)

func setup(t *testing.T) (*Store, *projectexec.Store, mission.Project, mission.Scope) {
	t.Helper()
	db, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "requirements.db")+"?_foreign_keys=on&_busy_timeout=10000&_journal_mode=WAL")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(8)
	t.Cleanup(func() { db.Close() })
	for _, q := range []string{`CREATE TABLE tenants(id TEXT PRIMARY KEY)`, `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id))`, `INSERT INTO tenants VALUES('tenant-a'),('tenant-b')`, `INSERT INTO spaces VALUES('space-a','tenant-a'),('space-b','tenant-b')`} {
		if _, err = db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"0006_project_execution.sql", "0007_project_merge_reviews.sql", "0010_project_portfolio.sql", "0011_project_deliveries.sql", "0013_project_requirements.sql"} {
		raw, e := os.ReadFile("../platform/migrations/sql/" + name)
		if e != nil {
			t.Fatal(e)
		}
		for _, q := range strings.Split(string(raw), "-- statement-breakpoint") {
			if _, e = db.Exec(q); e != nil {
				t.Fatal(name, e)
			}
		}
	}
	exec := projectexec.NewStore(db, "sqlite", nil)
	spec := mission.TaskSpec{ID: "a", Title: "Implement", Prompt: "Implement", AgentID: "agent", MaxAttempts: 3, Checks: []mission.CheckSpec{{ID: "file", Kind: "path_exists", Path: "result.txt", Required: true}}}
	other := spec
	other.ID = "b"
	p, err := exec.CreateProject(context.Background(), mission.Project{ID: "project-a", TenantID: "tenant-a", SpaceID: "space-a", Name: "Requirements", Goal: "Ship traceable behavior", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{spec, other}}, Config: mission.Config{Budget: mission.Budget{MaxConcurrent: 1, MaxModelCalls: 100, MaxToolCalls: 100, MaxTokens: 100000}, MaxTasks: 100}})
	if err != nil {
		t.Fatal(err)
	}
	return NewStore(db, "sqlite", nil), exec, p, mission.Scope{TenantID: p.TenantID, SpaceID: p.SpaceID, ProjectID: p.ID}
}
func draft() requirements.Draft {
	return requirements.Draft{Title: "Release requirements", RequiredBeforePublication: true, Clauses: []requirements.Clause{{ID: "REQ-1", Kind: "functional", Title: "Required implementation", Required: true, Bindings: []requirements.Binding{{TaskSpecID: "a", CheckID: "file"}}}}}
}
func approve(t *testing.T, s *Store, p mission.Project, scope mission.Scope) requirements.Baseline {
	t.Helper()
	baseline, err := s.Create(context.Background(), scope, draft(), "human")
	if err != nil {
		t.Fatal(err)
	}
	baseline, err = s.Review(context.Background(), scope, baseline.ID, baseline.Revision, p.Revision, "approved", "Checked each acceptance mapping", "human", true)
	if err != nil {
		t.Fatal(err)
	}
	return baseline
}

type snapshotFiles map[string]string

func (f snapshotFiles) Stat(ctx context.Context, path string) (acceptance.FileInfo, error) {
	raw, ok := f[path]
	if !ok {
		return acceptance.FileInfo{}, acceptance.ErrNotFound
	}
	return acceptance.FileInfo{Size: int64(len(raw))}, nil
}
func (f snapshotFiles) ReadFile(ctx context.Context, path string, limit int64) ([]byte, error) {
	raw, ok := f[path]
	if !ok {
		return nil, acceptance.ErrNotFound
	}
	return []byte(raw), nil
}
func proof(t *testing.T, task mission.Task, snapshot string, files snapshotFiles) mission.Verification {
	t.Helper()
	report, err := acceptance.Evaluate(context.Background(), task.Spec.Checks, acceptance.Environment{SnapshotID: snapshot, Files: files}, acceptance.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return report.Verification("verification-"+task.ID+"-"+snapshot, task.ID, "branch", time.Now().UTC())
}
func completed(t *testing.T, s *Store, exec *projectexec.Store, scope mission.Scope, runID, specID string) (mission.Task, mission.Verification) {
	t.Helper()
	tasks, err := exec.ListTasks(context.Background(), scope.TenantID, scope.ProjectID, runID)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range tasks {
		if task.Spec.ID != specID {
			continue
		}
		task.Status = "completed"
		task.SnapshotID = "snapshot-" + specID
		task.Revision++
		raw, _ := json.Marshal(task)
		if _, err = s.db.Exec(`UPDATE execution_tasks SET status=?,revision=?,task_json=? WHERE run_id=? AND id=?`, task.Status, task.Revision, string(raw), runID, task.ID); err != nil {
			t.Fatal(err)
		}
		verification := proof(t, task, task.SnapshotID, snapshotFiles{"result.txt": "implemented"})
		body, _ := json.Marshal(verification)
		if _, err = s.db.Exec(`INSERT INTO execution_verifications(id,tenant_id,project_id,run_id,task_id,revision,verification_json,created_at) VALUES(?,?,?,?,?,?,?,?)`, verification.ID, scope.TenantID, scope.ProjectID, runID, task.ID, task.Revision, string(body), stamp(time.Now().UTC())); err != nil {
			t.Fatal(err)
		}
		return task, verification
	}
	t.Fatal("task not found")
	return mission.Task{}, mission.Verification{}
}
func TestBindingFreezesApprovalAndGateUsesExactMappedTask(t *testing.T) {
	s, exec, p, scope := setup(t)
	ctx := context.Background()
	baseline := approve(t, s, p, scope)
	run, err := exec.CreateRun(ctx, p.TenantID, p.ID, "base")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Gate(ctx, scope, run.ID); err != nil {
		t.Fatalf("unbound default changed %v", err)
	}
	binding, err := s.Bind(ctx, scope, baseline.ID, run.ID, baseline.Revision, "member")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Bind(ctx, scope, baseline.ID, run.ID, baseline.Revision, "member"); err != nil {
		t.Fatalf("idempotent bind %v", err)
	}
	if err = s.Gate(ctx, scope, run.ID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing evidence gate %v", err)
	}
	completed(t, s, exec, scope, run.ID, "b")
	if err = s.Gate(ctx, scope, run.ID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unrelated task bypassed gate %v", err)
	}
	task, _ := completed(t, s, exec, scope, run.ID, "a")
	if err = s.Gate(ctx, scope, run.ID); err != nil {
		t.Fatal(err)
	}
	updated, err := s.Update(ctx, scope, baseline.ID, baseline.Revision, draft(), "Need another review", "member")
	if err != nil || updated.Status != "draft" || updated.ApprovedAt != nil {
		t.Fatalf("edit %+v %v", updated, err)
	}
	saved, found, err := s.Binding(ctx, scope, run.ID)
	if err != nil || !found || saved.BaselineHash != binding.BaselineHash || saved.Baseline.Status != "approved" {
		t.Fatalf("bound history mutated %+v %v", saved, err)
	}
	if _, err = s.Bind(ctx, scope, baseline.ID, run.ID, updated.Revision, "member"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("draft rebind %v", err)
	}
	final := proof(t, task, "final", snapshotFiles{"result.txt": "implemented"})
	if err = s.tx(ctx, scope, func(tx *sql.Tx) error {
		return s.ArtifactGateTx(ctx, tx, scope, run.ID, map[string]string{}, []mission.Verification{final}, "final")
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("subset merge bypassed required clause %v", err)
	}
	if err = s.tx(ctx, scope, func(tx *sql.Tx) error {
		return s.ArtifactGateTx(ctx, tx, scope, run.ID, map[string]string{task.ID: task.SnapshotID}, []mission.Verification{final}, "final")
	}); err != nil {
		t.Fatalf("valid final artifact %v", err)
	}
	failed := proof(t, task, "final-failed", snapshotFiles{})
	if err = s.tx(ctx, scope, func(tx *sql.Tx) error {
		return s.ArtifactGateTx(ctx, tx, scope, run.ID, map[string]string{task.ID: task.SnapshotID}, []mission.Verification{failed}, "final-failed")
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("failed final proof passed %v", err)
	}
	other := scope
	other.TenantID = "tenant-b"
	if _, err = s.Get(ctx, other, baseline.ID, 2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("scope leaked %v", err)
	}
}
func TestApprovalCASMappingValidationAndChangedRunPlan(t *testing.T) {
	s, exec, p, scope := setup(t)
	ctx := context.Background()
	invalidDraft := draft()
	invalidDraft.Clauses[0].Bindings = nil
	baseline, err := s.Create(ctx, scope, invalidDraft, "human")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Review(ctx, scope, baseline.ID, 1, p.Revision, "approved", "Check", "human", false); !errors.Is(err, ErrInvalid) {
		t.Fatalf("machine review %v", err)
	}
	if _, err = s.Review(ctx, scope, baseline.ID, 1, p.Revision, "approved", "Check", "human", true); !errors.Is(err, ErrInvalid) {
		t.Fatalf("orphan approved %v", err)
	}
	baseline, err = s.Update(ctx, scope, baseline.ID, 1, draft(), "Add mapping", "human")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Review(ctx, scope, baseline.ID, baseline.Revision, p.Revision+1, "approved", "Check", "human", true); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale plan accepted %v", err)
	}
	baseline, err = s.Review(ctx, scope, baseline.ID, baseline.Revision, p.Revision, "approved", "Check", "human", true)
	if err != nil {
		t.Fatal(err)
	}
	changed := p
	changed.Plan.Tasks[0].Prompt = "Another execution"
	changed, err = exec.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, changed)
	if err != nil {
		t.Fatal(err)
	}
	run, err := exec.CreateRun(ctx, p.TenantID, p.ID, "base")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Bind(ctx, scope, baseline.ID, run.ID, baseline.Revision, "human"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("different run plan bound %v", err)
	}
	if _, err = s.db.Exec(`INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES('tenant-a',1,'now')`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(ctx, scope, draft(), "human"); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatalf("draining bypass %v", err)
	}
}
