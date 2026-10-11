package projectrunner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/internal/sandbox"
	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

type fakeExecutor struct {
	calls atomic.Int32
	mu    sync.Mutex
	roots []string
	run   func(string, sandbox.ProjectExecParams) (sandbox.ExecResult, error)
}

func (f *fakeExecutor) Run(ctx context.Context, root string, p sandbox.ProjectExecParams) (sandbox.ExecResult, error) {
	f.calls.Add(1)
	f.mu.Lock()
	f.roots = append(f.roots, root)
	f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return sandbox.ExecResult{ExitCode: -1, Cancelled: true}, err
	}
	if f.run != nil {
		return f.run(root, p)
	}
	return sandbox.ExecResult{ExitCode: 0, Stdout: "ok"}, nil
}
func rpcResult(t *testing.T, m *Manager, method string, args map[string]any) map[string]json.RawMessage {
	t.Helper()
	result, err := rpcCall(m, method, args)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}
func rpcCall(m *Manager, method string, args map[string]any) (any, error) {
	raw, _ := json.Marshal(args)
	return m.Dispatch(context.Background(), method, raw)
}
func textField(t *testing.T, result map[string]json.RawMessage, key string) string {
	t.Helper()
	var value string
	if err := json.Unmarshal(result[key], &value); err != nil {
		t.Fatalf("field %s: %v", key, err)
	}
	return value
}
func scoped(extras map[string]any) map[string]any {
	args := map[string]any{"spaceId": "space_a", "projectId": "project_a"}
	for key, value := range extras {
		args[key] = value
	}
	return args
}
func testManager(t *testing.T, executor Executor) (*Manager, string, string) {
	t.Helper()
	root := t.TempDir()
	m := New(root)
	if executor != nil {
		m.WithExecutor(executor)
	}
	source, err := m.Source(Scope{"space_a", "project_a"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "hello.txt"), []byte("hello\n"), 0644); err != nil {
		t.Fatal(err)
	}
	result := rpcResult(t, m, "project.base", scoped(map[string]any{"operationId": "base_1"}))
	return m, source, textField(t, result, "snapshotId")
}
func branch(t *testing.T, m *Manager, base, id string) {
	t.Helper()
	rpcResult(t, m, "project.branch.create", scoped(map[string]any{"operationId": "create_" + id, "snapshotId": base, "branchId": id}))
}

func TestBranchToolsAreScopedAndDoNotWriteSource(t *testing.T) {
	m, source, base := testManager(t, nil)
	branch(t, m, base, "task_a")
	write := rpcResult(t, m, "project.branch.write", scoped(map[string]any{"operationId": "write_1", "branchId": "task_a", "path": "/workspace/docs/new.txt", "content": "alpha", "expectedRevision": "missing"}))
	revision := textField(t, write, "revision")
	if len(revision) != 64 {
		t.Fatalf("bad revision %q", revision)
	}
	listing := rpcResult(t, m, "project.branch.list", scoped(map[string]any{"branchId": "task_a"}))
	var entries []DirectoryEntry
	if err := json.Unmarshal(listing["entries"], &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || !entries[0].IsDir || entries[0].Name != "docs" {
		t.Fatalf("directory listing %+v", entries)
	}
	rpcResult(t, m, "project.branch.patch", scoped(map[string]any{"operationId": "patch_1", "branchId": "task_a", "path": "docs/new.txt", "expectedRevision": revision, "oldText": "alpha", "newText": "beta"}))
	if _, err := rpcCall(m, "project.branch.patch", scoped(map[string]any{"operationId": "patch_stale", "branchId": "task_a", "path": "docs/new.txt", "expectedRevision": revision, "oldText": "beta", "newText": "wrong"})); !errors.Is(err, workspace.ErrConflict) {
		t.Fatalf("stale patch: %v", err)
	}
	rpcResult(t, m, "project.branch.rename", scoped(map[string]any{"operationId": "rename_1", "branchId": "task_a", "oldPath": "docs/new.txt", "newPath": "docs/result.txt"}))
	read := rpcResult(t, m, "project.branch.read", scoped(map[string]any{"branchId": "task_a", "path": "docs/result.txt"}))
	if textField(t, read, "content") != "beta" {
		t.Fatal("patch or rename failed")
	}
	if _, err := os.Stat(filepath.Join(source, "docs")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("branch wrote source: %v", err)
	}
	if _, err := rpcCall(m, "project.branch.read", map[string]any{"spaceId": "space_a", "projectId": "another", "branchId": "task_a", "path": "docs/result.txt"}); !errors.Is(err, workspace.ErrNotFound) {
		t.Fatalf("scope escape: %v", err)
	}
	rpcResult(t, m, "project.branch.remove", scoped(map[string]any{"operationId": "remove_1", "branchId": "task_a", "path": "docs/result.txt"}))
	rpcResult(t, m, "project.branch.gc", scoped(map[string]any{"operationId": "gc_1", "branchIds": []string{"task_a"}}))
	if _, err := rpcCall(m, "project.branch.read", scoped(map[string]any{"branchId": "task_a", "path": "hello.txt"})); !errors.Is(err, workspace.ErrNotFound) {
		t.Fatalf("GC did not remove branch: %v", err)
	}
}

func TestJournalDeduplicatesAcrossRestartAndRejectsChangedArguments(t *testing.T) {
	fake := &fakeExecutor{}
	m, _, base := testManager(t, fake)
	branch(t, m, base, "task_a")
	args := scoped(map[string]any{"operationId": "command_1", "branchId": "task_a", "command": []string{"echo", "ok"}})
	rpcResult(t, m, "project.exec", args)
	rpcResult(t, m, "project.exec", args)
	restarted := New(m.storageRoot).WithExecutor(fake)
	rpcResult(t, restarted, "project.exec", args)
	if fake.calls.Load() != 1 {
		t.Fatalf("replayed command %d times", fake.calls.Load())
	}
	args["command"] = []string{"echo", "changed"}
	if _, err := rpcCall(restarted, "project.exec", args); err == nil || !strings.Contains(err.Error(), "different arguments") {
		t.Fatalf("reused operation: %v", err)
	}
	inspection, err := restarted.Inspect(Scope{"space_a", "project_a"}, "command_1")
	if err != nil || !inspection.Known || inspection.Status != "completed" {
		t.Fatalf("inspection %+v %v", inspection, err)
	}
	absent, err := restarted.Inspect(Scope{"space_a", "project_a"}, "absent")
	if err != nil || absent.Known {
		t.Fatalf("missing operation %+v %v", absent, err)
	}
}

func TestIntentExistsBeforeSideEffectsAndCrashIsUnknown(t *testing.T) {
	fake := &fakeExecutor{}
	m, _, base := testManager(t, fake)
	branch(t, m, base, "task_a")
	fake.run = func(_ string, _ sandbox.ProjectExecParams) (sandbox.ExecResult, error) {
		p, err := m.get(Scope{"space_a", "project_a"})
		if err != nil {
			t.Fatal(err)
		}
		op, err := loadOperation(p, "command_1")
		if err != nil || op.Status != "running" {
			t.Fatalf("missing durable intent: %+v %v", op, err)
		}
		return sandbox.ExecResult{ExitCode: 7, Stderr: "failure"}, nil
	}
	args := scoped(map[string]any{"operationId": "command_1", "branchId": "task_a", "command": []string{"false"}})
	result := rpcResult(t, m, "project.exec", args)
	var code int
	json.Unmarshal(result["exitCode"], &code)
	if code != 7 {
		t.Fatal("workload failure was hidden")
	}
	p, err := m.get(Scope{"space_a", "project_a"})
	if err != nil {
		t.Fatal(err)
	}
	op, err := loadOperation(p, "command_1")
	if err != nil {
		t.Fatal(err)
	}
	op.Status = "running"
	op.Result = nil
	if err := persistOperation(p, op); err != nil {
		t.Fatal(err)
	}
	restarted := New(m.storageRoot).WithExecutor(fake)
	inspection, err := restarted.Inspect(Scope{"space_a", "project_a"}, "command_1")
	if err != nil || inspection.Known || inspection.Status != "unknown" {
		t.Fatalf("crash was reported as known: %+v %v", inspection, err)
	}
	if _, err := rpcCall(restarted, "project.exec", args); err == nil {
		t.Fatal("unknown command was replayed")
	}
	if fake.calls.Load() != 1 {
		t.Fatal("unknown side effect repeated")
	}
}

func TestMergeRequiresExactReviewAndFreshCompleteBaseline(t *testing.T) {
	m, source, base := testManager(t, nil)
	branch(t, m, base, "task_a")
	rpcResult(t, m, "project.branch.write", scoped(map[string]any{"operationId": "write_1", "branchId": "task_a", "path": "hello.txt", "content": "task change\n"}))
	captured := rpcResult(t, m, "project.branch.capture", scoped(map[string]any{"operationId": "capture_1", "branchId": "task_a"}))
	head := textField(t, captured, "snapshotId")
	planned := rpcResult(t, m, "project.merge.plan", scoped(map[string]any{"operationId": "plan_1", "baseSnapshot": base, "snapshotId": head}))
	planID := textField(t, planned, "planId")
	expected := textField(t, planned, "expectedBase")
	var plan workspace.MergePlan
	json.Unmarshal(planned["plan"], &plan)
	apply := scoped(map[string]any{"operationId": "apply_wrong", "planId": planID, "expectedBase": expected, "reviewId": "review_1", "approved": true, "reviewSnapshot": base})
	if _, err := rpcCall(m, "project.merge.apply", apply); !errors.Is(err, workspace.ErrConflict) {
		t.Fatalf("wrong approved snapshot accepted: %v", err)
	}
	apply["operationId"] = "apply_stale"
	apply["reviewSnapshot"] = plan.Result.ID
	if err := os.WriteFile(filepath.Join(source, "unrelated.txt"), []byte("human edit"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := rpcCall(m, "project.merge.apply", apply); !errors.Is(err, workspace.ErrConflict) {
		t.Fatalf("changed tree accepted: %v", err)
	}
	inspection, err := m.Inspect(Scope{"space_a", "project_a"}, "apply_stale")
	if err != nil || !inspection.Known || inspection.Status != "failed" || inspection.EffectState != "not_performed" {
		t.Fatalf("merge preflight lacks no-effect proof: %+v %v", inspection, err)
	}
	if err := os.Remove(filepath.Join(source, "unrelated.txt")); err != nil {
		t.Fatal(err)
	}
	apply["operationId"] = "apply_1"
	rpcResult(t, m, "project.merge.apply", apply)
	content, err := os.ReadFile(filepath.Join(source, "hello.txt"))
	if err != nil || string(content) != "task change\n" {
		t.Fatalf("merge not published: %q %v", content, err)
	}
	rpcResult(t, m, "project.merge.apply", apply)
}

func TestConflictResolutionProducesImmutableReviewedPlan(t *testing.T) {
	m, source, base := testManager(t, nil)
	branch(t, m, base, "task_a")
	rpcResult(t, m, "project.branch.write", scoped(map[string]any{"operationId": "write_1", "branchId": "task_a", "path": "hello.txt", "content": "task side\n"}))
	captured := rpcResult(t, m, "project.branch.capture", scoped(map[string]any{"operationId": "capture_1", "branchId": "task_a"}))
	if err := os.WriteFile(filepath.Join(source, "hello.txt"), []byte("human side\n"), 0644); err != nil {
		t.Fatal(err)
	}
	planned := rpcResult(t, m, "project.merge.plan", scoped(map[string]any{"operationId": "plan_1", "baseSnapshot": base, "snapshotId": textField(t, captured, "snapshotId")}))
	var plan workspace.MergePlan
	json.Unmarshal(planned["plan"], &plan)
	if len(plan.Conflicts) == 0 {
		t.Fatal("expected overlapping-edit conflict")
	}
	resolutions := []workspace.Resolution{}
	for _, conflict := range plan.Conflicts {
		resolutions = append(resolutions, workspace.Resolution{ConflictID: conflict.ID, Choice: "content", Content: []byte("human reviewed resolution\n"), Mode: 0644})
	}
	resolved := rpcResult(t, m, "project.merge.resolve", scoped(map[string]any{"operationId": "resolve_1", "planId": plan.ID, "resolutions": resolutions}))
	var next workspace.MergePlan
	json.Unmarshal(resolved["plan"], &next)
	if len(next.Conflicts) != 0 || next.Result.ID == plan.Result.ID {
		t.Fatal("resolution did not produce a new immutable target")
	}
	rpcResult(t, m, "project.merge.apply", scoped(map[string]any{"operationId": "apply_1", "planId": next.ID, "expectedBase": next.Ours, "reviewId": "review_1", "reviewSnapshot": next.Result.ID, "approved": true}))
	content, err := os.ReadFile(filepath.Join(source, "hello.txt"))
	if err != nil || string(content) != "human reviewed resolution\n" {
		t.Fatalf("wrong resolved content %q %v", content, err)
	}
}

func TestVerificationCommandsCannotPolluteBranchOrLaterChecks(t *testing.T) {
	fake := &fakeExecutor{run: func(root string, p sandbox.ProjectExecParams) (sandbox.ExecResult, error) {
		if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("command pollution"), 0644); err != nil {
			return sandbox.ExecResult{}, err
		}
		return sandbox.ExecResult{ExitCode: 0, Stdout: strings.Join(p.Command, " ")}, nil
	}}
	m, source, base := testManager(t, fake)
	branch(t, m, base, "task_a")
	checks := []map[string]any{{"id": "first", "title": "first command", "kind": "command", "command": []string{"build"}, "required": true}, {"id": "text", "title": "frozen text", "kind": "text_contains", "path": "hello.txt", "pattern": "hello", "required": true}, {"id": "second", "title": "second command", "kind": "command", "command": []string{"test"}, "required": true}}
	verified := rpcResult(t, m, "project.verify", scoped(map[string]any{"operationId": "verify_1", "branchId": "task_a", "checks": checks}))
	if textField(t, verified, "status") != "passed" {
		t.Fatalf("verification %s", verified)
	}
	if len(fake.roots) != 2 || fake.roots[0] == fake.roots[1] {
		t.Fatal("commands shared a writable worktree")
	}
	for _, root := range fake.roots {
		if !strings.Contains(root, string(filepath.Separator)+"verification"+string(filepath.Separator)) {
			t.Fatalf("check used original branch: %s", root)
		}
		if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("temporary execution tree leaked")
		}
	}
	read := rpcResult(t, m, "project.branch.read", scoped(map[string]any{"branchId": "task_a", "path": "hello.txt"}))
	if textField(t, read, "content") != "hello\n" {
		t.Fatal("verification polluted task branch")
	}
	content, _ := os.ReadFile(filepath.Join(source, "hello.txt"))
	if string(content) != "hello\n" {
		t.Fatal("verification polluted source")
	}
	var results []struct {
		Evidence json.RawMessage `json:"evidence"`
	}
	json.Unmarshal(verified["checks"], &results)
	for _, result := range results {
		e, err := acceptance.DecodeEvidence(result.Evidence)
		if err != nil || e.SnapshotID != base {
			t.Fatalf("evidence does not bind frozen snapshot: %+v %v", e, err)
		}
	}
}

func TestScopePathsAndUnknownFieldsFailClosed(t *testing.T) {
	m, _, base := testManager(t, nil)
	branch(t, m, base, "task_a")
	for _, name := range []string{"../../escape", "/etc/passwd", "C:\\Windows\\system.ini", "/workspace/../escape", "."} {
		t.Run(name, func(t *testing.T) {
			if _, err := rpcCall(m, "project.branch.read", scoped(map[string]any{"branchId": "task_a", "path": name})); err == nil {
				t.Fatalf("unsafe path accepted: %q", name)
			}
		})
	}
	for _, field := range []string{"root", "image", "env", "network", "mounts", "approved", "command"} {
		t.Run("field_"+field, func(t *testing.T) {
			args := scoped(map[string]any{"branchId": "task_a", "path": "hello.txt", field: "bad"})
			if _, err := rpcCall(m, "project.branch.read", args); err == nil {
				t.Fatalf("unknown parameter accepted: %s", field)
			}
		})
	}
	args := scoped(map[string]any{"branchId": "task_a", "path": "hello.txt"})
	args["spaceId"] = "../space"
	if _, err := rpcCall(m, "project.branch.read", args); err == nil {
		t.Fatal("unsafe scope accepted")
	}
	root := t.TempDir()
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "projects")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := rpcCall(New(root), "project.policy", scoped(nil)); err == nil {
		t.Fatal("symlink project storage accepted")
	}
	p, _ := m.get(Scope{"space_a", "project_a"})
	branchRoot, _ := p.repository.BranchRoot(context.Background(), "task_a")
	if err := os.Symlink(t.TempDir(), filepath.Join(branchRoot, "evil")); err != nil {
		t.Fatal(err)
	}
	if _, err := rpcCall(m, "project.branch.read", scoped(map[string]any{"branchId": "task_a", "path": "evil/secret"})); err == nil {
		t.Fatal("branch symlink was followed")
	}
}

func TestSpaceLockBlocksSourceCaptureButNotIsolatedBranchReads(t *testing.T) {
	m, _, base := testManager(t, nil)
	branch(t, m, base, "task_a")
	unlock, err := m.LockSpace("space_a")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := rpcCall(m, "project.base", scoped(map[string]any{"operationId": "base_2"}))
		done <- err
	}()
	select {
	case err := <-done:
		unlock()
		t.Fatalf("capture bypassed lock: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	unlock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("capture did not resume")
	}
}

func TestSnapshotPreviewIsImmutableAfterBranchChanges(t *testing.T) {
	m, _, base := testManager(t, nil)
	branch(t, m, base, "task_a")
	rpcResult(t, m, "project.branch.write", scoped(map[string]any{"operationId": "write_1", "branchId": "task_a", "path": "hello.txt", "content": "modified"}))
	preview := rpcResult(t, m, "project.snapshot.read", scoped(map[string]any{"snapshotId": base, "path": "hello.txt"}))
	if textField(t, preview, "content") != "hello\n" || textField(t, preview, "snapshotId") != base {
		t.Fatal("preview read mutable branch content")
	}
	if _, err := rpcCall(m, "project.snapshot.read", scoped(map[string]any{"snapshotId": base, "path": "hello.txt", "maxBytes": 1})); err == nil {
		t.Fatal("snapshot preview ignored byte cap")
	}
}

func TestInspectRunningOperationDoesNotWaitForCommand(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	fake := &fakeExecutor{run: func(_ string, _ sandbox.ProjectExecParams) (sandbox.ExecResult, error) {
		close(entered)
		<-release
		return sandbox.ExecResult{ExitCode: 0}, nil
	}}
	m, _, base := testManager(t, fake)
	branch(t, m, base, "task_a")
	done := make(chan error, 1)
	go func() {
		_, err := rpcCall(m, "project.exec", scoped(map[string]any{"operationId": "command_1", "branchId": "task_a", "command": []string{"wait"}}))
		done <- err
	}()
	<-entered
	inspection, err := m.Inspect(Scope{"space_a", "project_a"}, "command_1")
	if err != nil || inspection.Known || inspection.Status != "running" {
		close(release)
		t.Fatalf("active operation inspection %+v %v", inspection, err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestGeneralCommandFailureNeverClaimsNoEffect(t *testing.T) {
	fake := &fakeExecutor{run: func(_ string, _ sandbox.ProjectExecParams) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{ExitCode: -1}, errors.New("cleanup could not be verified")
	}}
	m, _, base := testManager(t, fake)
	branch(t, m, base, "task_a")
	if _, err := rpcCall(m, "project.exec", scoped(map[string]any{"operationId": "command_1", "branchId": "task_a", "command": []string{"run"}})); err == nil {
		t.Fatal("backend uncertainty was hidden")
	}
	inspection, err := m.Inspect(Scope{"space_a", "project_a"}, "command_1")
	if err != nil || inspection.EffectState == "not_performed" {
		t.Fatalf("arbitrary failure was called no-effect: %+v %v", inspection, err)
	}
}

func TestSourcePublicationAtomicallyBlocksNewHostLaunches(t *testing.T) {
	m, _, _ := testManager(t, nil)
	unlock, err := m.LockPublication("space_a")
	if err != nil {
		t.Fatal(err)
	}
	launched := make(chan func(), 1)
	go func() {
		release, err := m.BeginSourceProcess("space_a")
		if err != nil {
			t.Error(err)
			return
		}
		launched <- release
	}()
	select {
	case release := <-launched:
		release()
		unlock()
		t.Fatal("source job began during source publication")
	case <-time.After(30 * time.Millisecond):
	}
	unlock()
	release := <-launched
	if unlock, err := m.LockPublication("space_a"); err == nil {
		unlock()
		release()
		t.Fatal("known source process did not block publication")
	}
	release()
	unlock, err = m.LockPublication("space_a")
	if err != nil {
		t.Fatal(err)
	}
	unlock()
	global, err := m.BeginSourceProcess("")
	if err != nil {
		t.Fatal(err)
	}
	if unlock, err := m.LockPublication("another_space"); err == nil {
		unlock()
		global()
		t.Fatal("unscoped host execution failed to block all source publications")
	}
	global()
}

func TestAgentRestartRetainsSourceWriterIntent(t *testing.T) {
	m, _, _ := testManager(t, nil)
	release, err := m.BeginSourceProcess("space_a")
	if err != nil {
		t.Fatal(err)
	}
	restarted := New(m.storageRoot)
	if unlock, err := restarted.LockPublication("space_a"); err == nil {
		unlock()
		release()
		t.Fatal("agent restart silently forgot a possibly live source writer")
	}
	release()
	settled := New(m.storageRoot)
	unlock, err := settled.LockPublication("space_a")
	if err != nil {
		t.Fatalf("persisted completion did not permit publication: %v", err)
	}
	unlock()
}
