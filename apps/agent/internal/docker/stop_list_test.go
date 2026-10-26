package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// This helper runs before the package TestMain, allowing isolated shell-free
// failure injection on Windows without changing the existing create fixtures.
func init() {
	log := os.Getenv("ZAKURA_TEST_RELIABILITY_DOCKER")
	if log == "" {
		return
	}
	f, err := os.OpenFile(log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		os.Exit(90)
	}
	_ = json.NewEncoder(f).Encode(os.Args[1:])
	_ = f.Close()
	if len(os.Args) < 2 {
		os.Exit(91)
	}
	scenario := os.Getenv("ZAKURA_TEST_RELIABILITY_SCENARIO")
	switch os.Args[1] {
	case "version":
		fmt.Println("28.0.0")
	case "stop":
		if scenario == "stop-error" {
			fmt.Fprintln(os.Stderr, "permission denied")
			os.Exit(1)
		}
		if scenario == "absent" {
			fmt.Fprintln(os.Stderr, "Error response from daemon: No such container: exact-id")
			os.Exit(1)
		}
		fmt.Println("exact-id")
	case "rm":
		if scenario == "remove-error" {
			fmt.Fprintln(os.Stderr, "filesystem busy")
			os.Exit(1)
		}
		fmt.Println("exact-id")
	case "ps":
		fmt.Println("first\nsecond")
	case "inspect":
		if os.Args[2] == "second" {
			fmt.Fprintln(os.Stderr, "inspect permission denied")
			os.Exit(1)
		}
		fmt.Println(`[{"Id":"first","Name":"/first","State":{"Status":"running"},"Config":{"Image":"workspace:1"}}]`)
	default:
		os.Exit(92)
	}
	os.Exit(0)
}
func reliabilityDocker(t *testing.T, scenario string) string {
	t.Helper()
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "calls.jsonl")
	t.Setenv("ZAKURA_DOCKER", bin)
	t.Setenv("ZAKURA_TEST_RELIABILITY_DOCKER", log)
	t.Setenv("ZAKURA_TEST_RELIABILITY_SCENARIO", scenario)
	return log
}
func TestStopFailureNeverRemoves(t *testing.T) {
	log := reliabilityDocker(t, "stop-error")
	err := Stop(context.Background(), "exact-id", true)
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("stop failure hidden: %v", err)
	}
	raw, _ := os.ReadFile(log)
	if strings.Contains(string(raw), `["rm"`) {
		t.Fatalf("removed after failed stop: %s", raw)
	}
}
func TestStopReportsRemoveFailure(t *testing.T) {
	log := reliabilityDocker(t, "remove-error")
	err := Stop(context.Background(), "exact-id", true)
	if err == nil || !strings.Contains(err.Error(), "filesystem busy") {
		t.Fatalf("remove failure hidden: %v", err)
	}
	raw, _ := os.ReadFile(log)
	if strings.Contains(string(raw), `"-f"`) {
		t.Fatalf("force removed container: %s", raw)
	}
}
func TestStopConfirmedAbsenceIsIdempotent(t *testing.T) {
	log := reliabilityDocker(t, "absent")
	if err := Stop(context.Background(), "exact-id", true); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(log)
	if strings.Contains(string(raw), `["rm"`) {
		t.Fatalf("removed an absent container: %s", raw)
	}
}
func TestStopPreservesContainerAndValidatesIdentity(t *testing.T) {
	log := reliabilityDocker(t, "")
	for _, id := range []string{"", "  ", "--all"} {
		if err := Stop(context.Background(), id, true); err == nil {
			t.Fatalf("accepted %q", id)
		}
	}
	if err := Stop(context.Background(), "exact-id", false); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(log)
	if strings.Contains(string(raw), `["rm"`) {
		t.Fatalf("stop removed container: %s", raw)
	}
}
func TestListFailsRatherThanReturningIncompleteInspection(t *testing.T) {
	reliabilityDocker(t, "")
	got, err := List(context.Background(), "zakura.space=space")
	if err == nil || got != nil || !strings.Contains(err.Error(), "inspect second") {
		t.Fatalf("incomplete list accepted: %+v %v", got, err)
	}
}
