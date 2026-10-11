package projectrunner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/refactor"
)

func refactorTestBinary(t *testing.T) string {
	t.Helper()
	if binary := os.Getenv("ZAKURA_TEST_AGENT_BINARY"); binary != "" {
		return binary
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate trusted agent source")
	}
	binary := filepath.Join(t.TempDir(), "rename-native-agent")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	command := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", binary, "./cmd/zakura-agent")
	command.Dir = filepath.Clean(filepath.Join(filepath.Dir(file), "../.."))
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build own native checker agent: %v %s", err, output)
	}
	return binary
}
func TestRefactorNativeWorkerStandardLibraryAndCancellation(t *testing.T) {
	binary := refactorTestBinary(t)
	source := refactor.MemorySource{Snapshot: "snapshot", FilesByPath: map[string]string{"a.go": "package p\nimport \"errors\"\nfunc Build() error { return errors.New(\"Build\") }\nfunc Use() error { return Build() }\n"}}
	offset := strings.Index(source.FilesByPath["a.go"], "Build()")
	req := refactor.Request{SnapshotID: source.Snapshot, Path: "a.go", Offset: &offset, NewName: "Create"}
	preview, err := runRefactorProcess(context.Background(), binary, source, req)
	if err != nil {
		t.Fatal(err)
	}
	if preview.References != 1 || len(preview.Files) != 1 || len(preview.CheckedPackages) != 1 {
		t.Fatalf("native worker %#v", preview)
	}
	rewritten, err := refactor.Apply([]byte(source.FilesByPath["a.go"]), preview.Files[0])
	if err != nil || !strings.Contains(string(rewritten), `errors.New("Build")`) || !strings.Contains(string(rewritten), "return Create()") {
		t.Fatalf("worker rewrote literal or missed binding %s %v", rewritten, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	started := time.Now()
	_, err = runRefactorProcess(ctx, binary, source, req)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > 5*time.Second {
		t.Fatalf("native worker cancellation %v elapsed %s", err, time.Since(started))
	}
}
func TestRefactorWorkerRejectsThirdPartyAndStrictRPCFields(t *testing.T) {
	for _, raw := range []string{
		`{"spaceId":"space_a","projectId":"project_a","snapshotId":"x","path":"a.go","offset":1,"symbolId":"12345678901234567890123456789012","newName":"X"}`,
		`{"spaceId":"space_a","projectId":"project_a","snapshotId":"x","path":"a.go","offset":1,"newName":"X","hostRoot":"/tmp"}`,
		`{"spaceId":"../escape","projectId":"project_a","snapshotId":"x","path":"a.go","offset":1,"newName":"X"}`,
	} {
		if _, err := decodeRefactorRequest("project.refactor.preview", json.RawMessage(raw)); err == nil {
			t.Fatalf("bad refactor request accepted %s", raw)
		}
	}
	if HandleRefactorWorker([]string{"agent", refactorWorkerFlag, "extra"}) {
		t.Fatal("worker accepted nonexact argv")
	}
	if HandleRefactorWorker([]string{"agent", "-server", "url"}) {
		t.Fatal("worker intercepted normal agent CLI")
	}
	buffer := &boundedRefactorBuffer{limit: 5}
	if _, err := buffer.Write([]byte("oversize")); !errors.Is(err, refactor.ErrLimit) {
		t.Fatalf("worker output limit %v", err)
	}
}
