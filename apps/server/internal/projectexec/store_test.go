package projectexec

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	_ "github.com/mattn/go-sqlite3"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	db, e := sql.Open("sqlite3", filepath.Join(t.TempDir(), "execution.db")+"?_foreign_keys=on&_busy_timeout=10000&_journal_mode=WAL")
	if e != nil {
		t.Fatal(e)
	}
	db.SetMaxOpenConns(8)
	t.Cleanup(func() { db.Close() })
	for _, q := range []string{`CREATE TABLE tenants(id TEXT PRIMARY KEY)`, `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id))`, `INSERT INTO tenants VALUES('tenant-a'),('tenant-b')`, `INSERT INTO spaces VALUES('space-a','tenant-a'),('space-b','tenant-b')`} {
		if _, e = db.Exec(q); e != nil {
			t.Fatal(e)
		}
	}
	migration, e := os.ReadFile("../platform/migrations/sql/0006_project_execution.sql")
	if e != nil {
		t.Fatal(e)
	}
	for _, q := range strings.Split(string(migration), "-- statement-breakpoint") {
		if _, e = db.Exec(q); e != nil {
			t.Fatal(e)
		}
	}
	portfolio, e := os.ReadFile("../platform/migrations/sql/0010_project_portfolio.sql")
	if e != nil {
		t.Fatal(e)
	}
	for _, q := range strings.Split(string(portfolio), "-- statement-breakpoint") {
		if _, e = db.Exec(q); e != nil {
			t.Fatal(e)
		}
	}
	return NewStore(db, "sqlite", nil)
}
func projectFixture() mission.Project {
	return mission.Project{TenantID: "tenant-a", SpaceID: "space-a", Name: "Implement searchable notes", Goal: "Store notes and demonstrate searchable results", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "implementation", Title: "Implement", Prompt: "Implement the feature", AgentID: "agent-a", MaxAttempts: 3, Checks: []mission.CheckSpec{{ID: "source", Kind: "path_exists", Path: "feature.go", Required: true}}}}}, Config: mission.Config{Budget: mission.Budget{MaxConcurrent: 2, MaxModelCalls: 10, MaxToolCalls: 10, MaxTokens: 100}, ExternalEffects: "allow"}}
}
func createFixture(t *testing.T, s *Store, p mission.Project) (mission.Project, mission.Run) {
	t.Helper()
	ctx := context.Background()
	p, e := s.CreateProject(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	r, e := s.CreateRun(ctx, p.TenantID, p.ID, "base-snapshot")
	if e != nil {
		t.Fatal(e)
	}
	return p, r
}
func claimFixture(t *testing.T, s *Store) (mission.Assignment, FenceRequest) {
	t.Helper()
	a, e := s.ClaimTask(context.Background(), "worker-a", time.Minute)
	if e != nil || a == nil {
		t.Fatalf("claim: %v %v", a, e)
	}
	return *a, FenceRequest{Scope: a.Scope, RunID: a.Run.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}
}
func decisionFixture(t *testing.T, s *Store, ref FenceRequest, decision mission.Decision) mission.Checkpoint {
	t.Helper()
	cp, e := s.GetCheckpoint(context.Background(), ref.Scope, ref.RunID, ref.TaskID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.ReserveDecisionBudget(context.Background(), ref, 10); e != nil {
		t.Fatal(e)
	}
	cp, e = s.RecordModelDecision(context.Background(), ref, cp.Sequence, decision)
	if e != nil {
		t.Fatal(e)
	}
	return cp
}
func verifyFixture(t *testing.T, s *Store, ref FenceRequest) {
	t.Helper()
	ctx := context.Background()
	if e := s.InitializeTaskBranch(ctx, ref, "branch-"+ref.TaskID, "base-snapshot"); e != nil {
		t.Fatal(e)
	}
	task, e := s.GetTask(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID)
	if e != nil {
		t.Fatal(e)
	}
	report, e := acceptance.Evaluate(ctx, task.Spec.Checks, acceptance.Environment{SnapshotID: "result-snapshot", Files: storeSnapshotFiles{"feature.go": "package feature"}}, acceptance.Options{})
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.RecordVerification(ctx, ref, report.Verification("", ref.TaskID, "branch-"+ref.TaskID, time.Now().UTC()))
	if e != nil {
		t.Fatal(e)
	}
}

type storeSnapshotFiles map[string]string

func (f storeSnapshotFiles) Stat(ctx context.Context, path string) (acceptance.FileInfo, error) {
	raw, ok := f[path]
	if !ok {
		return acceptance.FileInfo{}, acceptance.ErrNotFound
	}
	return acceptance.FileInfo{Size: int64(len(raw))}, nil
}
func (f storeSnapshotFiles) ReadFile(ctx context.Context, path string, limit int64) ([]byte, error) {
	raw, ok := f[path]
	if !ok {
		return nil, acceptance.ErrNotFound
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("content exceeds limit")
	}
	return []byte(raw), nil
}

func TestStoreFreezesRunConfigurationAndIsolatesTenants(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	p, r := createFixture(t, s, projectFixture())
	updated := p
	updated.Goal = "An unrelated newer goal"
	updated.Config.ExternalEffects = "deny"
	updated.Config.Budget.MaxTokens = 1
	updated.Plan.Tasks[0].Title = "New plan title"
	next, e := s.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, updated)
	if e != nil {
		t.Fatal(e)
	}
	if next.Revision != 2 || next.Plan.Version != 2 {
		t.Fatal(next)
	}
	frozen, e := s.GetRunProject(ctx, p.TenantID, p.ID, r.ID)
	if e != nil {
		t.Fatal(e)
	}
	if frozen.Config.ExternalEffects != "allow" || frozen.Goal != p.Goal || frozen.Plan.Tasks[0].Title == "New plan title" {
		t.Fatalf("run mutated: %+v", frozen)
	}
	if _, e = s.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, updated); !errors.Is(e, ErrConflict) {
		t.Fatalf("stale update: %v", e)
	}
	for _, read := range []func() error{func() error { _, e := s.GetProject(ctx, "tenant-b", p.ID); return e }, func() error { _, e := s.GetRun(ctx, "tenant-b", p.ID, r.ID); return e }, func() error { _, e := s.ListTasks(ctx, "tenant-b", p.ID, r.ID); return e }, func() error { _, e := s.ListEvents(ctx, "tenant-b", p.ID, r.ID, 0, 100); return e }, func() error { _, e := s.ListOperations(ctx, "tenant-b", p.ID, r.ID); return e }} {
		if e = read(); !errors.Is(e, ErrNotFound) {
			t.Fatalf("tenant leak: %v", e)
		}
	}
	tasks, e := s.ListTasks(ctx, p.TenantID, p.ID, r.ID)
	if e != nil {
		t.Fatal(e)
	}
	second, e := s.CreateRun(ctx, p.TenantID, p.ID, "other-base")
	if e != nil {
		t.Fatal(e)
	}
	otherTasks, e := s.ListTasks(ctx, p.TenantID, p.ID, second.ID)
	if e != nil {
		t.Fatal(e)
	}
	if tasks[0].ID == otherTasks[0].ID || tasks[0].SessionID == otherTasks[0].SessionID {
		t.Fatal("task incarnations shared across runs")
	}
}

func TestStoreConcurrentClaimsAndBudgetsAreAtomic(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	p.Config.Budget.MaxTokens = 15
	p.Plan.Tasks = append(p.Plan.Tasks, mission.TaskSpec{ID: "independent", Title: "Independent", Prompt: "Do independent work", AgentID: "agent-a", MaxAttempts: 3, Checks: []mission.CheckSpec{{ID: "check", Kind: "path_exists", Path: "independent.go", Required: true}}})
	_, _ = createFixture(t, s, p)
	ctx := context.Background()
	var wg sync.WaitGroup
	claimed := make(chan *mission.Assignment, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			a, e := s.ClaimTask(ctx, fmt.Sprintf("worker-%d", i), time.Minute)
			if e != nil {
				errs <- e
			}
			if a != nil {
				claimed <- a
			}
		}(i)
	}
	wg.Wait()
	close(claimed)
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	assignments := []*mission.Assignment{}
	seen := map[string]bool{}
	for a := range claimed {
		if seen[a.Task.ID] {
			t.Fatal("task claimed twice")
		}
		seen[a.Task.ID] = true
		assignments = append(assignments, a)
	}
	if len(assignments) != 2 {
		t.Fatalf("claims=%d", len(assignments))
	}
	allowances := make(chan int64, 2)
	for _, a := range assignments {
		wg.Add(1)
		go func(a *mission.Assignment) {
			defer wg.Done()
			n, e := s.ReserveDecisionBudget(ctx, FenceRequest{Scope: a.Scope, RunID: a.Run.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}, 10)
			if e != nil {
				t.Error(e)
			}
			allowances <- n
		}(a)
	}
	wg.Wait()
	close(allowances)
	sum := int64(0)
	for n := range allowances {
		sum += n
	}
	if sum != 15 {
		t.Fatalf("reserved %d", sum)
	}
	r, e := s.GetRun(ctx, assignments[0].Scope.TenantID, assignments[0].Scope.ProjectID, assignments[0].Run.ID)
	if e != nil {
		t.Fatal(e)
	}
	if r.Tokens != 15 || r.ModelCalls != 2 {
		t.Fatalf("budget %+v", r)
	}
}

func TestStoreLeaseRecoveryFencesStaleWorkerAndPreservesCheckpoint(t *testing.T) {
	s := testStore(t)
	_, _ = createFixture(t, s, projectFixture())
	ctx := context.Background()
	a, ref := claimFixture(t, s)
	if e := s.InitializeTaskBranch(ctx, ref, "branch", "base-snapshot"); e != nil {
		t.Fatal(e)
	}
	cp, e := s.SaveCheckpoint(ctx, ref, mission.Checkpoint{Messages: []mission.Message{{"role": "user", "content": "saved context"}}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.SaveCheckpoint(ctx, ref, mission.Checkpoint{}); !errors.Is(e, ErrConflict) {
		t.Fatalf("checkpoint CAS: %v", e)
	}
	future := time.Now().UTC().Add(2 * time.Minute)
	s.now = func() time.Time { return future }
	recovered, e := s.ClaimTask(ctx, "worker-b", time.Minute)
	if e != nil || recovered == nil {
		t.Fatalf("recover %v %v", recovered, e)
	}
	if recovered.Task.Attempt != a.Task.Attempt || recovered.Task.BranchID != "branch" || recovered.Checkpoint.ID != cp.ID || recovered.Task.Fence <= a.Task.Fence {
		t.Fatal(recovered)
	}
	if e = s.RenewLease(ctx, ref, time.Minute); !errors.Is(e, ErrLeaseLost) {
		t.Fatalf("stale renewal: %v", e)
	}
	if _, e = s.SaveCheckpoint(ctx, ref, cp); !errors.Is(e, ErrLeaseLost) {
		t.Fatalf("stale write: %v", e)
	}
	wrong := FenceRequest{Scope: recovered.Scope, RunID: recovered.Run.ID, TaskID: recovered.Task.ID, Owner: "worker-b", Fence: recovered.Task.Fence}
	wrong.Scope.SpaceID = "space-b"
	if e = s.RenewLease(ctx, wrong, time.Minute); !errors.Is(e, ErrNotFound) {
		t.Fatalf("space mismatch: %v", e)
	}
}

func TestStoreModelAllowanceSettlesUsageAndPersistsOvershoot(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	p.Config.Budget.MaxTokens = 10
	p, r := createFixture(t, s, p)
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	if _, e := s.ReserveDecisionBudget(ctx, ref, 8); e != nil {
		t.Fatal(e)
	}
	cp, e := s.RecordModelDecision(ctx, ref, 0, mission.Decision{Message: mission.Message{"role": "assistant", "content": "a decision"}, Tokens: 3, Tools: []mission.ToolCall{{ID: "read", Name: "read", Arguments: json.RawMessage(`{}`), Effect: "read"}}})
	if e != nil {
		t.Fatal(e)
	}
	run, e := s.GetRun(ctx, p.TenantID, p.ID, r.ID)
	if e != nil {
		t.Fatal(e)
	}
	if run.Tokens != 3 || run.ModelCalls != 1 {
		t.Fatal(run)
	}
	op, _, e := s.BeginOperation(ctx, ref, cp.ID, cp.Decision.Tools[0])
	if e != nil {
		t.Fatal(e)
	}
	op, e = s.StartOperation(ctx, ref, op.ID, op.Revision)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.CompleteOperation(ctx, ref, op.ID, mission.ToolResult{Content: json.RawMessage(`{}`)}); e != nil {
		t.Fatal(e)
	}
	op, e = s.GetOperation(ctx, ref.Scope, ref.RunID, op.ID)
	if e != nil {
		t.Fatal(e)
	}
	cp.Messages = append(cp.Messages, operationResultMessage(op))
	cp.NextTool++
	cp, e = s.SaveCheckpoint(ctx, ref, cp)
	if e != nil {
		t.Fatal(e)
	}
	cp.Decision = nil
	cp.NextTool = 0
	cp, e = s.SaveCheckpoint(ctx, ref, cp)
	if e != nil {
		t.Fatal(e)
	}
	allowance, e := s.ReserveDecisionBudget(ctx, ref, 10)
	if e != nil || allowance != 7 {
		t.Fatalf("allowance=%d %v", allowance, e)
	}
	out, e := s.RecordModelDecision(ctx, ref, cp.Sequence, mission.Decision{Done: true, Result: "still saved", Tokens: 9})
	if !errors.Is(e, ErrBudgetExceeded) {
		t.Fatalf("overshoot: %v", e)
	}
	run, e = s.GetRun(ctx, p.TenantID, p.ID, r.ID)
	if e != nil {
		t.Fatal(e)
	}
	if run.Status != "failed" || run.Tokens != 12 {
		t.Fatal(run)
	}
	saved, e := s.GetCheckpoint(ctx, ref.Scope, ref.RunID, ref.TaskID)
	if e != nil || saved.ID != out.ID || saved.Decision.Result != "still saved" {
		t.Fatalf("lost decision %+v %v", saved, e)
	}
	if e = s.InitializeTaskBranch(ctx, ref, "cannot-write", "base"); !errors.Is(e, ErrLeaseLost) {
		t.Fatalf("budget stop: %v", e)
	}
}

func TestStoreUnknownEffectRequiresExplicitHumanResolution(t *testing.T) {
	s := testStore(t)
	_, _ = createFixture(t, s, projectFixture())
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	call := mission.ToolCall{ID: "mail-1", Name: "send_mail", Effect: "external_write", Arguments: json.RawMessage(`{"to":"recipient"}`)}
	cp := decisionFixture(t, s, ref, mission.Decision{Tools: []mission.ToolCall{call}, Tokens: 1})
	op, fresh, e := s.BeginOperation(ctx, ref, cp.ID, call)
	if e != nil || !fresh || op.Status != "prepared" {
		t.Fatalf("prepare %+v %v", op, e)
	}
	op, e = s.StartOperation(ctx, ref, op.ID, op.Revision)
	if e != nil {
		t.Fatal(e)
	}
	again, fresh, e := s.BeginOperation(ctx, ref, cp.ID, call)
	if e != nil || fresh || again.ID != op.ID || again.Status != "running" {
		t.Fatalf("idempotency %+v %v", again, e)
	}
	if e = s.MarkOperationUnknown(ctx, ref, op.ID, "connection dropped after sending"); e != nil {
		t.Fatal(e)
	}
	a, e := s.ClaimTask(ctx, "other", time.Minute)
	if e != nil || a != nil {
		t.Fatalf("unknown replay %+v %v", a, e)
	}
	op, e = s.GetOperation(ctx, ref.Scope, ref.RunID, op.ID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.ResolveOperation(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, op.ID, op.Revision, Resolution{Decision: "not_performed"}); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("unaudited resolution %v", e)
	}
	resolved, e := s.ResolveOperation(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, op.ID, op.Revision, Resolution{Decision: "completed", Result: json.RawMessage(`{"messageId":"sent-123"}`), AuthorID: "operator", Comment: "Checked provider delivery log"})
	if e != nil || resolved.Status != "completed" {
		t.Fatalf("resolve %+v %v", resolved, e)
	}
	a, e = s.ClaimTask(ctx, "other", time.Minute)
	if e != nil || a == nil || a.Task.Attempt != 1 {
		t.Fatalf("recovery %+v %v", a, e)
	}
	run, e := s.GetRun(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID)
	if e != nil {
		t.Fatal(e)
	}
	if run.ToolCalls != 1 {
		t.Fatalf("replay billed twice: %+v", run)
	}
}

func TestStoreExternalApprovalAndWorkspaceWritePolicy(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	p.Config.ExternalEffects = "review"
	_, _ = createFixture(t, s, p)
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	call := mission.ToolCall{ID: "publish", Name: "publish", Effect: "external_write", Arguments: json.RawMessage(`{}`)}
	cp := decisionFixture(t, s, ref, mission.Decision{Tokens: 1, Tools: []mission.ToolCall{call}})
	op, _, e := s.BeginOperation(ctx, ref, cp.ID, call)
	if e != nil || op.Status != "pending_approval" {
		t.Fatalf("approval %+v %v", op, e)
	}
	if _, e = s.StartOperation(ctx, ref, op.ID, op.Revision); !errors.Is(e, ErrLeaseLost) {
		t.Fatalf("started before approval %v", e)
	}
	_, e = s.ResolveOperation(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, op.ID, op.Revision, Resolution{Decision: "approved", AuthorID: "reviewer", Comment: "Reviewed intended publication"})
	if e != nil {
		t.Fatal(e)
	}
	a, e := s.ClaimTask(ctx, "after-approval", time.Minute)
	if e != nil || a == nil || a.Task.Attempt != 1 {
		t.Fatalf("resume %+v %v", a, e)
	}
	nextRef := FenceRequest{Scope: a.Scope, RunID: a.Run.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}
	op, e = s.GetOperation(ctx, a.Scope, a.Run.ID, op.ID)
	if e != nil {
		t.Fatal(e)
	}
	op, e = s.StartOperation(ctx, nextRef, op.ID, op.Revision)
	if e != nil || op.Status != "running" {
		t.Fatalf("approved start %+v %v", op, e)
	}
	if e = s.CompleteOperation(ctx, nextRef, op.ID, mission.ToolResult{Content: json.RawMessage(`{"ok":true}`)}); e != nil {
		t.Fatal(e)
	}
	s2 := testStore(t)
	p = projectFixture()
	p.Config.ExternalEffects = "deny"
	_, _ = createFixture(t, s2, p)
	_, ref = claimFixture(t, s2)
	call = mission.ToolCall{ID: "write", Name: "write_file", Effect: "workspace_write", Arguments: json.RawMessage(`{}`)}
	cp = decisionFixture(t, s2, ref, mission.Decision{Tokens: 1, Tools: []mission.ToolCall{call}})
	op, _, e = s2.BeginOperation(ctx, ref, cp.ID, call)
	if e != nil || op.Status != "prepared" {
		t.Fatalf("workspace write blocked %+v %v", op, e)
	}
}

func TestStoreAcceptanceAndReviewGateDependency(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	p.Config.RequireReview = true
	p.Plan.Tasks = append(p.Plan.Tasks, mission.TaskSpec{ID: "consumer", Title: "Use implementation", Prompt: "Consume dependency", AgentID: "agent-a", DependsOn: []string{"implementation"}, Checks: []mission.CheckSpec{{ID: "source", Kind: "path_exists", Path: "consumer.go", Required: true}}})
	p, r := createFixture(t, s, p)
	a, ref := claimFixture(t, s)
	ctx := context.Background()
	if a.Task.Spec.ID != "implementation" {
		t.Fatal(a.Task)
	}
	if e := s.CompleteTask(ctx, ref, "unverified", "result-snapshot"); e == nil {
		t.Fatal("unverified task completed")
	}
	verifyFixture(t, s, ref)
	if e := s.CompleteTask(ctx, ref, "verified result", "different-snapshot"); !errors.Is(e, ErrConflict) {
		t.Fatalf("snapshot bypass %v", e)
	}
	if e := s.CompleteTask(ctx, ref, "verified result", "result-snapshot"); e != nil {
		t.Fatal(e)
	}
	next, e := s.ClaimTask(ctx, "another", time.Minute)
	if e != nil || next != nil {
		t.Fatalf("dependency ran before review %+v %v", next, e)
	}
	if _, e = s.RecordReview(ctx, p.TenantID, p.ID, r.ID, mission.Review{TaskID: a.Task.ID, SnapshotID: "old-snapshot", Decision: "approved", AuthorID: "reviewer"}); !errors.Is(e, ErrConflict) {
		t.Fatalf("stale review %v", e)
	}
	review, e := s.RecordReview(ctx, p.TenantID, p.ID, r.ID, mission.Review{TaskID: a.Task.ID, SnapshotID: "result-snapshot", Decision: "approved", AuthorID: "reviewer"})
	if e != nil || review.ID == "" {
		t.Fatal(e)
	}
	next, e = s.ClaimTask(ctx, "another", time.Minute)
	if e != nil || next == nil || next.Task.Spec.ID != "consumer" || next.DependencyResults["implementation"] != "verified result" {
		t.Fatalf("dependency %+v %v", next, e)
	}
}

func TestStorePauseRevokesFenceAndResumeRecovers(t *testing.T) {
	s := testStore(t)
	p, r := createFixture(t, s, projectFixture())
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	r, e := s.GetRun(ctx, p.TenantID, p.ID, r.ID)
	if e != nil {
		t.Fatal(e)
	}
	paused, e := s.PauseRun(ctx, p.TenantID, p.ID, r.ID, r.Revision)
	if e != nil || paused.Status != "paused" {
		t.Fatalf("pause %+v %v", paused, e)
	}
	if e = s.RenewLease(ctx, ref, time.Minute); !errors.Is(e, ErrLeaseLost) {
		t.Fatalf("paused writer %v", e)
	}
	if _, e = s.ResumeRun(ctx, p.TenantID, p.ID, r.ID, r.Revision); !errors.Is(e, ErrConflict) {
		t.Fatalf("stale resume %v", e)
	}
	resumed, e := s.ResumeRun(ctx, p.TenantID, p.ID, r.ID, paused.Revision)
	if e != nil || resumed.Status != "running" {
		t.Fatalf("resume %+v %v", resumed, e)
	}
	a, e := s.ClaimTask(ctx, "resumed-worker", time.Minute)
	if e != nil || a == nil || a.Task.Attempt != 1 {
		t.Fatalf("resumed %+v %v", a, e)
	}
}

func TestStoreRollbackKeepsEventsContiguousAndDatabaseErrorsVisible(t *testing.T) {
	s := testStore(t)
	p, r := createFixture(t, s, projectFixture())
	ctx := context.Background()
	_, ref := claimFixture(t, s)
	cp, e := s.SaveCheckpoint(ctx, ref, mission.Checkpoint{})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.SaveCheckpoint(ctx, ref, mission.Checkpoint{}); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	events, e := s.ListEvents(ctx, p.TenantID, p.ID, "", 0, 1000)
	if e != nil {
		t.Fatal(e)
	}
	for i, event := range events {
		if event.Sequence != int64(i+1) {
			t.Fatalf("event gap %+v", events)
		}
	}
	got, e := s.GetCheckpoint(ctx, ref.Scope, r.ID, ref.TaskID)
	if e != nil || got.ID != cp.ID {
		t.Fatal(got, e)
	}
	if e = s.db.Close(); e != nil {
		t.Fatal(e)
	}
	if _, e = s.GetProject(ctx, p.TenantID, p.ID); e == nil {
		t.Fatal("closed database error swallowed")
	}
}

func TestStoreReadyQueryDoesNotStarveLowPriorityProducer(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	producer := p.Plan.Tasks[0]
	producer.ID = "producer"
	producer.Priority = -1000
	p.Plan.Tasks = []mission.TaskSpec{producer}
	for i := 0; i < 300; i++ {
		consumer := producer
		consumer.ID = fmt.Sprintf("consumer-%03d", i)
		consumer.Priority = 1000
		consumer.DependsOn = []string{"producer"}
		p.Plan.Tasks = append(p.Plan.Tasks, consumer)
	}
	_, _ = createFixture(t, s, p)
	a, _ := claimFixture(t, s)
	if a.Task.Spec.ID != "producer" {
		t.Fatalf("unready high-priority tasks starved producer: %s", a.Task.Spec.ID)
	}
}

func TestStoreCancelledMutationRemainsAuditableAndBlocksDeletion(t *testing.T) {
	s := testStore(t)
	p, r := createFixture(t, s, projectFixture())
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	call := mission.ToolCall{ID: "mutate", Name: "write", Effect: "workspace_write", Arguments: json.RawMessage(`{}`)}
	cp := decisionFixture(t, s, ref, mission.Decision{Tools: []mission.ToolCall{call}, Tokens: 1})
	op, _, e := s.BeginOperation(ctx, ref, cp.ID, call)
	if e != nil {
		t.Fatal(e)
	}
	op, e = s.StartOperation(ctx, ref, op.ID, op.Revision)
	if e != nil {
		t.Fatal(e)
	}
	r, e = s.GetRun(ctx, p.TenantID, p.ID, r.ID)
	if e != nil {
		t.Fatal(e)
	}
	r, e = s.CancelRun(ctx, p.TenantID, p.ID, r.ID, r.Revision)
	if e != nil {
		t.Fatal(e)
	}
	op, e = s.GetOperation(ctx, ref.Scope, r.ID, op.ID)
	if e != nil || op.Status != "unknown" {
		t.Fatalf("cancel erased unknown %+v %v", op, e)
	}
	if e = s.DeleteProject(ctx, p.TenantID, p.ID, p.Revision); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("deleted unresolved project: %v", e)
	}
	resolved, e := s.ResolveOperation(ctx, p.TenantID, p.ID, r.ID, op.ID, op.Revision, Resolution{Decision: "completed", Result: json.RawMessage(`{"written":true}`), AuthorID: "operator", Comment: "Inspected runner operation log"})
	if e != nil || resolved.Status != "completed" {
		t.Fatalf("cancel reconciliation %+v %v", resolved, e)
	}
	r, e = s.GetRun(ctx, p.TenantID, p.ID, r.ID)
	if e != nil || r.Status != "cancelled" {
		t.Fatalf("resolution restarted cancelled run %+v %v", r, e)
	}
	if e = s.DeleteProject(ctx, p.TenantID, p.ID, p.Revision); e != nil {
		t.Fatal(e)
	}
	if _, e = s.GetProject(ctx, p.TenantID, p.ID); !errors.Is(e, ErrNotFound) {
		t.Fatalf("delete not committed: %v", e)
	}
}

func TestStoreTenantCancellationIsAtomicAndTenantScoped(t *testing.T) {
	s := testStore(t)
	p, r := createFixture(t, s, projectFixture())
	other := projectFixture()
	other.TenantID = "tenant-b"
	other.SpaceID = "space-b"
	other, otherRun := createFixture(t, s, other)
	ctx := context.Background()
	a, ref := claimFixture(t, s)
	if a.Scope.TenantID != "tenant-a" {
		t.Fatalf("unexpected scheduling order: %s", a.Scope.TenantID)
	}
	if e := s.CancelTenant(ctx, "tenant-a"); e != nil {
		t.Fatal(e)
	}
	if e := s.RenewLease(ctx, ref, time.Minute); !errors.Is(e, ErrLeaseLost) {
		t.Fatalf("cancelled tenant retains lease: %v", e)
	}
	got, e := s.GetRun(ctx, p.TenantID, p.ID, r.ID)
	if e != nil || got.Status != "cancelled" {
		t.Fatalf("cancelled tenant %+v %v", got, e)
	}
	got, e = s.GetRun(ctx, other.TenantID, other.ID, otherRun.ID)
	if e != nil || got.Status != "pending" {
		t.Fatalf("other tenant changed %+v %v", got, e)
	}
	next, e := s.ClaimTask(ctx, "other-worker", time.Minute)
	if e != nil || next == nil || next.Scope.TenantID != "tenant-b" {
		t.Fatalf("other tenant stalled %+v %v", next, e)
	}
}

func TestStoreFailurePreservesUnknownWriteAndForbidsBlindRetry(t *testing.T) {
	s := testStore(t)
	p, r := createFixture(t, s, projectFixture())
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	call := mission.ToolCall{ID: "write", Name: "write", Effect: "external_write", Arguments: json.RawMessage(`{}`)}
	cp := decisionFixture(t, s, ref, mission.Decision{Tools: []mission.ToolCall{call}, Tokens: 1})
	op, _, e := s.BeginOperation(ctx, ref, cp.ID, call)
	if e != nil {
		t.Fatal(e)
	}
	op, e = s.StartOperation(ctx, ref, op.ID, op.Revision)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.FailTask(ctx, ref, "deadline reached after dispatch"); e != nil {
		t.Fatal(e)
	}
	task, e := s.GetTask(ctx, p.TenantID, p.ID, r.ID, ref.TaskID)
	if e != nil || task.Status != "unknown" {
		t.Fatalf("failed unknown %+v %v", task, e)
	}
	op, e = s.GetOperation(ctx, ref.Scope, r.ID, op.ID)
	if e != nil || op.Status != "unknown" {
		t.Fatalf("effect unknown %+v %v", op, e)
	}
	if _, e = s.RetryTask(ctx, p.TenantID, p.ID, r.ID, task.ID, task.Revision); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("unknown retried: %v", e)
	}
}

func TestStoreRejectsForgedAcceptanceEvidence(t *testing.T) {
	s := testStore(t)
	_, _ = createFixture(t, s, projectFixture())
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	if e := s.InitializeTaskBranch(ctx, ref, "branch", "base-snapshot"); e != nil {
		t.Fatal(e)
	}
	report, e := acceptance.Evaluate(ctx, projectFixture().Plan.Tasks[0].Checks, acceptance.Environment{SnapshotID: "snapshot", Files: storeSnapshotFiles{"feature.go": "package feature"}}, acceptance.Options{})
	if e != nil {
		t.Fatal(e)
	}
	verification := report.Verification("", ref.TaskID, "branch", time.Now())
	verification.Checks[0].Evidence = json.RawMessage(`{"version":1,"snapshotId":"snapshot","checkId":"source","status":"passed"}`)
	if _, e = s.RecordVerification(ctx, ref, verification); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("forged proof accepted: %v", e)
	}
	verification = report.Verification("", ref.TaskID, "branch", time.Now())
	verification.Checks = nil
	if _, e = s.RecordVerification(ctx, ref, verification); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("missing rule accepted: %v", e)
	}
	records, e := s.ListVerifications(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID)
	if e != nil || len(records) != 0 {
		t.Fatalf("failed proof committed: %+v %v", records, e)
	}
}

func TestStoreDependencyFailureAndExplicitRetry(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	p.Plan.Tasks[0].Priority = 100
	dependent := p.Plan.Tasks[0]
	dependent.ID = "child"
	dependent.DependsOn = []string{"implementation"}
	independent := p.Plan.Tasks[0]
	independent.ID = "independent"
	independent.Priority = 0
	p.Plan.Tasks = append(p.Plan.Tasks, dependent, independent)
	p, r := createFixture(t, s, p)
	a, ref := claimFixture(t, s)
	ctx := context.Background()
	if a.Task.Spec.ID != "implementation" {
		t.Fatal(a.Task)
	}
	if e := s.FailTask(ctx, ref, "first attempt failed"); e != nil {
		t.Fatal(e)
	}
	tasks, e := s.ListTasks(ctx, p.TenantID, p.ID, r.ID)
	if e != nil {
		t.Fatal(e)
	}
	for _, task := range tasks {
		if task.Spec.ID == "child" && task.Status != "blocked" {
			t.Fatalf("failed dependency not blocked: %+v", task)
		}
	}
	next, nextRef := claimFixture(t, s)
	if next.Task.Spec.ID != "independent" {
		t.Fatal(next.Task)
	}
	verifyFixture(t, s, nextRef)
	if e = s.CompleteTask(ctx, nextRef, "independent result", "result-snapshot"); e != nil {
		t.Fatal(e)
	}
	failed, e := s.GetTask(ctx, p.TenantID, p.ID, r.ID, a.Task.ID)
	if e != nil {
		t.Fatal(e)
	}
	retried, e := s.RetryTask(ctx, p.TenantID, p.ID, r.ID, failed.ID, failed.Revision)
	if e != nil || retried.Attempt != 2 {
		t.Fatalf("retry %+v %v", retried, e)
	}
	next, nextRef = claimFixture(t, s)
	if next.Task.Spec.ID != "implementation" || next.Task.Attempt != 2 {
		t.Fatal(next.Task)
	}
	verifyFixture(t, s, nextRef)
	if e = s.CompleteTask(ctx, nextRef, "fixed result", "result-snapshot"); e != nil {
		t.Fatal(e)
	}
	next, _ = claimFixture(t, s)
	if next.Task.Spec.ID != "child" || next.DependencyResults["implementation"] != "fixed result" {
		t.Fatalf("child not resumed: %+v", next)
	}
}

func TestStoreTokenOvershootStopsPeerMutationConservatively(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	peer := p.Plan.Tasks[0]
	peer.ID = "peer"
	peer.Priority = -1
	p.Plan.Tasks = append(p.Plan.Tasks, peer)
	p.Config.Budget.MaxTokens = 20
	p, r := createFixture(t, s, p)
	_, firstRef := claimFixture(t, s)
	_, peerRef := claimFixture(t, s)
	ctx := context.Background()
	call := mission.ToolCall{ID: "peer-write", Name: "write", Effect: "external_write", Arguments: json.RawMessage(`{}`)}
	peerCheckpoint := decisionFixture(t, s, peerRef, mission.Decision{Tokens: 1, Tools: []mission.ToolCall{call}})
	op, _, e := s.BeginOperation(ctx, peerRef, peerCheckpoint.ID, call)
	if e != nil {
		t.Fatal(e)
	}
	op, e = s.StartOperation(ctx, peerRef, op.ID, op.Revision)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.ReserveDecisionBudget(ctx, firstRef, 10); e != nil {
		t.Fatal(e)
	}
	if _, e = s.RecordModelDecision(ctx, firstRef, 0, mission.Decision{Done: true, Tokens: 11}); !errors.Is(e, ErrBudgetExceeded) {
		t.Fatalf("overshoot %v", e)
	}
	if e = s.CompleteOperation(ctx, peerRef, op.ID, mission.ToolResult{Content: json.RawMessage(`{}`)}); !errors.Is(e, ErrLeaseLost) {
		t.Fatalf("peer effect still writes: %v", e)
	}
	op, e = s.GetOperation(ctx, peerRef.Scope, r.ID, op.ID)
	if e != nil || op.Status != "unknown" {
		t.Fatalf("peer result lost: %+v %v", op, e)
	}
	_, e = s.ResolveOperation(ctx, p.TenantID, p.ID, r.ID, op.ID, op.Revision, Resolution{Decision: "completed", Result: json.RawMessage(`{"confirmed":true}`), AuthorID: "operator", Comment: "Confirmed in provider log"})
	if e != nil {
		t.Fatal(e)
	}
	r, e = s.GetRun(ctx, p.TenantID, p.ID, r.ID)
	if e != nil || r.Status != "failed" {
		t.Fatalf("resolution restarted exhausted run %+v %v", r, e)
	}
}

func TestStoreCannotRewriteToolHistoryOrSkipDispatch(t *testing.T) {
	s := testStore(t)
	_, _ = createFixture(t, s, projectFixture())
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	call := mission.ToolCall{ID: "read", Name: "read", Effect: "read", Arguments: json.RawMessage(`{ "index": 9007199254740993 }`)}
	cp := decisionFixture(t, s, ref, mission.Decision{Tokens: 1, Tools: []mission.ToolCall{call}})
	if _, e := s.ReserveDecisionBudget(ctx, ref, 10); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("reserved over unfinished decision: %v", e)
	}
	skipped := cp
	skipped.NextTool = 1
	skipped.Messages = append(append([]mission.Message{}, cp.Messages...), mission.Message{"role": "tool", "tool_call_id": "read", "content": "pretend"})
	if _, e := s.SaveCheckpoint(ctx, ref, skipped); e == nil {
		t.Fatal("skipped undispatched tool")
	}
	cleared := cp
	cleared.Decision = nil
	if _, e := s.SaveCheckpoint(ctx, ref, cleared); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("cleared pending decision: %v", e)
	}
	op, _, e := s.BeginOperation(ctx, ref, cp.ID, call)
	if e != nil {
		t.Fatal(e)
	}
	op, e = s.StartOperation(ctx, ref, op.ID, op.Revision)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.CompleteOperation(ctx, ref, op.ID, mission.ToolResult{Content: json.RawMessage(`{"observed":true}`)}); e != nil {
		t.Fatal(e)
	}
	if _, e = s.SaveCheckpoint(ctx, ref, skipped); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("fabricated tool message: %v", e)
	}
	op, e = s.GetOperation(ctx, ref.Scope, ref.RunID, op.ID)
	if e != nil {
		t.Fatal(e)
	}
	cp.Messages = append(cp.Messages, operationResultMessage(op))
	cp.NextTool = 1
	if _, e = s.SaveCheckpoint(ctx, ref, cp); e != nil {
		t.Fatalf("genuine spaced-JSON decision cursor rejected: %v", e)
	}
	original, e := argumentsHash(call)
	if e != nil {
		t.Fatal(e)
	}
	changed := call
	changed.Arguments = json.RawMessage(`{"index":9007199254740992}`)
	different, e := argumentsHash(changed)
	if e != nil {
		t.Fatal(e)
	}
	if original == different {
		t.Fatal("large integer tool arguments collided")
	}
}

func TestStoreCannotStartPreparedEffectAfterWallBudget(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	p.Config.Budget.MaxWallSeconds = 1
	_, _ = createFixture(t, s, p)
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	call := mission.ToolCall{ID: "write", Name: "write", Effect: "external_write", Arguments: json.RawMessage(`{}`)}
	cp := decisionFixture(t, s, ref, mission.Decision{Tokens: 1, Tools: []mission.ToolCall{call}})
	op, _, e := s.BeginOperation(ctx, ref, cp.ID, call)
	if e != nil {
		t.Fatal(e)
	}
	future := time.Now().UTC().Add(2 * time.Second)
	s.now = func() time.Time { return future }
	if _, e = s.StartOperation(ctx, ref, op.ID, op.Revision); !errors.Is(e, ErrBudgetExceeded) {
		t.Fatalf("dispatch exceeded wall budget: %v", e)
	}
	saved, e := s.GetOperation(ctx, ref.Scope, ref.RunID, op.ID)
	if e != nil || saved.Status != "prepared" {
		t.Fatalf("failed start wrote running state %+v %v", saved, e)
	}
	if e = s.FailTask(ctx, ref, "wall budget reached before dispatch"); e != nil {
		t.Fatal(e)
	}
	saved, e = s.GetOperation(ctx, ref.Scope, ref.RunID, op.ID)
	if e != nil || saved.Status != "failed" {
		t.Fatalf("undispatched effect not closed %+v %v", saved, e)
	}
}

func TestStoreSaturatedRunCannotStarveAnotherRun(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	p.Config.Budget.MaxConcurrent = 1
	first := p.Plan.Tasks[0]
	first.Priority = 1000
	p.Plan.Tasks = []mission.TaskSpec{first}
	for i := 0; i < 300; i++ {
		task := first
		task.ID = fmt.Sprintf("ready-%03d", i)
		p.Plan.Tasks = append(p.Plan.Tasks, task)
	}
	_, _ = createFixture(t, s, p)
	firstAssignment, _ := claimFixture(t, s)
	other := projectFixture()
	other.Name = "Other run"
	other.Plan.Tasks[0].Priority = -1000
	other, otherRun := createFixture(t, s, other)
	next, e := s.ClaimTask(context.Background(), "other-worker", time.Minute)
	if e != nil || next == nil || next.Run.ID != otherRun.ID || next.Scope.ProjectID != other.ID {
		t.Fatalf("saturated run %s starved next run: %+v %v", firstAssignment.Run.ID, next, e)
	}
}

func TestStoreRetryClosesAllOutstandingAssistantToolReplies(t *testing.T) {
	s := testStore(t)
	p, r := createFixture(t, s, projectFixture())
	_, ref := claimFixture(t, s)
	ctx := context.Background()
	calls := []mission.ToolCall{{ID: "read-1", Name: "read", Effect: "read", Arguments: json.RawMessage(`{}`)}, {ID: "read-2", Name: "read", Effect: "read", Arguments: json.RawMessage(`{}`)}, {ID: "publish", Name: "publish", Effect: "external_write", Arguments: json.RawMessage(`{}`)}}
	cp := decisionFixture(t, s, ref, mission.Decision{Tools: calls, Tokens: 1})
	op, _, e := s.BeginOperation(ctx, ref, cp.ID, calls[0])
	if e != nil {
		t.Fatal(e)
	}
	op, e = s.StartOperation(ctx, ref, op.ID, op.Revision)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.CompleteOperation(ctx, ref, op.ID, mission.ToolResult{Content: json.RawMessage(`{"seen":"actual"}`)}); e != nil {
		t.Fatal(e)
	}
	if e = s.FailTask(ctx, ref, "execution stopped before next tool"); e != nil {
		t.Fatal(e)
	}
	task, e := s.GetTask(ctx, p.TenantID, p.ID, r.ID, ref.TaskID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.RetryTask(ctx, p.TenantID, p.ID, r.ID, task.ID, task.Revision); e != nil {
		t.Fatal(e)
	}
	saved, e := s.GetCheckpoint(ctx, ref.Scope, ref.RunID, ref.TaskID)
	if e != nil {
		t.Fatal(e)
	}
	replies := []mission.Message{}
	for _, m := range saved.Messages {
		if m["role"] == "tool" {
			replies = append(replies, m)
		}
	}
	if len(replies) != 3 || replies[0]["tool_call_id"] != "read-1" || replies[0]["content"] != `{"seen":"actual"}` || replies[1]["tool_call_id"] != "read-2" || replies[2]["tool_call_id"] != "publish" {
		t.Fatalf("tool history not closed: %+v", saved.Messages)
	}
	if !strings.Contains(replies[2]["content"].(string), "before this tool was dispatched") {
		t.Fatal(replies[2])
	}
	if saved.Decision != nil || saved.NextTool != 0 || saved.Messages[len(saved.Messages)-1]["role"] != "user" {
		t.Fatal(saved)
	}
}

func TestStoreDeleteHookIsInsideProjectTransaction(t *testing.T) {
	s := testStore(t)
	p, r := createFixture(t, s, projectFixture())
	ctx := context.Background()
	if _, e := s.CancelRun(ctx, p.TenantID, p.ID, r.ID, r.Revision); e != nil {
		t.Fatal(e)
	}
	sentinel := errors.New("pending workspace merge")
	e := s.DeleteProject(ctx, p.TenantID, p.ID, p.Revision, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, `UPDATE execution_projects SET event_sequence=999 WHERE id=?`, p.ID); e != nil {
			return e
		}
		return sentinel
	})
	if !errors.Is(e, sentinel) {
		t.Fatal(e)
	}
	if _, e = s.GetProject(ctx, p.TenantID, p.ID); e != nil {
		t.Fatal(e)
	}
	var sequence int64
	if e = s.db.QueryRow(`SELECT event_sequence FROM execution_projects WHERE id=?`, p.ID).Scan(&sequence); e != nil {
		t.Fatal(e)
	}
	if sequence == 999 {
		t.Fatal("failed delete hook committed changes")
	}
}

func completeAllStoreTasks(t *testing.T, s *Store) {
	t.Helper()
	ctx := context.Background()
	for {
		a, e := s.ClaimTask(ctx, "completion-worker", time.Minute)
		if e != nil {
			t.Fatal(e)
		}
		if a == nil {
			return
		}
		ref := FenceRequest{Scope: a.Scope, RunID: a.Run.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}
		decisionFixture(t, s, ref, mission.Decision{Done: true, Result: "completed " + a.Task.Spec.ID, Tokens: 1})
		verifyFixture(t, s, ref)
		if e = s.CompleteTask(ctx, ref, "result "+a.Task.Spec.ID, "result-snapshot"); e != nil {
			t.Fatal(e)
		}
	}
}

func TestStoreForkReusesOnlyUnchangedCausalArtifacts(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	p.Plan.Tasks[0].Priority = 100
	child := p.Plan.Tasks[0]
	child.ID = "child"
	child.DependsOn = []string{"implementation"}
	independent := p.Plan.Tasks[0]
	independent.ID = "independent"
	independent.Priority = 0
	p.Plan.Tasks = append(p.Plan.Tasks, child, independent)
	p, source := createFixture(t, s, p)
	completeAllStoreTasks(t, s)
	ctx := context.Background()
	before, e := s.GetRun(ctx, p.TenantID, p.ID, source.ID)
	if e != nil || before.Status != "completed" || before.ModelCalls != 3 {
		t.Fatalf("source %+v %v", before, e)
	}
	oldTasks, e := s.ListTasks(ctx, p.TenantID, p.ID, source.ID)
	if e != nil {
		t.Fatal(e)
	}
	p.Plan.Tasks[0].Prompt = "Implement a substantially different design"
	p, e = s.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	fork, e := s.ForkRun(ctx, p.TenantID, p.ID, source.ID, p.Revision)
	if e != nil {
		t.Fatal(e)
	}
	if fork.BaseSnapshot != source.BaseSnapshot || fork.ModelCalls != 0 || fork.ToolCalls != 0 || fork.Tokens != 0 {
		t.Fatal(fork)
	}
	tasks, e := s.ListTasks(ctx, p.TenantID, p.ID, fork.ID)
	if e != nil {
		t.Fatal(e)
	}
	oldBySpec := map[string]mission.Task{}
	for _, task := range oldTasks {
		oldBySpec[task.Spec.ID] = task
	}
	for _, task := range tasks {
		if task.ID == oldBySpec[task.Spec.ID].ID || task.SessionID == oldBySpec[task.Spec.ID].SessionID {
			t.Fatal("fork shared mutable identity")
		}
		if task.Spec.ID == "independent" {
			if task.Status != "completed" || task.BranchID != "" || task.CheckpointID != "" || task.SnapshotID != oldBySpec[task.Spec.ID].SnapshotID || task.ReusedFromTaskID != oldBySpec[task.Spec.ID].ID {
				t.Fatal(task)
			}
		} else if task.Status != "pending" || task.ReusedFromRunID != "" {
			t.Fatalf("changed ancestor reused: %+v", task)
		}
	}
	proofs, e := s.ListVerifications(ctx, p.TenantID, p.ID, fork.ID)
	if e != nil || len(proofs) != 1 || proofs[0].BranchID != "" {
		t.Fatalf("proof copy %+v %v", proofs, e)
	}
	ops, e := s.ListOperations(ctx, p.TenantID, p.ID, fork.ID)
	if e != nil || len(ops) != 0 {
		t.Fatalf("operations copied %+v %v", ops, e)
	}
}

func TestStoreForkRequiresFreshReviewAndRetriesOnPrivateArtifactSeed(t *testing.T) {
	s := testStore(t)
	p, source := createFixture(t, s, projectFixture())
	completeAllStoreTasks(t, s)
	ctx := context.Background()
	p.Config.RequireReview = true
	p, e := s.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	fork, e := s.ForkRun(ctx, p.TenantID, p.ID, source.ID, p.Revision)
	if e != nil || fork.Status != "waiting_review" {
		t.Fatalf("fork %+v %v", fork, e)
	}
	tasks, e := s.ListTasks(ctx, p.TenantID, p.ID, fork.ID)
	if e != nil {
		t.Fatal(e)
	}
	retained := tasks[0]
	if retained.Status != "waiting_review" || retained.BranchID != "" {
		t.Fatal(retained)
	}
	reviews, e := s.ListReviews(ctx, p.TenantID, p.ID, fork.ID)
	if e != nil || len(reviews) != 0 {
		t.Fatalf("old review copied: %+v %v", reviews, e)
	}
	if _, e = s.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: retained.ID, SnapshotID: retained.SnapshotID, Decision: "rejected", AuthorID: "reviewer", Comment: "Improve clarity of the retained feature"}); e != nil {
		t.Fatal(e)
	}
	retained, e = s.GetTask(ctx, p.TenantID, p.ID, fork.ID, retained.ID)
	if e != nil {
		t.Fatal(e)
	}
	retried, e := s.RetryTask(ctx, p.TenantID, p.ID, fork.ID, retained.ID, retained.Revision)
	if e != nil {
		t.Fatal(e)
	}
	if retried.BranchID != "" || retried.BaseSnapshot != "" || retried.ForkSnapshotID != retained.SnapshotID || retried.SnapshotID != "" || retried.CheckpointID == "" {
		t.Fatalf("unsafe retained retry: %+v", retried)
	}
	cp, e := s.GetCheckpoint(ctx, scopeOf(p), fork.ID, retried.ID)
	if e != nil || len(cp.Messages) != 2 || cp.Messages[0]["content"] != retained.Spec.Prompt || !strings.Contains(cp.Messages[1]["content"].(string), "Improve clarity") {
		t.Fatalf("rejection prompt lost: %+v %v", cp, e)
	}
	a, ref := claimFixture(t, s)
	if a.Task.ID != retried.ID || a.Task.Attempt != 1 {
		t.Fatal(a.Task)
	}
	if e = s.InitializeTaskBranch(ctx, ref, "new-private-branch", retried.ForkSnapshotID); e != nil {
		t.Fatal(e)
	}
	sourceTasks, e := s.ListTasks(ctx, p.TenantID, p.ID, source.ID)
	if e != nil || sourceTasks[0].Status != "completed" || sourceTasks[0].BranchID == "new-private-branch" {
		t.Fatalf("source changed by retry %+v %v", sourceTasks, e)
	}
}

func TestStoreForkChangedGoalRetainsNothingAndRejectsUnresolvedSource(t *testing.T) {
	s := testStore(t)
	p, source := createFixture(t, s, projectFixture())
	ctx := context.Background()
	if _, e := s.ForkRun(ctx, p.TenantID, p.ID, source.ID, p.Revision); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("forked active source: %v", e)
	}
	completeAllStoreTasks(t, s)
	p.Goal = "A different goal requiring independent work"
	p, e := s.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.ForkRun(ctx, p.TenantID, p.ID, source.ID, p.Revision-1); !errors.Is(e, ErrConflict) {
		t.Fatalf("fork missed project CAS: %v", e)
	}
	fork, e := s.ForkRun(ctx, p.TenantID, p.ID, source.ID, p.Revision)
	if e != nil {
		t.Fatal(e)
	}
	tasks, e := s.ListTasks(ctx, p.TenantID, p.ID, fork.ID)
	if e != nil || tasks[0].Status != "pending" || tasks[0].ReusedFromRunID != "" {
		t.Fatalf("changed goal reused: %+v %v", tasks, e)
	}
	a, ref := claimFixture(t, s)
	if a.Run.ID != fork.ID {
		t.Fatal(a.Run)
	}
	call := mission.ToolCall{ID: "external", Name: "external", Effect: "external_write", Arguments: json.RawMessage(`{}`)}
	cp := decisionFixture(t, s, ref, mission.Decision{Tools: []mission.ToolCall{call}, Tokens: 1})
	op, _, e := s.BeginOperation(ctx, ref, cp.ID, call)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.StartOperation(ctx, ref, op.ID, op.Revision); e != nil {
		t.Fatal(e)
	}
	fork, e = s.GetRun(ctx, p.TenantID, p.ID, fork.ID)
	if e != nil {
		t.Fatal(e)
	}
	fork, e = s.PauseRun(ctx, p.TenantID, p.ID, fork.ID, fork.Revision)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.ForkRun(ctx, p.TenantID, p.ID, fork.ID, p.Revision); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("fork duplicated uncertain effect: %v", e)
	}
}

func TestStoreReusedDiamondReviewRejectsObsoleteDescendantArtifacts(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	a := p.Plan.Tasks[0]
	a.ID = "a"
	a.Priority = 100
	b := a
	b.ID = "b"
	b.DependsOn = []string{"a"}
	c := a
	c.ID = "c"
	c.DependsOn = []string{"a"}
	d := a
	d.ID = "d"
	d.DependsOn = []string{"b", "c"}
	p.Plan.Tasks = []mission.TaskSpec{a, b, c, d}
	p, source := createFixture(t, s, p)
	completeAllStoreTasks(t, s)
	ctx := context.Background()
	p.Config.RequireReview = true
	p, e := s.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	fork, e := s.ForkRun(ctx, p.TenantID, p.ID, source.ID, p.Revision)
	if e != nil {
		t.Fatal(e)
	}
	tasks, e := s.ListTasks(ctx, p.TenantID, p.ID, fork.ID)
	if e != nil {
		t.Fatal(e)
	}
	bySpec := map[string]mission.Task{}
	for _, task := range tasks {
		bySpec[task.Spec.ID] = task
	}
	if _, e = s.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: bySpec["d"].ID, SnapshotID: bySpec["d"].SnapshotID, Decision: "approved", AuthorID: "reviewer"}); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("approved diamond consumer before dependencies: %v", e)
	}
	if _, e = s.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: bySpec["b"].ID, SnapshotID: bySpec["b"].SnapshotID, Decision: "approved", AuthorID: "reviewer"}); !errors.Is(e, ErrInvalidState) {
		t.Fatalf("approved consumer before ancestor: %v", e)
	}
	if _, e = s.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: bySpec["a"].ID, SnapshotID: bySpec["a"].SnapshotID, Decision: "rejected", AuthorID: "reviewer", Comment: "Rebuild the ancestor"}); e != nil {
		t.Fatal(e)
	}
	tasks, e = s.ListTasks(ctx, p.TenantID, p.ID, fork.ID)
	if e != nil {
		t.Fatal(e)
	}
	for _, task := range tasks {
		if task.Spec.ID == "a" {
			continue
		}
		if (task.Status != "pending" && task.Status != "blocked") || task.SnapshotID != "" || task.BranchID != "" || task.ForkSnapshotID != "" || task.BaseSnapshot != "" || task.ReusedFromRunID != "" || task.CheckpointID != "" || task.Result != "" {
			t.Fatalf("obsolete artifact remained reusable: %+v", task)
		}
	}
	events, e := s.ListEvents(ctx, p.TenantID, p.ID, fork.ID, 0, 1000)
	if e != nil {
		t.Fatal(e)
	}
	invalidated := map[string]int{}
	for _, event := range events {
		if event.Kind == "task.reuse_invalidated" {
			invalidated[event.TaskID]++
		}
	}
	if len(invalidated) != 3 {
		t.Fatalf("diamond invalidations %+v", invalidated)
	}
	for _, count := range invalidated {
		if count != 1 {
			t.Fatal("diamond artifact invalidated twice")
		}
	}
	ancestor, e := s.GetTask(ctx, p.TenantID, p.ID, fork.ID, bySpec["a"].ID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.RetryTask(ctx, p.TenantID, p.ID, fork.ID, ancestor.ID, ancestor.Revision); e != nil {
		t.Fatal(e)
	}
	assignment, ref := claimFixture(t, s)
	if assignment.Task.Spec.ID != "a" {
		t.Fatal(assignment.Task)
	}
	if e = s.InitializeTaskBranch(ctx, ref, "revised-a", assignment.Task.ForkSnapshotID); e != nil {
		t.Fatal(e)
	}
	decisionFixture(t, s, ref, mission.Decision{Done: true, Result: "new causal result", Tokens: 1})
	report, e := acceptance.Evaluate(ctx, a.Checks, acceptance.Environment{SnapshotID: "revised-a-snapshot", Files: storeSnapshotFiles{"feature.go": "package revised"}}, acceptance.Options{})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.RecordVerification(ctx, ref, report.Verification("", ref.TaskID, "revised-a", time.Now())); e != nil {
		t.Fatal(e)
	}
	if e = s.CompleteTask(ctx, ref, "new causal result", "revised-a-snapshot"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: ancestor.ID, SnapshotID: "revised-a-snapshot", Decision: "approved", AuthorID: "reviewer"}); e != nil {
		t.Fatal(e)
	}
	next, e := s.ClaimTask(ctx, "causal-consumer", time.Minute)
	if e != nil || next == nil {
		t.Fatalf("causal child not scheduled %+v %v", next, e)
	}
	if (next.Task.Spec.ID != "b" && next.Task.Spec.ID != "c") || next.Task.ForkSnapshotID != "" || next.Task.SnapshotID != "" || next.DependencyResults["a"] != "new causal result" {
		t.Fatalf("child restored obsolete output %+v", next)
	}
}

func TestStoreInvalidatedRetryCheckpointKeepsAuditWithoutRevivingOldHead(t *testing.T) {
	s := testStore(t)
	p := projectFixture()
	child := p.Plan.Tasks[0]
	child.ID = "child"
	child.DependsOn = []string{"implementation"}
	p.Plan.Tasks = append(p.Plan.Tasks, child)
	p, source := createFixture(t, s, p)
	completeAllStoreTasks(t, s)
	ctx := context.Background()
	p.Config.RequireReview = true
	p, e := s.UpdateProject(ctx, p.TenantID, p.ID, p.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	fork, e := s.ForkRun(ctx, p.TenantID, p.ID, source.ID, p.Revision)
	if e != nil {
		t.Fatal(e)
	}
	tasks, e := s.ListTasks(ctx, p.TenantID, p.ID, fork.ID)
	if e != nil {
		t.Fatal(e)
	}
	bySpec := map[string]mission.Task{}
	for _, task := range tasks {
		bySpec[task.Spec.ID] = task
	}
	descendant := bySpec["child"]
	if _, e = s.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: descendant.ID, SnapshotID: descendant.SnapshotID, Decision: "rejected", AuthorID: "reviewer", Comment: "Old child needs revision"}); e != nil {
		t.Fatal(e)
	}
	descendant, e = s.GetTask(ctx, p.TenantID, p.ID, fork.ID, descendant.ID)
	if e != nil {
		t.Fatal(e)
	}
	descendant, e = s.RetryTask(ctx, p.TenantID, p.ID, fork.ID, descendant.ID, descendant.Revision)
	if e != nil {
		t.Fatal(e)
	}
	oldCheckpoint, e := s.GetCheckpoint(ctx, scopeOf(p), fork.ID, descendant.ID)
	if e != nil || oldCheckpoint.ID == "" || descendant.ForkSnapshotID == "" {
		t.Fatal(oldCheckpoint, e)
	}
	ancestor := bySpec["implementation"]
	if _, e = s.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: ancestor.ID, SnapshotID: ancestor.SnapshotID, Decision: "rejected", AuthorID: "reviewer", Comment: "Revise causal ancestor"}); e != nil {
		t.Fatal(e)
	}
	descendant, e = s.GetTask(ctx, p.TenantID, p.ID, fork.ID, descendant.ID)
	if e != nil {
		t.Fatal(e)
	}
	head, e := s.GetCheckpoint(ctx, scopeOf(p), fork.ID, descendant.ID)
	if e != nil || head.ID != "" || head.Sequence != oldCheckpoint.Sequence || len(head.Messages) != 0 || descendant.ForkSnapshotID != "" || descendant.ReusedFromRunID != "" {
		t.Fatalf("invalidated head resurrected: %+v %+v %v", head, descendant, e)
	}
	var history int
	if e = s.db.QueryRow(`SELECT COUNT(*) FROM execution_checkpoints WHERE id=?`, oldCheckpoint.ID).Scan(&history); e != nil || history != 1 {
		t.Fatalf("audit checkpoint erased: %d %v", history, e)
	}
}
