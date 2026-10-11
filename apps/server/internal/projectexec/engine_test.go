// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	_ "github.com/mattn/go-sqlite3"
)

type engineFixture struct {
	store      *Store
	project    mission.Project
	run        mission.Run
	workspaces *memoryWorkspaces
	clock      atomic.Int64
}

func newEngineFixture(t *testing.T, tasks []mission.TaskSpec, config mission.Config) *engineFixture {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:"+filepath.Join(t.TempDir(), "engine.db")+"?_foreign_keys=on&_busy_timeout=4000&_journal_mode=WAL")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	if _, err = db.Exec(`CREATE TABLE tenants(id TEXT PRIMARY KEY); CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL); INSERT INTO tenants(id) VALUES('tenant'); INSERT INTO spaces(id,tenant_id) VALUES('space','tenant');`); err != nil {
		t.Fatal(err)
	}
	schema, err := os.ReadFile("../platform/migrations/sql/0006_project_execution.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(string(schema)); err != nil {
		t.Fatal(err)
	}
	f := &engineFixture{store: NewStore(db, "sqlite", nil), workspaces: newMemoryWorkspaces()}
	f.clock.Store(time.Now().UTC().UnixNano())
	f.store.now = func() time.Time { return time.Unix(0, f.clock.Load()).UTC() }
	p, err := f.store.CreateProject(context.Background(), mission.Project{TenantID: "tenant", SpaceID: "space", Name: "Useful project", Goal: "Build and verify an isolated artifact", Plan: mission.Plan{Version: 1, Tasks: tasks}, Config: config})
	if err != nil {
		t.Fatal(err)
	}
	f.project = p
	scope := scopeOf(p)
	base, err := f.workspaces.Base(context.Background(), scope)
	if err != nil {
		t.Fatal(err)
	}
	f.run, err = f.store.CreateRun(context.Background(), p.TenantID, p.ID, base)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func fixtureTask(id string, dependencies ...string) mission.TaskSpec {
	return mission.TaskSpec{ID: id, Title: "Produce " + id, Prompt: "Produce a verified report", AgentID: "agent", DependsOn: dependencies, Writes: []string{"report.txt", "outputs/**"}, MaxAttempts: 3, Checks: []mission.CheckSpec{{ID: "artifact", Kind: "path_exists", Title: "Report exists", Path: "report.txt", Required: true}}}
}

func (f *engineFixture) claim(t *testing.T, owner string) mission.Assignment {
	t.Helper()
	a, err := f.store.ClaimTask(context.Background(), owner, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if a == nil {
		t.Fatal("no runnable task")
	}
	return *a
}

func assignmentFence(a mission.Assignment) FenceRequest {
	return FenceRequest{Scope: a.Scope, RunID: a.Run.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}
}

func (f *engineFixture) engine(executor mission.Executor) *Engine {
	return NewEngine(f.store, executor, f.workspaces, EngineConfig{WorkerID: "test-engine", Workers: 2, Lease: time.Minute, HeartbeatInterval: time.Second, MaxDecisionTokens: 100, OnError: func(error) {}})
}

type callbackExecutor struct {
	advance func(context.Context, mission.Assignment) (mission.Decision, error)
	perform func(context.Context, mission.Assignment, mission.Operation) (mission.ToolResult, error)
	inspect func(context.Context, mission.Assignment, mission.Operation) (mission.Inspection, error)
}

func (x callbackExecutor) Advance(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
	return x.advance(ctx, a)
}
func (x callbackExecutor) Perform(ctx context.Context, a mission.Assignment, o mission.Operation) (mission.ToolResult, error) {
	if x.perform == nil {
		return mission.ToolResult{}, errors.New("unexpected tool dispatch")
	}
	return x.perform(ctx, a, o)
}
func (x callbackExecutor) Inspect(ctx context.Context, a mission.Assignment, o mission.Operation) (mission.Inspection, error) {
	if x.inspect == nil {
		return mission.Inspection{}, nil
	}
	return x.inspect(ctx, a, o)
}

func finishedDecision() mission.Decision {
	return mission.Decision{Done: true, Result: "Verified artifact ready", Message: mission.Message{"role": "assistant", "content": "Verified artifact ready"}, Tokens: 4}
}
func mutationDecision(effect string) mission.Decision {
	return mission.Decision{Message: mission.Message{"role": "assistant", "content": "Write the artifact"}, Tokens: 7, Tools: []mission.ToolCall{{ID: "call-1", Name: "write", Arguments: json.RawMessage(`{"path":"report.txt","content":"new report"}`), Effect: effect}}}
}

func TestEnginePersistsToolResultBeforeNextDecision(t *testing.T) {
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("draft")}, mission.Config{})
	var dispatches atomic.Int64
	x := callbackExecutor{
		advance: func(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
			if a.Task.SessionID == "" {
				t.Error("task session identity is absent")
			}
			if modelDecisionCount(a.Checkpoint) == 0 {
				return mutationDecision("workspace_write"), nil
			}
			operations, err := f.store.ListOperations(ctx, a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID)
			if err != nil {
				return mission.Decision{}, err
			}
			if len(operations) != 1 || operations[0].Status != "completed" {
				t.Error("next model call ran before durable tool completion")
			}
			return finishedDecision(), nil
		},
		perform: func(ctx context.Context, a mission.Assignment, o mission.Operation) (mission.ToolResult, error) {
			dispatches.Add(1)
			f.workspaces.write(a.Task.BranchID, "report.txt", "new report")
			return mission.ToolResult{Content: json.RawMessage(`{"written":true}`)}, nil
		},
	}
	a := f.claim(t, "worker")
	if err := f.engine(x).process(context.Background(), assignmentFence(a), a); err != nil {
		t.Fatal(err)
	}
	task, err := f.store.GetTask(context.Background(), f.project.TenantID, f.project.ID, f.run.ID, a.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != "completed" || task.SnapshotID == "" || task.BaseSnapshot == "" || dispatches.Load() != 1 {
		t.Fatalf("task=%+v dispatches=%d", task, dispatches.Load())
	}
	run, err := f.store.GetRun(context.Background(), f.project.TenantID, f.project.ID, f.run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "completed" || run.ModelCalls != 2 || run.ToolCalls != 1 || run.Tokens != 11 {
		t.Fatalf("run=%+v", run)
	}
}

func TestEngineRecoversCompletedToolWithoutRepeatingEffect(t *testing.T) {
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("draft")}, mission.Config{})
	first := f.claim(t, "crashed-worker")
	ref := assignmentFence(first)
	engine := f.engine(callbackExecutor{})
	if err := engine.initializeBranch(context.Background(), ref, &first); err != nil {
		t.Fatal(err)
	}
	cp, err := f.store.SaveCheckpoint(context.Background(), ref, mission.Checkpoint{Messages: []mission.Message{{"role": "user", "content": "Build report"}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.ReserveDecisionBudget(context.Background(), ref, 100); err != nil {
		t.Fatal(err)
	}
	d, err := normalizeDecision(mutationDecision("workspace_write"))
	if err != nil {
		t.Fatal(err)
	}
	cp, err = f.store.RecordModelDecision(context.Background(), ref, cp.Sequence, d)
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := f.store.BeginOperation(context.Background(), ref, cp.ID, d.Tools[0])
	if err != nil {
		t.Fatal(err)
	}
	op, err = f.store.StartOperation(context.Background(), ref, op.ID, op.Revision)
	if err != nil {
		t.Fatal(err)
	}
	f.workspaces.write(first.Task.BranchID, "report.txt", "persisted before crash")
	if err = f.store.CompleteOperation(context.Background(), ref, op.ID, mission.ToolResult{Content: json.RawMessage(`{"written":true}`)}); err != nil {
		t.Fatal(err)
	}
	// Simulate a process disappearing before advancing NextTool. The new worker
	// reads the same checkpoint and the already committed operation result.
	f.clock.Add(int64(2 * time.Minute))
	recovered := f.claim(t, "new-worker")
	if recovered.Task.Fence <= first.Task.Fence {
		t.Fatal("worker fence did not advance")
	}
	if err = f.store.CompleteOperation(context.Background(), ref, op.ID, mission.ToolResult{}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale worker accepted: %v", err)
	}
	var dispatches atomic.Int64
	x := callbackExecutor{advance: func(context.Context, mission.Assignment) (mission.Decision, error) { return finishedDecision(), nil }, perform: func(context.Context, mission.Assignment, mission.Operation) (mission.ToolResult, error) {
		dispatches.Add(1)
		return mission.ToolResult{}, nil
	}}
	if err = f.engine(x).process(context.Background(), assignmentFence(recovered), recovered); err != nil {
		t.Fatal(err)
	}
	if dispatches.Load() != 0 {
		t.Fatal("completed workspace effect was repeated")
	}
	final, err := f.store.GetCheckpoint(context.Background(), recovered.Scope, recovered.Run.ID, recovered.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	toolMessages := 0
	for _, message := range final.Messages {
		if message["role"] == "tool" {
			toolMessages++
		}
	}
	if toolMessages != 1 {
		t.Fatalf("reconstructed tool messages=%d", toolMessages)
	}
}

func TestEngineUnknownExternalEffectNeedsHumanAttestation(t *testing.T) {
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("draft")}, mission.Config{ExternalEffects: "allow"})
	var writes atomic.Int64
	x := callbackExecutor{advance: func(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
		if modelDecisionCount(a.Checkpoint) == 0 {
			return mutationDecision("external_write"), nil
		}
		return finishedDecision(), nil
	}, perform: func(context.Context, mission.Assignment, mission.Operation) (mission.ToolResult, error) {
		writes.Add(1)
		return mission.ToolResult{}, errors.New("connection lost after remote commit")
	}}
	a := f.claim(t, "first")
	if err := f.engine(x).process(context.Background(), assignmentFence(a), a); !errors.Is(err, errAwaitingDecision) {
		t.Fatalf("unknown state expected: %v", err)
	}
	ops, err := f.store.ListOperations(context.Background(), a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ops) != 1 || ops[0].Status != "unknown" {
		t.Fatalf("operations=%+v", ops)
	}
	f.clock.Add(int64(2 * time.Minute))
	if claim, err := f.store.ClaimTask(context.Background(), "unattended", time.Minute); err != nil || claim != nil {
		t.Fatalf("unknown operation was automatically reclaimed: %+v %v", claim, err)
	}
	_, err = f.store.ResolveOperation(context.Background(), a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID, ops[0].ID, ops[0].Revision, Resolution{Decision: "completed", Result: json.RawMessage(`{"remoteId":"confirmed"}`), AuthorID: "human", Comment: "Confirmed original change in remote system"})
	if err != nil {
		t.Fatal(err)
	}
	recovered := f.claim(t, "approved-recovery")
	if err = f.engine(x).process(context.Background(), assignmentFence(recovered), recovered); err != nil {
		t.Fatal(err)
	}
	if writes.Load() != 1 {
		t.Fatalf("external effect was repeated %d times", writes.Load())
	}
}

func TestEngineReviewApprovalPrecedesFirstExternalDispatch(t *testing.T) {
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("draft")}, mission.Config{ExternalEffects: "review"})
	var writes atomic.Int64
	x := callbackExecutor{advance: func(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
		if modelDecisionCount(a.Checkpoint) == 0 {
			return mutationDecision("external_write"), nil
		}
		return finishedDecision(), nil
	}, perform: func(context.Context, mission.Assignment, mission.Operation) (mission.ToolResult, error) {
		writes.Add(1)
		return mission.ToolResult{Content: json.RawMessage(`{"remoteId":"new"}`)}, nil
	}}
	a := f.claim(t, "first")
	if err := f.engine(x).process(context.Background(), assignmentFence(a), a); !errors.Is(err, errAwaitingDecision) {
		t.Fatalf("approval expected: %v", err)
	}
	if writes.Load() != 0 {
		t.Fatal("effect was dispatched before approval")
	}
	ops, err := f.store.ListOperations(context.Background(), a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ops) != 1 || ops[0].Status != "pending_approval" {
		t.Fatalf("operations=%+v", ops)
	}
	_, err = f.store.ResolveOperation(context.Background(), a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID, ops[0].ID, ops[0].Revision, Resolution{Decision: "approved", AuthorID: "human", Comment: "Reviewed exact arguments and approved"})
	if err != nil {
		t.Fatal(err)
	}
	next := f.claim(t, "approved")
	if next.Task.Attempt != a.Task.Attempt {
		t.Fatal("approval spent another task attempt")
	}
	if err = f.engine(x).process(context.Background(), assignmentFence(next), next); err != nil {
		t.Fatal(err)
	}
	if writes.Load() != 1 {
		t.Fatalf("approved effect dispatches=%d", writes.Load())
	}
}

func TestEngineDependenciesSupplyFileArtifacts(t *testing.T) {
	firstSpec := fixtureTask("producer")
	secondSpec := fixtureTask("consumer", "producer")
	f := newEngineFixture(t, []mission.TaskSpec{secondSpec, firstSpec}, mission.Config{})
	x := callbackExecutor{advance: func(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
		if a.Task.Spec.ID == "consumer" {
			if text := f.workspaces.read(a.Task.BranchID, "outputs/upstream.txt"); text != "actual dependency file" {
				return mission.Decision{}, fmt.Errorf("dependency artifact absent: %q", text)
			}
			if a.DependencyResults["producer"] == "" {
				return mission.Decision{}, errors.New("dependency result metadata absent")
			}
			return finishedDecision(), nil
		}
		if modelDecisionCount(a.Checkpoint) == 0 {
			return mutationDecision("workspace_write"), nil
		}
		return finishedDecision(), nil
	}, perform: func(ctx context.Context, a mission.Assignment, o mission.Operation) (mission.ToolResult, error) {
		f.workspaces.write(a.Task.BranchID, "outputs/upstream.txt", "actual dependency file")
		return mission.ToolResult{Content: json.RawMessage(`{"written":true}`)}, nil
	}}
	producer := f.claim(t, "producer-worker")
	if producer.Task.Spec.ID != "producer" {
		t.Fatal("dependency consumer scheduled too early")
	}
	if err := f.engine(x).process(context.Background(), assignmentFence(producer), producer); err != nil {
		t.Fatal(err)
	}
	consumer := f.claim(t, "consumer-worker")
	if err := f.engine(x).process(context.Background(), assignmentFence(consumer), consumer); err != nil {
		t.Fatal(err)
	}
	if consumer.Task.ID == producer.Task.ID {
		t.Fatal("tasks share execution identity")
	}
}

func TestEngineRejectsChangesOutsideWriteClaims(t *testing.T) {
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("draft")}, mission.Config{})
	x := callbackExecutor{advance: func(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
		f.workspaces.write(a.Task.BranchID, "secrets.txt", "out-of-scope edit")
		return finishedDecision(), nil
	}}
	a := f.claim(t, "worker")
	err := f.engine(x).process(context.Background(), assignmentFence(a), a)
	if err == nil || !strings.Contains(err.Error(), "outside its write claims") {
		t.Fatalf("unexpected result: %v", err)
	}
	verifications, err := f.store.ListVerifications(context.Background(), a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(verifications) != 0 {
		t.Fatal("out-of-scope branch was verified")
	}
}

func TestEngineLifecycleRunsWorkersAndStopsCleanly(t *testing.T) {
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("draft")}, mission.Config{})
	x := callbackExecutor{advance: func(context.Context, mission.Assignment) (mission.Decision, error) { return finishedDecision(), nil }}
	engine := f.engine(x)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := engine.Start(context.Background()); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate start: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		run, err := f.store.GetRun(context.Background(), f.project.TenantID, f.project.ID, f.run.ID)
		if err != nil {
			t.Fatal(err)
		}
		if run.Status == "completed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("worker did not finish: %+v", run)
		}
		time.Sleep(10 * time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engine.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if err := engine.Start(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("restarted stopped engine: %v", err)
	}
}

func TestEngineDoesNotDispatchAfterDecisionLeaseWasLost(t *testing.T) {
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("draft")}, mission.Config{})
	var dispatches atomic.Int64
	var newAssignment *mission.Assignment
	x := callbackExecutor{
		advance: func(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
			f.clock.Add(int64(2 * time.Minute))
			var err error
			newAssignment, err = f.store.ClaimTask(ctx, "new-owner", time.Minute)
			if err != nil {
				return mission.Decision{}, err
			}
			return mutationDecision("workspace_write"), nil
		},
		perform: func(context.Context, mission.Assignment, mission.Operation) (mission.ToolResult, error) {
			dispatches.Add(1)
			return mission.ToolResult{}, nil
		},
	}
	a := f.claim(t, "stale-worker")
	if err := f.engine(x).process(context.Background(), assignmentFence(a), a); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale decision was accepted: %v", err)
	}
	if newAssignment == nil || newAssignment.Task.Fence <= a.Task.Fence {
		t.Fatal("replacement worker was not established")
	}
	if dispatches.Load() != 0 {
		t.Fatal("lease-lost worker dispatched a new tool")
	}
	operations, err := f.store.ListOperations(context.Background(), a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(operations) != 0 {
		t.Fatal("stale model decision produced an operation")
	}
}

func TestEngineVerifiedDependencyWaitsForReview(t *testing.T) {
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("producer"), fixtureTask("consumer", "producer")}, mission.Config{RequireReview: true})
	x := callbackExecutor{advance: func(context.Context, mission.Assignment) (mission.Decision, error) { return finishedDecision(), nil }}
	a := f.claim(t, "producer-worker")
	if err := f.engine(x).process(context.Background(), assignmentFence(a), a); err != nil {
		t.Fatal(err)
	}
	task, err := f.store.GetTask(context.Background(), a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID, a.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != "waiting_review" {
		t.Fatalf("review gate absent: %+v", task)
	}
	if next, err := f.store.ClaimTask(context.Background(), "too-early", time.Minute); err != nil || next != nil {
		t.Fatalf("dependent task ran before producer review: %+v %v", next, err)
	}
	_, err = f.store.RecordReview(context.Background(), a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID, mission.Review{TaskID: task.ID, SnapshotID: "stale-snapshot", Decision: "approved", AuthorID: "reviewer", Comment: "Try an old output"})
	if err == nil {
		t.Fatal("stale snapshot was approved")
	}
	_, err = f.store.RecordReview(context.Background(), a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID, mission.Review{TaskID: task.ID, SnapshotID: task.SnapshotID, Decision: "approved", AuthorID: "reviewer", Comment: "Reviewed current verified output"})
	if err != nil {
		t.Fatal(err)
	}
	consumer := f.claim(t, "consumer-worker")
	if consumer.Task.Spec.ID != "consumer" {
		t.Fatal("approved dependency did not unblock consumer")
	}
}

func TestEngineRevisesRejectedReusedArtifactOnNewBranch(t *testing.T) {
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("draft")}, mission.Config{})
	ctx := context.Background()
	sourceExecutor := callbackExecutor{
		advance: func(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
			if modelDecisionCount(a.Checkpoint) == 0 {
				return mutationDecision("workspace_write"), nil
			}
			return finishedDecision(), nil
		},
		perform: func(ctx context.Context, a mission.Assignment, op mission.Operation) (mission.ToolResult, error) {
			f.workspaces.write(a.Task.BranchID, "report.txt", "accepted source artifact")
			return mission.ToolResult{Content: json.RawMessage(`{"written":true}`)}, nil
		},
	}
	source := f.claim(t, "source-worker")
	if err := f.engine(sourceExecutor).process(ctx, assignmentFence(source), source); err != nil {
		t.Fatal(err)
	}
	sourceTask, err := f.store.GetTask(ctx, source.Scope.TenantID, source.Scope.ProjectID, source.Run.ID, source.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.project.Config.RequireReview = true
	f.project.Plan.Version++
	p, err := f.store.UpdateProject(ctx, f.project.TenantID, f.project.ID, f.project.Revision, f.project)
	if err != nil {
		t.Fatal(err)
	}
	fork, err := f.store.ForkRun(ctx, p.TenantID, p.ID, source.Run.ID, p.Revision)
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := f.store.ListTasks(ctx, p.TenantID, p.ID, fork.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].Status != "waiting_review" || tasks[0].BranchID != "" || tasks[0].ID == sourceTask.ID || tasks[0].SessionID == sourceTask.SessionID {
		t.Fatalf("reused task did not receive a fresh isolated identity and review: %+v", tasks)
	}
	_, err = f.store.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: tasks[0].ID, SnapshotID: tasks[0].SnapshotID, Decision: "rejected", AuthorID: "new-reviewer", Comment: "Include concrete implementation details"})
	if err != nil {
		t.Fatal(err)
	}
	rejected, err := f.store.GetTask(ctx, p.TenantID, p.ID, fork.ID, tasks[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.engine(sourceExecutor).RetryTask(ctx, p.TenantID, p.ID, fork.ID, rejected.ID, rejected.Revision); err != nil {
		t.Fatal(err)
	}
	var checkedBaseline bool
	revisionExecutor := callbackExecutor{
		advance: func(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
			if modelDecisionCount(a.Checkpoint) == 0 {
				if a.Task.BranchID == sourceTask.BranchID || a.Task.BaseSnapshot != sourceTask.SnapshotID || f.workspaces.read(a.Task.BranchID, "report.txt") != "accepted source artifact" {
					return mission.Decision{}, errors.New("revision did not fork the immutable reused artifact")
				}
				feedback := a.Checkpoint.Messages[len(a.Checkpoint.Messages)-1]["content"]
				if text, ok := feedback.(string); !ok || !strings.Contains(text, "Include concrete implementation details") {
					return mission.Decision{}, errors.New("new reviewer feedback was lost")
				}
				checkedBaseline = true
				return mutationDecision("workspace_write"), nil
			}
			return finishedDecision(), nil
		},
		perform: func(ctx context.Context, a mission.Assignment, op mission.Operation) (mission.ToolResult, error) {
			f.workspaces.write(a.Task.BranchID, "report.txt", "revised artifact with concrete implementation details")
			return mission.ToolResult{Content: json.RawMessage(`{"written":true}`)}, nil
		},
	}
	revision := f.claim(t, "revision-worker")
	if revision.Run.ID != fork.ID {
		t.Fatal("revision worker reclaimed the completed source run")
	}
	if err = f.engine(revisionExecutor).process(ctx, assignmentFence(revision), revision); err != nil {
		t.Fatal(err)
	}
	revised, err := f.store.GetTask(ctx, p.TenantID, p.ID, fork.ID, revision.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !checkedBaseline || revised.Status != "waiting_review" || revised.SnapshotID == sourceTask.SnapshotID {
		t.Fatalf("revision did not produce a new verified output requiring review: %+v", revised)
	}
	if f.workspaces.read(sourceTask.BranchID, "report.txt") != "accepted source artifact" {
		t.Fatal("revising reused output changed the source run's mutable branch")
	}
	_, err = f.store.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: revised.ID, SnapshotID: revised.SnapshotID, Decision: "approved", AuthorID: "new-reviewer", Comment: "Reviewed the revised implementation"})
	if err != nil {
		t.Fatal(err)
	}
	merged, err := f.engine(revisionExecutor).ComposeTaskOutputs(ctx, p.TenantID, p.ID, fork.ID, []string{revised.ID})
	if err != nil || merged != revised.SnapshotID {
		t.Fatalf("final selection did not expose the revised accepted artifact: %s %v", merged, err)
	}
}

func TestEngineRejectedReusedAncestorRebuildsDescendantFromNewFiles(t *testing.T) {
	ctx := context.Background()
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("producer"), fixtureTask("consumer", "producer")}, mission.Config{})
	makeExecutor := func(repaired bool) callbackExecutor {
		return callbackExecutor{
			advance: func(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
				if modelDecisionCount(a.Checkpoint) > 0 {
					return finishedDecision(), nil
				}
				if repaired && a.Task.Spec.ID == "consumer" {
					if actual := f.workspaces.read(a.Task.BranchID, "outputs/producer.txt"); actual != "repaired producer" {
						return mission.Decision{}, fmt.Errorf("descendant inherited obsolete producer files: %q", actual)
					}
					if obsolete := f.workspaces.read(a.Task.BranchID, "outputs/consumer.txt"); obsolete != "" {
						return mission.Decision{}, fmt.Errorf("invalidated consumer artifact was used as a seed: %q", obsolete)
					}
				}
				return mutationDecision("workspace_write"), nil
			},
			perform: func(ctx context.Context, a mission.Assignment, op mission.Operation) (mission.ToolResult, error) {
				if a.Task.Spec.ID == "producer" {
					text := "original producer"
					if repaired {
						text = "repaired producer"
					}
					f.workspaces.write(a.Task.BranchID, "outputs/producer.txt", text)
				} else {
					upstream := f.workspaces.read(a.Task.BranchID, "outputs/producer.txt")
					f.workspaces.write(a.Task.BranchID, "outputs/consumer.txt", "derived from "+upstream)
				}
				return mission.ToolResult{Content: json.RawMessage(`{"written":true}`)}, nil
			},
		}
	}
	sourceTasks := map[string]mission.Task{}
	for range 2 {
		a := f.claim(t, "source-worker")
		if err := f.engine(makeExecutor(false)).process(ctx, assignmentFence(a), a); err != nil {
			t.Fatal(err)
		}
		task, err := f.store.GetTask(ctx, f.project.TenantID, f.project.ID, f.run.ID, a.Task.ID)
		if err != nil {
			t.Fatal(err)
		}
		sourceTasks[task.Spec.ID] = task
	}
	f.project.Config.RequireReview = true
	f.project.Plan.Version++
	p, err := f.store.UpdateProject(ctx, f.project.TenantID, f.project.ID, f.project.Revision, f.project)
	if err != nil {
		t.Fatal(err)
	}
	fork, err := f.store.ForkRun(ctx, p.TenantID, p.ID, f.run.ID, p.Revision)
	if err != nil {
		t.Fatal(err)
	}
	cloned, err := f.store.ListTasks(ctx, p.TenantID, p.ID, fork.ID)
	if err != nil {
		t.Fatal(err)
	}
	bySpec := map[string]mission.Task{}
	for _, task := range cloned {
		bySpec[task.Spec.ID] = task
	}
	consumer := bySpec["consumer"]
	if _, err = f.store.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: consumer.ID, SnapshotID: consumer.SnapshotID, Decision: "approved", AuthorID: "reviewer", Comment: "Attempt out-of-order approval"}); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("descendant was approved before its ancestor: %v", err)
	}
	producer := bySpec["producer"]
	if _, err = f.store.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: producer.ID, SnapshotID: producer.SnapshotID, Decision: "rejected", AuthorID: "reviewer", Comment: "Repair the upstream artifact"}); err != nil {
		t.Fatal(err)
	}
	consumer, err = f.store.GetTask(ctx, p.TenantID, p.ID, fork.ID, consumer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if (consumer.Status != "pending" && consumer.Status != "blocked") || consumer.SnapshotID != "" || consumer.ForkSnapshotID != "" || consumer.ReusedFromRunID != "" {
		t.Fatalf("reused descendant remained eligible for the obsolete artifact: %+v", consumer)
	}
	producer, err = f.store.GetTask(ctx, p.TenantID, p.ID, fork.ID, producer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.engine(makeExecutor(true)).RetryTask(ctx, p.TenantID, p.ID, fork.ID, producer.ID, producer.Revision); err != nil {
		t.Fatal(err)
	}
	repairedProducer := f.claim(t, "repair-worker")
	if err = f.engine(makeExecutor(true)).process(ctx, assignmentFence(repairedProducer), repairedProducer); err != nil {
		t.Fatal(err)
	}
	if tooEarly, err := f.store.ClaimTask(ctx, "consumer-too-early", time.Minute); err != nil || tooEarly != nil {
		t.Fatalf("consumer ran before approval of the new upstream artifact: %+v %v", tooEarly, err)
	}
	producer, err = f.store.GetTask(ctx, p.TenantID, p.ID, fork.ID, repairedProducer.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.RecordReview(ctx, p.TenantID, p.ID, fork.ID, mission.Review{TaskID: producer.ID, SnapshotID: producer.SnapshotID, Decision: "approved", AuthorID: "reviewer", Comment: "Checked the repaired upstream artifact"}); err != nil {
		t.Fatal(err)
	}
	rebuiltConsumer := f.claim(t, "consumer-worker")
	if rebuiltConsumer.Task.ID != consumer.ID {
		t.Fatal("invalidated consumer was not scheduled")
	}
	if err = f.engine(makeExecutor(true)).process(ctx, assignmentFence(rebuiltConsumer), rebuiltConsumer); err != nil {
		t.Fatal(err)
	}
	consumer, err = f.store.GetTask(ctx, p.TenantID, p.ID, fork.ID, rebuiltConsumer.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.workspaces.read(consumer.BranchID, "outputs/consumer.txt"); got != "derived from repaired producer" {
		t.Fatalf("consumer was not rebuilt from the repaired files: %q", got)
	}
	if got := f.workspaces.read(sourceTasks["consumer"].BranchID, "outputs/consumer.txt"); got != "derived from original producer" {
		t.Fatalf("new dependency execution mutated the source run: %q", got)
	}
}

type memoryWorkspaces struct {
	mu        sync.Mutex
	snapshots map[string]map[string]string
	branches  map[string]map[string]string
}

func newMemoryWorkspaces() *memoryWorkspaces {
	return &memoryWorkspaces{snapshots: map[string]map[string]string{}, branches: map[string]map[string]string{}}
}
func copyFiles(files map[string]string) map[string]string {
	out := map[string]string{}
	for path, content := range files {
		out[path] = content
	}
	return out
}
func snapshotKey(files map[string]string) string {
	raw, _ := json.Marshal(files)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func (w *memoryWorkspaces) Base(context.Context, mission.Scope) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	files := map[string]string{"report.txt": "baseline report", "seed.txt": "untouched"}
	key := snapshotKey(files)
	w.snapshots[key] = files
	return key, nil
}
func (w *memoryWorkspaces) Compose(ctx context.Context, scope mission.Scope, base string, heads []string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	files, ok := w.snapshots[base]
	if !ok {
		return "", errors.New("base absent")
	}
	merged := copyFiles(files)
	for _, head := range heads {
		snapshot, ok := w.snapshots[head]
		if !ok {
			return "", errors.New("dependency snapshot absent")
		}
		for path, content := range snapshot {
			if files[path] == content {
				continue
			}
			if prior, exists := merged[path]; exists && prior != files[path] && prior != content {
				return "", errors.New("composition conflict")
			}
			merged[path] = content
		}
	}
	key := snapshotKey(merged)
	w.snapshots[key] = merged
	return key, nil
}
func (w *memoryWorkspaces) Fork(ctx context.Context, scope mission.Scope, base, taskID string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	branch := "branch-" + taskID
	if _, exists := w.branches[branch]; exists {
		return branch, nil
	}
	files, ok := w.snapshots[base]
	if !ok {
		return "", errors.New("fork base absent")
	}
	w.branches[branch] = copyFiles(files)
	return branch, nil
}
func (w *memoryWorkspaces) Snapshot(ctx context.Context, scope mission.Scope, branch string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	files, ok := w.branches[branch]
	if !ok {
		return "", errors.New("branch absent")
	}
	key := snapshotKey(files)
	w.snapshots[key] = copyFiles(files)
	return key, nil
}
func (w *memoryWorkspaces) ValidateWrites(ctx context.Context, scope mission.Scope, base, branch string, writes []string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	before, ok := w.snapshots[base]
	if !ok {
		return errors.New("base absent")
	}
	after, ok := w.branches[branch]
	if !ok {
		return errors.New("branch absent")
	}
	all := map[string]bool{}
	for path := range before {
		all[path] = true
	}
	for path := range after {
		all[path] = true
	}
	for path := range all {
		old, oldExists := before[path]
		next, nextExists := after[path]
		if oldExists == nextExists && old == next {
			continue
		}
		allowed := false
		for _, claim := range writes {
			if claim == path || strings.HasSuffix(claim, "/**") && strings.HasPrefix(path, strings.TrimSuffix(claim, "/**")+"/") {
				allowed = true
			}
		}
		if !allowed {
			return fmt.Errorf("path %s is not claimed", path)
		}
	}
	return nil
}
func (w *memoryWorkspaces) Verify(ctx context.Context, scope mission.Scope, branch string, checks []mission.CheckSpec) (mission.Verification, error) {
	snapshot, err := w.Snapshot(ctx, scope, branch)
	if err != nil {
		return mission.Verification{}, err
	}
	w.mu.Lock()
	files := copyFiles(w.snapshots[snapshot])
	w.mu.Unlock()
	report, err := acceptance.Evaluate(ctx, checks, acceptance.Environment{SnapshotID: snapshot, Files: memorySnapshotFiles(files)}, acceptance.Options{})
	return report.Verification("", "", branch, time.Now().UTC()), err
}
func (w *memoryWorkspaces) write(branch, path, content string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.branches[branch][path] = content
}
func (w *memoryWorkspaces) read(branch, path string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.branches[branch][path]
}

type memorySnapshotFiles map[string]string

func (f memorySnapshotFiles) Stat(ctx context.Context, path string) (acceptance.FileInfo, error) {
	raw, ok := f[path]
	if !ok {
		return acceptance.FileInfo{}, acceptance.ErrNotFound
	}
	return acceptance.FileInfo{Size: int64(len(raw))}, nil
}
func (f memorySnapshotFiles) ReadFile(ctx context.Context, path string, limit int64) ([]byte, error) {
	raw, ok := f[path]
	if !ok {
		return nil, acceptance.ErrNotFound
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("size limit exceeded")
	}
	return []byte(raw), nil
}
