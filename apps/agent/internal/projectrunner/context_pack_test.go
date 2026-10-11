package projectrunner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/packages/projectkit/contextpack"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

func TestContextRPCFrozenScopeStrictBoundsAndNoExecution(t *testing.T) {
	executor := &fakeExecutor{}
	m, source, _ := testManager(t, executor)
	initial := "package context\n// 引用\nfunc Checkpoint() string { return \"snapshot\" }\n"
	if err := os.WriteFile(filepath.Join(source, "api.go"), []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	base := textField(t, rpcResult(t, m, "project.base", scoped(map[string]any{"operationId": "context_base"})), "snapshotId")
	if err := os.WriteFile(filepath.Join(source, "api.go"), []byte("package changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	args := scoped(map[string]any{"snapshotId": base, "query": "Checkpoint", "writes": []string{"api.go"}, "checkPaths": []string{}, "maxBytes": 1024})
	raw, _ := json.Marshal(args)
	result, err := m.ContextDispatch(context.Background(), "project.context.pack", raw)
	if err != nil {
		t.Fatal(err)
	}
	p := result.(contextpack.Pack)
	encoded, _ := json.Marshal(p)
	if len(encoded) > 1024 || p.Bytes != len(encoded) || len(p.Snippets) == 0 || !strings.Contains(p.Snippets[0].Text, "Checkpoint") {
		t.Fatalf("wrong immutable bounded result %+v", p)
	}
	for _, mutation := range []map[string]any{{"snapshotId": base, "branchId": "model_branch"}, {"snapshotId": base, "maxBytes": 16001}, {"snapshotId": base, "writes": []string{"../outside"}}, {"snapshotId": base, "taskId": "foreign"}} {
		bad, _ := json.Marshal(scoped(mutation))
		if _, err = m.ContextDispatch(context.Background(), "project.context.pack", bad); err == nil {
			t.Fatalf("accepted unsupported request %v", mutation)
		}
	}
	args["projectId"] = "foreign_project"
	raw, _ = json.Marshal(args)
	if _, err = m.ContextDispatch(context.Background(), "project.context.pack", raw); !errors.Is(err, workspace.ErrNotFound) {
		t.Fatalf("scope escape: %v", err)
	}
	if executor.calls.Load() != 0 {
		t.Fatal("context ran workspace program")
	}
	current, err := os.ReadFile(filepath.Join(source, "api.go"))
	if err != nil || string(current) != "package changed\n" {
		t.Fatal("context wrote original source")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	raw, _ = json.Marshal(scoped(map[string]any{"snapshotId": base}))
	if _, err = m.ContextDispatch(ctx, "project.context.pack", raw); !errors.Is(err, context.Canceled) {
		t.Fatalf("context cancellation %v", err)
	}
}
