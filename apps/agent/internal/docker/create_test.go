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

// Re-execute the test binary as Docker for shell-free Windows coverage.
func TestMain(m *testing.M) {
	if log := os.Getenv("ZAKURA_TEST_CREATE_DOCKER_LOG"); log != "" {
		f, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			os.Exit(90)
		}
		_ = json.NewEncoder(f).Encode(os.Args[1:])
		_ = f.Close()
		if len(os.Args) < 2 {
			os.Exit(91)
		}
		switch os.Args[1] {
		case "version":
			fmt.Println("28.0.0")
		case "run":
			if os.Getenv("ZAKURA_TEST_CREATE_CONFLICT") == "1" {
				fmt.Fprintln(os.Stderr, "name already in use")
				os.Exit(1)
			}
			fmt.Println("exact-container-id")
		case "inspect":
			fmt.Println(`[{"Id":"exact-container-id","Name":"/stable-name","State":{"Status":"running"},"Config":{"Image":"workspace:1"}}]`)
		default:
			os.Exit(92)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestCreateNeverRemovesExistingContainer(t *testing.T) {
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", bin)
	for _, conflict := range []bool{false, true} {
		t.Run(fmt.Sprint(conflict), func(t *testing.T) {
			log := filepath.Join(t.TempDir(), "calls.jsonl")
			t.Setenv("ZAKURA_TEST_CREATE_DOCKER_LOG", log)
			if conflict {
				t.Setenv("ZAKURA_TEST_CREATE_CONFLICT", "1")
			} else {
				t.Setenv("ZAKURA_TEST_CREATE_CONFLICT", "")
			}
			info, err := Create(context.Background(), RunSpec{Name: "stable-name", Image: "workspace:1", Volumes: []Volume{{VolumeName: "independent-volume", ContainerPath: "/workspace"}}})
			if conflict && err == nil {
				t.Fatal("conflict accepted")
			}
			if !conflict && (err != nil || info.DockerID != "exact-container-id") {
				t.Fatalf("create: %+v %v", info, err)
			}
			raw, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			runs := 0
			for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
				var args []string
				if err := json.Unmarshal([]byte(line), &args); err != nil {
					t.Fatal(err)
				}
				switch args[0] {
				case "version", "inspect":
				case "run":
					runs++
					joined := strings.Join(args, " ")
					if !strings.Contains(joined, "--name stable-name") || !strings.Contains(joined, "type=volume,source=independent-volume,target=/workspace") {
						t.Fatalf("lost identity or volume: %v", args)
					}
				default:
					t.Fatalf("unexpected mutation: %v", args)
				}
			}
			if runs != 1 {
				t.Fatalf("create retried %d times", runs)
			}
		})
	}
}

func TestCreateRequiresIdentityBeforeDockerAccess(t *testing.T) {
	t.Setenv("ZAKURA_DOCKER", filepath.Join(t.TempDir(), "missing-docker"))
	for _, spec := range []RunSpec{{Image: "workspace:1"}, {Name: "   ", Image: "workspace:1"}, {Name: "stable-name"}} {
		if _, err := Create(context.Background(), spec); err == nil || err == ErrUnavailable {
			t.Fatalf("missing identity was not validated: %v", err)
		}
	}
}
