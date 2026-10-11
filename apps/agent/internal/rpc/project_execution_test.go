package rpc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

func projectRPC(t *testing.T, h *Handler, method string, params map[string]any) Msg {
	t.Helper()
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var response Msg
	h.Dispatch(context.Background(), Msg{ID: "test", Method: method, Params: encoded}, func(msg Msg) {
		if msg.Type == "res" {
			response = msg
		}
	})
	if response.OK == nil {
		t.Fatalf("no response for %s", method)
	}
	return response
}
func projectRPCOK(t *testing.T, h *Handler, method string, params map[string]any) map[string]json.RawMessage {
	t.Helper()
	response := projectRPC(t, h, method, params)
	if !*response.OK {
		t.Fatalf("%s: %s", method, response.Error)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(response.Result, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}
func projectField(t *testing.T, object map[string]json.RawMessage, key string) string {
	t.Helper()
	var value string
	if err := json.Unmarshal(object[key], &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func projectScope(extra map[string]any) map[string]any {
	object := map[string]any{"spaceId": "source_a", "projectId": "project_a"}
	for key, value := range extra {
		object[key] = value
	}
	return object
}

func TestProjectMergeRejectsLegacyBackgroundHeldDescriptor(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("held descriptor and process group coordination regression uses Linux")
	}
	t.Setenv("ZAKURA_SANDBOX_ENABLED", "false")
	storage := t.TempDir()
	handler := New("test", storage)
	projectRPCOK(t, handler, "host.fs.write", map[string]any{"spaceId": "source_a", "path": "hello.txt", "content": "hello\n"})
	base := projectField(t, projectRPCOK(t, handler, "project.base", projectScope(map[string]any{"operationId": "base_1"})), "snapshotId")
	projectRPCOK(t, handler, "project.branch.create", projectScope(map[string]any{"operationId": "fork_1", "snapshotId": base, "branchId": "task_a"}))
	projectRPCOK(t, handler, "project.branch.write", projectScope(map[string]any{"operationId": "write_1", "branchId": "task_a", "path": "hello.txt", "content": "project change\n"}))
	head := projectField(t, projectRPCOK(t, handler, "project.branch.capture", projectScope(map[string]any{"operationId": "capture_1", "branchId": "task_a"})), "snapshotId")
	planned := projectRPCOK(t, handler, "project.merge.plan", projectScope(map[string]any{"operationId": "plan_1", "baseSnapshot": base, "snapshotId": head}))
	var plan workspace.MergePlan
	if err := json.Unmarshal(planned["plan"], &plan); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(storage, "held-fd-opened")
	// The foreground exits after opening a writable descriptor inherited by a
	// child, which deliberately disconnects stdout/stderr before its delayed write.
	started := projectRPCOK(t, handler, "host.exec.start", map[string]any{"spaceId": "source_a", "command": []string{"/bin/sh", "-c", "exec 3>>hello.txt; (sleep 0.25; printf 'held FD\n' >&3) >/dev/null 2>&1 & printf ready > \"$1\"", "held-job", marker}})
	jobID := projectField(t, started, "id")
	defer handler.jobs.Kill(jobID)
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("host command never opened its source descriptor")
		}
		time.Sleep(time.Millisecond)
	}
	apply := projectScope(map[string]any{"operationId": "apply_active", "planId": plan.ID, "expectedBase": plan.Ours, "reviewId": "review_1", "reviewSnapshot": plan.Result.ID, "approved": true})
	response := projectRPC(t, handler, "project.merge.apply", apply)
	if *response.OK || !strings.Contains(response.Error, "active host processes") {
		t.Fatalf("merge ignored the source writer: %+v", response)
	}
	inspection := projectRPCOK(t, handler, "project.operation.inspect", projectScope(map[string]any{"operationId": "apply_active"}))
	if projectField(t, inspection, "effectState") != "not_performed" {
		t.Fatal("publication rejection lacked no-effect proof")
	}
	select {
	case <-handler.jobs.Done(jobID):
	case <-time.After(3 * time.Second):
		t.Fatal("host job process group did not settle")
	}
	source := filepath.Join(storage, "spaces", "source_a", "workspace", "hello.txt")
	content, err := os.ReadFile(source)
	if err != nil || string(content) != "hello\nheld FD\n" {
		t.Fatalf("publication lost a held descriptor write: %q %v", content, err)
	}
	apply["operationId"] = "apply_stale"
	response = projectRPC(t, handler, "project.merge.apply", apply)
	if *response.OK {
		t.Fatal("the now-stale preview overwrote the completed host write")
	}
}
