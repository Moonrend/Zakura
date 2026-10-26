package docker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt in explicitly against a local Linux Docker daemon. The image must already
// exist: its immutable image ID is passed to Create, so this test never pulls.
// Only this invocation's exact name and ownership labels authorize cleanup.
func TestDockerRealLifecycleIntegration(t *testing.T) {
	if os.Getenv("ZAKURA_DOCKER_LIFECYCLE_INTEGRATION") != "1" {
		t.Skip("real Docker lifecycle not requested; set ZAKURA_DOCKER_LIFECYCLE_INTEGRATION=1")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := Require(); err != nil {
		t.Fatal(err)
	}
	out, err := exec.CommandContext(ctx, dockerBin(), "image", "inspect", "golang:1.26.4").CombinedOutput()
	if err != nil {
		t.Fatalf("pre-cached golang:1.26.4 required; no pull attempted: %s %v", out, err)
	}
	var images []struct {
		ID           string `json:"Id"`
		OS           string `json:"Os"`
		Architecture string `json:"Architecture"`
	}
	if err = json.Unmarshal(out, &images); err != nil || len(images) != 1 || images[0].ID == "" || images[0].OS != "linux" || images[0].Architecture != "amd64" {
		t.Fatalf("expected one cached linux/amd64 image: %s %v", out, err)
	}
	imageID := images[0].ID
	var nonce [12]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	identity := hex.EncodeToString(nonce[:])
	name := "zakura-lifecycle-test-" + identity
	label := "zakura.test.lifecycle=" + identity
	labels := map[string]string{
		"zakura.test.lifecycle": identity,
		"zakura.tenant":         "lifecycle-test-" + identity,
		"zakura.space":          "space-" + identity,
		"zakura.computer":       "computer-" + identity,
		"zakura.incarnation":    identity,
		"zakura.purpose":        "lifecycle-integration-test",
	}
	root := t.TempDir()
	if err = os.Mkdir(filepath.Join(root, "home"), 0700); err != nil {
		t.Fatal(err)
	}
	sentinel := "bind-sentinel-" + identity
	if err = os.WriteFile(filepath.Join(root, "sentinel.txt"), []byte(sentinel), 0600); err != nil {
		t.Fatal(err)
	}
	assertOwned := func(c ContainerInfo) bool {
		if c.DockerID == "" || c.Name != name || c.Image != imageID {
			return false
		}
		for key, value := range labels {
			if c.Labels[key] != value {
				return false
			}
		}
		return true
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		// Includes a container created before an interrupted Create/Inspect reply.
		// Never use global prune, name-only removal, forced removal or volume rm.
		list, listErr := List(cleanupCtx, label)
		if listErr != nil {
			t.Errorf("cannot verify own test cleanup: %v", listErr)
			return
		}
		for _, c := range list {
			if !assertOwned(c) {
				t.Errorf("refusing cleanup of unexpected test-label identity: %s %s", c.DockerID, c.Name)
				continue
			}
			if stopErr := Stop(cleanupCtx, c.DockerID, true); stopErr != nil {
				t.Errorf("exact test container cleanup failed: %v", stopErr)
			}
		}
		remaining, listErr := List(cleanupCtx, label)
		if listErr != nil || len(remaining) != 0 {
			t.Errorf("test cleanup absence not confirmed: count=%d err=%v", len(remaining), listErr)
		}
	})
	assertList := func(id, status string) {
		t.Helper()
		list, listErr := List(ctx, label)
		if listErr != nil || len(list) != 1 || !assertOwned(list[0]) || list[0].DockerID != id || list[0].Status != status {
			t.Fatalf("ownership/status list: got=%+v want=%s/%s err=%v", list, id, status, listErr)
		}
	}
	assertPreserved := func(id string) {
		t.Helper()
		stdout, stderr, code, execErr := Exec(ctx, id, []string{"sh", "-c", `test "$HOME" = /fixture/home && test "$(cat /fixture/sentinel.txt)" = "$1" && test "$(cat "$HOME/.retained")" = "$2" && printf 'preserved'`, "fixture", sentinel, identity}, "", nil)
		if execErr != nil || code != 0 || stdout != "preserved" {
			t.Fatalf("HOME/bind sentinel not preserved: stdout=%q stderr=%q code=%d err=%v", stdout, stderr, code, execErr)
		}
		for path, expected := range map[string]string{"sentinel.txt": sentinel, "home/.retained": identity} {
			data, readErr := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
			if readErr != nil || string(data) != expected {
				t.Fatalf("host bind file %s changed: %q %v", path, data, readErr)
			}
		}
	}
	list, err := List(ctx, label)
	if err != nil || len(list) != 0 {
		t.Fatalf("unique test scope not empty: %+v %v", list, err)
	}
	spec := RunSpec{
		Name: name, Image: imageID, Labels: labels, Restart: "no", Network: "none",
		Env:     map[string]string{"HOME": "/fixture/home"},
		Volumes: []Volume{{HostPath: root, ContainerPath: "/fixture"}},
		Command: []string{"sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1 & wait $!; done"},
	}
	first, err := Create(ctx, spec)
	if err != nil || !assertOwned(first) || first.Status != "running" {
		t.Fatalf("real Create ownership: %+v %v", first, err)
	}
	assertList(first.DockerID, "running")
	inspected, err := Inspect(ctx, first.DockerID)
	if err != nil || !assertOwned(inspected) || inspected.DockerID != first.DockerID {
		t.Fatalf("real Inspect identity: %+v %v", inspected, err)
	}
	stdout, stderr, code, err := Exec(ctx, first.DockerID, []string{"sh", "-c", `test "$HOME" = /fixture/home && printf '%s' "$1" > "$HOME/.retained"`, "fixture", identity}, "", nil)
	if err != nil || code != 0 {
		t.Fatalf("write HOME fixture: stdout=%q stderr=%q code=%d err=%v", stdout, stderr, code, err)
	}
	assertPreserved(first.DockerID)
	if _, err = Create(ctx, spec); err == nil {
		t.Fatal("duplicate Create unexpectedly replaced/accepted existing named container")
	}
	assertList(first.DockerID, "running")
	assertPreserved(first.DockerID)
	if err = Stop(ctx, first.DockerID, false); err != nil {
		t.Fatal(err)
	}
	assertList(first.DockerID, "exited")
	resumed, err := Start(ctx, first.DockerID)
	if err != nil || resumed.DockerID != first.DockerID || !assertOwned(resumed) {
		t.Fatalf("Start replaced original identity: %+v %v", resumed, err)
	}
	assertList(first.DockerID, "running")
	assertPreserved(first.DockerID)
	if err = Stop(ctx, first.DockerID, true); err != nil {
		t.Fatal(err)
	}
	list, err = List(ctx, label)
	if err != nil || len(list) != 0 {
		t.Fatalf("removal absence not confirmed: %+v %v", list, err)
	}
	second, err := Create(ctx, spec)
	if err != nil || !assertOwned(second) || second.DockerID == first.DockerID {
		t.Fatalf("explicit recreation: %+v %v", second, err)
	}
	assertList(second.DockerID, "running")
	assertPreserved(second.DockerID)
	if err = Stop(ctx, second.DockerID, true); err != nil {
		t.Fatal(err)
	}
	if err = Stop(ctx, second.DockerID, true); err != nil {
		t.Fatalf("confirmed absence must be idempotent: %v", err)
	}
	list, err = List(ctx, label)
	if err != nil || len(list) != 0 {
		t.Fatalf("final absence not confirmed: %+v %v", list, err)
	}
	if _, err = Inspect(ctx, second.DockerID); err == nil || !strings.Contains(strings.ToLower(err.Error()), "no such object:") {
		t.Fatalf("removed exact ID still inspectable or absence unclear: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, "sentinel.txt"))
	if err != nil || string(data) != sentinel {
		t.Fatalf("container removal deleted bind files: %q %v", data, err)
	}
	t.Logf("real lifecycle passed: cached image=%s scope=%s original=%s recreated=%s; bind/HOME preserved and final absence confirmed", imageID, identity, first.DockerID, second.DockerID)
}
