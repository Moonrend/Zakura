package docker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestStartResumesExistingContainerWithoutReplacingIt(t *testing.T) {
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", bin)
	log := filepath.Join(t.TempDir(), "calls.jsonl")
	t.Setenv("ZAKURA_TEST_CREATE_DOCKER_LOG", log)
	info, err := Start(context.Background(), "exact-container-id")
	if err != nil || info.DockerID != "exact-container-id" || info.Status != "running" {
		t.Fatalf("start: %+v %v", info, err)
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var args []string
		if err := json.Unmarshal([]byte(line), &args); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, args)
	}
	want := [][]string{{"version", "--format", "{{.Server.Version}}"}, {"start", "exact-container-id"}, {"version", "--format", "{{.Server.Version}}"}, {"inspect", "exact-container-id"}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("start mutated or replaced container: %v", calls)
	}
}

func TestStartValidatesIdentityAndSurfacesFailure(t *testing.T) {
	t.Setenv("ZAKURA_DOCKER", filepath.Join(t.TempDir(), "missing-docker"))
	for _, id := range []string{"", "   ", "--all"} {
		if _, err := Start(context.Background(), id); err == nil || err == ErrUnavailable {
			t.Fatalf("invalid identity %q not rejected before Docker: %v", id, err)
		}
	}
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", bin)
	t.Setenv("ZAKURA_TEST_CREATE_DOCKER_LOG", filepath.Join(t.TempDir(), "calls.jsonl"))
	t.Setenv("ZAKURA_TEST_START_FAILED", "1")
	if _, err := Start(context.Background(), "exact-container-id"); err == nil || !strings.Contains(err.Error(), "container cannot be started") {
		t.Fatalf("start failure hidden: %v", err)
	}
}
