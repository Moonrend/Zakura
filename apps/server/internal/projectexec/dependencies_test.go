// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"context"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func dependencyTestSnapshot(t *testing.T, w *memoryWorkspaces, base, id string, edits map[string]string) string {
	t.Helper()
	branch, err := w.Fork(context.Background(), mission.Scope{}, base, id)
	if err != nil {
		t.Fatal(err)
	}
	for path, content := range edits {
		w.write(branch, path, content)
	}
	snapshot, err := w.Snapshot(context.Background(), mission.Scope{}, branch)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func completedDependency(id, snapshot string, deps ...string) mission.Task {
	return mission.Task{ID: "instance-" + id, Spec: mission.TaskSpec{ID: id, DependsOn: deps}, Status: "completed", SnapshotID: snapshot}
}

func TestDependencyDiamondUsesSharedAncestorSnapshot(t *testing.T) {
	w := newMemoryWorkspaces()
	ctx := context.Background()
	root, err := w.Base(ctx, mission.Scope{})
	if err != nil {
		t.Fatal(err)
	}
	a := dependencyTestSnapshot(t, w, root, "a", map[string]string{"report.txt": "ancestor edit"})
	b := dependencyTestSnapshot(t, w, a, "b", map[string]string{"report.txt": "later child edit"})
	c := dependencyTestSnapshot(t, w, a, "c", map[string]string{"outputs/c.txt": "independent child edit"})
	if _, err = w.Compose(ctx, mission.Scope{}, root, []string{b, c}); err == nil {
		t.Fatal("regression setup should conflict when using original run baseline")
	}
	tasks := []mission.Task{completedDependency("a", a), completedDependency("b", b, "a"), completedDependency("c", c, "a")}
	composed, err := composeDependencies(ctx, w, mission.Scope{}, root, tasks, []string{"b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	files := copyFiles(w.snapshots[composed])
	w.mu.Unlock()
	if files["report.txt"] != "later child edit" || files["outputs/c.txt"] != "independent child edit" {
		t.Fatalf("composed=%v", files)
	}
	// Listing both an ancestor and its descendant must not reapply the older
	// ancestor output as a competing independent branch.
	withAncestor, err := composeDependencies(ctx, w, mission.Scope{}, root, tasks, []string{"a", "b", "c"})
	if err != nil || withAncestor != composed {
		t.Fatalf("redundant ancestor affected output: %s %v", withAncestor, err)
	}
}

func TestDependencyCompositionHandlesMultipleCommonMaxima(t *testing.T) {
	w := newMemoryWorkspaces()
	ctx := context.Background()
	root, err := w.Base(ctx, mission.Scope{})
	if err != nil {
		t.Fatal(err)
	}
	x := dependencyTestSnapshot(t, w, root, "x", map[string]string{"outputs/x.txt": "shared X"})
	y := dependencyTestSnapshot(t, w, root, "y", map[string]string{"outputs/y.txt": "shared Y"})
	xy, err := w.Compose(ctx, mission.Scope{}, root, []string{x, y})
	if err != nil {
		t.Fatal(err)
	}
	b := dependencyTestSnapshot(t, w, xy, "b", map[string]string{"outputs/x.txt": "B advances X"})
	c := dependencyTestSnapshot(t, w, xy, "c", map[string]string{"outputs/y.txt": "C advances Y"})
	tasks := []mission.Task{completedDependency("x", x), completedDependency("y", y), completedDependency("b", b, "x", "y"), completedDependency("c", c, "x", "y")}
	composed, err := ComposeTaskOutputs(ctx, w, mission.Scope{}, root, tasks, []string{"instance-b", "instance-c"})
	if err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	files := copyFiles(w.snapshots[composed])
	w.mu.Unlock()
	if files["outputs/x.txt"] != "B advances X" || files["outputs/y.txt"] != "C advances Y" {
		t.Fatalf("composed=%v", files)
	}
	// Both selected heads have changed shared inputs, so preserving all common
	// maxima rather than picking one arbitrary ancestor is necessary.
	if _, err = w.Compose(ctx, mission.Scope{}, root, []string{b, c}); err == nil {
		t.Fatal("original baseline should produce a false conflict")
	}
}

func TestComposeTaskOutputsRejectsUnacceptedOrForeignIdentity(t *testing.T) {
	w := newMemoryWorkspaces()
	root, err := w.Base(context.Background(), mission.Scope{})
	if err != nil {
		t.Fatal(err)
	}
	task := completedDependency("task", root)
	for _, ids := range [][]string{nil, {"task"}, {"instance-task", "instance-task"}} {
		if _, err := ComposeTaskOutputs(context.Background(), w, mission.Scope{}, root, []mission.Task{task}, ids); err == nil {
			t.Fatalf("invalid selection accepted: %v", ids)
		}
	}
	task.Status = "waiting_review"
	if _, err := ComposeTaskOutputs(context.Background(), w, mission.Scope{}, root, []mission.Task{task}, []string{"instance-task"}); err == nil || !strings.Contains(err.Error(), "acceptance") {
		t.Fatalf("unaccepted output: %v", err)
	}
}

func TestDependencyCompositionPropagatesRealMergeConflict(t *testing.T) {
	w := newMemoryWorkspaces()
	ctx := context.Background()
	root, err := w.Base(ctx, mission.Scope{})
	if err != nil {
		t.Fatal(err)
	}
	a := dependencyTestSnapshot(t, w, root, "a", map[string]string{"report.txt": "common"})
	b := dependencyTestSnapshot(t, w, a, "b", map[string]string{"report.txt": "different B"})
	c := dependencyTestSnapshot(t, w, a, "c", map[string]string{"report.txt": "different C"})
	tasks := []mission.Task{completedDependency("a", a), completedDependency("b", b, "a"), completedDependency("c", c, "a")}
	if _, err = composeDependencies(ctx, w, mission.Scope{}, root, tasks, []string{"b", "c"}); err == nil {
		t.Fatal("real conflict was hidden")
	}
}
