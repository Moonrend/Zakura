package projectrunner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Moonrend/Zakura/packages/projectkit/semantic"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

func semanticCall(t *testing.T, m *Manager, method string, args map[string]any, out any) error {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	result, err := m.SemanticDispatch(context.Background(), method, raw)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, out); err != nil {
		t.Fatal(err)
	}
	return nil
}
func TestSemanticRPCReadsOnlyFrozenScopedArtifacts(t *testing.T) {
	executor := &fakeExecutor{}
	m, source, _ := testManager(t, executor)
	initial := "package p\nfunc Exported(name string) int { return 1 }\n"
	if err := os.WriteFile(filepath.Join(source, "api.go"), []byte(initial), 0644); err != nil {
		t.Fatal(err)
	}
	base := textField(t, rpcResult(t, m, "project.base", scoped(map[string]any{"operationId": "semantic_base"})), "snapshotId")
	var summary semantic.Summary
	if err := semanticCall(t, m, "project.semantic.index", scoped(map[string]any{"snapshotId": base}), &summary); err != nil {
		t.Fatal(err)
	}
	if !summary.Complete || summary.Symbols != 2 || summary.SnapshotID != base {
		t.Fatalf("summary %#v", summary)
	}
	// Changing source and a live branch never changes an already captured index.
	if err := os.WriteFile(filepath.Join(source, "api.go"), []byte("package p\nfunc SourceOnly() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	branch(t, m, base, "semantic_branch")
	rpcResult(t, m, "project.branch.write", scoped(map[string]any{"operationId": "semantic_write", "branchId": "semantic_branch", "path": "api.go", "content": "package p\nfunc Replacement() {}\n"}))
	after := textField(t, rpcResult(t, m, "project.branch.capture", scoped(map[string]any{"operationId": "semantic_capture", "branchId": "semantic_branch"})), "snapshotId")
	var search semantic.SearchResult
	if err := semanticCall(t, m, "project.semantic.search", scoped(map[string]any{"snapshotId": base, "query": "Exported"}), &search); err != nil || search.Total != 1 {
		t.Fatalf("frozen index %#v %v", search, err)
	}
	if err := semanticCall(t, m, "project.semantic.search", scoped(map[string]any{"snapshotId": after, "query": "Exported"}), &search); err != nil || search.Total != 0 {
		t.Fatalf("new snapshot %#v %v", search, err)
	}
	var comparison semantic.Comparison
	if err := semanticCall(t, m, "project.semantic.compare", scoped(map[string]any{"snapshotId": after, "beforeSnapshot": base}), &comparison); err != nil {
		t.Fatal(err)
	}
	removed := false
	for _, change := range comparison.APIChanges {
		if change.Kind == "removed" && change.Classification == "breaking" {
			removed = true
		}
	}
	if !removed {
		t.Fatalf("removal absent %#v", comparison)
	}
	var file semantic.FileResult
	if err := semanticCall(t, m, "project.semantic.file", scoped(map[string]any{"snapshotId": base, "path": "api.go", "limit": 1}), &file); err != nil {
		t.Fatal(err)
	}
	if !file.Truncated || file.TotalSymbols != 2 || len(file.File.Symbols) != 1 {
		t.Fatalf("file bound %#v", file)
	}
	var navigation semantic.Navigation
	if err := semanticCall(t, m, "project.semantic.symbol", scoped(map[string]any{"snapshotId": base, "symbolId": file.File.Symbols[0].ID}), &navigation); err != nil {
		t.Fatal(err)
	}
	if err := semanticCall(t, m, "project.semantic.index", map[string]any{"spaceId": "space_a", "projectId": "another", "snapshotId": base}, &summary); !errors.Is(err, workspace.ErrNotFound) {
		t.Fatalf("scope escaped: %v", err)
	}
	if err := semanticCall(t, m, "project.semantic.file", scoped(map[string]any{"snapshotId": base, "path": "../api.go"}), &file); !errors.Is(err, semantic.ErrInvalid) {
		t.Fatalf("path escaped: %v", err)
	}
	if executor.calls.Load() != 0 {
		t.Fatal("semantic analysis executed project code")
	}
	current, err := os.ReadFile(filepath.Join(source, "api.go"))
	if err != nil || string(current) != "package p\nfunc SourceOnly() {}\n" {
		t.Fatalf("semantic mutated source %s %v", current, err)
	}
}
func TestSemanticCachedSnapshotMustStillExist(t *testing.T) {
	m, source, _ := testManager(t, nil)
	if err := os.WriteFile(filepath.Join(source, "a.go"), []byte("package p\nfunc A() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	base := textField(t, rpcResult(t, m, "project.base", scoped(map[string]any{"operationId": "cached_semantic"})), "snapshotId")
	var summary semantic.Summary
	if err := semanticCall(t, m, "project.semantic.index", scoped(map[string]any{"snapshotId": base}), &summary); err != nil {
		t.Fatal(err)
	}
	p, err := m.get(Scope{"space_a", "project_a"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(p.root, "repository", "manifests", base+".json")); err != nil {
		t.Fatal(err)
	}
	if err := semanticCall(t, m, "project.semantic.index", scoped(map[string]any{"snapshotId": base}), &summary); !errors.Is(err, workspace.ErrNotFound) {
		t.Fatalf("stale cache exposed deleted snapshot: %v", err)
	}
}
func TestSemanticRPCStrictFieldsAndWindows(t *testing.T) {
	m, _, base := testManager(t, nil)
	for _, test := range []struct {
		method string
		args   map[string]any
	}{
		{"project.semantic.index", scoped(map[string]any{"snapshotId": base, "operationId": "not_allowed"})},
		{"project.semantic.search", scoped(map[string]any{"snapshotId": base, "query": "x", "limit": 1001})},
		{"project.semantic.search", scoped(map[string]any{"snapshotId": base, "query": "x", "offset": -1})},
		{"project.semantic.file", scoped(map[string]any{"snapshotId": base, "path": "a.go", "branchId": "live"})},
		{"project.semantic.compare", scoped(map[string]any{"snapshotId": base})},
		{"project.semantic.unknown", scoped(map[string]any{"snapshotId": base})},
	} {
		raw, _ := json.Marshal(test.args)
		if _, err := m.SemanticDispatch(context.Background(), test.method, raw); err == nil {
			t.Fatalf("invalid parameters accepted: %s %#v", test.method, test.args)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	raw, _ := json.Marshal(scoped(map[string]any{"snapshotId": base}))
	if _, err := m.SemanticDispatch(ctx, "project.semantic.index", raw); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled semantic request %v", err)
	}
}
